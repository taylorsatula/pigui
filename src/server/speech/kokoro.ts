// Speech synthesis with Kokoro-82M through kokoro-js: the 8-bit model on the CPU, in the af_heart voice. kokoro-js is an
// optional dependency that a build leaves out with PICLOUD_SPEECH=off, so it is imported only when speech is first used.
// deploy/speech-model.sh bakes the model into the app's models directory; the voice ships inside kokoro-js, which reads
// it from its own package in Node. At runtime nothing touches the network or writes a cache: the container's root is
// read-only.
import { access } from "node:fs/promises";
import { join } from "node:path";
import { encodeWav } from "../../shared/wav.ts";

export type Synthesizer = {
	/** `text`, at most SPEECH_SEGMENT_CHARS, read aloud as a WAV file. */
	synthesize(text: string, signal: AbortSignal): Promise<Uint8Array>;
};

/** Where deploy/speech-model.sh puts the model: `models` beside the sources. */
export const MODELS_DIR = join(import.meta.dirname, "..", "..", "..", "models");
const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
/** The q8 weights, the last file deploy/speech-model.sh puts in place. */
const WEIGHTS = join(MODELS_DIR, MODEL, "onnx", "model_quantized.onnx");
const VOICE = "af_heart";

/** Whether this build reads aloud: kokoro-js is installed and its model is in place. */
export async function kokoroInstalled(): Promise<boolean> {
	try {
		import.meta.resolve("kokoro-js");
	} catch {
		return false;
	}
	return access(WEIGHTS).then(
		() => true,
		() => false,
	);
}

async function load() {
	// One environment for the whole process, which kokoro-js loads through: local files only, and no cache to write.
	const { env } = await import("@huggingface/transformers");
	env.allowRemoteModels = false;
	env.allowLocalModels = true;
	env.localModelPath = MODELS_DIR;
	env.useFSCache = false;
	const { KokoroTTS } = await import("kokoro-js");
	return KokoroTTS.from_pretrained(MODEL, { dtype: "q8", device: "cpu" });
}

/**
 * Kokoro, loaded on first use and kept loaded (about 800 MB resident once it has read), reading one text at a time: on
 * two CPUs a second synthesis would only slow the first.
 */
export function kokoroSynthesizer(): Synthesizer {
	let model: ReturnType<typeof load> | undefined;
	let queue: Promise<unknown> = Promise.resolve();
	return {
		synthesize(text, signal) {
			const turn = queue.then(async () => {
				// Stopped while it waited its turn: nothing is read for it.
				signal.throwIfAborted();
				model ??= load().catch((error: unknown) => {
					model = undefined;
					throw error;
				});
				const audio = await (await model).generate(text, { voice: VOICE });
				return encodeWav(audio.audio, audio.sampling_rate);
			});
			queue = turn.catch(() => undefined);
			return turn;
		},
	};
}
