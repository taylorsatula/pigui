// The live stream: newline-delimited JSON over one long HTTP response. Each source is a Durable watch, so the phone
// gets a value and then only the Chord operations of later commits. A reconnect asks for the window after the newest
// entry it holds, so it never reloads the transcript.
import type { ServerResponse } from "node:http";
import { type Context, withCancel } from "@earendil-works/chord/context";
import type { WatchHandle } from "@earendil-works/chord/watch";
import { AgentDoc, type ConversationDocToken, type ConversationId, type EntryId, type Harness, LiveDoc, UsageDoc } from "@earendil-works/pi-durable";
import type { SessionDoc } from "../shared/session.ts";
import { type AgentDocKind, type AgentDocs, type LiveMessage, PING_INTERVAL_MS } from "../shared/stream.ts";
import { SessionDocToken, SessionIndexToken } from "./documents.ts";
import type { Presence } from "./presence.ts";

export type LiveRequest = {
	session?: number;
	/** One of the session's agents, whose conversation the stream carries instead of the session's, for its viewer. */
	agent?: number;
	/** The first entry the phone does not have yet. */
	from?: number;
};

/**
 * Begin a newline-delimited JSON response, the framing of the live stream and of a speech script. `send` writes one
 * message while the response is open.
 */
export function openLines<T>(response: ServerResponse): (message: T) => void {
	response.writeHead(200, {
		"Content-Type": "application/x-ndjson; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Accel-Buffering": "no",
	});
	return (message) => {
		if (!response.writableEnded && !response.destroyed) response.write(`${JSON.stringify(message)}\n`);
	};
}

export async function serveLive(response: ServerResponse, request: LiveRequest, harness: Harness, presence: Presence, parent: Context): Promise<void> {
	const { context, cancel } = withCancel(parent);
	const watches: WatchHandle<unknown>[] = [];
	let leave: (() => void) | undefined;
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		clearInterval(ping);
		leave?.();
		cancel();
		for (const watch of watches) void watch.stop();
		response.end();
	};
	const send = openLines<LiveMessage>(response);
	const ping = setInterval(() => send({ t: "ping" }), PING_INTERVAL_MS);
	response.on("close", close);
	const keep = (watch: WatchHandle<unknown>) => {
		watches.push(watch);
		// A watch acquired as the stream closed would otherwise outlive it.
		if (closed) void watch.stop();
	};

	const followDoc = async <K extends AgentDocKind>(agent: number, kind: K, token: ConversationDocToken<AgentDocs[K]>) => {
		const watch = await harness.watchDoc(token, agent as ConversationId, context);
		if (watch === undefined) return;
		keep(watch as WatchHandle<unknown>);
		send({ t: "agent-doc", agent, doc: kind, value: watch.value } as LiveMessage);
		watch.start(async (call) => {
			if (call.kind === "value" && call.ops.length > 0) send({ t: "agent-doc-ops", agent, doc: kind, ops: [...call.ops] });
		});
	};
	// Each agent's documents, from the moment its row appears in the session's document: what it is doing, what it
	// has spent, and its model.
	const followed = new Set<number>();
	const followAgents = async (doc: Readonly<SessionDoc>) => {
		for (const row of doc.agents ?? []) {
			if (followed.has(row.id) || closed) continue;
			followed.add(row.id);
			await followDoc(row.id, "pi.live", LiveDoc);
			await followDoc(row.id, "pi.usage", UsageDoc);
			await followDoc(row.id, "pi.agent", AgentDoc);
		}
	};

	try {
		const index = await harness.watchDoc(SessionIndexToken, context);
		if (index !== undefined) {
			keep(index as WatchHandle<unknown>);
			send({ t: "index", value: index.value });
			index.start(async (call) => {
				if (call.kind === "value" && call.ops.length > 0) send({ t: "index-ops", ops: [...call.ops] });
			});
		} else {
			send({ t: "index", value: { rows: {}, created: [] } });
		}
		if (request.session !== undefined) {
			const id = request.session as ConversationId;
			const doc = await harness.watchDoc(SessionDocToken, id, context);
			const conversation = await harness.conversation((request.agent ?? request.session) as ConversationId, context);
			if (doc === undefined || conversation === undefined) {
				send({ t: "missing" });
			} else {
				leave = presence.enter(request.session);
				keep(doc as WatchHandle<unknown>);
				send({ t: "session", value: doc.value });
				// The viewer of one agent needs only that agent's conversation, which carries its own live state.
				const panel = request.agent === undefined;
				if (panel) await followAgents(doc.value);
				doc.start(async (call) => {
					if (call.kind !== "value" || call.ops.length === 0) return;
					send({ t: "session-ops", ops: [...call.ops] });
					if (panel) await followAgents(call.value);
				});
				const view = await conversation.watch(context, request.from === undefined ? undefined : { from: request.from as EntryId });
				keep(view as WatchHandle<unknown>);
				send({ t: "view", value: view.value });
				view.start(async (call) => {
					if (call.kind === "value" && call.ops.length > 0) send({ t: "view-ops", ops: [...call.ops] });
				});
			}
		}
	} catch (error) {
		close();
		throw error;
	}
	if (closed) return;
	// A watch ends when the Harness closes; the phone then reconnects to the next server.
	await Promise.race(watches.map((watch) => watch.closed));
	close();
}
