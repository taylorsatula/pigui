// picloud's Durable documents. Everything picloud remembers lives here, changed in the same commits as the agent's own
// state, so there is no second store to drift from it.
import type { Draft } from "@earendil-works/chord/delta";
import { type ConversationId, defineDoc, defineDocFamily, type Tx } from "@earendil-works/pi-durable";
import { type SessionDoc, type SessionIndex, sessionRow } from "../shared/session.ts";

// Store a full base every 50 deltas, so loading a long-lived document never replays an unbounded chain.
const checkpointWhen = (_value: unknown, _ops: unknown, info: { deltasSinceBase: number }): boolean => info.deltasSinceBase >= 50;

/** One per session (a Durable conversation): its repository, workflow, cards, plan, report and delivery. */
export const SessionDocToken = defineDoc<SessionDoc>({
	kind: "picloud.session",
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
	kind: "picloud.index",
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
	kind: "picloud.repo-memory",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ notes: "", updatedAt: 0 }),
	checkpointWhen: () => true,
});

export type StoredPushSubscription = {
	endpoint: string;
	keys: { p256dh: string; auth: string };
	createdAt: number;
};

export const PushSubscriptionsToken = defineDoc<{ subscriptions: StoredPushSubscription[] }>({
	kind: "picloud.push-subscriptions",
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
