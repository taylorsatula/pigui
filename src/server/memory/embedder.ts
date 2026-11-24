// Embeddings for long-term memory: an OpenAI-compatible /embeddings endpoint signed with the credential Pi holds for the
// configured provider (pi-ai has no embeddings API), or LEAF on this server (leaf.ts). Fake mode embeds without a network.
import { join } from "node:path";
import { type ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { MemoryConfig } from "../config.ts";
import { errorKind } from "../log.ts";

/**
 * What a text is to retrieval: a query searches, a document (a memory, and the golden sentence) is searched. An
 * asymmetric model embeds the two differently; the others ignore it.
 */
export type EmbedKind = "query" | "document";

export type Embedder = {
	/** The model's name, stored beside the vectors: vectors from different models are not comparable. */
	model: string;
	/**
	 * The cosine a memory must reach to count as a match. Each model spreads its scores differently, so it is measured per
	 * model, against off-topic queries: the floor rejects off-topic work, it does not tune precision.
	 */
	floor: number;
	/** One vector per text, in order. Throws on any failure rather than returning silent zeros. */
	embed(texts: readonly string[], kind: EmbedKind, signal?: AbortSignal): Promise<Float32Array[]>;
};

const EMBED_TIMEOUT_MS = 30_000;

/** Texts per request. Sending every text in one request outgrows a re-embedding of a large store. */
const BATCH = 128;

/**
 * Measured on `emb-qwen3` over a 35-memory benchmark (queries share no content words with their targets,
 * so the numbers are semantic, not lexical). 0.44 clears the off-topic peak (0.408) and the weakest on-topic match
 * (0.477) by ~0.035; recall is flat in the floor from 0.30–0.49. Unmeasured for any other model an endpoint serves:
 * re-measure on a benchmark of that shape for it.
 */
const QWEN3_FLOOR = 0.44;

/** Where the memory provider is lunaroute and Pi's catalog has no model of it to take a base URL from. */
const LUNAROUTE_EMBEDDINGS = "https://gw.lunaroute.com/v1/embeddings";

export function httpEmbedder(endpoint: { url: string; model: string; apiKey: string | undefined }): Embedder {
	return {
		model: endpoint.model,
		floor: QWEN3_FLOOR,
		async embed(texts, _kind, signal) {
			const vectors: Float32Array[] = [];
			for (let start = 0; start < texts.length; start += BATCH) {
				vectors.push(...(await post(endpoint, texts.slice(start, start + BATCH), signal)));
			}
			return vectors;
		},
	};
}

async function post(endpoint: { url: string; model: string; apiKey: string | undefined }, texts: readonly string[], signal: AbortSignal | undefined): Promise<Float32Array[]> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (endpoint.apiKey !== undefined) headers.authorization = `Bearer ${endpoint.apiKey}`;
	const timeout = AbortSignal.timeout(EMBED_TIMEOUT_MS);
	let response: Response;
	let body: string;
	try {
		response = await fetch(endpoint.url, {
			method: "POST",
			headers,
			body: JSON.stringify({ model: endpoint.model, input: texts }),
			// The caller's signal too: stopping a run should stop the embedding request, not just its rendering.
			signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
		});
		body = await response.text();
	} catch (error) {
		const reason = timeout.aborted ? `no answer within ${EMBED_TIMEOUT_MS / 1000} s` : error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
		// The key is never in the message: it is in the Authorization header, and errors get logged.
		throw new Error(`Embedding request to ${endpoint.url} failed: ${reason}`);
	}
	if (!response.ok) throw new Error(`Embedding request failed: HTTP ${response.status} from ${endpoint.url} — ${body.slice(0, 300)}`);
	let data: Array<{ index: number; embedding: number[] }> | undefined;
	try {
		data = (JSON.parse(body) as { data?: Array<{ index: number; embedding: number[] }> }).data;
	} catch {
		throw new Error(`Embedding response from ${endpoint.url} was not JSON: ${body.slice(0, 300)}`);
	}
	if (!Array.isArray(data) || data.length !== texts.length) {
		throw new Error(`Embedding response returned ${Array.isArray(data) ? data.length : 0} vectors for ${texts.length} inputs.`);
	}
	// Key by the returned index, never array position: the provider may reorder.
	const byIndex = new Map(data.map((item) => [item.index, Float32Array.from(item.embedding)]));
	return texts.map((_, i) => {
		const vector = byIndex.get(i);
		if (vector === undefined || vector.length === 0) throw new Error(`Embedding for input ${i} was missing or empty.`);
		return vector;
	});
}

/**
 * Real mode's embedder: the configured endpoint, signed with the key Pi holds for the memory provider, or the reason
 * memory is off. Pi resolves a provider registered in its models.json; a provider with only a key in auth.json (as
 * lunaroute usually is) is read from there.
 */
export async function piEmbedder(runtime: ModelRuntime, agentDir: string, config: MemoryConfig): Promise<{ embedder: Embedder } | { off: string }> {
	let apiKey: string | undefined;
	try {
		apiKey = (await runtime.getAuth(config.provider))?.auth.apiKey;
	} catch (error) {
		// The reason is logged, so it names the error's kind, never its message.
		return { off: `Pi could not resolve a credential for ${config.provider} (${errorKind(error)})` };
	}
	if (apiKey === undefined) {
		const stored = readStoredCredential(config.provider, join(agentDir, "auth.json"));
		// Read as written: Pi runs a `!command` key only for a provider it resolves, one registered in models.json.
		if (stored?.type === "api_key" && stored.key?.startsWith("!")) return { off: `The auth.json key for ${config.provider} is a command, which Pi runs only for a provider in models.json` };
		if (stored?.type === "api_key") apiKey = stored.key;
	}
	if (apiKey === undefined && config.embedUrl === undefined) {
		return { off: `Pi has no key for ${config.provider} (models.json or auth.json) and PIGUI_MEMORY_EMBED_URL is not set` };
	}
	const baseUrl = runtime.getModels(config.provider)[0]?.baseUrl;
	const url = config.embedUrl ?? (baseUrl !== undefined ? `${baseUrl.replace(/\/+$/, "")}/embeddings` : config.provider === "lunaroute" ? LUNAROUTE_EMBEDDINGS : undefined);
	if (url === undefined) return { off: `Pi's catalog has no base URL for ${config.provider}; set PIGUI_MEMORY_EMBED_URL` };
	return { embedder: httpEmbedder({ url, model: config.embedModel, apiKey }) };
}

const FAKE_DIMENSIONS = 256;

/**
 * Fake mode's embedder: each word of three letters or more hashed into one of a few hundred dimensions and counted,
 * then L2-normalised, so texts sharing most of their words land close together and unrelated ones do not. The model's
 * name seeds the hash, so another name gives vectors the first cannot be compared with, as another model would.
 */
export function fakeEmbedder(model = "fake-words"): Embedder {
	return {
		model,
		// The scripted query and memory score about 0.85; unrelated texts stay under 0.3.
		floor: 0.44,
		async embed(texts) {
			return texts.map((text) => {
				const vector = new Float32Array(FAKE_DIMENSIONS);
				for (const word of text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) vector[fnv1a(`${model}:${word}`) % FAKE_DIMENSIONS]! += 1;
				const norm = Math.hypot(...vector);
				return norm === 0 ? vector : vector.map((value) => value / norm);
			});
		},
	};
}

function fnv1a(text: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
	return hash >>> 0;
}
