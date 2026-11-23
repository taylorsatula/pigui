// Speech synthesis with Kokoro-82M through kokoro-js: the 8-bit model on the CPU, in the af_heart voice. kokoro-js is an
// optional dependency that a build leaves out with PIGUI_SPEECH=off, so it is imported only where it is installed.
// deploy/models.sh bakes the model into the app's models directory; the voice ships inside kokoro-js, which reads
// it from its own package in Node. At runtime nothing touches the network or writes a cache (see transformers.ts): the
// container's root is read-only.
import { access } from "node:fs/promises";
import { join } from "node:path";
import { encodeWav } from "../../shared/wav.ts";
import { heldModel } from "../held-model.ts";
import type { Logger } from "../log.ts";
import { MODELS_DIR, transformers } from "../transformers.ts";

export type Synthesizer = {
	/** `text`, at most SPEECH_SEGMENT_CHARS, read aloud as a WAV file. */
	synthesize(text: string, signal: AbortSignal): Promise<Uint8Array>;
};

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
/** The q8 weights, the last file deploy/models.sh puts in place for speech. */
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
	// kokoro-js loads through the process's one transformers.js environment, set before it is imported.
	await transformers();
	const { KokoroTTS } = await import("kokoro-js");
	return KokoroTTS.from_pretrained(MODEL, { dtype: "q8", device: "cpu" });
}

/**
 * Silence kept around a segment's speech. Kokoro pads each one with about 0.3 s before it and 0.5 s after (measured on
 * af_heart, the same at any threshold from 0.002 to 0.01), so sentences read one after another would each be followed
 * by most of a second of nothing. What is kept, with the phone's swap to the next segment, makes a sentence's pause.
 */
const KEEP_BEFORE_S = 0.05;
const KEEP_AFTER_S = 0.2;
/** Below this the padding lies; speech rises far above it within a few milliseconds of its start. */
const QUIET = 0.005;

function trimSilence(samples: Float32Array, rate: number): Float32Array {
	let first = 0;
	while (first < samples.length && Math.abs(samples[first] ?? 0) < QUIET) first++;
	if (first === samples.length) return samples;
	let last = samples.length - 1;
	while (Math.abs(samples[last] ?? 0) < QUIET) last--;
	return samples.subarray(Math.max(0, first - Math.round(KEEP_BEFORE_S * rate)), Math.min(samples.length, last + 1 + Math.round(KEEP_AFTER_S * rate)));
}

/**
 * Kokoro, about 600 MB resident while loaded (in about 0.7 s on two vCPU), held as PIGUI_MODELS_UNLOAD says, reading
 * one text at a time: on two CPUs a second synthesis would only slow the first.
 */
export function kokoroSynthesizer(log: Logger, unloadAfterMs: number | undefined): Synthesizer {
	const kokoro = heldModel({ name: "speech", load, release: (tts) => tts.model.dispose(), unloadAfterMs, log });
	let queue: Promise<unknown> = Promise.resolve();
	return {
		synthesize(text, signal) {
			const turn = queue.then(() =>
				kokoro.use(async (tts) => {
					// Stopped while it waited its turn: nothing is read for it.
					signal.throwIfAborted();
					const audio = await tts.generate(text, { voice: VOICE });
					return encodeWav(trimSilence(audio.audio, audio.sampling_rate), audio.sampling_rate);
				}),
			);
			queue = turn.catch(() => undefined);
			return turn;
		},
	};
}
