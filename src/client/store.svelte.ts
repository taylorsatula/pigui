// One small reactive store for the whole app: what the live stream delivers and what the person is looking at.
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import type { TranscriptView } from "@earendil-works/pi-durable";
import type { Bootstrap } from "../shared/api.ts";
import type { SessionDoc, SessionIndex, SessionStart } from "../shared/session.ts";
import type { AgentDocs, AgentDocKind } from "../shared/stream.ts";

/** A session, or with `agent` the viewer of one of its agents' conversations; "start" is a blank one the server does not know exists. */
export type Route = { kind: "new" } | { kind: "session"; id: number; agent?: number } | { kind: "start" };

/**
 * Where a spawned-but-not-yet-sent session will land. Creating it on the server is the first message's job, so a tap in
 * and straight out makes nothing. Kept in storage until the first send or an explicit back, so a reload mid-draft lands
 * on the same blank screen with the draft text intact (the draft keeps its own storage under the composer's "new" key).
 */
export type PendingStart =
	| { place: "local"; dir: string }
	| { place: "repo"; repo: string; start: SessionStart };

export type Toast = { message: string; action?: { label: string; run: () => void } };

/** The reply being read aloud (see speech.ts): its first words are being prepared, or it is playing. */
export type Reading = { key: string; state: "preparing" | "playing" };

export type State = {
	route: Route;
	/** The unsent spawned session the blank screen shows; absent on the splash page. */
	pendingStart?: PendingStart;
	bootstrap?: Bootstrap;
	index?: SessionIndex;
	/** The open session's pigui document and Durable view (in an agent's viewer, the agent's), for `route.id` only. */
	session?: SessionDoc;
	view?: TranscriptView;
	/** What the open session's stream follows of each of its agents, by agent id. */
	agents: Record<number, Partial<AgentDocs>>;
	/** The open session does not exist. */
	missing: boolean;
	/** The session picker, open over the page. */
	pickerOpen: boolean;
	toast?: Toast;
	reading?: Reading;
};

export function routeFromHash(hash: string): Route {
	const match = /^#\/s\/(\d+)(?:\/agent\/(\d+))?/.exec(hash);
	if (match === null) return /^#\/start(\/|$)/.test(hash) ? { kind: "start" } : { kind: "new" };
	return match[2] === undefined ? { kind: "session", id: Number(match[1]) } : { kind: "session", id: Number(match[1]), agent: Number(match[2]) };
}

const PENDING_KEY = "pigui.pending-start";

/** Read the stored spawn target, or nothing; anything malformed is dropped rather than trusted. */
export function loadPendingStart(): PendingStart | undefined {
	try {
		const raw = localStorage.getItem(PENDING_KEY);
		if (raw === null) return undefined;
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const record = parsed as Record<string, unknown>;
		if (record["place"] === "local" && typeof record["dir"] === "string") return { place: "local", dir: record["dir"] };
		if (record["place"] === "repo" && typeof record["repo"] === "string" && typeof record["start"] === "object" && record["start"] !== null) {
			const start = record["start"] as Record<string, unknown>;
			if (start["kind"] === "new" && typeof start["base"] === "string") return { place: "repo", repo: record["repo"], start: { kind: "new", base: start["base"] } };
			if (start["kind"] === "continue" && typeof start["branch"] === "string") return { place: "repo", repo: record["repo"], start: { kind: "continue", branch: start["branch"] } };
		}
		localStorage.removeItem(PENDING_KEY);
		return undefined;
	} catch {
		return undefined;
	}
}

/** Spawn the blank screen and remember where it will land; the send creates it. */
export function setPendingStart(pending: PendingStart): void {
	app.pendingStart = pending;
	try {
		localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
	} catch {
		// Storage can be unavailable (private browsing); the spawn then lives only in memory.
	}
}

/** The first send, a tap on the back button, or a navigation to the splash: the spawn is over or abandoned. */
export function clearPendingStart(): void {
	app.pendingStart = undefined;
	try {
		localStorage.removeItem(PENDING_KEY);
	} catch {
		// Storage can be unavailable; nothing to clear.
	}
}

const stored = loadPendingStart();
// A start hash with nothing stored behind it is a stale link; show the splash instead.
const initial = routeFromHash(location.hash);
export const app = $state<State>({
	route: initial.kind === "start" && stored === undefined ? { kind: "new" } : initial,
	pendingStart: stored,
	agents: {},
	missing: false,
	pickerOpen: false,
});

/** Apply the Chord operations the stream carries. The ops are the wire boundary's one untyped value; the boundary lives here. */
export function applyOps<T>(target: T, ops: readonly Op[]): T {
	return applyImmutable(target, ops);
}

// The actions the live stream feeds through, so the field names live in one place with the types they carry.

export function setBootstrap(bootstrap: Bootstrap): void {
	app.bootstrap = bootstrap;
}

export function setIndex(index: SessionIndex): void {
	app.index = index;
}

/** Fold index operations into the open index; answers with what it holds now, or undefined while there is nothing to apply to. */
export function applyIndexOps(ops: readonly Op[]): SessionIndex | undefined {
	const index = app.index;
	if (index === undefined) return undefined;
	const next = applyOps(index, ops);
	app.index = next;
	return next;
}

export function setSession(session: SessionDoc): void {
	app.session = session;
	app.missing = false;
}

/** Fold session operations into the open session; answers with the next document, or undefined while there is none to apply to. */
export function applySessionOps(ops: readonly Op[]): SessionDoc | undefined {
	const session = app.session;
	if (session === undefined) return undefined;
	const next = applyOps(session, ops);
	app.session = next;
	return next;
}

export function setView(view: TranscriptView | undefined): void {
	app.view = view;
}

export function setAgentDoc<K extends AgentDocKind>(agent: number, doc: K, value: AgentDocs[K]): void {
	app.agents = { ...app.agents, [agent]: { ...app.agents[agent], [doc]: value } };
}

export function applyAgentDocOps<K extends AgentDocKind>(agent: number, doc: K, ops: readonly Op[]): void {
	const value = app.agents[agent]?.[doc];
	if (value === undefined) return;
	app.agents = { ...app.agents, [agent]: { ...app.agents[agent], [doc]: applyOps(value, ops) } };
}

export function setMissing(missing: boolean): void {
	app.missing = missing;
}

/** Point the page at another route; the hash it writes is what the router parses. Going back to the splash discards a pending spawn. */
export function navigate(route: Route): void {
	if (route.kind === "new") clearPendingStart();
	location.hash = route.kind === "new" ? "#/" : route.kind === "start" ? "#/start" : route.agent === undefined ? `#/s/${route.id}` : `#/s/${route.id}/agent/${route.agent}`;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
let toastLeft = 0;
let toastSince = 0;
let toastHeld = false;

/** Returning to a toast that had almost run out still leaves time to read it. */
const TOAST_AFTER_HOLD = 2000;

function runToastClock(ms: number): void {
	clearTimeout(toastTimer);
	toastLeft = ms;
	toastSince = Date.now();
	toastTimer = setTimeout(dismissToast, ms);
}

export function showToast(toast: Toast, ms = 6000): void {
	app.toast = toast;
	toastHeld = document.visibilityState === "hidden";
	if (toastHeld) {
		clearTimeout(toastTimer);
		toastLeft = ms;
	} else runToastClock(ms);
}

/** Stop the toast's clock while a finger is on it or the app is in the background, and restart it after. */
export function holdToast(held: boolean): void {
	if (held === toastHeld || app.toast === undefined) return;
	toastHeld = held;
	if (held) {
		clearTimeout(toastTimer);
		toastLeft -= Date.now() - toastSince;
	} else runToastClock(Math.max(toastLeft, TOAST_AFTER_HOLD));
}

export function dismissToast(): void {
	clearTimeout(toastTimer);
	toastHeld = false;
	app.toast = undefined;
}
