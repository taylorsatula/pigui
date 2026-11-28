// Shows /girl.gif in the lower-right corner after 5 idle minutes while a session is in the implementing workflow.
// Suppressed by prefers-reduced-motion, hidden tabs, or a missing/broken asset.

const IDLE_MS = 5 * 60 * 1000;
const INPUT_EVENTS = ["pointerdown", "keydown", "touchstart", "wheel", "scroll"];

let timer = null;
let active = false;
let failed = false;

function host() {
	return document.getElementById("screensaver-host");
}

function hide() {
	const el = host();
	if (el) el.innerHTML = "";
}

function show() {
	if (!active || failed) return;
	if (document.visibilityState !== "visible") return;
	if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
	const el = host();
	if (!el || el.children.length > 0) return;
	const wrap = document.createElement("div");
	wrap.className = "screensaver";
	const img = document.createElement("img");
	img.src = "/girl.gif";
	img.width = 500;
	img.height = 500;
	img.alt = "";
	img.addEventListener("error", () => {
		failed = true;
		hide();
	});
	wrap.appendChild(img);
	el.appendChild(wrap);
}

function arm() {
	clearTimeout(timer);
	if (!active || failed) return;
	timer = setTimeout(show, IDLE_MS);
}

function onInput() {
	hide();
	arm();
}

function onVisibility() {
	if (document.visibilityState === "hidden") hide();
	else arm();
}

let wired = false;

export function setScreensaverActive(nextActive) {
	active = Boolean(nextActive);
	if (!wired) {
		wired = true;
		for (const ev of INPUT_EVENTS) window.addEventListener(ev, onInput, { capture: true, passive: true });
		document.addEventListener("visibilitychange", onVisibility);
	}
	if (!active) {
		clearTimeout(timer);
		hide();
	} else {
		arm();
	}
}
