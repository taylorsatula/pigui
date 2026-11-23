// pigui's Durable documents. Everything pigui remembers lives here, changed in the same commits as the agent's own
// state, so there is no second store to drift from it.
import type { Context } from "@earendil-works/chord/context";
import type { Draft } from "@earendil-works/chord/delta";
import { type ConversationId, defineDoc, defineDocFamily, type DocumentReader, type Tx } from "@earendil-works/pi-durable";
import { type SessionDoc, type SessionIndex, sessionRow } from "../shared/session.ts";
import { DIRECTIVE_VERSION } from "./memory/directives.ts";
import { agentSession } from "./subagents/extension.ts";

// Store a full base every 50 deltas, so loading a long-lived document never replays an unbounded chain.
const checkpointWhen = (_value: unknown, _ops: unknown, info: { deltasSinceBase: number }): boolean => info.deltasSinceBase >= 50;

/** One per session (a Durable conversation): its repository, workflow, cards, plan, report and delivery. */
export const SessionDocToken = defineDoc<SessionDoc>({
	kind: "pigui.session",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	// Replaced in full by the commit that creates the session; never read before that.
	initial: () => ({}) as SessionDoc,
	checkpointWhen,
});

/** The drawer: one row per session, derived from its SessionDoc in the same commit. */
export const SessionIndexToken = defineDoc<SessionIndex>({
	kind: "pigui.index",
	version: 1,
	scope: "session",
	initial: () => ({ rows: {}, created: [] }),
	checkpointWhen,
});

export type RepoMemory = {
	/** What Pi learned about building and testing the repository on this machine, as of its last report. */
	notes: string;
	updatedAt: number;
};

/** Repo memory, one member per repository, carried into every later session on it. */
export const RepoMemoryToken = defineDocFamily<RepoMemory, null>({
	kind: "pigui.repo-memory",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ notes: "", updatedAt: 0 }),
	checkpointWhen: () => true,
});

/**
 * The repo memory a session reads and its reports replace: its repository's, or for every local session one of this
 * computer's. A repository is always `owner/name`, so the computer's key, without a slash, can never be one.
 */
export function repoMemoryKey(doc: Readonly<SessionDoc>): string {
	return doc.place === "local" ? "this computer" : doc.repo;
}

/** One long-term memory. */
export type MemoryRow = {
	text: string;
	/** Its embedding: a Float32 vector, base64. */
	emb: string;
	/** Moved by ratings; it nudges the memory up or down the ranking. */
	score: number;
	/** Provenance: the sessions that wrote it, as pigui session ids, oldest first. */
	sessions: string[];
	createdAt: number;
	updatedAt: number;
};

export type MemoryDoc = {
	/** Keyed by id: four random bytes, hex. */
	rows: Record<string, MemoryRow>;
	/** The embedding model the vectors were made with; absent until they were first checked. */
	embedder?: string;
	/** The golden text's vector under that model (base64), which shows the model changing under its own name. */
	golden?: string;
	/** The create directive in force when the store began, so a later pass can tell which rows predate a newer one. */
	directive: number;
};

/**
 * Long-term memory, shared by every session and repository: what earlier sessions recorded that no file states,
 * searched by embedding similarity in memory, which is fine up to a few thousand rows.
 */
export const MemoryToken = defineDoc<MemoryDoc>({
	kind: "pigui.memory",
	version: 1,
	scope: "session",
	initial: () => ({ rows: {}, directive: DIRECTIVE_VERSION }),
	checkpointWhen,
});

export type StoredPushSubscription = {
	endpoint: string;
	keys: { p256dh: string; auth: string };
	createdAt: number;
};

export const PushSubscriptionsToken = defineDoc<{ subscriptions: StoredPushSubscription[] }>({
	kind: "pigui.push-subscriptions",
	version: 1,
	scope: "session",
	initial: () => ({ subscriptions: [] }),
	checkpointWhen: () => true,
});

/**
 * Change a session in a commit. Every SessionDoc change goes through here, so `updatedAt` and the drawer row can never
 * fall out of step with the document. `touch: false` is for changes that are not activity, such as the person looking.
 */
export async function editSession<T>(
	tx: Tx,
	id: ConversationId | number,
	now: number,
	change: (doc: Draft<SessionDoc>) => T | Promise<T>,
	options: { touch?: boolean } = {},
): Promise<T> {
	const conversationId = id as ConversationId;
	const doc = await tx.doc(SessionDocToken, conversationId);
	const result = await change(doc);
	if (options.touch !== false) doc.updatedAt = now;
	const index = await tx.doc(SessionIndexToken);
	const row = sessionRow(doc as SessionDoc);
	const key = String(conversationId);
	if (JSON.stringify(index.rows[key]) !== JSON.stringify(row)) index.rows[key] = row;
	return result;
}

/**
 * The session a conversation works for: its own document, or for an agent's conversation the session that started the
 * agent, whose directory, project and spend cap the agent shares.
 */
export async function sessionFor(read: Pick<DocumentReader, "snapshot">, conversationId: ConversationId, context: Context): Promise<Readonly<SessionDoc> | undefined> {
	const session = (await agentSession(read, conversationId, context)) ?? conversationId;
	const doc = await read.snapshot(SessionDocToken, session, context);
	return doc?.id === undefined ? undefined : doc;
}

/** The session's document as committed, or undefined for a conversation that is not a session. */
export async function readSession(tx: Tx, id: number): Promise<Draft<SessionDoc> | undefined> {
	const index = await tx.doc(SessionIndexToken);
	if (index.rows[String(id)] === undefined) return undefined;
	return tx.doc(SessionDocToken, id as ConversationId);
}

const REQUEST_MEMORY = 100;

/** The stored answer to a request already handled, so a retried request returns it instead of acting again. */
export function handledRequest(doc: Draft<SessionDoc>, requestId: string): string | undefined {
	return doc.requests.find((request) => request.id === requestId)?.result;
}

export function rememberRequest(doc: Draft<SessionDoc>, requestId: string, result: string, now: number): void {
	doc.requests.push({ id: requestId, at: now, result });
	if (doc.requests.length > REQUEST_MEMORY) doc.requests.splice(0, doc.requests.length - REQUEST_MEMORY);
}
