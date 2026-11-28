// The HTTP boundary: every request is checked here (access, size, shape) before it reaches the session logic, and
// every failure leaves as JSON the phone can show with a next step. Access is checked in layers: in OnPrem the host
// the request names, then who opened the connection, then the Tailscale login of what came through Tailscale, and for
// anything that changes something, that the request comes from pigui's own page.
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
	PinBody,
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
	StarDirBody,
	StarRepoBody,
} from "../shared/api.ts";
import type { SessionDoc } from "../shared/session.ts";
import { skillsAt } from "./agent/resources.ts";
import { PushSubscriptionsToken, SessionDocToken, SessionIndexToken } from "./documents.ts";
import type { OnPrem } from "./config.ts";
import type { Delivery } from "./delivery.ts";
import { HttpError, notFound } from "./errors.ts";
import { trackedFiles } from "./git.ts";
import type { RepoHost } from "./host.ts";
import { MAX_UPLOAD_BYTES, type Uploads } from "./input.ts";
import { absolutePath, listDirectory, localDirectory } from "./local.ts";
import { renderServiceWorker } from "./assets.ts";
import { createUiRouter } from "./ui/routes.ts";
import { errorKind, type Logger } from "./log.ts";
import type { Presence } from "./presence.ts";
import type { Sessions } from "./sessions.ts";
import type { Speech } from "./speech/speech.ts";
import { agentSession } from "./subagents/extension.ts";
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
	/** Where a session's agent works (see AgentServices). */
	workingDir: (doc: Readonly<SessionDoc>) => string;
	/** pigui OnPrem: reached at this computer's loopback names and its allowed tailnet names, with local sessions. */
	onPrem: OnPrem | undefined;
	/** Where committed zero-build static assets (css, js, manifest, sw.js) live. */
	publicDir: string;
	/** Where build/startup-generated assets (fonts, icons) live. */
	assetsDir: string;
	/** Undefined when this server does not read aloud. */
	speech: Speech | undefined;
	/** Long-term memory's state, shown in the sidebar while it is off. */
	memory: MemoryStatus;
	/**
	 * Who may open a connection (see callers.ts): on a server, anyone but pigui's own user, as the agent's commands
	 * are; in OnPrem on Linux, pigui's own user only. Absent: no check, as in fake mode and OnPrem elsewhere.
	 */
	callerCheck?: (socket: Socket) => Promise<boolean>;
};

const MAX_JSON_BYTES = 1024 * 1024;

type Validator<T> = { check(value: unknown): value is T; errors(value: unknown): readonly { path: string; message: string }[] };

function validator<T>(schema: object): Validator<T> {
	return compile(schema) as unknown as Validator<T>;
}

/** Route matcher: `is("GET", "repos", a, b, "files")` is true for GET /api/repos/:a/:b/files. */
function matcher(method: string, parts: string[]) {
	const [, area, a, b, c] = parts;
	return (expected: string, ...path: (string | undefined)[]) =>
		method === expected && path.every((part, index) => part === undefined || part === [area, a, b, c][index]);
}

const bodies = {
	create: validator<CreateSessionBody>(CreateSessionBody),
	send: validator<SendMessageBody>(SendMessageBody),
	answer: validator<AnswerCardBody>(AnswerCardBody),
	deliver: validator<DeliverBody>(DeliverBody),
	budget: validator<BudgetBody>(BudgetBody),
	archive: validator<ArchiveBody>(ArchiveBody),
	pin: validator<PinBody>(PinBody),
	star: validator<StarDirBody>(StarDirBody),
	starRepo: validator<StarRepoBody>(StarRepoBody),
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

function openLines<T>(response: ServerResponse): (message: T) => void {
	response.writeHead(200, {
		"Content-Type": "application/x-ndjson; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Accel-Buffering": "no",
	});
	return (message) => {
		if (!response.writableEnded && !response.destroyed) response.write(`${JSON.stringify(message)}\n`);
	};
}

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".webmanifest": "application/manifest+json",
	".png": "image/png",
	".gif": "image/gif",
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

/** An agent of the session `session`, as the phone names it; any other conversation is not found. */
async function agentOf(harness: Harness, session: number, raw: string | null | undefined): Promise<number> {
	const id = Number(raw);
	const known = Number.isInteger(id) && id > 0 && (await agentSession(harness, id as ConversationId, BACKGROUND_CONTEXT)) === session;
	if (!known) throw notFound("The agent");
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

/**
 * How an OnPrem request names pigui: one of its loopback names at its own port (`local`, the computer's own browser),
 * one of the names it is served under by `tailscale serve` (`tailnet`), or neither. A page elsewhere whose name was
 * pointed at 127.0.0.1 (DNS rebinding) would otherwise be same-origin with pigui as far as the browser knew, and
 * could read and drive it; the allowed names are ones no one else's DNS can point at this computer.
 */
function addressedAs(request: IncomingMessage, hosts: readonly string[]): "local" | "tailnet" | undefined {
	const port = request.socket.localPort;
	const host = (request.headers.host ?? "").toLowerCase();
	const names = ["localhost", "127.0.0.1", "[::1]"];
	const local = names.map((name) => `${name}:${port}`);
	if (port === 80) local.push(...names);
	if (local.includes(host)) return "local";
	// tailscale serve passes the name the phone asked for, which carries no port on 443.
	const name = host.startsWith("[") ? host : host.replace(/:\d+$/, "");
	return hosts.includes(name) ? "tailnet" : undefined;
}

/**
 * Whether a request that changes something comes from pigui's own page. Every browser request says where it comes
 * from, in Sec-Fetch-Site and, on a POST, in Origin. Both are checked, because a page on any other site can send a
 * simple POST (text/plain, no preflight) that would otherwise be acted on: on a server that is any page the phone
 * opens; in OnPrem, commands on the person's computer. A request with neither header comes from a program, not from a
 * page; the caller and login checks still apply to it.
 */
function fromOwnPage(request: IncomingMessage): boolean {
	const site = request.headers["sec-fetch-site"];
	if (site !== undefined && site !== "same-origin") return false;
	const origin = request.headers.origin;
	if (origin === undefined) return true;
	let host: string;
	try {
		host = new URL(origin).host;
	} catch {
		// "null", from a sandboxed frame or a file: page.
		return false;
	}
	// The host the browser asked for. tailscale serve passes it on as Host, and as X-Forwarded-Host should a proxy
	// rewrite Host; a cross-site page cannot set either header without a preflight, which pigui never allows.
	const asked = [request.headers.host, request.headers["x-forwarded-host"]].map((value) => String(value ?? "").toLowerCase());
	return asked.includes(host);
}

function repoName(owner: string | undefined, name: string | undefined): string {
	const repo = `${owner ?? ""}/${name ?? ""}`;
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw notFound("The repository");
	return repo;
}

export function createHttpServer(deps: HttpDeps): Server {
	const context = BACKGROUND_CONTEXT;
	const ui = createUiRouter({
		harness: deps.harness,
		sessions: deps.sessions,
		delivery: deps.delivery,
		host: deps.host,
		presence: deps.presence,
		now: deps.now,
		vapidPublicKey: deps.vapidPublicKey,
		onPrem: deps.onPrem,
		speech: deps.speech !== undefined,
		memory: deps.memory,
	});

	async function serveStaticFrom(rootDir: string, relative: string, response: ServerResponse): Promise<boolean> {
		const file = join(rootDir, relative);
		if (!file.startsWith(rootDir + sep)) return false;
		const info = await stat(file).catch(() => undefined);
		if (info === undefined || !info.isFile()) return false;
		response.writeHead(200, {
			"Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
			"Cache-Control": "no-cache",
			"X-Content-Type-Options": "nosniff",
		});
		response.end(await readFile(file));
		return true;
	}

	async function staticFile(path: string, response: ServerResponse): Promise<void> {
		const relative = normalize(path).replace(/^([/\\])+/, "");
		if (relative === "sw.js") {
			const script = await renderServiceWorker(deps.publicDir, deps.assetsDir);
			response.writeHead(200, {
				"Content-Type": "text/javascript; charset=utf-8",
				"Cache-Control": "no-cache",
				"X-Content-Type-Options": "nosniff",
			});
			response.end(script);
			return;
		}
		if (await serveStaticFrom(deps.publicDir, relative, response)) return;
		if (await serveStaticFrom(deps.assetsDir, relative, response)) return;
		throw notFound("The file");
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
			throw new HttpError(404, "Reading aloud is not available on this server.", "pigui was built without speech (PIGUI_SPEECH=off), or its model is missing.");
		}
		return deps.speech;
	}

	function globalSkills(): SkillSummary[] {
		// A directory with no project of its own, so only the global skills in Pi's configuration are found.
		return skillsAt(join(deps.agentDir, "skills"), deps.agentDir).map(({ name, description }) => ({ name, description }));
	}

	/** Pi's skills as an agent working in `dir` finds them: its project's and the global ones. */
	function skillsIn(dir: string): SkillSummary[] {
		return skillsAt(dir, deps.agentDir).map(({ name, description }) => ({ name, description }));
	}

	function home(): string {
		if (deps.onPrem === undefined) throw new HttpError(404, "Directories on this computer are offered only by pigui OnPrem.");
		return deps.onPrem.home;
	}

	async function route(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
		const method = request.method ?? "GET";
		const parts = url.pathname.split("/").filter((part) => part !== "").map(decodeURIComponent);
		if (parts[0] !== "api") {
			if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "Only GET is allowed here.");
			if (parts[0] === "ui") {
				if (await ui.handleFragment(url, response, context)) return;
				throw notFound("That address");
			}
			if (url.pathname === "/sw.js" || extname(url.pathname) !== "") {
				return staticFile(url.pathname, response);
			}
			if (await ui.handlePage(url, response, context)) return;
			throw notFound("That page");
		}
		const [, area] = parts;
		const harness = deps.harness();
		const is = matcher(method, parts);

		if (is("GET", "bootstrap") && parts.length === 2) {
			const index = await harness.snapshot(SessionIndexToken, context);
			const body: Bootstrap = { fake: deps.fake, vapidPublicKey: deps.vapidPublicKey, speech: deps.speech !== undefined, memory: deps.memory };
			if (index?.lastRepo !== undefined) body.lastRepo = index.lastRepo;
			if (deps.onPrem !== undefined) body.onPrem = { home: deps.onPrem.home };
			return send(response, 200, body);
		}
		if (is("GET", "events") && parts.length === 2) {
			return ui.handleEvents(url, response, context);
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
		if (is("POST", "local", "starred") && parts.length === 3) {
			const at = home();
			const body = await json(request, bodies.star);
			// Starring checks the directory is one; unstarring does not, so a directory since removed can still go.
			const dir = body.starred ? await localDirectory(body.dir, at) : absolutePath(body.dir, at);
			await harness.commit(async (tx) => {
				const index = await tx.doc(SessionIndexToken);
				const starred = index.starred ?? [];
				if (starred.includes(dir) === body.starred) return;
				index.starred = body.starred ? [...starred, dir] : starred.filter((path) => path !== dir);
			}, context);
			return send(response, 200, { ok: true, dir, starred: body.starred });
		}
		if (is("POST", "repos", "starred") && parts.length === 3) {
			const body = await json(request, bodies.starRepo);
			// The name is pattern-validated only: starring does not reach gh, so unstarring works when the repository host does not.
			await harness.commit(async (tx) => {
				const index = await tx.doc(SessionIndexToken);
				const starred = index.starredRepos ?? [];
				if (starred.includes(body.repo) === body.starred) return;
				index.starredRepos = body.starred ? [...starred, body.repo] : starred.filter((name) => name !== body.repo);
			}, context);
			return send(response, 200, { ok: true, repo: body.repo, starred: body.starred });
		}
		if (area === "local") return localRoutes(request, response, url, parts);
		if (area === "repos") return reposRoutes(request, response, url, parts);
		if (area === "sessions") return sessionsRoutes(request, response, url, parts, harness);
		throw notFound("That address");
	}

	async function localRoutes(request: IncomingMessage, response: ServerResponse, url: URL, parts: string[]): Promise<void> {
		const method = request.method ?? "GET";
		const [, , a] = parts;
		// What a local session's first message can refer to, before the session exists: the chosen directory's files and skills.
		if (method === "GET" && parts.length === 3) {
			const dir = await localDirectory(url.searchParams.get("dir") ?? "~", home());
			if (a === "files") return send(response, 200, await listDirectory(dir));
			if (a === "skills") return send(response, 200, skillsIn(dir));
		}
		throw notFound("That address");
	}

	async function reposRoutes(request: IncomingMessage, response: ServerResponse, url: URL, parts: string[]): Promise<void> {
		const method = request.method ?? "GET";
		const [, , a, b] = parts;
		const is = matcher(method, parts);
		if (is("GET", "repos") && parts.length === 2) return send(response, 200, await deps.host.listRepos());
		const repo = repoName(a, b);
		const ref = url.searchParams.get("ref") ?? "";
		if (is("GET", "repos", a, b, "branches")) return send(response, 200, await deps.host.branches(repo));
		if (ref === "") throw new HttpError(400, "Say which branch with ?ref=.");
		if (is("GET", "repos", a, b, "files")) return send(response, 200, await deps.host.files(repo, ref));
		if (is("GET", "repos", a, b, "skills")) return send(response, 200, [...globalSkills(), ...(await projectSkills(repo, ref))]);
		throw notFound("That address");
	}

	async function sessionsRoutes(request: IncomingMessage, response: ServerResponse, url: URL, parts: string[], harness: Harness): Promise<void> {
		const method = request.method ?? "GET";
		const [, , a, b, c] = parts;
		const is = matcher(method, parts);
		if (is("POST", "sessions") && parts.length === 2) {
			const body = await json(request, bodies.create);
			return send(response, 200, { id: await deps.sessions.create(body, context) });
		}
		const id = sessionId(a);
		const action = b;
		if (method === "GET") {
			const doc = await harness.snapshot(SessionDocToken, id as ConversationId, context);
			if (doc?.id === undefined) throw notFound("The session");
			const dir = deps.workingDir(doc);
			if (action === "files") {
				// A local session's directory is there from the start; a clone only once setup made it.
				if (doc.place === "local") return send(response, 200, await listDirectory(dir));
				if (doc.setup.status !== "ready") return send(response, 200, await deps.host.files(doc.repo, doc.start.kind === "new" ? doc.start.base : doc.start.branch));
				return send(response, 200, { files: await trackedFiles(dir), truncated: false });
			}
			if (action === "skills") {
				if (doc.place === "repo" && doc.setup.status !== "ready") return send(response, 200, globalSkills());
				return send(response, 200, skillsIn(dir));
			}
			if (action === "diff") return send(response, 200, await deps.delivery.diff(id, context));
			if (action === "entries") {
				// An agent's conversation, for its viewer, or the session's own.
				const agent = url.searchParams.get("agent");
				const shown = agent === null ? id : await agentOf(harness, id, agent);
				const conversation = await harness.conversation(shown as ConversationId, context);
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
					const { text, kind } = await json(request, bodies.script);
					const model = await reader.modelOf(id, context);
					await reader.script(id, model, text, kind ?? "reply", openLines<ScriptLine>(response), abortOnClose(response), context);
					response.end();
					return;
				}
				case "messages":
					return send(response, 200, { route: await deps.sessions.send(id, await json(request, bodies.send), context) });
				case "answer":
					await deps.sessions.answer(id, await json(request, bodies.answer), context);
					return send(response, 200, { ok: true });
				case "stop":
					await deps.sessions.stop(id, context);
					return send(response, 200, { ok: true });
				case "continue":
					await deps.sessions.continue(id, context);
					return send(response, 200, { ok: true });
				case "budget": {
					const { cap } = await json(request, bodies.budget);
					await deps.sessions.raiseBudget(id, cap, context);
					return send(response, 200, { ok: true, cap });
				}
				case "deliver":
					return send(response, 200, await deps.delivery.deliver(id, (await json(request, bodies.deliver)).action, context));
				case "archive": {
					const { archived } = await json(request, bodies.archive);
					await deps.sessions.archive(id, archived, context);
					return send(response, 200, { ok: true, archived });
				}
				case "pin": {
					const { pinned } = await json(request, bodies.pin);
					await deps.sessions.pin(id, pinned, context);
					return send(response, 200, { ok: true, pinned });
				}
				case "seen":
					await deps.sessions.seen(id, context);
					return send(response, 200, { ok: true });
				case "retry-setup":
					await deps.sessions.retrySetup(id, context);
					return send(response, 200, { ok: true });
				case "queued":
					if (parts.length === 6 && parts[5] === "cancel") {
						const submission = Number(c);
						if (!Number.isSafeInteger(submission) || submission <= 0) throw new HttpError(400, "Which message do you want to cancel?");
						return send(response, 200, await deps.sessions.cancelQueued(id, submission, context));
					}
					break;
				case "agents":
					if (parts.length === 6 && parts[5] === "stop") {
						await deps.sessions.stopAgent(id, await agentOf(harness, id, c), context);
						return send(response, 200, { ok: true });
					}
					break;
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

	const callerRefused: ApiError =
		deps.onPrem === undefined
			? { error: "This connection comes from pigui's own user, as the agent's commands do. pigui is reached through Tailscale." }
			: { error: "This connection comes from another user of this computer. pigui OnPrem answers only the user it runs as, and Tailscale." };

	return createServer((request, response) => {
		const started = Date.now();
		const url = new URL(request.url ?? "/", "http://pigui.local");
		const done = (status: number) => {
			// Paths and status only: no query strings, bodies or headers, which can carry content.
			if (!url.pathname.startsWith("/api/events")) deps.log.info("http", { method: request.method, path: url.pathname, status, ms: Date.now() - started });
		};
		const refuse = (event: string, body: ApiError) => {
			deps.log.warn(event, { path: url.pathname });
			send(response, 403, body);
		};
		const addressed = deps.onPrem === undefined ? undefined : addressedAs(request, deps.onPrem.hosts);
		if (deps.onPrem !== undefined && addressed === undefined) {
			const port = request.socket.localPort;
			const name = String(request.headers.host ?? "").replace(/:\d+$/, "");
			refuse("http.host", {
				error: `pigui OnPrem answers only to localhost and to the names in PIGUI_ALLOWED_HOSTS, and not to ${name || "a request without a host"}.`,
				hint: `Open http://localhost:${port} on this computer. To reach it as ${name || "another name"} through tailscale serve, add that name to PIGUI_ALLOWED_HOSTS (the installer's --tailscale on does).`,
			});
			return;
		}
		const caller = deps.callerCheck === undefined ? Promise.resolve(true) : deps.callerCheck(request.socket);
		void caller.then((allowed) => {
			if (!allowed) return refuse("http.local_caller", callerRefused);
			const login = String(request.headers["tailscale-user-login"] ?? "").toLowerCase();
			// On a server everything comes through Tailscale. In OnPrem, what comes through it is addressed to a tailnet
			// name, or carries the login header tailscale serve adds should it have named pigui by localhost; the
			// computer's own browser at localhost has no login, and needs none.
			const throughTailscale = deps.onPrem === undefined || addressed === "tailnet" || login !== "";
			if (throughTailscale && deps.allowedLogins.length > 0 && !deps.allowedLogins.includes(login)) {
				return refuse("http.forbidden", { error: "This Tailscale login is not allowed to use pigui." });
			}
			if (request.method !== "GET" && request.method !== "HEAD" && !fromOwnPage(request)) {
				return refuse("http.cross_site", { error: "This request comes from another site, so pigui refuses it.", hint: "Use pigui from its own page." });
			}
			handle(request, response, url, done);
		});
	});
}
