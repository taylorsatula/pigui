// The live protocol: one newline-delimited JSON stream per open app, carrying the drawer index and, when a session is
// open, that session's Durable view and picloud document. Each source sends its value once, then Chord operations that
// the phone applies to it (`@earendil-works/chord/delta`), so a change costs its size, not the whole state.
import type { Op } from "@earendil-works/chord/delta";
import type { ConversationView } from "@earendil-works/pi-durable";
import type { SessionDoc, SessionIndex } from "./session.ts";

export type LiveMessage =
	| { t: "index"; value: SessionIndex }
	| { t: "index-ops"; ops: Op[] }
	| { t: "view"; value: ConversationView }
	| { t: "view-ops"; ops: Op[] }
	| { t: "session"; value: SessionDoc }
	| { t: "session-ops"; ops: Op[] }
	/** The requested session does not exist. */
	| { t: "missing" }
	/** Keeps proxies and the phone's network stack from closing an idle stream. */
	| { t: "ping" };

/** How long the server waits between keepalives; the client treats twice this without data as a dead stream. */
export const PING_INTERVAL_MS = 20_000;
