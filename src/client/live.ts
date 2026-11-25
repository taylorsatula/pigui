// The live connection: one streamed response carrying the drawer index and the open session, with its agents' state or,
// in an agent's viewer, that agent's conversation. It applies Chord operations to the values it holds, keeps the
// transcript in Durable's ConversationTranscript (which loads older entries on demand and fills gaps), and reconnects on
// its own, asking only for what it missed.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type ConversationView,
	ConversationTranscript,
	type EntryLoader,
	type TranscriptItem,
} from "@earendil-works/pi-durable";
import { type LiveMessage, PING_INTERVAL_MS } from "../shared/stream.ts";
import { api, lines } from "./api.ts";
import { applyAgentDocOps, applyIndexOps, applyOps, applySessionOps, setAgentDoc, setIndex, setMissing, setSession, setView, app } from "./store.svelte.ts";

export type Gap = Extract<TranscriptItem, { kind: "gap" }>;

/** What the stream follows: a session, and in an agent's viewer one of its agents. */
type Followed = { session: number; agent?: number };

function loader(followed: Followed): EntryLoader {
	const id = followed.session;
	return async (query, limit) => {
		const params: Parameters<typeof api.entries>[1] = { limit, order: query.order ?? "descending" };
		if (query.minEntryId !== undefined) params.minEntryId = Number(query.minEntryId);
		if (query.maxEntryId !== undefined) params.maxEntryId = Number(query.maxEntryId);
		if (followed.agent !== undefined) params.agent = followed.agent;
		return api.entries(id, params);
	};
}

class Live {
	#controller: AbortController | undefined;
	#followed: Followed | undefined;
	#transcript: ConversationTranscript | undefined;
	#view: ConversationView | undefined;
	#retry = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#watchdog: ReturnType<typeof setTimeout> | undefined;

	/** Follow `session`, or one of its agents (or only the index); keeps what it has of what it already follows. */
	follow(session: number | undefined, agent?: number): void {
		const followed = session === undefined ? undefined : agent === undefined ? { session } : { session, agent };
		if (followed?.session !== this.#followed?.session || followed?.agent !== this.#followed?.agent) {
			this.#followed = followed;
			this.#transcript = followed === undefined ? undefined : new ConversationTranscript(loader(followed));
			this.#view = undefined;
			app.session = undefined; app.view = undefined; app.agents = {}; app.missing = false;
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
		setView(await transcript.loadEarlier(BACKGROUND_CONTEXT));
	}

	async fillGap(gap: Gap): Promise<void> {
		const transcript = this.#transcript;
		if (transcript === undefined) return;
		setView(await transcript.fillGap(gap, BACKGROUND_CONTEXT));
	}

	#connect(): void {
		this.pause();
		const controller = new AbortController();
		this.#controller = controller;
		const params = new URLSearchParams();
		if (this.#followed !== undefined) {
			params.set("session", String(this.#followed.session));
			if (this.#followed.agent !== undefined) params.set("agent", String(this.#followed.agent));
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
		if (response.status === 404) {
			// What it asked for is not there, such as an agent of another session: nothing to come back for.
			this.#controller = undefined;
			setMissing(true);
			return;
		}
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
				setIndex(message.value);
				return;
			case "index-ops":
				applyIndexOps(message.ops);
				return;
			case "session":
				setSession(message.value);
				void api.seen(message.value.id).catch(() => undefined);
				return;
			case "session-ops": {
				const next = applySessionOps(message.ops);
				// Something new that needs the person, while they are looking: mark it seen.
				if (next !== undefined && document.visibilityState === "visible" && (next.attentionAt ?? 0) > next.seenAt) void api.seen(next.id).catch(() => undefined);
				return;
			}
			case "view":
				this.#view = message.value;
				this.#merge();
				return;
			case "view-ops":
				if (this.#view === undefined) return;
				this.#view = applyOps(this.#view, message.ops);
				this.#merge();
				return;
			case "agent-doc":
				setAgentDoc(message.agent, message.doc, message.value);
				return;
			case "agent-doc-ops":
				applyAgentDocOps(message.agent, message.doc, message.ops);
				return;
			case "missing":
				setMissing(true);
				return;
			case "ping":
				return;
		}
	}

	#merge(): void {
		if (this.#view === undefined || this.#transcript === undefined) return;
		setView(this.#transcript.merge(this.#view));
	}
}

export const live = new Live();
