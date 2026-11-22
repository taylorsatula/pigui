// Speech synthesis with Kokoro-82M through kokoro-js: the 8-bit model on the CPU, in the af_heart voice. kokoro-js is an
// optional dependency that a build leaves out with PICLOUD_SPEECH=off, so it is imported only when speech is first used.
// deploy/models.sh bakes the model into the app's models directory; the voice ships inside kokoro-js, which reads
// it from its own package in Node. At runtime nothing touches the network or writes a cache (see transformers.ts): the
// container's root is read-only.
import { access } from "node:fs/promises";
import { join } from "node:path";
import { encodeWav } from "../../shared/wav.ts";
import { errorKind, type Logger } from "../log.ts";
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

/** How long Kokoro stays loaded after it last read: releasing it gives back about 400 MB, and loading again takes a second. */
const IDLE_MS = 5 * 60_000;

/**
 * Kokoro, loaded on first use (about 650 MB more resident while it reads) and released after five idle minutes, reading
 * one text at a time: on two CPUs a second synthesis would only slow the first.
 */
export function kokoroSynthesizer(log: Logger): Synthesizer {
	let model: ReturnType<typeof load> | undefined;
	let queue: Promise<unknown> = Promise.resolve();
	let waiting = 0;
	let idle: NodeJS.Timeout | undefined;
	const release = () => {
		const loaded = model;
		model = undefined;
		loaded
			?.then((tts) => tts.model.dispose())
			.catch((error: unknown) => log.error("speech.release", { error: errorKind(error) }));
	};
	return {
		synthesize(text, signal) {
			waiting++;
			clearTimeout(idle);
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
			queue = turn
				.catch(() => undefined)
				.finally(() => {
					if (--waiting === 0) idle = setTimeout(release, IDLE_MS).unref();
				});
			return turn;
		},
	};
}
