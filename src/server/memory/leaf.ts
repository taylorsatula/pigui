// Memory's embeddings on this server, with no key and no network: MongoDB's LEAF in its asymmetric form
// (mdbr-leaf-ir-asym). A query is embedded by mdbr-leaf-ir, 23M parameters distilled from snowflake-arctic-embed-m-v1.5
// into that model's vector space; a memory, which is embedded once and searched many times, by arctic itself. Both run
// through transformers.js on the CPU, 8-bit, from the ONNX exports of the two repositories the asymmetric model is
// packaged from (its own weights are byte-identical to theirs). `deploy/models.sh DIR memory` bakes them in; the build
// switch is PICLOUD_MEMORY_LOCAL.
import { access } from "node:fs/promises";
import { join } from "node:path";
import { errorKind, type Logger } from "../log.ts";
import { MODELS_DIR, transformers } from "../transformers.ts";
import type { Embedder } from "./embedder.ts";

const QUERY_MODEL = "MongoDB/mdbr-leaf-ir";
const DOCUMENT_MODEL = "Snowflake/snowflake-arctic-embed-m-v1.5";
/** The prompt the asymmetric model's configuration gives queries; documents take none. */
const QUERY_PROMPT = "Represent this sentence for searching relevant passages: ";

/**
 * Measured with the original's method on a set of its own shape: 14 memories written to the create rules, each with a
 * distill sharing no content word with it, and the original's 12 off-topic queries, every text embedded alone. The
 * ranges overlap: the off-topic peak is 0.275 and the weakest on-topic matches 0.263 and 0.286 (mean 0.380). The
 * floor's job is to reject off-topic work, so it sits just above that peak: 13 of 14 targets clear it, no off-topic
 * query does, and 12 of 14 ranked first. Thin, and over a small set: re-measure with a real store.
 */
const LEAF_FLOOR = 0.28;

/** The last file of each model deploy/models.sh puts in place for memory. */
const WEIGHTS = [join(MODELS_DIR, QUERY_MODEL, "onnx", "model_quantized.onnx_data"), join(MODELS_DIR, DOCUMENT_MODEL, "onnx", "model_quantized.onnx")];

/** Whether this build embeds on the server: @huggingface/transformers is installed and both models are in place. */
export async function leafInstalled(): Promise<boolean> {
	try {
		import.meta.resolve("@huggingface/transformers");
	} catch {
		return false;
	}
	return Promise.all(WEIGHTS.map((file) => access(file))).then(
		() => true,
		() => false,
	);
}

async function load() {
	const { AutoModel, AutoTokenizer } = await transformers();
	const [queryTokenizer, queryModel, documentTokenizer, documentModel] = await Promise.all([
		AutoTokenizer.from_pretrained(QUERY_MODEL),
		// Its weights sit in a file of their own beside the graph.
		AutoModel.from_pretrained(QUERY_MODEL, { dtype: "q8", device: "cpu", use_external_data_format: true }),
		AutoTokenizer.from_pretrained(DOCUMENT_MODEL),
		AutoModel.from_pretrained(DOCUMENT_MODEL, { dtype: "q8", device: "cpu" }),
	]);
	return {
		query: { tokenizer: queryTokenizer, model: queryModel },
		document: { tokenizer: documentTokenizer, model: documentModel },
	};
}

/** How long the models stay loaded after their last use: releasing them gives back about 300 MB, and loading takes half a second. */
const IDLE_MS = 5 * 60_000;

/**
 * LEAF, loaded on first use and released after five idle minutes. Both exports end in the model's own pooling and
 * normalisation (mean and a dense projection to 768 dimensions for the query model, the CLS token for arctic), as the
 * `sentence_embedding` output, so a text's vector is that output as it stands.
 */
export function leafEmbedder(log: Logger): Embedder {
	let models: ReturnType<typeof load> | undefined;
	let busy = 0;
	let idle: NodeJS.Timeout | undefined;
	const release = () => {
		const loaded = models;
		models = undefined;
		loaded
			?.then((both) => Promise.all([both.query.model.dispose(), both.document.model.dispose()]))
			.catch((error: unknown) => log.error("memory.release", { error: errorKind(error) }));
	};
	return {
		model: "mdbr-leaf-ir-asym",
		floor: LEAF_FLOOR,
		async embed(texts, kind, signal) {
			if (texts.length === 0) return [];
			busy++;
			clearTimeout(idle);
			try {
				models ??= load().catch((error: unknown) => {
					models = undefined;
					throw error;
				});
				const { tokenizer, model } = (await models)[kind];
				// One text per pass. The 8-bit models quantize their activations with one scale per tensor, taken over the
				// whole batch, padding included, so in a batch a text's vector depends on the texts beside it (cosine 0.990
				// to the same text alone, measured). Alone, a vector is a function of its text, as stored vectors must be.
				const vectors: Float32Array[] = [];
				for (const text of texts) {
					signal?.throwIfAborted();
					const inputs = await tokenizer(kind === "query" ? QUERY_PROMPT + text : text, { truncation: true });
					const { sentence_embedding: embedding } = await model(inputs);
					vectors.push((embedding.data as Float32Array).slice());
				}
				return vectors;
			} finally {
				if (--busy === 0) idle = setTimeout(release, IDLE_MS).unref();
			}
		},
	};
}
