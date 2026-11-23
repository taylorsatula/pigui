// The live protocol: one newline-delimited JSON stream per open app, carrying the drawer index and, when a session is
// open, that session's Durable view and picloud document, with a few documents of each of its agents; in an agent's
// viewer, the agent's view instead of the session's. Each source sends its value once, then Chord operations that the
// phone applies to it (`@earendil-works/chord/delta`), so a change costs its size, not the whole state.
import type { Op } from "@earendil-works/chord/delta";
import type { AgentState, ConversationView, LiveState, UsageState } from "@earendil-works/pi-durable";
import type { SessionDoc, SessionIndex } from "./session.ts";

/** What the open session's stream follows of each of its agents: Durable's documents of the agent's conversation. */
export type AgentDocs = { "pi.live": LiveState; "pi.usage": UsageState; "pi.agent": AgentState };
export type AgentDocKind = keyof AgentDocs;

export type LiveMessage =
	| { t: "index"; value: SessionIndex }
	| { t: "index-ops"; ops: Op[] }
	/** The open conversation: the session's, or in an agent's viewer the agent's. */
	| { t: "view"; value: ConversationView }
	| { t: "view-ops"; ops: Op[] }
	| { t: "session"; value: SessionDoc }
	| { t: "session-ops"; ops: Op[] }
	/** One of an agent's documents, for the session's Agents panel and its spend. */
	| { [K in AgentDocKind]: { t: "agent-doc"; agent: number; doc: K; value: AgentDocs[K] } }[AgentDocKind]
	| { t: "agent-doc-ops"; agent: number; doc: AgentDocKind; ops: Op[] }
	/** The requested session does not exist. */
	| { t: "missing" }
	/** Keeps proxies and the phone's network stack from closing an idle stream. */
	| { t: "ping" };

/** How long the server waits between keepalives; the client treats twice this without data as a dead stream. */
export const PING_INTERVAL_MS = 20_000;
