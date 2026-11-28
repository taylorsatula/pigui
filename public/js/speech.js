// Read aloud controller: unlocks one shared HTMLAudioElement inside the user gesture with a silent WAV, streams
// sentences from /api/sessions/:id/speech-script, prefetches up to 3 WAV segments ahead of playback, holds start if a
// short first sentence would outrun the second sentence's synthesis, and swaps segments synchronously on `ended`.
import { encodeWav } from "/shared/wav.js";
import { describeFailure, postAudio, streamLines } from "./api.js";
import { showToast } from "./toast.js";

const AHEAD = 3;
const WAV_HEADER = 44;
const WAV_BYTES_PER_SECOND = 48_000;
const SPEAKER_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="icon"><path d="M4 9.5h3l5-4v13l-5-4H4zM16 9a4.5 4.5 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"></path></svg>`;
const STOP_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="icon"><path d="M8 8h8v8H8z"></path></svg>`;
const LABELS = { idle: "Read aloud", preparing: "Preparing to read aloud", playing: "Stop reading aloud" };

const audio = new Audio();
const SILENCE = URL.createObjectURL(new Blob([encodeWav(new Float32Array(2400), 24_000)], { type: "audio/wav" }));
const scripts = new Map();
let current = null;

function setButtonState(key, state) {
	for (const btn of document.querySelectorAll(`[data-speak-id="${CSS.escape(key)}"]`)) {
		btn.classList.remove("idle", "preparing", "playing");
		btn.classList.add(state);
		btn.setAttribute("aria-label", LABELS[state]);
		btn.innerHTML = state === "preparing" ? `<span class="spinner" aria-hidden="true"></span>` : state === "playing" ? STOP_SVG : SPEAKER_SVG;
	}
}

export function syncSpeakButtons() {
	if (current) setButtonState(current.key, current.state);
}

function release(url) {
	if (url) URL.revokeObjectURL(url);
}

function start(playback) {
	audio.play().catch((error) => {
		if (error instanceof DOMException && error.name === "AbortError") return;
		fail(playback, error);
	});
}

function play(playback, url) {
	release(playback.playing);
	playback.playing = url;
	playback.starved = false;
	audio.src = url;
	start(playback);
	if (playback.state !== "playing") {
		playback.state = "playing";
		setButtonState(playback.key, "playing");
	}
}

function hold(playback) {
	const fetching = playback.segments[playback.next - 1];
	if (!playback.fetching || fetching === undefined || playback.fetchedChars === 0) return false;
	const expected = (playback.fetchedMs / playback.fetchedChars) * fetching.length - (performance.now() - playback.fetchStarted);
	const ready = playback.ready.reduce((total, segment) => total + segment.seconds, 0);
	return expected > ready * 1000;
}

function finishIfDone(playback) {
	const done = playback.complete && playback.starved && !playback.fetching && playback.ready.length === 0 && playback.next >= playback.segments.length;
	if (playback === current && done) stopReading();
}

function fetchNext(playback) {
	if (playback !== current || playback.fetching || playback.ready.length >= AHEAD) return;
	const text = playback.segments[playback.next];
	if (text === undefined) return;
	playback.next += 1;
	playback.fetching = true;
	playback.fetchStarted = performance.now();
	postAudio("/api/speech", { text }, playback.controller.signal).then(
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
		(error) => fail(playback, error),
	);
}

function fail(playback, error) {
	if (playback !== current || playback.controller.signal.aborted) return;
	stopReading();
	const blocked = error instanceof DOMException && error.name === "NotAllowedError";
	const failure = blocked ? { message: "The phone did not let pigui play audio." } : describeFailure(error);
	showToast({ message: `Could not read this aloud. ${failure.message} ${failure.hint ?? "Tap the speaker to try again."}` }, 10_000);
}

audio.addEventListener("ended", () => {
	const playback = current;
	if (!playback) return;
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
	if (current) fail(current, new Error("The phone could not play the audio."));
});

export function stopReading() {
	const playback = current;
	if (!playback) return;
	current = null;
	playback.controller.abort();
	for (const { url } of playback.ready) release(url);
	release(playback.playing);
	audio.pause();
	audio.removeAttribute("src");
	audio.load();
	setButtonState(playback.key, "idle");
}

export function toggleSpeak(key, sessionId, markdown, kind = "reply") {
	if (current?.key === key) {
		stopReading();
		return;
	}
	stopReading();
	const playback = {
		key,
		state: "preparing",
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
	setButtonState(key, "preparing");
	// Unlock inside the user tap gesture with a short silent WAV.
	audio.src = SILENCE;
	start(playback);

	const cached = scripts.get(key);
	if (cached !== undefined) {
		playback.segments.push(...cached);
		playback.complete = true;
		fetchNext(playback);
		return;
	}

	void (async () => {
		try {
			for await (const line of streamLines(`/api/sessions/${sessionId}/speech-script`, { text: markdown, kind }, playback.controller.signal)) {
				if (playback !== current) return;
				if (line.t === "segment" && typeof line.text === "string" && line.text.trim() !== "") {
					playback.segments.push(line.text);
					fetchNext(playback);
				}
			}
			if (playback !== current) return;
			scripts.set(key, [...playback.segments]);
			playback.complete = true;
			finishIfDone(playback);
		} catch (error) {
			fail(playback, error);
		}
	})();
}
