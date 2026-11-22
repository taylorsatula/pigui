// Reading replies aloud. iOS lets media play only from a tap, and a reply's audio arrives several awaits after it, so one
// shared audio element is unlocked inside the tap by playing a moment of silence, then plays each segment in turn from
// fetched audio. Segments are fetched ahead of the one playing, so `ended` swaps the next in and plays it with no await
// between: that is what keeps a reading going with the screen locked. An audio element rather than Web Audio,
// which the iPhone's silent switch mutes.
import { encodeWav } from "../shared/wav.ts";
import { api, describeFailure } from "./api.ts";
import { showToast, store } from "./store.ts";

const audio = new Audio();
/**
 * Segments fetched ahead of the one playing. More than one keeps the server's synthesizer busy, so it pulls ahead of
 * playback (it reads at about 0.6 of real time) and a long sentence after a short one leaves no gap.
 */
const AHEAD = 3;
const SILENCE = URL.createObjectURL(new Blob([encodeWav(new Float32Array(2400), 24_000)], { type: "audio/wav" }));

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
	/** Fetched segments waiting to play, in order. */
	ready: string[];
	/** What the element is playing, released when it is done with. */
	playing: string | undefined;
	/** The element ran out with nothing ready, so the next segment plays as soon as it arrives. */
	starved: boolean;
};

let current: Playback | undefined;

/** Read `markdown` aloud, as the reply `key` of session `session`; stops whatever was reading. Call it inside the tap. */
export function speak(key: string, session: number, markdown: string): void {
	stopReading();
	const playback: Playback = { key, controller: new AbortController(), segments: [], complete: false, next: 0, fetching: false, ready: [], playing: undefined, starved: false };
	current = playback;
	store.set({ reading: { key, state: "preparing" } });
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
	for (const url of playback.ready) release(url);
	release(playback.playing);
	audio.pause();
	audio.removeAttribute("src");
	audio.load();
	store.set({ reading: undefined });
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
	if (store.get().reading?.state !== "playing") store.set({ reading: { key: playback.key, state: "playing" } });
}

/** Fetch the next segment, one at a time, until AHEAD of them wait to play. */
function fetchNext(playback: Playback): void {
	if (playback !== current || playback.fetching || playback.ready.length >= AHEAD) return;
	const text = playback.segments[playback.next];
	if (text === undefined) return;
	playback.next++;
	playback.fetching = true;
	api.speech(text, playback.controller.signal).then(
		(blob) => {
			playback.fetching = false;
			if (playback !== current) return;
			const url = URL.createObjectURL(blob);
			if (playback.starved) play(playback, url);
			else playback.ready.push(url);
			fetchNext(playback);
			finishIfDone(playback);
		},
		(error: unknown) => fail(playback, error),
	);
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
	play(playback, next);
	fetchNext(playback);
});

audio.addEventListener("error", () => {
	if (current !== undefined) fail(current, new Error("The phone could not play the audio."));
});

function fail(playback: Playback, error: unknown): void {
	if (playback !== current || playback.controller.signal.aborted) return;
	stopReading();
	const blocked = error instanceof DOMException && error.name === "NotAllowedError";
	const failure = blocked ? { message: "The phone did not let picloud play audio." } : describeFailure(error);
	showToast({ message: `Could not read this aloud. ${failure.message} ${failure.hint ?? "Tap the speaker to try again."}` }, 10_000);
}
