// WAV, 16-bit PCM in one channel: every browser plays it, iOS Safari included. The server encodes what Kokoro (or fake
// mode's tone) produces; the phone encodes the moment of silence that unlocks its audio element.

const HEADER_BYTES = 44;

/** `samples` in -1 to 1, clipped, as a WAV file at `sampleRate`. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(HEADER_BYTES + samples.length * 2);
	const view = new DataView(bytes.buffer);
	const ascii = (offset: number, text: string) => {
		for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index));
	};
	ascii(0, "RIFF");
	view.setUint32(4, bytes.length - 8, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true); // bytes per second
	view.setUint16(32, 2, true); // bytes per frame
	view.setUint16(34, 16, true); // bits per sample
	ascii(36, "data");
	view.setUint32(40, samples.length * 2, true);
	samples.forEach((sample, index) => {
		const clipped = Math.max(-1, Math.min(1, sample));
		view.setInt16(HEADER_BYTES + index * 2, Math.round(clipped * 0x7fff), true);
	});
	return bytes;
}
