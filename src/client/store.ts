// One small observable store for the whole app: what the live stream delivers and what the person is looking at.
import type { TranscriptView } from "@earendil-works/pi-durable";
import { useEffect, useState } from "preact/hooks";
import type { Bootstrap } from "../shared/api.ts";
import type { SessionDoc, SessionIndex } from "../shared/session.ts";
import type { AgentDocs } from "../shared/stream.ts";

/** A session, or with `agent` the viewer of one of its agents' conversations. */
export type Route = { kind: "new" } | { kind: "session"; id: number; agent?: number };

export type Toast = { message: string; action?: { label: string; run: () => void } };

/** The reply being read aloud (see speech.ts): its first words are being prepared, or it is playing. */
export type Reading = { key: string; state: "preparing" | "playing" };

export type State = {
	route: Route;
	bootstrap?: Bootstrap;
	index?: SessionIndex;
	/** The open session's picloud document and Durable view (in an agent's viewer, the agent's), for `route.id` only. */
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

type Listener = () => void;

export class Store {
	#state: State;
	readonly #listeners = new Set<Listener>();

	constructor(initial: State) {
		this.#state = initial;
	}

	get(): State {
		return this.#state;
	}

	set(change: Partial<State> | ((state: State) => Partial<State>)): void {
		const patch = typeof change === "function" ? change(this.#state) : change;
		this.#state = { ...this.#state, ...patch };
		for (const listener of this.#listeners) listener();
	}

	subscribe(listener: Listener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
}

export function routeFromHash(hash: string): Route {
	const match = /^#\/s\/(\d+)(?:\/agent\/(\d+))?/.exec(hash);
	if (match === null) return { kind: "new" };
	return match[2] === undefined ? { kind: "session", id: Number(match[1]) } : { kind: "session", id: Number(match[1]), agent: Number(match[2]) };
}

export const store = new Store({ route: routeFromHash(location.hash), agents: {}, missing: false, pickerOpen: false });


/** Re-render when the selected part of the state changes. */
export function useStore<T>(select: (state: State) => T): T {
	const [value, setValue] = useState(() => select(store.get()));
	useEffect(() => {
		const update = () => setValue(() => select(store.get()));
		update();
		return store.subscribe(update);
		// The selector is chosen at mount; components select by stable functions.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	return value;
}

export function navigate(route: Route): void {
	location.hash = route.kind === "new" ? "#/" : route.agent === undefined ? `#/s/${route.id}` : `#/s/${route.id}/agent/${route.agent}`;
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
	store.set({ toast });
	toastHeld = document.visibilityState === "hidden";
	if (toastHeld) {
		clearTimeout(toastTimer);
		toastLeft = ms;
	} else runToastClock(ms);
}

/** Stop the toast's clock while a finger is on it or the app is in the background, and restart it after. */
export function holdToast(held: boolean): void {
	if (held === toastHeld || store.get().toast === undefined) return;
	toastHeld = held;
	if (held) {
		clearTimeout(toastTimer);
		toastLeft -= Date.now() - toastSince;
	} else runToastClock(Math.max(toastLeft, TOAST_AFTER_HOLD));
}

export function dismissToast(): void {
	clearTimeout(toastTimer);
	toastHeld = false;
	store.set({ toast: undefined });
}
