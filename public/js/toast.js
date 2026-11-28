// Top-layer popover toast manager with pause-on-hold, pause-on-hidden, swipe-down dismiss, and one-shot
// sessionStorage flash messages across page navigations (e.g. archiving the open session with Undo).
import { postJson } from "./api.js";
import { attachSwipeDown, exitMs } from "./swipe.js";

const FLASH_KEY = "pigui.flash-toast";
const TOAST_AFTER_HOLD = 2000;

let timer = null;
let leaveTimer = null;
let leftMs = 0;
let since = 0;
let held = false;
let currentEl = null;
let detachSwipe = null;

function host() {
	return document.getElementById("toast-host");
}

function showHost() {
	const el = host();
	if (!el) return;
	if (typeof el.showPopover === "function") {
		try {
			if (!el.matches(":popover-open")) el.showPopover();
		} catch {
			// Ignore if already open or unsupported.
		}
	}
}

function hideHost() {
	const el = host();
	if (!el) return;
	if (typeof el.hidePopover === "function") {
		try {
			if (el.matches(":popover-open")) el.hidePopover();
		} catch {
			// Ignore.
		}
	}
}

function runClock(ms) {
	clearTimeout(timer);
	leftMs = ms;
	since = Date.now();
	timer = setTimeout(dismissToast, ms);
}

export function holdToast(nextHeld) {
	if (nextHeld === held || currentEl === null) return;
	held = nextHeld;
	if (held) {
		clearTimeout(timer);
		leftMs -= Date.now() - since;
	} else {
		runClock(Math.max(leftMs, TOAST_AFTER_HOLD));
	}
}

export function dismissToast() {
	clearTimeout(timer);
	held = false;
	const el = currentEl;
	if (!el) return;
	currentEl = null;
	detachSwipe?.();
	detachSwipe = null;
	el.classList.add("leaving");
	clearTimeout(leaveTimer);
	leaveTimer = setTimeout(() => {
		el.remove();
		if (host()?.children.length === 0) hideHost();
	}, exitMs());
}

export function showToast({ message, action }, ms = 6000) {
	const container = host();
	if (!container) return;
	clearTimeout(timer);
	clearTimeout(leaveTimer);
	detachSwipe?.();
	detachSwipe = null;
	container.innerHTML = "";

	const el = document.createElement("div");
	el.className = "toast";
	el.setAttribute("role", "status");
	el.setAttribute("aria-live", "polite");

	const span = document.createElement("span");
	span.textContent = message;
	el.appendChild(span);

	if (action) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "link";
		btn.textContent = action.label;
		btn.addEventListener("click", () => {
			action.run();
			dismissToast();
		});
		el.appendChild(btn);
	}

	container.appendChild(el);
	currentEl = el;
	showHost();
	detachSwipe = attachSwipeDown(el, {
		canStart: () => true,
		distance: () => 45,
		onDismiss: dismissToast,
		onHold: holdToast,
	});

	held = document.visibilityState === "hidden";
	if (held) leftMs = ms;
	else runClock(ms);
}

export function flashToast(payload) {
	try {
		sessionStorage.setItem(FLASH_KEY, JSON.stringify(payload));
	} catch {
		// Ignore private browsing storage limits.
	}
}

export function consumeFlashToast() {
	let raw = null;
	try {
		raw = sessionStorage.getItem(FLASH_KEY);
		if (raw !== null) sessionStorage.removeItem(FLASH_KEY);
	} catch {
		return;
	}
	if (!raw) return;
	try {
		const data = JSON.parse(raw);
		if (!data || typeof data.message !== "string") return;
		if (data.undoArchive) {
			const { id, archived, reopen } = data.undoArchive;
			showToast({
				message: data.message,
				action: {
					label: "Undo",
					run: () => {
						void postJson(`/api/sessions/${id}/archive`, { archived }).then(() => {
							if (reopen) location.href = `/s/${id}`;
						});
					},
				},
			});
		} else {
			showToast({ message: data.message });
		}
	} catch {
		// Ignore malformed flash payload.
	}
}
