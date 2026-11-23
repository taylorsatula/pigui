import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type ConversationId, UsageDoc } from "@earendil-works/pi-durable";
import { type ApiError, type Bootstrap, type ScriptLine, SPEECH_SEGMENT_CHARS } from "../src/shared/api.ts";
import { spentOf } from "../src/shared/spend.ts";
import { silentLogger } from "../src/server/log.ts";
import { kokoroInstalled, kokoroSynthesizer } from "../src/server/speech/kokoro.ts";
import { context, TestServer } from "./helpers.ts";

/** `lead` and `trail`: the seconds of silence before the first sample above 1% of full scale and after the last. */
type Wav = { riff: string; wave: string; format: number; channels: number; rate: number; bits: number; dataBytes: number; seconds: number; peak: number; lead: number; trail: number };

function readWav(bytes: Uint8Array): Wav {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const text = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
	const rate = view.getUint32(24, true);
	const dataBytes = view.getUint32(40, true);
	let peak = 0;
	let first: number | undefined;
	let last = 0;
	const samples = dataBytes / 2;
	for (let index = 0; index < samples; index++) {
		const level = Math.abs(view.getInt16(44 + 2 * index, true)) / 0x7fff;
		peak = Math.max(peak, level);
		if (level >= 0.01) {
			first ??= index;
			last = index;
		}
	}
	const lead = (first ?? samples) / rate;
	const trail = first === undefined ? 0 : (samples - 1 - last) / rate;
	return { riff: text(0), wave: text(8), format: view.getUint16(20, true), channels: view.getUint16(22, true), rate, bits: view.getUint16(34, true), dataBytes, seconds: samples / rate, peak, lead, trail };
}

/** Every line of a speech script, with when each arrived. */
async function script(server: TestServer, id: number, text: string): Promise<{ lines: ScriptLine[]; at: number[] }> {
	const response = await fetch(`${server.app.url}/api/sessions/${id}/speech-script`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text }),
	});
	assert.equal(response.status, 200);
	assert.match(response.headers.get("content-type") ?? "", /^application\/x-ndjson/);
	const lines: ScriptLine[] = [];
	const at: number[] = [];
	let buffer = "";
	for await (const chunk of response.body!.pipeThrough(new TextDecoderStream())) {
		buffer += chunk;
		const parts = buffer.split("\n");
		buffer = parts.pop() ?? "";
		for (const line of parts.filter((part) => part !== "")) {
			lines.push(JSON.parse(line) as ScriptLine);
			at.push(performance.now());
		}
	}
	return { lines, at };
}

async function post(server: TestServer, path: string, body: string): Promise<Response> {
	return fetch(server.app.url + path, { method: "POST", headers: { "content-type": "application/json" }, body });
}

/** The real model is tried only where this checkout has it (npm ci, then deploy/models.sh models speech). */
const installed = await kokoroInstalled();

const REPLY = [
	"## What changed",
	"The **parser** now reads `src/config.ts` before it opens the socket. The [design notes](https://example.com/notes) say why.",
	"```ts\nexport function parse(text: string): Config {\n\treturn JSON.parse(text);\n}\n```",
	"- Reads the file first\n- Opens the socket after",
	"This paragraph runs long on purpose, so that it cannot be read in one go. It has several sentences, each of them short enough on its own. Together they are longer than one segment holds. So the server cuts the paragraph between its sentences, and never in the middle of one.",
	"One sentence can run too long by itself, with clause after clause and pause after pause, going on well past what the voice reads in a single call, so the server cuts it after the last comma that still fits, and reads the rest next.",
].join("\n\n");

describe("reading a reply aloud", () => {
	test("its speakable script streams back a segment at a time, and its cost counts toward the session", async () => {
		const asked: string[] = [];
		const server = await TestServer.start({ fakeModel: { tokensPerSecond: 100, onRequest: (kind, text) => void (kind === "speech" && asked.push(text)) } });
		try {
			const id = await server.createSession("What does greet() return?");
			await server.settled(id);
			const spent = spentOf(await server.app.harness.snapshot(UsageDoc, id as ConversationId, context));

			const { lines, at } = await script(server, id, REPLY);
			assert.deepEqual(asked, [REPLY], "the session's model is asked once, with the reply's Markdown");
			assert.deepEqual(lines.at(-1), { t: "done" });
			const segments = lines.flatMap((line) => (line.t === "segment" ? [line.text] : []));
			assert.equal(segments.length, lines.length - 1);
			// A sentence to a segment, in order, with the code block described rather than read, and a sentence too long by
			// itself cut at its last pause that fits.
			assert.deepEqual(segments, [
				"What changed.",
				"The parser now reads src/config.ts before it opens the socket.",
				"The design notes say why.",
				"A code block.",
				"Reads the file first.",
				"Opens the socket after.",
				"This paragraph runs long on purpose, so that it cannot be read in one go.",
				"It has several sentences, each of them short enough on its own.",
				"Together they are longer than one segment holds.",
				"So the server cuts the paragraph between its sentences, and never in the middle of one.",
				"One sentence can run too long by itself, with clause after clause and pause after pause, going on well past what the voice reads in a single call,",
				"so the server cuts it after the last comma that still fits, and reads the rest next.",
			]);
			for (const segment of segments) assert.ok(segment.length <= SPEECH_SEGMENT_CHARS, `${segment.length} characters: ${segment}`);
			// The first segment came while the model was still writing, long before the script was done.
			assert.ok((at.at(-1) ?? 0) - (at[0] ?? 0) > 300, `first segment ${Math.round((at.at(-1) ?? 0) - (at[0] ?? 0))} ms before the end`);

			const after = await server.app.harness.snapshot(UsageDoc, id as ConversationId, context);
			assert.ok(spentOf(after) > spent, "the rewrite's cost is in the session's spend");
			// Counted as Durable counts its own requests, every counter, so the cost's parts still add up to its total.
			for (const usage of Object.values(after?.models ?? {})) {
				const parts = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
				assert.ok(Math.abs(parts - usage.cost.total) < 1e-9, `parts ${parts}, total ${usage.cost.total}`);
			}
		} finally {
			await server.close();
		}
	});

	test("a failed rewrite ends the script with what went wrong and what to do", async () => {
		const server = await TestServer.start();
		try {
			const id = await server.createSession("What does greet() return?");
			await server.settled(id);
			const { lines } = await script(server, id, "Read this [speech-fails]");
			assert.equal(lines.length, 1);
			const [line] = lines;
			assert.equal(line?.t, "error");
			assert.match(line.t === "error" ? line.error : "", /Scripted speech failure/);
			assert.equal(line.t === "error" ? line.hint : undefined, "Tap the speaker to try again.");
		} finally {
			await server.close();
		}
	});

	test("the audio endpoint answers one segment with a 16-bit mono WAV at 24 kHz, as long as the text", async () => {
		const server = await TestServer.start();
		try {
			const read = async (text: string) => {
				const response = await post(server, "/api/speech", JSON.stringify({ text }));
				assert.equal(response.status, 200);
				assert.equal(response.headers.get("content-type"), "audio/wav");
				const bytes = new Uint8Array(await response.arrayBuffer());
				assert.equal(Number(response.headers.get("content-length")), bytes.length);
				const wav = readWav(bytes);
				assert.deepEqual({ riff: wav.riff, wave: wav.wave, format: wav.format, channels: wav.channels, rate: wav.rate, bits: wav.bits }, {
					riff: "RIFF",
					wave: "WAVE",
					format: 1,
					channels: 1,
					rate: 24_000,
					bits: 16,
				});
				assert.equal(wav.dataBytes, bytes.length - 44);
				return wav;
			};
			const short = await read("Done.");
			const long = await read("The parser now reads the configuration file before it opens the socket.");
			assert.ok(short.seconds > 0 && long.seconds > short.seconds * 5, `${short.seconds} s and ${long.seconds} s`);
		} finally {
			await server.close();
		}
	});

	test("bad input is refused with 400 at the boundary, and an unknown session with 404", async () => {
		const server = await TestServer.start();
		try {
			for (const body of ["{}", JSON.stringify({ text: "" }), JSON.stringify({ text: "a".repeat(SPEECH_SEGMENT_CHARS + 1) }), "not json", JSON.stringify({ text: 5 })]) {
				const response = await post(server, "/api/speech", body);
				assert.equal(response.status, 400, body);
				assert.ok(((await response.json()) as ApiError).error !== "");
			}
			const id = await server.createSession("What does greet() return?");
			await server.settled(id);
			for (const body of ["{}", JSON.stringify({ text: "" }), "not json"]) {
				assert.equal((await post(server, `/api/sessions/${id}/speech-script`, body)).status, 400, body);
			}
			const missing = await post(server, "/api/sessions/9999/speech-script", JSON.stringify({ text: "Hello." }));
			assert.equal(missing.status, 404);
			assert.equal(((await missing.json()) as ApiError).error, "The session was not found.");
		} finally {
			await server.close();
		}
	});

	test("a server built without speech says so, and answers both endpoints with 404 and why", async () => {
		const server = await TestServer.start({ speech: false });
		try {
			assert.equal((await server.get<Bootstrap>("/api/bootstrap")).speech, false);
			const id = await server.createSession("What does greet() return?");
			await server.settled(id);
			for (const path of ["/api/speech", `/api/sessions/${id}/speech-script`]) {
				const response = await post(server, path, JSON.stringify({ text: "Hello." }));
				assert.equal(response.status, 404, path);
				const body = (await response.json()) as ApiError;
				assert.equal(body.error, "Reading aloud is not available on this server.");
				assert.match(body.hint ?? "", /PICLOUD_SPEECH=off/);
			}
		} finally {
			await server.close();
		}
		const speaking = await TestServer.start();
		try {
			assert.equal((await speaking.get<Bootstrap>("/api/bootstrap")).speech, true);
		} finally {
			await speaking.close();
		}
	});

	test("real Kokoro reads a short phrase, with only a sentence's pause of silence around it", { skip: installed ? false : "the speech model is not installed: deploy/models.sh models speech" }, async () => {
		const wav = readWav(await kokoroSynthesizer(silentLogger).synthesize("picloud reads replies aloud.", new AbortController().signal));
		assert.equal(wav.rate, 24_000);
		assert.ok(wav.seconds > 1 && wav.seconds < 6, `${wav.seconds} s`);
		assert.ok(wav.peak > 0.1, "it is not silence");
		// Kokoro pads with about 0.3 s before and 0.5 s after; one segment follows another, so most of it goes.
		assert.ok(wav.lead < 0.1 && wav.trail < 0.3, `${wav.lead.toFixed(3)} s before, ${wav.trail.toFixed(3)} s after`);
	});
});
