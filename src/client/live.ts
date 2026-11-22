// The live connection: one streamed response carrying the drawer index and the open session. It applies Chord
// operations to the values it holds, keeps the transcript in Durable's ConversationTranscript (which loads older
// entries on demand and fills gaps), and reconnects on its own, asking only for what it missed.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import {
	type ConversationView,
	ConversationTranscript,
	type Cursor,
	type EntryLoader,
	type EntryRecord,
	type Page,
	type TranscriptItem,
} from "@earendil-works/pi-durable";
import { type LiveMessage, PING_INTERVAL_MS } from "../shared/stream.ts";
import { api, lines } from "./api.ts";
import { store } from "./store.ts";

export type Gap = Extract<TranscriptItem, { kind: "gap" }>;

function loader(id: number): EntryLoader {
	return async (query, limit) => {
		const params = new URLSearchParams({ limit: String(limit), order: query.order ?? "descending" });
		if (query.minEntryId !== undefined) params.set("min", String(query.minEntryId));
		if (query.maxEntryId !== undefined) params.set("max", String(query.maxEntryId));
		const response = await fetch(`/api/sessions/${id}/entries?${params}`);
		if (!response.ok) throw new Error(`Loading history failed with ${response.status}`);
		return (await response.json()) as Page<EntryRecord, Cursor>;
	};
}

class Live {
	#controller: AbortController | undefined;
	#session: number | undefined;
	#transcript: ConversationTranscript | undefined;
	#view: ConversationView | undefined;
	#retry = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#watchdog: ReturnType<typeof setTimeout> | undefined;

	/** Follow `session` (or only the index); keeps what it has of a session it already follows. */
	follow(session: number | undefined): void {
		if (session !== this.#session) {
			this.#session = session;
			this.#transcript = session === undefined ? undefined : new ConversationTranscript(loader(session));
			this.#view = undefined;
			store.set({ session: undefined, view: undefined, missing: false });
		}
		this.#connect();
	}

	/** Stop streaming, as when the app goes to the background; `follow` resumes. */
	pause(): void {
		clearTimeout(this.#timer);
		clearTimeout(this.#watchdog);
		this.#controller?.abort();
		this.#controller = undefined;
	}

	async loadEarlier(): Promise<void> {
		const transcript = this.#transcript;
		if (transcript === undefined) return;
		store.set({ view: await transcript.loadEarlier(BACKGROUND_CONTEXT) });
	}

	async fillGap(gap: Gap): Promise<void> {
		const transcript = this.#transcript;
		if (transcript === undefined) return;
		store.set({ view: await transcript.fillGap(gap, BACKGROUND_CONTEXT) });
	}

	#connect(): void {
		this.pause();
		const controller = new AbortController();
		this.#controller = controller;
		const params = new URLSearchParams();
		if (this.#session !== undefined) {
			params.set("session", String(this.#session));
			const from = this.#transcript?.resume?.from;
			if (from !== undefined) params.set("from", String(from));
		}
		void this.#read(controller, params).catch(() => undefined).finally(() => {
			if (this.#controller !== controller) return;
			// Reconnect with backoff: a restarting server is back within seconds, a dead network costs nothing.
			const delay = Math.min(15_000, 500 * 2 ** this.#retry++);
			this.#timer = setTimeout(() => this.#connect(), delay);
		});
	}

	#arm(controller: AbortController): void {
		clearTimeout(this.#watchdog);
		this.#watchdog = setTimeout(() => controller.abort(), PING_INTERVAL_MS * 2.5);
	}

	async #read(controller: AbortController, params: URLSearchParams): Promise<void> {
		const response = await fetch(`/api/live?${params}`, { signal: controller.signal });
		if (!response.ok || response.body === null) throw new Error(`Live stream failed with ${response.status}`);
		this.#arm(controller);
		this.#retry = 0;
		for await (const message of lines<LiveMessage>(response)) {
			this.#arm(controller);
			this.#apply(message);
		}
	}

	#apply(message: LiveMessage): void {
		switch (message.t) {
			case "index":
				store.set({ index: message.value });
				return;
			case "index-ops": {
				const index = store.get().index;
				if (index !== undefined) store.set({ index: applyImmutable(index, message.ops as Op[]) });
				return;
			}
			case "session":
				store.set({ session: message.value, missing: false });
				void api.seen(message.value.id).catch(() => undefined);
				return;
			case "session-ops": {
				const session = store.get().session;
				if (session === undefined) return;
				const next = applyImmutable(session, message.ops as Op[]);
				store.set({ session: next });
				// Something new that needs the person, while they are looking: mark it seen.
				if (document.visibilityState === "visible" && (next.attentionAt ?? 0) > next.seenAt) void api.seen(next.id).catch(() => undefined);
				return;
			}
			case "view":
				this.#view = message.value;
				this.#merge();
				return;
			case "view-ops":
				if (this.#view === undefined) return;
				this.#view = applyImmutable(this.#view, message.ops as Op[]);
				this.#merge();
				return;
			case "missing":
				store.set({ missing: true });
				return;
			case "ping":
				return;
		}
	}

	#merge(): void {
		if (this.#view === undefined || this.#transcript === undefined) return;
		store.set({ view: this.#transcript.merge(this.#view) });
	}
}

export const live = new Live();
