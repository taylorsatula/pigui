// Single zero-build ES module entry point for every pigui page. Wires global buttons, dialogs, the New session sheets,
// composer, transcript, SSE stream, speech cleanup, push refresh, screensaver, and service worker.
import { describeFailure, postJson } from "./api.js";
import { initComposer } from "./composer.js";
import { localizeDates } from "./dates.js";
import { openAgents, openDiff, openPicker, openStartSheet } from "./dialogs.js";
import { connectEvents } from "./events.js";
import { refreshSubscription } from "./push.js";
import { setScreensaverActive } from "./screensaver.js";
import { stopReading } from "./speech.js";
import { consumeFlashToast, holdToast, showToast } from "./toast.js";
import { pinToEnd, watchViewportAndDock, wireTranscriptInteractions } from "./transcript.js";

// Redirect legacy #/s/:id or #/s/:id/agent/:agent bookmarked URLs to real paths.
if (location.pathname === "/" && location.hash.startsWith("#/s/")) {
	const match = /^#\/s\/(\d+)(?:\/agent\/(\d+))?/.exec(location.hash);
	if (match) location.replace(match[2] ? `/s/${match[1]}/agent/${match[2]}` : `/s/${match[1]}`);
}

// Suppress CSS transitions for one frame during OS light/dark theme switches so nothing flashes.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
	const root = document.documentElement;
	root.classList.add("theme-changing");
	requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-changing")));
});

// Service worker registration and notification-click navigation.
if ("serviceWorker" in navigator) {
	void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
	navigator.serviceWorker.addEventListener("message", (event) => {
		if (event.data?.type === "open" && typeof event.data.url === "string") {
			location.href = event.data.url;
		}
	});
}

void refreshSubscription().catch(() => undefined);
consumeFlashToast();
localizeDates();
watchViewportAndDock();

const page = document.body.dataset.page;
const composerForm = document.querySelector("[data-composer]");
const composer = composerForm ? initComposer(composerForm, { onBeforeSend: pinToEnd }) : null;

wireTranscriptInteractions({ focusComposer: () => composer?.focus() });
setScreensaverActive(page === "session" && document.body.dataset.workflow === "implementing");

const events = connectEvents({ composer });

document.addEventListener("visibilitychange", () => {
	const hidden = document.visibilityState === "hidden";
	holdToast(hidden);
	if (hidden) events.pause();
	else events.resume();
});

window.addEventListener("pagehide", () => {
	stopReading();
	events.pause();
});

// Global topbar and New session action delegation.
document.addEventListener("click", async (event) => {
	const el = event.target;
	if (!(el instanceof Element)) return;

	const pickerTrigger = el.closest('[data-action="open-picker"]');
	if (pickerTrigger) {
		void openPicker(pickerTrigger);
		return;
	}

	const placeTrigger = el.closest('[data-action="open-place"]');
	if (placeTrigger) {
		void openStartSheet("place", placeTrigger);
		return;
	}

	const branchTrigger = el.closest('[data-action="open-branch"]');
	if (branchTrigger) {
		void openStartSheet("branch", branchTrigger);
		return;
	}

	const agentsTrigger = el.closest('[data-action="open-agents"]');
	if (agentsTrigger) {
		void openAgents(Number(agentsTrigger.dataset.session), agentsTrigger);
		return;
	}

	const diffTrigger = el.closest('.topbar [data-action="open-diff"]');
	if (diffTrigger) {
		void openDiff(Number(diffTrigger.dataset.session), diffTrigger);
		return;
	}

	const agentStop = el.closest('#agent-stop-slot [data-action="stop-agent"]');
	if (agentStop) {
		agentStop.disabled = true;
		try {
			await postJson(`/api/sessions/${agentStop.dataset.session}/agents/${agentStop.dataset.agent}/stop`);
		} catch (error) {
			agentStop.disabled = false;
			showToast({ message: describeFailure(error).message });
		}
		return;
	}
});
