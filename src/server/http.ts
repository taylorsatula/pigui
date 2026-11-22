// The HTTP boundary: every request is checked here (access, size, shape) before it reaches the session logic, and
// every failure leaves as JSON the phone can show with a next step.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { type ConversationId, type EntryId, type Harness } from "@earendil-works/pi-durable";
import { compile } from "@earendil-works/pi-schema";
import {
	AnswerCardBody,
	ArchiveBody,
	type ApiError,
	type Bootstrap,
	type MemoryStatus,
	BudgetBody,
	CreateSessionBody,
	DeliverBody,
	PushSubscriptionBody,
	type ScriptLine,
	SendMessageBody,
	type SkillSummary,
	SpeechBody,
	SpeechScriptBody,
} from "../shared/api.ts";
import { skillsAt } from "./agent/resources.ts";
import { PushSubscriptionsToken, SessionDocToken, SessionIndexToken } from "./docs.ts";
import type { Delivery } from "./delivery.ts";
import { HttpError, notFound } from "./errors.ts";
import { trackedFiles } from "./git.ts";
import type { RepoHost } from "./host.ts";
import { MAX_UPLOAD_BYTES, type Uploads } from "./input.ts";
import { openLines, serveLive } from "./live.ts";
import { errorKind, type Logger } from "./log.ts";
import type { Presence } from "./presence.ts";
import type { Sessions } from "./sessions.ts";
import type { Speech } from "./speech/speech.ts";
import { validPushKeys } from "./webpush.ts";

export type HttpDeps = {
	harness: () => Harness;
	sessions: Sessions;
	delivery: Delivery;
	host: RepoHost;
	uploads: Uploads;
	presence: Presence;
	log: Logger;
	now: () => number;
	fake: boolean;
	vapidPublicKey: string;
	allowedLogins: readonly string[];
	agentDir: string;
	workspace: (id: number) => string;
	staticDir: string;
	/** Undefined when this server does not read aloud. */
	speech: Speech | undefined;
	/** Long-term memory's state, shown in the sidebar while it is off. */
	memory: MemoryStatus;
	/** Real mode: refuses connections opened by picloud's own user, as the agent's commands are (see callers.ts). */
	callerCheck?: (socket: Socket) => Promise<boolean>;
};

const MAX_JSON_BYTES = 1024 * 1024;

type Validator<T> = { check(value: unknown): value is T; errors(value: unknown): readonly { path: string; message: string }[] };

function validator<T>(schema: object): Validator<T> {
	return compile(schema) as unknown as Validator<T>;
}

const bodies = {
	create: validator<CreateSessionBody>(CreateSessionBody),
	send: validator<SendMessageBody>(SendMessageBody),
	answer: validator<AnswerCardBody>(AnswerCardBody),
	deliver: validator<DeliverBody>(DeliverBody),
	budget: validator<BudgetBody>(BudgetBody),
	archive: validator<ArchiveBody>(ArchiveBody),
	push: validator<PushSubscriptionBody>(PushSubscriptionBody),
	script: validator<SpeechScriptBody>(SpeechScriptBody),
	speech: validator<SpeechBody>(SpeechBody),
};

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		size += (chunk as Buffer).length;
		if (size > limit) throw new HttpError(413, `The request is larger than ${Math.round(limit / 1024 / 1024)} MB.`);
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks);
}

async function json<T>(request: IncomingMessage, check: Validator<T>): Promise<T> {
	let value: unknown;
	try {
		value = JSON.parse((await readBody(request, MAX_JSON_BYTES)).toString("utf8"));
	} catch (error) {
		if (error instanceof HttpError) throw error;
		throw new HttpError(400, "The request body is not JSON.");
	}
	if (!check.check(value)) {
		const [first] = check.errors(value);
		throw new HttpError(400, `Invalid request${first === undefined ? "" : `: ${first.path || "body"} ${first.message}`}.`);
	}
	return value;
}

function send(response: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body ?? {});
	response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
	response.end(text);
}

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".webmanifest": "application/manifest+json",
	".png": "image/png",
	".woff2": "font/woff2",
	".txt": "text/plain; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json",
	".map": "application/json",
};

function sessionId(raw: string | undefined): number {
	const id = Number(raw);
	if (!Number.isInteger(id) || id <= 0) throw notFound("The session");
	return id;
}

/** Aborted when the phone goes away before the response is finished, so the work for it stops. */
function abortOnClose(response: ServerResponse): AbortSignal {
	const controller = new AbortController();
	response.once("close", () => {
		if (!response.writableFinished) controller.abort();
	});
	return controller.signal;
}

function repoName(owner: string | undefined, name: string | undefined): string {
	const repo = `${owner ?? ""}/${name ?? ""}`;
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw notFound("The repository");
	return repo;
}

export function createHttpServer(deps: HttpDeps): Server {
	const context = BACKGROUND_CONTEXT;

	async function staticFile(path: string, response: ServerResponse): Promise<void> {
		const relative = normalize(path === "/" ? "/index.html" : path).replace(/^([/\\])+/, "");
		const file = join(deps.staticDir, relative);
		if (!file.startsWith(deps.staticDir + sep)) throw notFound("The file");
		const info = await stat(file).catch(() => undefined);
		if (info === undefined || !info.isFile()) {
			// The app routes in the fragment, so any other path is the app shell.
			if (extname(relative) === "") return staticFile("/index.html", response);
			throw notFound("The file");
		}
		response.writeHead(200, {
			"Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
			"Cache-Control": "no-cache",
			"X-Content-Type-Options": "nosniff",
			...(extname(file) === ".html"
				? { "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" }
				: {}),
		});
		response.end(await readFile(file));
	}

	async function projectSkills(repo: string, ref: string): Promise<SkillSummary[]> {
		const { files } = await deps.host.files(repo, ref);
		const found: SkillSummary[] = [];
		for (const path of files) {
			const match = path.match(/^\.pi\/skills\/(?:([^/]+)\/SKILL\.md|([^/]+)\.md)$/);
			if (match === null) continue;
			const text = (await deps.host.readFile(repo, ref, path)) ?? "";
			const { frontmatter } = parseFrontmatter<{ name?: string; description?: string }>(text);
			found.push({ name: frontmatter.name ?? match[1] ?? match[2] ?? path, description: frontmatter.description ?? "" });
		}
		return found;
	}

	function speech(): Speech {
		if (deps.speech === undefined) {
			throw new HttpError(404, "Reading aloud is not available on this server.", "picloud was built without speech (PICLOUD_SPEECH=off), or its model is missing.");
		}
		return deps.speech;
	}

	function globalSkills(): SkillSummary[] {
		// A directory with no project of its own, so only the global skills in Pi's configuration are found.
		return skillsAt(join(deps.agentDir, "skills"), deps.agentDir).map(({ name, description }) => ({ name, description }));
	}

	async function route(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
		const method = request.method ?? "GET";
		const parts = url.pathname.split("/").filter((part) => part !== "").map(decodeURIComponent);
		if (parts[0] !== "api") {
			if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "Only GET is allowed here.");
			return staticFile(url.pathname, response);
		}
		const [, area, a, b, c] = parts;
		const harness = deps.harness();
		const is = (expected: string, ...path: (string | undefined)[]) => method === expected && path.every((part, index) => part === undefined || part === [area, a, b, c][index]);

		if (is("GET", "bootstrap") && parts.length === 2) {
			const index = await harness.snapshot(SessionIndexToken, context);
			const body: Bootstrap = { fake: deps.fake, vapidPublicKey: deps.vapidPublicKey, speech: deps.speech !== undefined, memory: deps.memory };
			if (index?.lastRepo !== undefined) body.lastRepo = index.lastRepo;
			return send(response, 200, body);
		}
		if (is("GET", "live") && parts.length === 2) {
			const session = url.searchParams.get("session");
			const from = url.searchParams.get("from");
			const live: { session?: number; from?: number } = {};
			if (session !== null) live.session = sessionId(session);
			if (from !== null && /^\d+$/.test(from)) live.from = Number(from);
			return serveLive(response, live, harness, deps.presence, context);
		}
		if (is("POST", "push", "subscribe") && parts.length === 3) {
			const body = await json(request, bodies.push);
			if (!validPushKeys(body.keys)) throw new HttpError(400, "The push subscription's keys are not valid.");
			await harness.commit(async (tx) => {
				const doc = await tx.doc(PushSubscriptionsToken);
				doc.subscriptions = doc.subscriptions.filter((existing) => existing.endpoint !== body.endpoint);
				doc.subscriptions.push({ endpoint: body.endpoint, keys: { p256dh: body.keys.p256dh, auth: body.keys.auth }, createdAt: deps.now() });
			}, context);
			return send(response, 200, {});
		}
		if (is("POST", "speech") && parts.length === 2) {
			const reader = speech();
			const { text } = await json(request, bodies.speech);
			const signal = abortOnClose(response);
			let wav: Uint8Array;
			try {
				wav = await reader.audio(text, signal);
			} catch (error) {
				// The phone stopped listening; there is no one to answer.
				if (signal.aborted) return;
				throw error;
			}
			response.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": wav.length, "Cache-Control": "no-store" });
			response.end(wav);
			return;
		}
		if (is("POST", "uploads") && parts.length === 2) {
			const bytes = await readBody(request, MAX_UPLOAD_BYTES);
			if (bytes.length === 0) throw new HttpError(400, "The upload is empty.");
			const name = decodeURIComponent(String(request.headers["x-filename"] ?? "attachment"));
			const type = String(request.headers["content-type"] ?? "application/octet-stream").split(";")[0]?.trim() ?? "application/octet-stream";
			return send(response, 200, await deps.uploads.save(bytes, name, type));
		}
		if (area === "repos") {
			if (is("GET", "repos") && parts.length === 2) return send(response, 200, await deps.host.listRepos());
			const repo = repoName(a, b);
			const ref = url.searchParams.get("ref") ?? "";
			if (is("GET", "repos", a, b, "branches")) return send(response, 200, await deps.host.branches(repo));
			if (ref === "") throw new HttpError(400, "Say which branch with ?ref=.");
			if (is("GET", "repos", a, b, "files")) return send(response, 200, await deps.host.files(repo, ref));
			if (is("GET", "repos", a, b, "skills")) return send(response, 200, [...globalSkills(), ...(await projectSkills(repo, ref))]);
		}
		if (area === "sessions") {
			if (is("POST", "sessions") && parts.length === 2) {
				const body = await json(request, bodies.create);
				return send(response, 200, { id: await deps.sessions.create(body, context) });
			}
			const id = sessionId(a);
			const action = b;
			if (method === "GET") {
				const doc = await harness.snapshot(SessionDocToken, id as ConversationId, context);
				if (doc?.id === undefined) throw notFound("The session");
				const workspace = deps.workspace(id);
				if (action === "files") {
					if (doc.setup.status !== "ready") return send(response, 200, await deps.host.files(doc.repo, doc.start.kind === "new" ? doc.start.base : doc.start.branch));
					const files = await trackedFiles(workspace);
					return send(response, 200, { files, truncated: false });
				}
				if (action === "skills") {
					if (doc.setup.status !== "ready") return send(response, 200, globalSkills());
					return send(response, 200, skillsAt(workspace, deps.agentDir).map(({ name, description }) => ({ name, description })));
				}
				if (action === "diff") return send(response, 200, await deps.delivery.diff(id, context));
				if (action === "entries") {
					const conversation = await harness.conversation(id as ConversationId, context);
					if (conversation === undefined) throw notFound("The session");
					const min = url.searchParams.get("min");
					const max = url.searchParams.get("max");
					const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
					const order = url.searchParams.get("order") === "ascending" ? "ascending" : "descending";
					const query: { minEntryId?: EntryId; maxEntryId?: EntryId; order: "ascending" | "descending" } = { order };
					if (min !== null) query.minEntryId = Number(min) as EntryId;
					if (max !== null) query.maxEntryId = Number(max) as EntryId;
					return send(response, 200, await conversation.entries(query, limit, undefined, context));
				}
			}
			if (method === "POST") {
				switch (action) {
					case "speech-script": {
						const reader = speech();
						const { text } = await json(request, bodies.script);
						const model = await reader.modelOf(id, context);
						await reader.script(id, model, text, openLines<ScriptLine>(response), abortOnClose(response), context);
						response.end();
						return;
					}
					case "messages":
						return send(response, 200, { route: await deps.sessions.send(id, await json(request, bodies.send), context) });
					case "answer":
						await deps.sessions.answer(id, await json(request, bodies.answer), context);
						return send(response, 200, {});
					case "stop":
						await deps.sessions.stop(id, context);
						return send(response, 200, {});
					case "continue":
						await deps.sessions.continue(id, context);
						return send(response, 200, {});
					case "budget":
						await deps.sessions.raiseBudget(id, (await json(request, bodies.budget)).cap, context);
						return send(response, 200, {});
					case "deliver":
						return send(response, 200, await deps.delivery.deliver(id, (await json(request, bodies.deliver)).action, context));
					case "archive":
						await deps.sessions.archive(id, (await json(request, bodies.archive)).archived, context);
						return send(response, 200, {});
					case "seen":
						await deps.sessions.seen(id, context);
						return send(response, 200, {});
					case "retry-setup":
						await deps.sessions.retrySetup(id, context);
						return send(response, 200, {});
				}
			}
		}
		throw notFound("That address");
	}

	function handle(request: IncomingMessage, response: ServerResponse, url: URL, done: (status: number) => void): void {
		route(request, response, url)
			.then(() => done(response.statusCode))
			.catch((error: unknown) => {
				const known = error instanceof HttpError;
				const status = known ? error.status : 500;
				if (!known) deps.log.error("http.failed", { method: request.method, path: url.pathname, error: errorKind(error) });
				const body: ApiError = known
					? error.hint === undefined
						? { error: error.message }
						: { error: error.message, hint: error.hint }
					: { error: error instanceof Error ? error.message : "Something went wrong.", hint: "Try again; if it keeps failing, check the server's journal." };
				if (response.headersSent) response.end();
				else send(response, status, body);
				done(status);
			});
	}

	return createServer((request, response) => {
		const started = Date.now();
		const url = new URL(request.url ?? "/", "http://picloud.local");
		const done = (status: number) => {
			// Paths and status only: no query strings, bodies or headers, which can carry content.
			if (!url.pathname.startsWith("/api/live")) deps.log.info("http", { method: request.method, path: url.pathname, status, ms: Date.now() - started });
		};
		const caller = deps.callerCheck === undefined ? Promise.resolve(true) : deps.callerCheck(request.socket);
		caller
			.then((allowed) => {
				if (allowed) return true;
				deps.log.warn("http.local_caller", { path: url.pathname });
				send(response, 403, { error: "This connection comes from picloud's own user, as the agent's commands do. picloud is reached through Tailscale." } satisfies ApiError);
				return false;
			})
			.then((allowed) => {
				if (!allowed) return;
				const login = String(request.headers["tailscale-user-login"] ?? "").toLowerCase();
				if (deps.allowedLogins.length > 0 && !deps.allowedLogins.includes(login)) {
					deps.log.warn("http.forbidden", { path: url.pathname });
					send(response, 403, { error: "This Tailscale login is not allowed to use picloud." } satisfies ApiError);
					return;
				}
				handle(request, response, url, done);
			});
	});
}
