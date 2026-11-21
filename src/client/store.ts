// One small observable store for the whole app: what the live stream delivers and what the person is looking at.
import type { TranscriptView } from "@earendil-works/pi-durable";
import { useEffect, useState } from "preact/hooks";
import type { Bootstrap } from "../shared/api.ts";
import type { SessionDoc, SessionIndex } from "../shared/session.ts";

export type Route = { kind: "new" } | { kind: "session"; id: number };

export type Toast = { message: string; action?: { label: string; run: () => void } };

export type State = {
	route: Route;
	bootstrap?: Bootstrap;
	index?: SessionIndex;
	/** The open session's picloud document and Durable view, for `route.id` only. */
	session?: SessionDoc;
	view?: TranscriptView;
	/** The open session does not exist. */
	missing: boolean;
	connected: boolean;
	drawerOpen: boolean;
	toast?: Toast;
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
	const match = /^#\/s\/(\d+)/.exec(hash);
	return match === null ? { kind: "new" } : { kind: "session", id: Number(match[1]) };
}

export const store = new Store({ route: routeFromHash(location.hash), missing: false, connected: false, drawerOpen: false });

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
	location.hash = route.kind === "new" ? "#/" : `#/s/${route.id}`;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function showToast(toast: Toast, ms = 6000): void {
	clearTimeout(toastTimer);
	store.set({ toast });
	toastTimer = setTimeout(() => store.set({ toast: undefined }), ms);
}
