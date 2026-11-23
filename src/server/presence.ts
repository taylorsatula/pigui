// Which sessions the person is looking at right now. A session is "viewed" while a live stream is open; the app
// closes its stream when it goes to the background, so a phone in a pocket is not looking. This is the moment's
// truth, not state worth keeping, so it lives only in memory.
export class Presence {
	readonly #viewers = new Map<number, number>();

	/** Mark `session` as being viewed until the returned function is called. */
	enter(session: number): () => void {
		this.#viewers.set(session, (this.#viewers.get(session) ?? 0) + 1);
		let left = false;
		return () => {
			if (left) return;
			left = true;
			const count = (this.#viewers.get(session) ?? 1) - 1;
			if (count <= 0) this.#viewers.delete(session);
			else this.#viewers.set(session, count);
		};
	}

	viewing(session: number): boolean {
		return this.#viewers.has(session);
	}
}
