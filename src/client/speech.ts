// Reading replies aloud. iOS lets media play only from a tap, and a reply's audio arrives several awaits after it, so one
// shared audio element is unlocked inside the tap by playing a moment of silence, then plays each segment in turn from
// fetched audio. Segments are fetched ahead of the one playing, so `ended` swaps the next in and plays it with no await
// between: that is what keeps a reading going with the screen locked. An audio element rather than Web Audio,
// which the iPhone's silent switch mutes.
import { encodeWav } from "../shared/wav.ts";
import { api, describeFailure } from "./api.ts";
import { app, showToast } from "./store.svelte.ts";

const audio = new Audio();
/**
 * Segments fetched ahead of the one playing. More than one keeps the server's synthesizer busy, so it pulls ahead of
 * playback (it reads at about 0.6 of real time) and a long sentence after a short one leaves no gap.
 */
const AHEAD = 3;
const SILENCE = URL.createObjectURL(new Blob([encodeWav(new Float32Array(2400), 24_000)], { type: "audio/wav" }));

/** The server's WAV: a 44-byte header, then 16-bit mono samples at 24 kHz. */
const WAV_HEADER = 44;
const WAV_BYTES_PER_SECOND = 48_000;

/** Each reply's script once complete, so reading it again costs no model call. */
const scripts = new Map<string, readonly string[]>();

type Playback = {
	key: string;
	controller: AbortController;
	segments: string[];
	/** The whole script is in `segments`. */
	complete: boolean;
	/** The next segment to fetch. */
	next: number;
	fetching: boolean;
	/** When the segment being fetched was asked for. */
	fetchStarted: number;
	/** How long the segments fetched so far took to arrive, and how many characters they held. */
	fetchedMs: number;
	fetchedChars: number;
	/** Fetched segments waiting to play, in order, each with how long it plays. */
	ready: Array<{ url: string; seconds: number }>;
	/** What the element is playing, released when it is done with. */
	playing: string | undefined;
	/** The element ran out with nothing ready, so the next segment plays as soon as it arrives, unless `hold` waits. */
	starved: boolean;
};

let current: Playback | undefined;

/** Read `markdown` aloud, as the reply `key` of session `session`; stops whatever was reading. Call it inside the tap. */
export function speak(key: string, session: number, markdown: string): void {
	stopReading();
	const playback: Playback = {
		key,
		controller: new AbortController(),
		segments: [],
		complete: false,
		next: 0,
		fetching: false,
		fetchStarted: 0,
		fetchedMs: 0,
		fetchedChars: 0,
		ready: [],
		playing: undefined,
		starved: false,
	};
	current = playback;
	app.reading = { key, state: "preparing" };
	// Within the tap, before anything waits: this is what lets the element play later without one.
	audio.src = SILENCE;
	start(playback);
	const cached = scripts.get(key);
	if (cached !== undefined) {
		playback.segments.push(...cached);
		playback.complete = true;
		fetchNext(playback);
		return;
	}
	api
		.speechScript(session, markdown, playback.controller.signal, (text) => {
			playback.segments.push(text);
			fetchNext(playback);
		})
		.then(
			() => {
				scripts.set(key, [...playback.segments]);
				playback.complete = true;
				finishIfDone(playback);
			},
			(error: unknown) => fail(playback, error),
		);
}

export function stopReading(): void {
	const playback = current;
	if (playback === undefined) return;
	current = undefined;
	playback.controller.abort();
	for (const { url } of playback.ready) release(url);
	release(playback.playing);
	audio.pause();
	audio.removeAttribute("src");
	audio.load();
	app.reading = undefined;
}

function release(url: string | undefined): void {
	if (url !== undefined) URL.revokeObjectURL(url);
}

function start(playback: Playback): void {
	audio.play().catch((error: unknown) => {
		// A newer source replaced this one before it started: not a failure.
		if (error instanceof DOMException && error.name === "AbortError") return;
		fail(playback, error);
	});
}

function play(playback: Playback, url: string): void {
	release(playback.playing);
	playback.playing = url;
	playback.starved = false;
	audio.src = url;
	start(playback);
	if (app.reading?.state !== "playing") app.reading = { key: playback.key, state: "playing" };
}

/** Fetch the next segment, one at a time, until AHEAD of them wait to play. */
function fetchNext(playback: Playback): void {
	if (playback !== current || playback.fetching || playback.ready.length >= AHEAD) return;
	const text = playback.segments[playback.next];
	if (text === undefined) return;
	playback.next++;
	playback.fetching = true;
	playback.fetchStarted = performance.now();
	api.speech(text, playback.controller.signal).then(
		(blob) => {
			playback.fetching = false;
			if (playback !== current) return;
			playback.fetchedMs += performance.now() - playback.fetchStarted;
			playback.fetchedChars += text.length;
			playback.ready.push({ url: URL.createObjectURL(blob), seconds: (blob.size - WAV_HEADER) / WAV_BYTES_PER_SECOND });
			fetchNext(playback);
			const next = playback.starved && !hold(playback) ? playback.ready.shift() : undefined;
			if (next !== undefined) play(playback, next.url);
			finishIfDone(playback);
		},
		(error: unknown) => fail(playback, error),
	);
}

/**
 * Whether to wait for the segment being fetched before playing what is ready, when nothing plays: it is expected to
 * arrive after what is ready has played, so playing now would leave a gap in the reading. That happens after a short
 * first sentence (a heading, "Done."), since the server reads at about 0.6 of real time: one wait at the start
 * rather than a stammer after the first words. Expected from how long the segments so far took per character.
 */
function hold(playback: Playback): boolean {
	const fetching = playback.segments[playback.next - 1];
	if (!playback.fetching || fetching === undefined || playback.fetchedChars === 0) return false;
	const expected = (playback.fetchedMs / playback.fetchedChars) * fetching.length - (performance.now() - playback.fetchStarted);
	const ready = playback.ready.reduce((total, segment) => total + segment.seconds, 0);
	return expected > ready * 1000;
}

function finishIfDone(playback: Playback): void {
	const done = playback.complete && playback.starved && !playback.fetching && playback.ready.length === 0 && playback.next >= playback.segments.length;
	if (playback === current && done) stopReading();
}

audio.addEventListener("ended", () => {
	const playback = current;
	if (playback === undefined) return;
	const next = playback.ready.shift();
	if (next === undefined) {
		playback.starved = true;
		finishIfDone(playback);
		return;
	}
	play(playback, next.url);
	fetchNext(playback);
});

audio.addEventListener("error", () => {
	if (current !== undefined) fail(current, new Error("The phone could not play the audio."));
});

function fail(playback: Playback, error: unknown): void {
	if (playback !== current || playback.controller.signal.aborted) return;
	stopReading();
	const blocked = error instanceof DOMException && error.name === "NotAllowedError";
	const failure = blocked ? { message: "The phone did not let pigui play audio." } : describeFailure(error);
	showToast({ message: `Could not read this aloud. ${failure.message} ${failure.hint ?? "Tap the speaker to try again."}` }, 10_000);
}
