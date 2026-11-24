// The transformers.js runtime that the optional on-device models load through: Kokoro for speech, and LEAF for memory's
// embeddings. Its settings are one environment for the whole process, so they are set here, once, for both.
// @huggingface/transformers is an optional dependency, imported only when a model it runs is installed.
import { join } from "node:path";

/** Where deploy/models.sh puts the models: `models` beside the sources. */
export const MODELS_DIR = join(import.meta.dirname, "..", "..", "models");

let runtime: Promise<typeof import("@huggingface/transformers")> | undefined;

/**
 * Local files only, from MODELS_DIR. `useFSCache` asks for paths rather than buffers: onnxruntime finds a model's
 * external weights (LEAF's `model_quantized.onnx_data`) beside its path, and fails to load from a buffer. A local file
 * is never written to a cache, so nothing is written on the container's read-only root.
 */
export function transformers(): Promise<typeof import("@huggingface/transformers")> {
	runtime ??= import("@huggingface/transformers").then((module) => {
		module.env.allowRemoteModels = false;
		module.env.allowLocalModels = true;
		module.env.localModelPath = MODELS_DIR;
		module.env.useFSCache = true;
		return module;
	});
	return runtime;
}
