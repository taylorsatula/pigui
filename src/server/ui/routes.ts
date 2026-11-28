// HTTP router for server-rendered HTML pages, on-demand <dialog> & pagination fragments, and the granular SSE stream.
import type { ServerResponse } from "node:http";
import type { Context } from "@earendil-works/chord/context";
import {
	AgentDoc,
	type ConversationId,
	type EntryId,
	type Harness,
	LiveDoc,
	type LiveState,
	UsageDoc,
	type UsageState,
} from "@earendil-works/pi-durable";
import type { BranchList, MemoryStatus, RepoSummary } from "../../shared/api.ts";
import { type SessionDoc, type SessionIndex, type SessionRow } from "../../shared/session.ts";
import { sessionSpent } from "../../shared/spend.ts";
import type { OnPrem } from "../config.ts";
import type { Delivery } from "../delivery.ts";
import { SessionDocToken, SessionIndexToken } from "../documents.ts";
import { HttpError, notFound } from "../errors.ts";
import type { RepoHost } from "../host.ts";
import type { Presence } from "../presence.ts";
import type { Sessions } from "../sessions.ts";
import { agentSession } from "../subagents/extension.ts";
import { type AgentDocs } from "./format.ts";
import { type EventStreamRequest, loadTranscriptItems, serveEvents } from "./events.ts";
import { renderTranscriptRows } from "./render/blocks.ts";
import { renderPage } from "./render/frame.ts";
import {
	type PickerColumn,
	renderAgentPage,
	renderAgentsDialog,
	renderDiffDialog,
	renderBranchSheet,
	renderNewSessionPage,
	renderNotFoundPage,
	renderPickerDialog,
	renderPlaceSheet,
	renderSessionPage,
	renderStartTarget,
	type SessionBranch,
	type StartTarget,
} from "./render/pages.ts";
import { buildBlocks, sourceFromEntries } from "./transcript.ts";

export type UiDeps = {
	harness: () => Harness;
	sessions: Sessions;
	delivery: Delivery;
	host: RepoHost;
	presence: Presence;
	now: () => number;
	vapidPublicKey: string;
	onPrem: OnPrem | undefined;
	speech: boolean;
	memory: MemoryStatus;
};

const CSP = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'";

function sendHtml(response: ServerResponse, status: number, body: string, fullDocument: boolean): void {
	response.writeHead(status, {
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
		...(fullDocument ? { "Content-Security-Policy": CSP } : {}),
	});
	response.end(body);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
	response.end(JSON.stringify(body));
}

function parsePositiveInt(raw: string | undefined | null): number | undefined {
	if (raw === undefined || raw === null || !/^\d+$/.test(raw)) return undefined;
	const n = Number(raw);
	return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** The target a query names, as `startQuery` writes it; undefined when it names none, or one that is not valid. */
function parseStartTarget(url: URL, onPrem: boolean): StartTarget | undefined {
	const place = url.searchParams.get("place");
	if (place === "local") {
		if (!onPrem) return undefined;
		const dir = url.searchParams.get("dir")?.trim() || "~";
		return { place: "local", dir };
	}
	if (place === "repo") {
		const repo = url.searchParams.get("repo")?.trim() ?? "";
		if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return undefined;
		if (url.searchParams.get("mode") === "continue") {
			const branch = url.searchParams.get("branch")?.trim() ?? "";
			if (branch === "") return undefined;
			const from = parsePositiveInt(url.searchParams.get("from"));
			return from === undefined ? { place: "repo", repo, mode: "continue", branch } : { place: "repo", repo, mode: "continue", branch, from };
		}
		const base = url.searchParams.get("base")?.trim() ?? "";
		return base === "" ? { place: "repo", repo, mode: "new" } : { place: "repo", repo, mode: "new", base };
	}
	return undefined;
}

/**
 * Where a new session starts when the person has not said: where the newest session worked, on a new branch; else the
 * last repository; else, in OnPrem, this computer. Nothing on a fresh server, where the chip asks for a repository.
 */
function defaultStartTarget(index: SessionIndex | undefined, onPrem: boolean): StartTarget | undefined {
	const newest = Object.values(index?.rows ?? {})
		.filter((row) => !row.archived && (row.place === "repo" || onPrem))
		.sort((a, b) => b.updatedAt - a.updatedAt)[0];
	if (newest?.place === "local") return { place: "local", dir: newest.dir };
	const repo = newest?.place === "repo" ? newest.repo : index?.lastRepo;
	if (repo !== undefined) return { place: "repo", repo, mode: "new" };
	return onPrem ? { place: "local", dir: "~" } : undefined;
}

/** The branches sessions have worked on in `repo`, newest first, one per branch, from sessions that are not put away. */
function sessionBranchesOf(index: SessionIndex | undefined, repo: string): Array<{ branch: string; session: SessionRow }> {
	const newest = new Map<string, SessionRow & { place: "repo" }>();
	for (const row of Object.values(index?.rows ?? {})) {
		if (row.place !== "repo" || row.repo !== repo || row.archived) continue;
		const seen = newest.get(row.branch);
		if (seen === undefined || row.updatedAt > seen.updatedAt) newest.set(row.branch, row);
	}
	return [...newest.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((session) => ({ branch: session.branch, session }));
}

async function readAgentDocs(harness: Harness, doc: SessionDoc, context: Context): Promise<Record<number, Partial<AgentDocs>>> {
	const out: Record<number, Partial<AgentDocs>> = {};
	for (const row of doc.agents ?? []) {
		const [live, usage, agent] = await Promise.all([
			harness.snapshot(LiveDoc, row.id as ConversationId, context),
			harness.snapshot(UsageDoc, row.id as ConversationId, context),
			harness.snapshot(AgentDoc, row.id as ConversationId, context),
		]);
		const entry: Partial<AgentDocs> = {};
		if (live !== undefined) entry["pi.live"] = live;
		if (usage !== undefined) entry["pi.usage"] = usage;
		if (agent !== undefined) entry["pi.agent"] = agent;
		out[row.id] = entry;
	}
	return out;
}

export function createUiRouter(deps: UiDeps) {
	const frameBase = () => ({
		vapidPublicKey: deps.vapidPublicKey,
		speech: deps.speech,
		onPrem: deps.onPrem !== undefined,
		...(deps.onPrem !== undefined ? { home: deps.onPrem.home } : {}),
	});

	async function handlePage(url: URL, response: ServerResponse, context: Context): Promise<boolean> {
		const parts = url.pathname.split("/").filter((part) => part !== "").map(decodeURIComponent);
		const harness = deps.harness();
		const index = await harness.snapshot(SessionIndexToken, context);

		// GET /?place=... -> New session, at the target the query names or the default one
		if (parts.length === 0) {
			const target = parseStartTarget(url, deps.onPrem !== undefined);
			if (target === undefined && url.searchParams.has("place")) {
				response.writeHead(302, { Location: "/" });
				response.end();
				return true;
			}
			const body = renderNewSessionPage({
				index,
				target: target ?? defaultStartTarget(index, deps.onPrem !== undefined),
				...(deps.onPrem !== undefined ? { home: deps.onPrem.home } : {}),
			});
			sendHtml(response, 200, renderPage({ ...frameBase(), title: "New session · pigui", page: "new", body }), true);
			return true;
		}

		// GET /start?... -> the New session page, which took over the blank start screen; kept for old links
		if (parts.length === 1 && parts[0] === "start") {
			response.writeHead(302, { Location: `/${url.search}` });
			response.end();
			return true;
		}

		// GET /s/:id -> Session view
		if (parts.length === 2 && parts[0] === "s") {
			const id = parsePositiveInt(parts[1]);
			const doc = id === undefined ? undefined : await harness.snapshot(SessionDocToken, id as ConversationId, context);
			const conversation = id === undefined ? undefined : await harness.conversation(id as ConversationId, context);
			if (id === undefined || doc?.id === undefined || conversation === undefined) {
				const body = renderNotFoundPage(index, "This session does not exist.");
				sendHtml(response, 404, renderPage({ ...frameBase(), title: "Not found · pigui", page: "not-found", body }), true);
				return true;
			}
			void deps.sessions.seen(id, context).catch(() => undefined);
			const watch = await conversation.watch(context);
			const view = watch.value;
			await watch.stop();
			const liveState = view.docs["pi.live"] as LiveState | undefined;
			const running = liveState?.run !== undefined || doc.activeRun !== undefined;
			const agentDocs = await readAgentDocs(harness, doc, context);
			const spent = sessionSpent(
				view.docs["pi.usage"] as UsageState | undefined,
				(doc.agents ?? []).map((agent) => agentDocs[agent.id]?.["pi.usage"]),
			);
			const items = await loadTranscriptItems(conversation, view, doc, running, context);
			const blocks = buildBlocks({ items, docs: view.docs }, doc, running);
			const body = renderSessionPage({ doc, index, blocks, spent, running, speech: deps.speech, home: deps.onPrem?.home });
			sendHtml(
				response,
				200,
				renderPage({
					...frameBase(),
					title: `${doc.title} · pigui`,
					page: "session",
					body,
					sessionId: doc.id,
					running,
					workflow: doc.workflow,
				}),
				true,
			);
			return true;
		}

		// GET /s/:id/agent/:agent -> Subagent viewer
		if (parts.length === 4 && parts[0] === "s" && parts[2] === "agent") {
			const sessionId = parsePositiveInt(parts[1]);
			const agentId = parsePositiveInt(parts[3]);
			const doc = sessionId === undefined ? undefined : await harness.snapshot(SessionDocToken, sessionId as ConversationId, context);
			const row = agentId === undefined ? undefined : doc?.agents?.find((item) => item.id === agentId);
			const owns = sessionId !== undefined && agentId !== undefined && (await agentSession(harness, agentId as ConversationId, context)) === sessionId;
			const conversation = owns && agentId !== undefined ? await harness.conversation(agentId as ConversationId, context) : undefined;
			if (sessionId === undefined || agentId === undefined || doc === undefined || row === undefined || conversation === undefined) {
				const body = renderNotFoundPage(index, "This session has no such agent.", sessionId !== undefined ? `/s/${sessionId}` : undefined);
				sendHtml(response, 404, renderPage({ ...frameBase(), title: "Not found · pigui", page: "not-found", body }), true);
				return true;
			}
			const watch = await conversation.watch(context);
			const view = watch.value;
			await watch.stop();
			const running = (view.docs["pi.live"] as LiveState | undefined)?.run !== undefined;
			const items = await loadTranscriptItems(conversation, view, undefined, running, context);
			const blocks = buildBlocks({ items, docs: view.docs }, undefined, running);
			const body = renderAgentPage({ sessionId, row, index, blocks, running, speech: deps.speech });
			sendHtml(
				response,
				200,
				renderPage({
					...frameBase(),
					title: `${row.description} · pigui`,
					page: "agent",
					body,
					sessionId,
					agentId,
					running,
				}),
				true,
			);
			return true;
		}

		return false;
	}

	async function handleFragment(url: URL, response: ServerResponse, context: Context): Promise<boolean> {
		const parts = url.pathname.split("/").filter((part) => part !== "").map(decodeURIComponent);
		if (parts[0] !== "ui") return false;
		const harness = deps.harness();

		// GET /ui/picker
		if (parts.length === 2 && parts[1] === "picker") {
			const index = await harness.snapshot(SessionIndexToken, context);
			const current = parsePositiveInt(url.searchParams.get("current"));
			const colRaw = url.searchParams.get("sort");
			const column: PickerColumn = colRaw === "name" || colRaw === "where" || colRaw === "modified" || colRaw === "status" ? colRaw : "modified";
			const ascending = url.searchParams.get("dir") === "asc";
			const inactiveParam = url.searchParams.get("inactive");
			const inactiveOpen = inactiveParam === "1" ? true : inactiveParam === "0" ? false : undefined;
			const html = renderPickerDialog({
				index,
				current,
				column,
				ascending,
				inactiveOpen,
				home: deps.onPrem?.home,
				memory: deps.memory,
				now: deps.now(),
			});
			sendHtml(response, 200, html.value, false);
			return true;
		}

		// GET /ui/agents/:id
		if (parts.length === 3 && parts[1] === "agents") {
			const id = parsePositiveInt(parts[2]);
			if (id === undefined) throw notFound("The session");
			const doc = await harness.snapshot(SessionDocToken, id as ConversationId, context);
			if (doc?.id === undefined) throw notFound("The session");
			const docsByAgent = await readAgentDocs(harness, doc, context);
			sendHtml(response, 200, renderAgentsDialog(doc, docsByAgent, deps.now()).value, false);
			return true;
		}

		// GET /ui/diff/:id
		if (parts.length === 3 && parts[1] === "diff") {
			const id = parsePositiveInt(parts[2]);
			if (id === undefined) throw notFound("The session");
			try {
				const diff = await deps.delivery.diff(id, context);
				sendHtml(response, 200, renderDiffDialog(diff).value, false);
			} catch (error) {
				const message = error instanceof Error ? error.message : "Could not load changes.";
				sendHtml(response, 200, renderDiffDialog(undefined, message).value, false);
			}
			return true;
		}

		// GET /ui/target?<target> -> the chips for a target the person just chose in a sheet
		if (parts.length === 2 && parts[1] === "target") {
			const target = parseStartTarget(url, deps.onPrem !== undefined);
			if (target === undefined) throw new HttpError(400, "That is not a place a session can start.", "Choose it again from the list.");
			sendHtml(response, 200, renderStartTarget(target, deps.onPrem?.home).value, false);
			return true;
		}

		// GET /ui/places?<target> -> the Where sheet
		if (parts.length === 2 && parts[1] === "places") {
			const index = await harness.snapshot(SessionIndexToken, context);
			const current = parseStartTarget(url, deps.onPrem !== undefined);
			const common = { starred: index?.starredRepos ?? [], current, onPrem: deps.onPrem !== undefined };
			let repos: RepoSummary[] = [];
			let error: string | undefined;
			try {
				repos = await deps.host.listRepos();
			} catch (failure) {
				error = failure instanceof Error ? failure.message : "Could not load repositories.";
			}
			sendHtml(response, 200, renderPlaceSheet({ ...common, repos, ...(error !== undefined ? { error } : {}) }).value, false);
			return true;
		}

		// GET /ui/branches?<target> -> the Branch sheet for the target's repository
		if (parts.length === 2 && parts[1] === "branches") {
			const current = parseStartTarget(url, deps.onPrem !== undefined);
			if (current?.place !== "repo") throw new HttpError(400, "Choose a repository first.");
			const index = await harness.snapshot(SessionIndexToken, context);
			const sessionBranches: SessionBranch[] = await Promise.all(
				sessionBranchesOf(index, current.repo).map(async (item) => {
					const unpushed = await deps.delivery.unpushed(item.session.id, item.branch);
					return unpushed === undefined ? item : { ...item, unpushed };
				}),
			);
			let branches: BranchList | undefined;
			let error: string | undefined;
			try {
				branches = await deps.host.branches(current.repo);
			} catch (failure) {
				error = `GitHub's branches could not be listed: ${failure instanceof Error ? failure.message : String(failure)}`;
			}
			const sheet = renderBranchSheet({
				current,
				sessionBranches,
				...(branches !== undefined ? { branches } : {}),
				...(error !== undefined ? { error } : {}),
				now: deps.now(),
			});
			sendHtml(response, 200, sheet.value, false);
			return true;
		}

		// GET /ui/sessions/:id/earlier?before=N[&agent=A]
		if (parts.length === 4 && parts[1] === "sessions" && parts[3] === "earlier") {
			const id = parsePositiveInt(parts[2]);
			const before = parsePositiveInt(url.searchParams.get("before"));
			if (id === undefined || before === undefined) throw new HttpError(400, "Specify a valid session and ?before= entry id.");
			const agentParam = url.searchParams.get("agent");
			const agentId = agentParam === null ? undefined : parsePositiveInt(agentParam);
			if (agentParam !== null && (agentId === undefined || (await agentSession(harness, agentId as ConversationId, context)) !== id)) {
				throw notFound("The agent");
			}
			const doc = agentId === undefined ? await harness.snapshot(SessionDocToken, id as ConversationId, context) : undefined;
			const conversation = await harness.conversation((agentId ?? id) as ConversationId, context);
			if (conversation === undefined) throw notFound("The session");
			const page = await conversation.entries({ maxEntryId: (before - 1) as EntryId, order: "descending" }, 50, undefined, context);
			const entries = [...page.items].reverse();
			const hasMore = page.next !== undefined;
			const blocks = buildBlocks(sourceFromEntries(entries, {}, hasMore), doc, false);
			const html = renderTranscriptRows(blocks, { session: doc, running: false, speech: deps.speech }, true).value;
			sendJson(response, 200, {
				html,
				firstEntryId: entries[0]?.id,
				hasMore,
			});
			return true;
		}

		return false;
	}

	async function handleEvents(url: URL, response: ServerResponse, context: Context): Promise<void> {
		const pageParam = url.searchParams.get("page");
		const page: EventStreamRequest["page"] =
			pageParam === "new" || pageParam === "session" || pageParam === "agent"
				? pageParam
				: url.searchParams.get("session") !== null
					? "session"
					: "new";
		const sessionParam = url.searchParams.get("session");
		const agentParam = url.searchParams.get("agent");
		const sinceParam = url.searchParams.get("since");
		const req: EventStreamRequest = { page };
		const harness = deps.harness();
		if (sessionParam !== null) {
			const id = parsePositiveInt(sessionParam);
			if (id === undefined) throw notFound("The session");
			req.session = id;
		}
		if (agentParam !== null) {
			const agentId = parsePositiveInt(agentParam);
			if (agentId === undefined || req.session === undefined || (await agentSession(harness, agentId as ConversationId, context)) !== req.session) {
				throw notFound("The agent");
			}
			req.agent = agentId;
		}
		const since = parsePositiveInt(sinceParam);
		if (since !== undefined) req.since = since;
		await serveEvents(
			response,
			req,
			{
				harness,
				presence: deps.presence,
				now: deps.now,
				speech: deps.speech,
				home: deps.onPrem?.home,
				markSeen: (sessionId) => deps.sessions.seen(sessionId, context),
			},
			context,
		);
	}

	return { handlePage, handleFragment, handleEvents };
}
