// Long-term memory on its Durable document: keeping the stored vectors comparable with the embedding model, ranking
// memories against a query, and applying what a report records. Searched in memory: fine up to a few thousand memories.
import { randomBytes } from "node:crypto";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Draft } from "@earendil-works/chord/delta";
import type { Harness } from "@earendil-works/pi-durable";
import type { ReportMemory } from "../../shared/session.ts";
import { type MemoryDoc, type MemoryRow, MemoryToken } from "../documents.ts";
import type { SurfaceHit, SurfaceResult } from "./directives.ts";
import type { Embedder } from "./embedder.ts";

/**
 * K=8 is the knee of the benchmark this ranking was tuned on: recall plateaus there, precision decays beyond it. The
 * similarity floor belongs to the embedding model, so each embedder carries its own (embedder.ts).
 */
const TOP_K = 8;

/** DECLINED-ALTERNATIVE: hubness correction. +0.11 MRR on terse queries but +0.003 once the distill names the machinery, at O(n²·dim) per query. Revisit past a few thousand rows. */
const VOTE_STEP = 0.5;
const SCORE_WEIGHT = 0.05;
const SCORE_INFLUENCE_CAP = 0.25;

/** A neutral sentence embedded beside the rows: when its vector stops reproducing, the model changed under its name. */
const GOLDEN_TEXT = "The blue kettle on the second shelf holds one and a half litres of water.";
const GOLDEN_MIN_COSINE = 0.999;

/** A report's memory part as the agent wrote it. */
export type MemoryChanges = {
	create: string[];
	helpful: { id: string; helpful: boolean }[];
	edit: { id: string; text: string }[];
	delete: string[];
};

/** A report's memory changes, embedded and ready to apply in the report's commit. */
export type PreparedChanges = {
	delete: string[];
	edit: { id: string; text: string; emb: string }[];
	create: { text: string; emb: string }[];
	helpful: { id: string; helpful: boolean }[];
};

export class Memory {
	readonly embedder: Embedder;
	readonly #harness: () => Harness;
	/**
	 * The check that the stored vectors were made by this embedder, made once per process: it costs an embedding round
	 * trip and its answer cannot change while the process runs. Shared while it runs, and cleared when it fails, so the
	 * next call tries again rather than searching mismatched vectors.
	 */
	#checked: Promise<void> | undefined;

	constructor(embedder: Embedder, harness: () => Harness) {
		this.embedder = embedder;
		this.#harness = harness;
	}

	async rows(context: Context): Promise<Readonly<Record<string, MemoryRow>>> {
		return (await this.#harness().snapshot(MemoryToken, context))?.rows ?? {};
	}

	/** The memories that match `query` best, above the floor and ranked with their ratings. */
	async search(query: string, context: Context): Promise<SurfaceResult> {
		await this.#ensureEmbeddings();
		const [vector] = await this.embedder.embed([query], "query", context.abortSignal);
		const rows = await this.rows(context);
		const ranked: { id: string; row: MemoryRow; similarity: number; rank: number }[] = [];
		let bestMiss = 0;
		for (const [id, row] of Object.entries(rows)) {
			const similarity = cosine(vector!, decodeVector(row.emb));
			if (similarity < this.embedder.floor) {
				if (similarity > bestMiss) bestMiss = similarity;
				continue;
			}
			const influence = Math.max(-SCORE_INFLUENCE_CAP, Math.min(SCORE_INFLUENCE_CAP, row.score * SCORE_WEIGHT));
			ranked.push({ id, row, similarity, rank: similarity + influence });
		}
		ranked.sort((a, b) => b.rank - a.rank);
		const hits = ranked.slice(0, TOP_K).map(
			({ id, row, similarity }): SurfaceHit => ({
				id,
				text: row.text,
				score: Number(row.score.toFixed(2)),
				similarity: Number(similarity.toFixed(4)),
				session: row.sessions.at(-1),
				stamps: row.sessions.length,
			}),
		);
		return { hits, total: Object.keys(rows).length, floor: this.embedder.floor, bestMiss: Number(bestMiss.toFixed(4)) };
	}

	/** Trim and embed what a report creates and edits, in one round trip for the whole batch. Throws when embedding fails. */
	async prepare(changes: MemoryChanges, signal: AbortSignal | undefined): Promise<PreparedChanges> {
		const create = changes.create.map((text) => text.trim()).filter((text) => text !== "");
		const edit = changes.edit.map((item) => ({ id: item.id, text: item.text.trim() }));
		const texts = [...create, ...edit.map((item) => item.text)];
		let vectors: Float32Array[] = [];
		if (texts.length > 0) {
			await this.#ensureEmbeddings();
			vectors = await this.embedder.embed(texts, "document", signal);
		}
		return {
			delete: [...new Set(changes.delete)],
			edit: edit.map((item, i) => ({ ...item, emb: encodeVector(vectors[create.length + i]!) })),
			create: create.map((text, i) => ({ text, emb: encodeVector(vectors[i]!) })),
			helpful: changes.helpful,
		};
	}

	#ensureEmbeddings(): Promise<void> {
		this.#checked ??= this.#reembedIfStale().catch((error: unknown) => {
			this.#checked = undefined;
			throw error;
		});
		return this.#checked;
	}

	/**
	 * Vectors are comparable only within one embedding model, so a stored model name other than this embedder's, or a
	 * golden vector that no longer reproduces, regenerates every embedding. Shared by every caller, so it runs without
	 * any one caller's signal.
	 */
	async #reembedIfStale(): Promise<void> {
		const harness = this.#harness();
		const [golden] = await this.embedder.embed([GOLDEN_TEXT], "document");
		const doc = await harness.snapshot(MemoryToken, BACKGROUND_CONTEXT);
		if (doc?.embedder === this.embedder.model && doc.golden !== undefined && cosine(golden!, decodeVector(doc.golden)) >= GOLDEN_MIN_COSINE) return;
		const rows = Object.entries(doc?.rows ?? {});
		const vectors = await this.embedder.embed(rows.map(([, row]) => row.text), "document");
		await harness.commit(async (tx) => {
			const store = await tx.doc(MemoryToken);
			rows.forEach(([id, row], i) => {
				// Vectors only: re-embedding is not an edit, and updatedAt is authorship. A memory a report changed meanwhile
				// already has a vector from this embedder, and one it deleted stays deleted.
				const current = store.rows[id];
				if (current !== undefined && current.text === row.text) current.emb = encodeVector(vectors[i]!);
			});
			store.embedder = this.embedder.model;
			store.golden = encodeVector(golden!);
		}, BACKGROUND_CONTEXT);
	}
}

/**
 * Apply a report's memory changes inside the report's commit, in the order delete, edit, create, helpful. A memory
 * another session removed since the report was checked is skipped. Returns what was done (undefined when nothing was)
 * and the rated ids that matched no memory: reported, not an error, since a rating may name one from an earlier session.
 */
export function applyChanges(doc: Draft<MemoryDoc>, changes: PreparedChanges, session: string, now: number): { done: ReportMemory | undefined; missing: string[] } {
	const done: ReportMemory = { created: [], edited: [], deleted: [], helpful: 0, unhelpful: 0 };
	const missing: string[] = [];
	for (const id of changes.delete) {
		if (doc.rows[id] === undefined) continue;
		delete doc.rows[id];
		done.deleted.push(id);
	}
	for (const { id, text, emb } of changes.edit) {
		const row = doc.rows[id];
		if (row === undefined) continue;
		row.text = text;
		row.emb = emb;
		if (row.sessions.at(-1) !== session) row.sessions.push(session);
		row.updatedAt = now;
		done.edited.push({ id, text });
	}
	for (const { text, emb } of changes.create) {
		const id = newId(doc.rows);
		doc.rows[id] = { text, emb, score: 0, sessions: [session], createdAt: now, updatedAt: now };
		done.created.push({ id, text });
	}
	// true moves a memory up future rankings, false sinks it toward silt.
	for (const vote of changes.helpful) {
		const row = doc.rows[vote.id];
		if (row === undefined) {
			missing.push(vote.id);
			continue;
		}
		row.score += vote.helpful ? VOTE_STEP : -VOTE_STEP;
		row.updatedAt = now;
		if (vote.helpful) done.helpful++;
		else done.unhelpful++;
	}
	const changed = done.created.length + done.edited.length + done.deleted.length + done.helpful + done.unhelpful > 0;
	return { done: changed ? done : undefined, missing };
}

function newId(rows: Readonly<Record<string, unknown>>): string {
	for (let attempt = 0; attempt < 20; attempt++) {
		const id = randomBytes(4).toString("hex");
		if (rows[id] === undefined) return id;
	}
	throw new Error("Could not allocate a free memory id after 20 attempts.");
}

function cosine(a: Float32Array, b: Float32Array): number {
	// Vectors of different lengths come from different models; they never match.
	if (a.length !== b.length) return 0;
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i]! * b[i]!;
		na += a[i]! * a[i]!;
		nb += b[i]! * b[i]!;
	}
	const denom = Math.sqrt(na) * Math.sqrt(nb);
	return denom === 0 ? 0 : dot / denom;
}

function encodeVector(vector: Float32Array): string {
	return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("base64");
}

function decodeVector(text: string): Float32Array {
	const bytes = Buffer.from(text, "base64");
	// Copied, so the vector is aligned whatever offset Buffer's pool gave the bytes.
	return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
