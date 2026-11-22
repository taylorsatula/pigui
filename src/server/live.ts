// The live stream: newline-delimited JSON over one long HTTP response. Each source is a Durable watch, so the phone
// gets a value and then only the Chord operations of later commits. A reconnect asks for the window after the newest
// entry it holds, so it never reloads the transcript.
import type { ServerResponse } from "node:http";
import { type Context, withCancel } from "@earendil-works/chord/context";
import type { WatchHandle } from "@earendil-works/chord/watch";
import type { ConversationId, EntryId, Harness } from "@earendil-works/pi-durable";
import { type LiveMessage, PING_INTERVAL_MS } from "../shared/stream.ts";
import { SessionDocToken, SessionIndexToken } from "./docs.ts";
import type { Presence } from "./presence.ts";

export type LiveRequest = {
	session?: number;
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

	try {
		const index = await harness.watchDoc(SessionIndexToken, context);
		if (index !== undefined) {
			watches.push(index as WatchHandle<unknown>);
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
			const conversation = await harness.conversation(id, context);
			if (doc === undefined || conversation === undefined) {
				send({ t: "missing" });
			} else {
				leave = presence.enter(request.session);
				watches.push(doc as WatchHandle<unknown>);
				send({ t: "session", value: doc.value });
				doc.start(async (call) => {
					if (call.kind === "value" && call.ops.length > 0) send({ t: "session-ops", ops: [...call.ops] });
				});
				const view = await conversation.watch(context, request.from === undefined ? undefined : { from: request.from as EntryId });
				watches.push(view as WatchHandle<unknown>);
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
