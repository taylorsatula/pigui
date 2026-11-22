// Assembles picloud: one Harness over one SQLite storage, the extensions it runs, and the HTTP server in front. Tests
// build the server through `startApp` exactly as `main.ts` does, with fake mode and a temporary data directory.
import type { AddressInfo } from "node:net";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, Harness, type ModelRef, type Report } from "@earendil-works/pi-durable";
import { createFitImagesExtension } from "@earendil-works/pi-durable/images/fit";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { picloudAgent } from "./agent/extension.ts";
import type { AgentServices, Faults } from "./agent/services.ts";
import type { Config } from "./config.ts";
import { Delivery } from "./delivery.ts";
import { SessionIndexToken } from "./docs.ts";
import { LocalGitHub } from "./fake/github.ts";
import { type ScriptedModelOptions, scriptedModels } from "./fake/model.ts";
import { GhHost, type RepoHost } from "./host.ts";
import { createHttpServer } from "./http.ts";
import { Uploads } from "./input.ts";
import { createLogger, type Logger } from "./log.ts";
import { Maintenance } from "./maintenance.ts";
import { Notifications } from "./notify.ts";
import { Presence } from "./presence.ts";
import { openSandbox, readableGrants, type Sandbox } from "./sandbox.ts";
import { sessionEnvs } from "./session-env.ts";
import { Sessions } from "./sessions.ts";
import { Supervisor } from "./supervisor.ts";
import { loadVapidKeys, type PushSender, RecordingPushSender, WebPushSender } from "./webpush.ts";

export type AppOptions = {
	config: Config;
	/** Pi's configuration directory; in fake mode an empty one. */
	agentDir: string;
	/** Real mode: Pi's models and default model. Fake mode builds the scripted ones. */
	pi?: { models: Models; defaultModel: () => ModelRef };
	fakeModel?: ScriptedModelOptions;
	log?: Logger;
	faults?: Faults;
	/** The clock picloud stamps its records with; tests move it to make sessions old. */
	now?: () => number;
	/** Where the built client is; default `dist/public` beside the sources. */
	staticDir?: string;
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
	const sandbox = await openSandbox({ enabled: config.sandbox, fake: config.fake, log });
	const paths = {
		database: join(config.dataDir, "picloud.sqlite"),
		workspaces: join(config.dataDir, "workspaces"),
		uploads: join(config.dataDir, "uploads"),
		backups: join(config.dataDir, "backups"),
		sandbox: join(config.dataDir, "sandbox"),
	};
	for (const dir of [config.dataDir, paths.workspaces, paths.uploads, paths.backups]) await mkdir(dir, { recursive: true });
	const workspace = (id: number) => join(paths.workspaces, String(id));
	/** A session's own home, tmp and gh configuration, which its commands get instead of picloud's. */
	const scratch = (id: number) => join(paths.sandbox, String(id));

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
	const services: AgentServices = {
		now,
		log,
		notifications,
		harness,
		models: () => pi.models,
		model: (provider, modelId) => pi.models.getModel(provider, modelId) as Model<Api> | undefined,
		agentDir: options.agentDir,
		workspace,
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
		maxTurns: config.maxTurns,
		spendCap: config.spendCap,
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
	const delivery = new Delivery({ harness, host, workspace, now });
	const supervisor = new Supervisor({ harness, notifications, log, now });

	const registry = createRegistry();
	registry.install(createCodingTools({ images }));
	registry.install(createFitImagesExtension(images));
	registry.install(picloudAgent(services));
	registry.install(defineExtension({ name: "picloud-sessions", tasks: [sessions.setupTask, notifications.task, maintenance.task] }));

	const env = sessionEnvs({
		dirs: (id) => ({ workspace: workspace(id), scratch: scratch(id) }),
		gitHubToken: config.agentGitHubToken,
		sandbox,
		// Skills are read and run, while the rest of Pi's directory (sign-in, settings, models) stays out of reach. In fake
		// mode the agent's git fetch reads the stand-in remote.
		readable: readableGrants([join(options.agentDir, "skills"), ...(fakeGitHub === undefined ? [] : [fakeGitHub.root])]),
	});
	opened = await Harness.open(
		await openNodeSqliteStorage(paths.database),
		{
			models: pi.models,
			registry,
			identity: { attribution: { name: "picloud", url: "https://github.com/taylorsatula/picloud" } },
			settings: {
				// Fake mode fails fast, so a scripted model failure ends its run in milliseconds.
				retry: config.fake ? { maxRetries: 1, baseDelayMs: 10 } : { maxRetries: 3 },
				afterFailedRun: "keep",
			},
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
	// The drawer's document exists from the start, so a phone can watch it before the first session.
	await opened.commit(async (tx) => {
		await tx.doc(SessionIndexToken);
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
		agentDir: options.agentDir,
		workspace,
		staticDir: options.staticDir ?? join(import.meta.dirname, "..", "..", "dist", "public"),
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(config.port, config.host, () => resolve());
	});
	const address = server.address() as AddressInfo;
	const url = `http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${address.port}`;
	log.info("started", { port: address.port, fake: config.fake });

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

function toPi(scripted: { models: Models; model: ModelRef }): { models: Models; defaultModel: () => ModelRef } {
	return { models: scripted.models, defaultModel: () => scripted.model };
}
