// How tests build picloud: the real server (`startApp`) in fake mode, on a free port, over a temporary data directory
// and an empty Pi configuration directory. Nothing is mocked; restarting closes the server and opens a new one on the
// same data directory, as a process restart would.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, type EntryRecord, LiveDoc, type LiveState } from "@earendil-works/pi-durable";
import type { ApiError } from "../src/shared/api.ts";
import { CHECKPOINT_ENTRY, type RepoSessionDoc, type SessionDoc } from "../src/shared/session.ts";
import { type App, type AppOptions, startApp } from "../src/server/app.ts";
import { readConfig } from "../src/server/config.ts";
import { SessionDocToken } from "../src/server/docs.ts";
import type { LocalGitHub } from "../src/server/fake/github.ts";
import { silentLogger } from "../src/server/log.ts";
import type { RecordingPushSender } from "../src/server/webpush.ts";

export const context = BACKGROUND_CONTEXT;

export type TestOptions = Partial<Omit<AppOptions, "config" | "agentDir">> & { env?: Record<string, string> };

export class ApiFailure extends Error {
	readonly status: number;
	readonly body: ApiError;

	constructor(status: number, body: ApiError) {
		super(`${status}: ${body.error}`);
		this.status = status;
		this.body = body;
	}
}

let requests = 0;
export const requestId = (): string => `test-${process.pid}-${++requests}-${Date.now()}`;

export class TestServer {
	app!: App;
	readonly dataDir: string;
	readonly agentDir: string;
	readonly options: TestOptions;

	private constructor(dataDir: string, agentDir: string, options: TestOptions) {
		this.dataDir = dataDir;
		this.agentDir = agentDir;
		this.options = options;
	}

	static async start(options: TestOptions = {}): Promise<TestServer> {
		const server = new TestServer(await mkdtemp(join(tmpdir(), "picloud-test-")), await mkdtemp(join(tmpdir(), "picloud-pi-")), options);
		await server.open();
		return server;
	}

	async open(): Promise<void> {
		const config = readConfig({ PICLOUD_DATA_DIR: this.dataDir, PICLOUD_PORT: "0", PICLOUD_FAKE: "1", ...this.options.env });
		const { env: _env, ...rest } = this.options;
		this.app = await startApp({ log: silentLogger, ...rest, config, agentDir: this.agentDir });
	}

	/** Close and reopen on the same data directory, as a process restart would. */
	async restart(options: Partial<TestOptions> = {}): Promise<void> {
		await this.app.close();
		Object.assign(this.options, options);
		await this.open();
	}

	async close(): Promise<void> {
		await this.app.close();
		await rm(this.dataDir, { recursive: true, force: true });
		await rm(this.agentDir, { recursive: true, force: true });
	}

	get github(): LocalGitHub {
		return this.app.host as LocalGitHub;
	}

	get push(): RecordingPushSender {
		return this.app.push as RecordingPushSender;
	}

	async request<T>(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
		const init: RequestInit = { method, headers: { ...headers } };
		if (body !== undefined) {
			init.body = JSON.stringify(body);
			(init.headers as Record<string, string>)["content-type"] = "application/json";
		}
		const response = await fetch(this.app.url + path, init);
		const json = (await response.json()) as T & ApiError;
		if (!response.ok) throw new ApiFailure(response.status, json);
		return json;
	}

	get<T>(path: string): Promise<T> {
		return this.request<T>("GET", path);
	}

	post<T>(path: string, body: unknown = {}): Promise<T> {
		return this.request<T>("POST", path, body);
	}

	async createSession(text: string, start: { kind: "new"; base: string } | { kind: "continue"; branch: string } = { kind: "new", base: "main" }, repo = "demo/greeter"): Promise<number> {
		const { id } = await this.post<{ id: number }>("/api/sessions", { requestId: requestId(), place: "repo", repo, start, text, attachments: [] });
		return id;
	}

	/** A local session, in `dir` on this computer (picloud OnPrem only). */
	async createLocalSession(text: string, dir: string): Promise<number> {
		const { id } = await this.post<{ id: number }>("/api/sessions", { requestId: requestId(), place: "local", dir, text, attachments: [] });
		return id;
	}

	send(id: number, text: string, attachments: string[] = []): Promise<{ route: string }> {
		return this.post(`/api/sessions/${id}/messages`, { requestId: requestId(), text, attachments });
	}

	answer(id: number, cardId: string, answer: unknown): Promise<unknown> {
		return this.post(`/api/sessions/${id}/answer`, { requestId: requestId(), cardId, answer });
	}

	session(id: number): Promise<Readonly<SessionDoc> | undefined> {
		return this.app.harness.snapshot(SessionDocToken, id as ConversationId, context);
	}

	/** Resolve with the session document once `predicate` holds, following the document's watch rather than polling. */
	async until(id: number, predicate: (doc: Readonly<SessionDoc>) => boolean, label: string, timeoutMs = 20_000): Promise<Readonly<SessionDoc>> {
		const watch = await this.app.harness.watchDoc(SessionDocToken, id as ConversationId, context);
		if (watch === undefined) throw new Error(`Session ${id} does not exist`);
		try {
			if (predicate(watch.value)) return watch.value;
			return await new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}: ${JSON.stringify(watch.value).slice(0, 2000)}`)), timeoutMs);
				watch.start(async (call) => {
					if (call.kind === "value" && predicate(call.value)) {
						clearTimeout(timer);
						resolve(call.value);
					}
				});
			});
		} finally {
			await watch.stop();
		}
	}

	/** Wait until the session's current tool call is parked, holding no invocation. */
	async parked(id: number): Promise<void> {
		const watch = await this.app.harness.watchDoc(LiveDoc, id as ConversationId, context);
		if (watch === undefined) throw new Error(`Session ${id} has no live state`);
		const isParked = (live: Readonly<LiveState>) => live.tools?.some((slot) => slot.status === "sleeping") === true;
		try {
			if (isParked(watch.value)) return;
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("Timed out waiting for the tool to park")), 20_000);
				watch.start(async (call) => {
					if (call.kind === "value" && isParked(call.value)) {
						clearTimeout(timer);
						resolve();
					}
				});
			});
		} finally {
			await watch.stop();
		}
		// The slot shows the park in the commit that stores it; the invocation lets go just after.
		for (let attempt = 0; attempt < 200; attempt++) {
			const tasks = (await this.app.harness.inspect(context)).tasks;
			if (tasks.some((task) => task.record.conversationId === id && task.record.kind === "pi.tool" && task.state.kind === "sleeping")) return;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error("The tool never parked");
	}

	/** Wait until the session is idle with no run, after the supervisor has handled its end. */
	async settled(id: number, label = "the run to end", timeoutMs = 20_000): Promise<Readonly<SessionDoc>> {
		const doc = await this.until(id, (doc) => doc.setup.status !== "preparing" && doc.activeRun === undefined && doc.card === undefined, label, timeoutMs);
		await this.app.supervisor.idle();
		return (await this.session(id)) ?? doc;
	}

	async entries(id: number): Promise<EntryRecord[]> {
		const conversation = await this.app.harness.conversation(id as ConversationId, context);
		const page = await conversation!.entries({ order: "ascending" }, 10_000, undefined, context);
		return [...page.items];
	}

	workspace(id: number): string {
		return join(this.dataDir, "workspaces", String(id));
	}

	/** The session's own home, tmp and gh configuration live here. */
	scratch(id: number): string {
		return join(this.dataDir, "sandbox", String(id));
	}

	/**
	 * Run `lines` in a new session through the scripted model's [probe]: `$ command` with bash, `read PATH` with read,
	 * `write PATH` with write, in order. Resolves with each call's result.
	 */
	async probe(lines: readonly string[]): Promise<{ id: number; results: { text: string; isError: boolean }[] }> {
		const id = await this.createSession(["Probe the machine [probe]", ...lines].join("\n"));
		await this.settled(id, "the probe");
		const results = (await this.entries(id)).flatMap((entry) => {
			const message = entry.model?.[0];
			return message?.role === "toolResult" && message.toolCallId.startsWith("probe:") ? [{ text: modelText(entry), isError: message.isError }] : [];
		});
		if (results.length !== lines.length) throw new Error(`The probe ran ${results.length} of ${lines.length} calls`);
		return { id, results };
	}

	/** Answer the scenario's question card with the recommended options, then approve its plan. */
	async approveThrough(id: number): Promise<void> {
		const questions = await this.until(id, (doc) => doc.card?.kind === "questions", "the question card");
		const card = questions.card!;
		if (card.kind !== "questions") throw new Error("expected questions");
		await this.answer(id, card.id, {
			kind: "questions",
			answers: card.questions.map((question) => ({ questionId: question.id, selected: [question.recommended ?? question.options[0]!.id] })),
		});
		const plan = await this.until(id, (doc) => doc.card?.kind === "plan", "the plan card");
		await this.answer(id, plan.card!.id, { kind: "approve" });
	}
}

/** A repository session's document; fails the test for anything else. */
export function repoDoc(doc: Readonly<SessionDoc> | undefined): Readonly<RepoSessionDoc> {
	if (doc?.place !== "repo") throw new Error(`Expected a repository session: ${JSON.stringify(doc).slice(0, 300)}`);
	return doc;
}

/** The text a user entry gave the model. */
export function modelText(entry: EntryRecord): string {
	const message = entry.model?.[0];
	if (message === undefined || message.role === "system") return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** The text of every compaction in the transcript: picloud's checkpoint markers and Durable's summaries. */
export function checkpoints(entries: readonly EntryRecord[]): string[] {
	return entries.filter((entry) => entry.kind === "pi.compaction" || entry.kind === CHECKPOINT_ENTRY).map(modelText);
}
