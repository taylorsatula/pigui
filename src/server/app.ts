// Assembles pigui: one Harness over one SQLite storage, the extensions it runs, and the HTTP server in front. Tests
// build the server through `startApp` exactly as `main.ts` does, with fake mode and a temporary data directory.
import type { AddressInfo } from "node:net";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { Draft } from "@earendil-works/chord/delta";
import { configure, type ConversationId, createRegistry, defineExtension, Harness, type ModelRef, type Report } from "@earendil-works/pi-durable";
import { createFitImagesExtension } from "@earendil-works/pi-durable/images/fit";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { piguiAgent } from "./agent/extension.ts";
import { toolDiagnostics } from "./agent/toolDiagnostics.ts";
import { projectExtension, skillsExtension } from "./agent/project.ts";
import { BUNDLED_AGENTS, BUNDLED_SKILLS } from "./agent/resources.ts";
import type { AgentServices, Faults } from "./agent/services.ts";
import type { Config } from "./config.ts";
import { Delivery } from "./delivery.ts";
import { editSession, SessionDocToken, SessionIndexToken } from "./documents.ts";
import { type AgentRow, type RepoSessionDoc, type SessionDoc, sessionRow } from "../shared/session.ts";
import { LocalGitHub } from "./fake/github.ts";
import { type ScriptedModelOptions, scriptedModels } from "./fake/model.ts";
import { fakeSynthesizer } from "./fake/synthesizer.ts";
import { currentBranch } from "./git.ts";
import { GhHost, type RepoHost } from "./host.ts";
import { callerCheck } from "./callers.ts";
import { createHttpServer } from "./http.ts";
import { Uploads } from "./input.ts";
import { createLogger, type Logger } from "./log.ts";
import { Maintenance } from "./maintenance.ts";
import type { MemoryStatus } from "../shared/api.ts";
import { type Embedder, fakeEmbedder } from "./memory/embedder.ts";
import { Memory } from "./memory/store.ts";
import { Notifications } from "./notify.ts";
import { Presence } from "./presence.ts";
import { openSandbox, readableGrants, type Sandbox } from "./sandbox.ts";
import { sessionEnvs } from "./session-env.ts";
import { Sessions } from "./sessions.ts";
import { kokoroInstalled, kokoroSynthesizer } from "./speech/kokoro.ts";
import { Speech } from "./speech/speech.ts";
import { migrateSeededAgents, seedSettings, subagentsExtension } from "./subagents/extension.ts";
import { Supervisor } from "./supervisor.ts";
import { loadVapidKeys, type PushSender, RecordingPushSender, WebPushSender } from "./webpush.ts";

export type AppOptions = {
	config: Config;
	/** Pi's configuration directory; in fake mode an empty one. */
	agentDir: string;
	/** Real mode: Pi's models and default model. Fake mode builds the scripted ones. */
	pi?: { models: Models; defaultModel: () => ModelRef };
	/**
	 * Long-term memory's embeddings, or why memory is off (shown in the sidebar). Real mode: what main.ts chose; absent
	 * reads as off. Fake mode: a stand-in that needs no network unless one is given.
	 */
	embedder?: Embedder | { off: string };
	fakeModel?: ScriptedModelOptions;
	log?: Logger;
	faults?: Faults;
	/** The clock pigui stamps its records with; tests move it to make sessions old. */
	now?: () => number;
	/** Where the built client is; default `dist/public` beside the sources. */
	staticDir?: string;
	/**
	 * Check who opened each connection (see callers.ts): on a server, refuse pigui's own user; in OnPrem on Linux,
	 * allow only it and root (tailscaled). On in real mode; off in fake mode, where tests connect as pigui's own user.
	 */
	checkCallers?: boolean;
	/**
	 * Read replies aloud where this build can: with kokoro-js and its model installed, and always in fake mode, whose
	 * synthesizer needs neither. Tests set false to see a build without speech.
	 */
	speech?: boolean;
};

export type App = {
	url: string;
	harness: Harness;
	sessions: Sessions;
	supervisor: Supervisor;
	maintenance: Maintenance;
	delivery: Delivery;
	host: RepoHost;
	push: PushSender;
	presence: Presence;
	/** Undefined when agent commands run unconfined. */
	sandbox: Sandbox | undefined;
	close(): Promise<void>;
};

export async function startApp(options: AppOptions): Promise<App> {
	const { config } = options;
	const log = options.log ?? createLogger();
	const now = options.now ?? (() => Date.now());
	const context = BACKGROUND_CONTEXT;
	// OnPrem runs agent commands as the person, so there is nothing to open.
	const sandbox = config.onPrem === undefined ? await openSandbox({ enabled: config.sandbox, fake: config.fake, log }) : undefined;
	const paths = {
		database: join(config.dataDir, "pigui.sqlite"),
		workspaces: join(config.dataDir, "workspaces"),
		uploads: join(config.dataDir, "uploads"),
		backups: join(config.dataDir, "backups"),
		sandbox: join(config.dataDir, "sandbox"),
	};
	for (const dir of [config.dataDir, paths.workspaces, paths.uploads, paths.backups]) await mkdir(dir, { recursive: true });
	// An earlier pigui seeded the bundled definitions into the data directory; move the person's edits to their agent
	// directory and drop the unchanged copies, so updates to the bundled definitions reach them again.
	await migrateSeededAgents(config.dataDir, options.agentDir, BUNDLED_AGENTS, log);
	await seedSettings(config.dataDir);
	/** pigui's own directory for a session: a repository session's clone, and every session's attachments. */
	const workspace = (id: number) => join(paths.workspaces, String(id));
	/** A session's own home, tmp and gh configuration, which its commands get instead of pigui's (not in OnPrem). */
	const scratch = (id: number) => join(paths.sandbox, String(id));
	/** Where the agent works: a repository session's clone, or the directory a local session chose. */
	const workingDir = (doc: Readonly<SessionDoc>) => (doc.place === "local" ? doc.dir : workspace(doc.id));

	const fakeGitHub = config.fake ? await LocalGitHub.open(join(config.dataDir, "fake-github")) : undefined;
	const host: RepoHost = fakeGitHub ?? new GhHost();
	const pi = config.fake ? toPi(scriptedModels(options.fakeModel)) : options.pi;
	if (pi === undefined) throw new Error("Real mode needs Pi's models.");
	const vapid = await loadVapidKeys(join(config.dataDir, "vapid.json"));
	const push: PushSender = config.fake ? new RecordingPushSender() : new WebPushSender(vapid, config.pushSubject);
	const images = await createNodePhotonImages();
	const presence = new Presence();
	const uploads = new Uploads(paths.uploads);

	let opened: Harness | undefined;
	const harness = (): Harness => {
		if (opened === undefined) throw new Error("The Harness is not open yet.");
		return opened;
	};
	const notifications = new Notifications({ sender: push, presence, log, harness });
	const chosen = options.embedder ?? (config.fake ? fakeEmbedder() : { off: "No embedder was configured." });
	const memory = "off" in chosen ? undefined : new Memory(chosen, harness);
	const memoryStatus: MemoryStatus = "off" in chosen ? { on: false, reason: chosen.off } : { on: true, model: chosen.model };
	const services: AgentServices = {
		now,
		log,
		notifications,
		harness,
		models: () => pi.models,
		model: (provider, modelId) => pi.models.getModel(provider, modelId) as Model<Api> | undefined,
		compactionModel: config.compactionModel,
		agentDir: options.agentDir,
		workspace,
		workingDir,
		onPrem: config.onPrem !== undefined,
		sandboxed: sandbox !== undefined,
		memory,
		faults: options.faults ?? {},
	};
	const sessions = new Sessions({
		harness,
		host,
		uploads,
		images,
		agent: services,
		log,
		now,
		defaultModel: pi.defaultModel,
		spendCap: config.spendCap,
		onPrem: config.onPrem,
	});
	const maintenance = new Maintenance({
		harness,
		log,
		now,
		databaseFile: paths.database,
		backupDir: paths.backups,
		uploadsDir: paths.uploads,
		workspace,
		scratch,
	});
	const delivery = new Delivery({ harness, host, workspace, now, log });
	const supervisor = new Supervisor({ harness, notifications, log, now });
	const synthesizer = options.speech === false ? undefined : config.fake ? fakeSynthesizer() : (await kokoroInstalled()) ? kokoroSynthesizer(log, config.modelsUnloadAfterMs) : undefined;
	const speech = synthesizer === undefined ? undefined : new Speech({ harness, agent: services, synthesizer, log, now });

	const registry = createRegistry();
	const coding = createCodingTools({ images });
	const session = piguiAgent(services);
	const skills = skillsExtension(services);
	registry.install(coding);
	registry.install(createFitImagesExtension(images));
	registry.install(session);
	registry.install(toolDiagnostics(services));
	registry.install(defineExtension({ name: "pigui-sessions", tasks: [sessions.setupTask, notifications.task, maintenance.task] }));
	registry.install(projectExtension(services));
	registry.install(skills);
	registry.install(
		subagentsExtension({
			dataDir: config.dataDir,
			agents: { bundled: BUNDLED_AGENTS, user: join(options.agentDir, "agents") },
			dir: async (id, read, context) => {
				const doc = await read.snapshot(SessionDocToken, id, context);
				return doc?.setup.status === "ready" ? workingDir(doc) : undefined;
			},
			now,
			log,
			registry,
			models: () => pi.models,
			exclude: [session],
			coding,
			skills,
			place: async (id, read, context) => {
				const doc = await read.snapshot(SessionDocToken, id, context);
				if (doc?.id === undefined) throw new Error("Agents are started by a pigui session.");
				const dir = workingDir(doc);
				// A local session's directory may be a repository, on whatever branch the person left it.
				const branch = doc.place === "repo" ? doc.branch : await currentBranch(dir).catch(() => undefined);
				return branch === undefined ? { dir } : { dir, branch };
			},
			reported: async (id, read, context) => {
				const doc = await read.snapshot(SessionDocToken, id, context);
				return doc?.outcome?.kind === "reported" && doc.activeRun !== undefined && doc.outcome.at >= doc.activeRun.startedAt;
			},
			row: (tx, id, agent, change, effect) =>
				editSession(tx, id, now(), (doc) => {
					const rows = doc.agents ?? [];
					const at = rows.findIndex((row) => row.id === agent);
					const next = change(at === -1 ? undefined : (rows[at] as AgentRow));
					if (at === -1) doc.agents = [...rows, next];
					else rows[at] = next;
					if (effect?.kind === "run") {
						// A background answer started the next run: the supervisor follows it as any other.
						doc.activeRun = { submission: effect.submission, startedAt: now() };
						delete doc.outcome;
					} else if (effect?.kind === "quiet" && doc.outcome?.kind === "waiting-agents") {
						doc.outcome = { kind: "stopped", at: now() };
					}
				}),
			faults: options.faults ?? {},
		}),
	);

	const env = sessionEnvs({
		dirs: (id) => ({ workspace: workspace(id), scratch: scratch(id) }),
		gitHubToken: config.agentGitHubToken,
		sandbox,
		onPrem: config.onPrem,
		// Skills are read and run, while the rest of Pi's directory (sign-in, settings, models) stays out of reach. In fake
		// mode the agent's git fetch reads the stand-in remote.
		readable: readableGrants([join(options.agentDir, "skills"), join(homedir(), ".agents", "skills"), BUNDLED_SKILLS, ...(fakeGitHub === undefined ? [] : [fakeGitHub.root])]),
	});
	opened = await Harness.open(
		await openNodeSqliteStorage(paths.database),
		{
			models: pi.models,
			registry,
			identity: { attribution: { name: "pigui", url: "https://github.com/taylorsatula/pigui" } },
			// Durable's defaults otherwise, so a change to them reaches pigui. Fake mode fails fast, so a scripted model
			// failure ends its run in milliseconds.
			...(config.fake ? { settings: { retry: { maxRetries: 1, baseDelayMs: 10 } } } : {}),
			env,
			onReport: (report: Report) => {
				const task = "task" in report ? report.task : undefined;
				log.warn("durable.report", {
					kind: report.kind,
					reason: "reason" in report ? report.reason : undefined,
					task: task?.kind,
					session: task?.conversationId,
				});
			},
		},
		context,
	);
	// The drawer's document exists from the start, so a phone can watch it before the first session. Its rows are a
	// projection of each session, recomputed here so rows an earlier pigui wrote take the current shape. Sessions
	// an earlier pigui created with a turn limit lose it: a run takes as many tool rounds as its work needs. Sessions
	// from before local sessions were all repository sessions, and say so from here on.
	await opened.commit(async (tx) => {
		const index = await tx.doc(SessionIndexToken);
		for (const key of Object.keys(index.rows)) {
			const id = Number(key) as ConversationId;
			const doc = await tx.doc(SessionDocToken, id);
			if ((doc as { place?: string }).place === undefined) (doc as Draft<RepoSessionDoc>).place = "repo";
			const row = sessionRow(doc as SessionDoc);
			if (JSON.stringify(index.rows[key]) !== JSON.stringify(row)) index.rows[key] = row;
			await configure(tx, id, { maxTurns: null });
		}
	}, context);
	await maintenance.ensureScheduled(context);
	await supervisor.start(context);
	opened.resume();

	const server = createHttpServer({
		harness,
		sessions,
		delivery,
		host,
		uploads,
		presence,
		log,
		now,
		fake: config.fake,
		vapidPublicKey: vapid.publicKey,
		allowedLogins: config.allowedLogins,
		...callers(options.checkCallers ?? !config.fake, config.onPrem !== undefined),
		agentDir: options.agentDir,
		workingDir,
		onPrem: config.onPrem,
		staticDir: options.staticDir ?? join(import.meta.dirname, "..", "..", "dist", "public"),
		speech,
		memory: memoryStatus,
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(config.port, config.host, () => resolve());
	});
	const address = server.address() as AddressInfo;
	const url = `http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${address.port}`;
	log.info("started", { port: address.port, fake: config.fake, onPrem: config.onPrem !== undefined, speech: speech !== undefined, memory: memory?.embedder.model });

	return {
		url,
		harness: opened,
		sessions,
		supervisor,
		maintenance,
		delivery,
		host,
		push,
		presence,
		sandbox,
		async close() {
			supervisor.stop();
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			});
			await opened?.close(context);
		},
	};
}

/**
 * The caller check, when on. OnPrem allows only pigui's own user and root (tailscaled) where the kernel's socket
 * table says who that is, on Linux; elsewhere it checks no caller, and any user of the computer can reach it (README,
 * "PiGUI OnPrem").
 */
function callers(on: boolean, onPrem: boolean): { callerCheck?: ReturnType<typeof callerCheck> } {
	if (!on) return {};
	if (!onPrem) return { callerCheck: callerCheck("others") };
	return process.platform === "linux" ? { callerCheck: callerCheck("own") } : {};
}

function toPi(scripted: { models: Models; model: ModelRef }): { models: Models; defaultModel: () => ModelRef } {
	return { models: scripted.models, defaultModel: () => scripted.model };
}
