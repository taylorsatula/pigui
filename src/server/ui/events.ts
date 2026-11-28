// Granular Server-Sent Events stream replacing raw Chord-op /api/live: watches Durable server-side, coalesces rapid
// streaming tokens at 60 ms, diffs rendered blocks by key + hash, and sends ONLY the DOM patches that changed.
import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import { type Context, withCancel } from "@earendil-works/chord/context";
import type { WatchHandle } from "@earendil-works/chord/watch";
import {
	AgentDoc,
	type Conversation,
	type ConversationDocToken,
	type ConversationId,
	type ConversationView,
	type EntryId,
	type EntryRecord,
	type Harness,
	LiveDoc,
	type LiveState,
	type TranscriptItem,
	UsageDoc,
	type UsageState,
} from "@earendil-works/pi-durable";
import { type SessionDoc, type SessionIndex } from "../../shared/session.ts";
import { sessionSpent } from "../../shared/spend.ts";
import { SessionDocToken, SessionIndexToken } from "../documents.ts";
import type { Presence } from "../presence.ts";
import { agentCounts, agentCountText, type AgentDocKind, type AgentDocs, placeholderFor, sameDay } from "./format.ts";
import { renderBlock, renderDayHeading } from "./render/blocks.ts";
import {
	attentionCount,
	renderAgentHeaderContent,
	renderAgentsButton,
	renderAgentsDialog,
	renderBanner,
	renderSessionHeaderContent,
	sessionsButtonLabel,
} from "./render/pages.ts";
import { type Block, buildBlocks, sourceFromEntries, turnStart } from "./transcript.ts";

const PING_MS = 20_000;
const COALESCE_MS = 60;
const MAX_TURN_BACKFILL = 500;

export type EventStreamRequest = {
	page: "new" | "session" | "agent";
	session?: number;
	agent?: number;
	/** Highest committed entry ID already in the client DOM on reconnect; backfills missed entries without gaps. */
	since?: number;
};

export type EventStreamDeps = {
	harness: Harness;
	presence: Presence;
	now: () => number;
	speech: boolean;
	home?: string;
	markSeen: (sessionId: number) => Promise<void>;
};

type BlockOp =
	| { op: "insert"; key: string; afterKey: string | null; html: string; dayHtml?: string }
	| { op: "update"; key: string; html: string }
	| { op: "remove"; key: string };

function hashOf(text: string): string {
	return createHash("sha1").update(text).digest("base64url");
}

/**
 * Load a full active turn if the newest 50-entry window started mid-turn while working.
 * Used both on initial SSR GET /s/:id and inside the SSE stream so reloads show the full active turn.
 */
export async function loadTranscriptItems(
	conversation: Conversation,
	view: ConversationView,
	doc: SessionDoc | undefined,
	running: boolean,
	context: Context,
): Promise<readonly TranscriptItem[]> {
	const entries: EntryRecord[] = [...view.entries];
	let hasEarlier = view.before !== undefined;
	const working = running && doc?.card === undefined;
	if (!working || !hasEarlier) return sourceFromEntries(entries, view.docs, hasEarlier).items;

	const baseBlocks = buildBlocks(sourceFromEntries(entries, view.docs, hasEarlier), doc, running);
	if (turnStart(baseBlocks) !== -1) return sourceFromEntries(entries, view.docs, hasEarlier).items;

	while (hasEarlier && entries.length < MAX_TURN_BACKFILL) {
		const earliest = entries[0]?.id;
		if (earliest === undefined) break;
		const page = await conversation.entries({ maxEntryId: (Number(earliest) - 1) as EntryId, order: "descending" }, 50, undefined, context);
		const older = [...page.items].reverse();
		if (older.length === 0) {
			hasEarlier = false;
			break;
		}
		entries.unshift(...older);
		hasEarlier = page.next !== undefined;
		const nextBlocks = buildBlocks(sourceFromEntries(entries, view.docs, hasEarlier), doc, running);
		if (turnStart(nextBlocks) !== -1) break;
	}
	return sourceFromEntries(entries, view.docs, hasEarlier).items;
}

export async function serveEvents(response: ServerResponse, request: EventStreamRequest, deps: EventStreamDeps, parent: Context): Promise<void> {
	const { context, cancel } = withCancel(parent);
	const watches: WatchHandle<unknown>[] = [];
	let leave: (() => void) | undefined;
	let closed = false;
	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	let flushing = false;
	let dirty = false;

	response.writeHead(200, {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-store",
		"Connection": "keep-alive",
		"X-Accel-Buffering": "no",
	});

	const emit = (event: string, data: unknown) => {
		if (!closed && !response.writableEnded && !response.destroyed) {
			response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		}
	};

	const close = () => {
		if (closed) return;
		closed = true;
		clearInterval(ping);
		clearTimeout(flushTimer);
		leave?.();
		cancel();
		for (const watch of watches) void watch.stop();
		response.end();
	};

	const ping = setInterval(() => {
		if (!closed && !response.writableEnded && !response.destroyed) response.write(": ping\n\n");
	}, PING_MS);
	response.on("close", close);

	const keep = (watch: WatchHandle<unknown>) => {
		watches.push(watch);
		if (closed) void watch.stop();
	};

	let currentIndex: SessionIndex | undefined;
	let currentDoc: SessionDoc | undefined;
	let currentView: ConversationView | undefined;
	let conversation: Conversation | undefined;
	const agentDocs: Record<number, Partial<AgentDocs>> = {};
	// Monotonic per-connection entry retention: pi-durable's watch window splices off old entries past 100, so
	// merging into knownEntries prevents already-shown turns from vanishing mid-run while the user reads them.
	const knownEntries = new Map<number, EntryRecord>();
	let knownHasEarlier = false;
	let seededEntries = false;

	// Diff baselines for this connection.
	let lastAttentionKey = "";
	let lastHeaderHash = "";
	let lastBannerHash = "";
	let lastAgentsHash = "";
	let lastBlockList: Array<{ key: string; hash: string; at?: number }> = [];
	let initializedBlocks = false;

	const mergeViewEntries = async (conv: Conversation, view: ConversationView, doc: SessionDoc | undefined, running: boolean): Promise<readonly TranscriptItem[]> => {
		if (!seededEntries) {
			seededEntries = true;
			const initialItems = await loadTranscriptItems(conv, view, doc, running, context);
			knownHasEarlier = initialItems.some((item) => item.kind === "earlier");
			for (const item of initialItems) {
				if (item.kind === "entry") knownEntries.set(Number(item.entry.id), item.entry);
			}
			// On SSE reconnect after a drop, backfill any entries strictly between `request.since` and our earliest loaded entry.
			if (request.since !== undefined && knownEntries.size > 0) {
				const earliest = Math.min(...knownEntries.keys());
				if (earliest > request.since + 1) {
					let cursorMin = request.since + 1;
					let backfilled = 0;
					while (cursorMin < earliest && backfilled < MAX_TURN_BACKFILL) {
						const page = await conv.entries(
							{ minEntryId: cursorMin as EntryId, maxEntryId: (earliest - 1) as EntryId, order: "ascending" },
							100,
							undefined,
							context,
						);
						if (page.items.length === 0) break;
						for (const entry of page.items) knownEntries.set(Number(entry.id), entry);
						backfilled += page.items.length;
						const lastId = Number(page.items[page.items.length - 1]!.id);
						if (page.next === undefined || lastId >= earliest - 1) break;
						cursorMin = lastId + 1;
					}
				}
			}
		} else {
			for (const entry of view.entries) knownEntries.set(Number(entry.id), entry);
		}
		const ordered = [...knownEntries.values()].sort((a, b) => Number(a.id) - Number(b.id));
		return sourceFromEntries(ordered, view.docs, knownHasEarlier).items;
	};

	const followedAgents = new Set<number>();
	const followAgentDoc = async <K extends AgentDocKind>(agentId: number, kind: K, token: ConversationDocToken<AgentDocs[K]>) => {
		const watch = await deps.harness.watchDoc(token, agentId as ConversationId, context);
		if (watch === undefined) return;
		keep(watch as WatchHandle<unknown>);
		agentDocs[agentId] = { ...agentDocs[agentId], [kind]: watch.value };
		watch.start(async (call) => {
			if (call.kind === "value" && call.ops.length > 0) {
				agentDocs[agentId] = { ...agentDocs[agentId], [kind]: call.value };
				scheduleFlush(false);
			}
		});
	};

	const followAgents = async (doc: Readonly<SessionDoc>) => {
		for (const row of doc.agents ?? []) {
			if (followedAgents.has(row.id) || closed) continue;
			followedAgents.add(row.id);
			await followAgentDoc(row.id, "pi.live", LiveDoc);
			await followAgentDoc(row.id, "pi.usage", UsageDoc);
			await followAgentDoc(row.id, "pi.agent", AgentDoc);
		}
	};

	const computeBlockOps = (blocks: readonly Block[], doc: SessionDoc | undefined, running: boolean): BlockOp[] => {
		const ctx = { session: doc, running, speech: deps.speech };
		const nextEntries: Array<{ key: string; hash: string; html: string; at?: number; dayHtml?: string }> = [];
		let day: number | undefined;
		for (const block of blocks) {
			let dayHtml: string | undefined;
			if (block.at !== undefined) {
				if (day !== undefined && !sameDay(day, block.at)) dayHtml = renderDayHeading(block.key, block.at).value;
				day = block.at;
			}
			const rendered = renderBlock(block, ctx).value;
			const hash = hashOf(rendered + (dayHtml ?? ""));
			nextEntries.push({ key: block.key, hash, html: rendered, ...(block.at !== undefined ? { at: block.at } : {}), ...(dayHtml !== undefined ? { dayHtml } : {}) });
		}

		// First projection seeds the baseline from the SSR page state without resending unchanged blocks,
		// EXCEPT if new blocks already landed between SSR HTML generation and SSE connect, we send only the diff!
		// Wait: to avoid any race between SSR render and SSE connect, on initial connect we DO send a full sync
		// ONLY for blocks not yet present or changed — the client applies ops idempotently by data-block-key!
		const prevMap = new Map(lastBlockList.map((item) => [item.key, item.hash]));
		const nextKeys = new Set(nextEntries.map((item) => item.key));
		const ops: BlockOp[] = [];

		if (initializedBlocks) {
			for (const prev of lastBlockList) {
				if (!nextKeys.has(prev.key)) ops.push({ op: "remove", key: prev.key });
			}
		}

		let prevKey: string | null = null;
		for (const item of nextEntries) {
			const oldHash = prevMap.get(item.key);
			if (oldHash === undefined) {
				ops.push({ op: "insert", key: item.key, afterKey: prevKey, html: item.html, ...(item.dayHtml !== undefined ? { dayHtml: item.dayHtml } : {}) });
			} else if (oldHash !== item.hash) {
				ops.push({ op: "update", key: item.key, html: item.html });
			}
			prevKey = item.key;
		}

		lastBlockList = nextEntries.map(({ key, hash, at }) => ({ key, hash, ...(at !== undefined ? { at } : {}) }));
		initializedBlocks = true;
		return ops;
	};

	const flush = async () => {
		if (closed || flushing) {
			dirty = true;
			return;
		}
		flushing = true;
		dirty = false;
		try {
			// 1. Attention dot across all pages.
			const others = attentionCount(currentIndex, request.session);
			const attKey = `${others}`;
			if (attKey !== lastAttentionKey) {
				lastAttentionKey = attKey;
				emit("attention", { count: others, label: sessionsButtonLabel(others) });
			}

			// 2. Session view or Agent viewer.
			if (request.session !== undefined && currentDoc !== undefined && currentView !== undefined && conversation !== undefined) {
				const liveState = currentView.docs["pi.live"] as LiveState | undefined;
				if (request.agent === undefined) {
					const running = liveState?.run !== undefined || currentDoc.activeRun !== undefined;
					const spent = sessionSpent(
						currentView.docs["pi.usage"] as UsageState | undefined,
						(currentDoc.agents ?? []).map((agent) => agentDocs[agent.id]?.["pi.usage"]),
					);
					const headerHtml = renderSessionHeaderContent(currentDoc, spent, deps.home).value;
					const placeholder = placeholderFor(currentDoc, running);
					const composerDisabled = currentDoc.setup.status !== "ready" || currentDoc.cleanedAt !== undefined;
					const diffDisabled = currentDoc.setup.status !== "ready";
					const headerPayload = {
						html: headerHtml,
						running,
						workflow: currentDoc.workflow,
						placeholder,
						composerDisabled,
						diffDisabled,
						title: currentDoc.title,
					};
					const headerHash = hashOf(JSON.stringify(headerPayload));
					if (headerHash !== lastHeaderHash) {
						lastHeaderHash = headerHash;
						emit("header", headerPayload);
					}

					const bannerHtml = renderBanner(currentDoc, spent, running).value;
					const bannerHash = hashOf(bannerHtml);
					if (bannerHash !== lastBannerHash) {
						lastBannerHash = bannerHash;
						emit("banner", { html: bannerHtml });
					}

					const agentRows = currentDoc.agents ?? [];
					const counts = agentCounts(agentRows);
					const buttonHtml = renderAgentsButton(currentDoc).value;
					// Pass no wall-clock `now`: elapsed timers tick locally in the browser so SSE only fires on real state changes.
					const panelHtml = agentRows.length > 0 ? renderAgentsDialog(currentDoc, agentDocs).value : "";
					const agentsHash = hashOf(`${buttonHtml}|${panelHtml}`);
					if (agentsHash !== lastAgentsHash) {
						lastAgentsHash = agentsHash;
						emit("agents", {
							count: counts.running + counts.queued,
							label: counts.running + counts.queued === 0 ? "Agents" : `Agents, ${agentCountText(counts)}`,
							present: agentRows.length > 0,
							buttonHtml,
							panelHtml,
						});
					}

					const items = await mergeViewEntries(conversation, currentView, currentDoc, running);
					const blocks = buildBlocks({ items, docs: currentView.docs }, currentDoc, running);
					const ops = computeBlockOps(blocks, currentDoc, running);
					if (ops.length > 0) emit("blocks", { ops });
				} else {
					const row = currentDoc.agents?.find((item) => item.id === request.agent);
					if (row === undefined) {
						emit("missing", {});
					} else {
						const running = liveState?.run !== undefined;
						const headerHtml = renderAgentHeaderContent(row).value;
						const isLive = row.status === "running" || row.status === "queued";
						const headerPayload = { html: headerHtml, running, live: isLive, title: row.description };
						const headerHash = hashOf(JSON.stringify(headerPayload));
						if (headerHash !== lastHeaderHash) {
							lastHeaderHash = headerHash;
							emit("header", headerPayload);
						}

						const items = await mergeViewEntries(conversation, currentView, undefined, running);
						const blocks = buildBlocks({ items, docs: currentView.docs }, undefined, running);
						const ops = computeBlockOps(blocks, undefined, running);
						if (ops.length > 0) emit("blocks", { ops });
					}
				}
			}
		} catch {
			// Connection likely closed mid-flush; handled by close().
		} finally {
			flushing = false;
			if (dirty && !closed) scheduleFlush(false);
		}
	};

	const scheduleFlush = (immediate: boolean) => {
		if (closed) return;
		if (immediate) {
			clearTimeout(flushTimer);
			flushTimer = undefined;
			void flush();
			return;
		}
		if (flushTimer !== undefined) return;
		flushTimer = setTimeout(() => {
			flushTimer = undefined;
			void flush();
		}, COALESCE_MS);
	};

	try {
		const indexWatch = await deps.harness.watchDoc(SessionIndexToken, context);
		if (indexWatch !== undefined) {
			keep(indexWatch as WatchHandle<unknown>);
			currentIndex = indexWatch.value;
			indexWatch.start(async (call) => {
				if (call.kind === "value" && call.ops.length > 0) {
					currentIndex = call.value;
					scheduleFlush(false);
				}
			});
		} else {
			currentIndex = { rows: {}, created: [] };
		}

		if (request.session !== undefined) {
			const id = request.session as ConversationId;
			const docWatch = await deps.harness.watchDoc(SessionDocToken, id, context);
			conversation = await deps.harness.conversation((request.agent ?? request.session) as ConversationId, context);
			if (docWatch === undefined || conversation === undefined) {
				emit("missing", {});
			} else {
				leave = deps.presence.enter(request.session);
				keep(docWatch as WatchHandle<unknown>);
				currentDoc = docWatch.value;
				if (request.agent === undefined) {
					void deps.markSeen(request.session).catch(() => undefined);
					await followAgents(currentDoc);
				}
				docWatch.start(async (call) => {
					if (call.kind !== "value" || call.ops.length === 0) return;
					currentDoc = call.value;
					if (request.agent === undefined) {
						if ((currentDoc.attentionAt ?? 0) > currentDoc.seenAt) void deps.markSeen(currentDoc.id).catch(() => undefined);
						await followAgents(currentDoc);
					}
					scheduleFlush(true);
				});

				const viewWatch = await conversation.watch(context);
				keep(viewWatch as WatchHandle<unknown>);
				currentView = viewWatch.value;
				viewWatch.start(async (call) => {
					if (call.kind === "value" && call.ops.length > 0) {
						currentView = call.value;
						scheduleFlush(false);
					}
				});
			}
		}

		emit("ready", {});
		await flush();
	} catch (error) {
		close();
		throw error;
	}
	if (closed) return;
	await Promise.race(watches.map((watch) => watch.closed));
	close();
}
