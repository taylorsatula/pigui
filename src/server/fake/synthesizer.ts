// Fake mode's voice: a low tone held for as long as the text, so tests and the end-to-end flow can read replies aloud
// without any model or network.
import { encodeWav } from "../../shared/wav.ts";
import type { Synthesizer } from "../speech/kokoro.ts";

const SAMPLE_RATE = 24_000;
/** Roughly three times the pace of speech, so a whole reply reads aloud quickly in a test. */
const SECONDS_PER_CHAR = 0.02;

export function fakeSynthesizer(): Synthesizer {
	return {
		synthesize: async (text) => {
			const samples = new Float32Array(Math.round(text.length * SECONDS_PER_CHAR * SAMPLE_RATE));
			for (let index = 0; index < samples.length; index++) samples[index] = 0.05 * Math.sin((2 * Math.PI * 440 * index) / SAMPLE_RATE);
			return encodeWav(samples, SAMPLE_RATE);
		},
	};
}
