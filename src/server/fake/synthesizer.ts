// Fake mode's speech: a quiet tone as long as the text, so tests and the end-to-end flow read aloud without a model.
import { encodeWav } from "../../shared/wav.ts";
import type { Synthesizer } from "../speech/kokoro.ts";

const SAMPLE_RATE = 24_000;
/** About three times as fast as speech, so a test that listens to a whole reply stays quick. */
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
