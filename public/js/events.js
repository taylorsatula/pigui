// Granular EventSource (SSE) client using Idiomorph for surgical DOM morphing: pauses while the tab is hidden,
// reconnects with ?since= backfill, and preserves focus, open <details>, and in-progress question inputs automatically.
import { Idiomorph } from "/vendor/idiomorph.esm.js";
import { localizeDates } from "./dates.js";
import { updateAgentsPanel } from "./dialogs.js";
import { setScreensaverActive } from "./screensaver.js";
import { syncSpeakButtons } from "./speech.js";
import { followEnd } from "./transcript.js";

function parseElement(html) {
	const tpl = document.createElement("template");
	tpl.innerHTML = html.trim();
	return tpl.content.firstElementChild;
}

const BLOCK_MORPH = {
	morphStyle: "outerHTML",
	callbacks: {
		beforeAttributeUpdated(attrName, node, mutationType) {
			// Keep user-opened <details> disclosures open across live updates.
			if (attrName === "open" && node.tagName === "DETAILS" && mutationType === "remove") return false;
			return true;
		},
		beforeNodeMorphed(oldNode, newNode) {
			// Preserve in-progress radio/checkbox/freeform selections while the same waiting question card stays pending.
			if (
				oldNode instanceof Element &&
				newNode instanceof Element &&
				oldNode.matches(".card.questions.waiting") &&
				newNode.matches(".card.questions.waiting") &&
				oldNode.dataset.cardId === newNode.dataset.cardId
			) {
				return false;
			}
			return true;
		},
	},
};

function earlierCursor(el) {
	const raw = el?.querySelector("[data-before]")?.dataset.before;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

function minLoadedEntryId(transcript) {
	let min = Infinity;
	for (const el of transcript.querySelectorAll("[data-block-key]")) {
		const match = /^(\d+)(?::|$)/.exec(el.dataset.blockKey || "");
		if (match) {
			const n = Number(match[1]);
			if (n < min) min = n;
		}
	}
	return min < Infinity ? min : undefined;
}

function shouldSkipEarlier(transcript, existing, nextHtml) {
	if (transcript.dataset.allLoaded === "true") return true;
	const incomingBefore = earlierCursor(parseElement(nextHtml));
	if (incomingBefore === undefined) return true;
	const currentBefore = earlierCursor(existing);
	if (currentBefore !== undefined && incomingBefore >= currentBefore) return true;
	const minLoaded = minLoadedEntryId(transcript);
	// Never insert or update an "earlier" button pointing at an entry already present in the DOM.
	if (minLoaded !== undefined && incomingBefore > minLoaded) return true;
	return false;
}

function applyBlockOps(ops) {
	const transcript = document.getElementById("transcript");
	if (!transcript || !Array.isArray(ops) || ops.length === 0) return;

	for (const op of ops) {
		const existing = transcript.querySelector(`[data-block-key="${CSS.escape(op.key)}"]`);

		if (op.op === "remove") {
			if (!existing || existing.dataset.historical === "true") continue;
			if (op.key === "earlier" && existing.dataset.paginated === "true") continue;
			transcript.querySelector(`[data-day-for="${CSS.escape(op.key)}"]`)?.remove();
			existing.remove();
			continue;
		}

		if (op.op === "update") {
			if (op.key === "earlier" && shouldSkipEarlier(transcript, existing, op.html)) continue;
			if (!existing) {
				const nextEl = parseElement(op.html);
				if (nextEl) transcript.appendChild(nextEl);
				continue;
			}
			Idiomorph.morph(existing, op.html, BLOCK_MORPH);
			continue;
		}

		if (op.op === "insert") {
			if (op.key === "earlier" && shouldSkipEarlier(transcript, existing, op.html)) continue;
			if (existing) {
				Idiomorph.morph(existing, op.html, BLOCK_MORPH);
				continue;
			}
			const nextEl = parseElement(op.html);
			if (!nextEl) continue;
			const dayEl = op.dayHtml ? parseElement(op.dayHtml) : null;
			const afterEl = op.afterKey ? transcript.querySelector(`[data-block-key="${CSS.escape(op.afterKey)}"]`) : null;
			if (afterEl) {
				if (dayEl) afterEl.after(dayEl, nextEl);
				else afterEl.after(nextEl);
			} else if (op.key === "earlier") {
				transcript.prepend(nextEl);
			} else {
				if (dayEl) transcript.appendChild(dayEl);
				transcript.appendChild(nextEl);
			}
		}
	}

	localizeDates(transcript);
	syncSpeakButtons();
	followEnd();
}

export function connectEvents(opts) {
	const page = document.body.dataset.page;
	if (!page || page === "not-found") return { pause() {}, resume() {} };

	let source = null;

	const maxLoadedEntryId = () => {
		const transcript = document.getElementById("transcript");
		if (!transcript) return undefined;
		let max = 0;
		for (const el of transcript.querySelectorAll("[data-block-key]")) {
			const match = /^(\d+)(?::|$)/.exec(el.dataset.blockKey || "");
			if (match) {
				const n = Number(match[1]);
				if (n > max) max = n;
			}
		}
		return max > 0 ? max : undefined;
	};

	const buildUrl = () => {
		const params = new URLSearchParams({ page });
		if (document.body.dataset.sessionId) params.set("session", document.body.dataset.sessionId);
		if (document.body.dataset.agentId) params.set("agent", document.body.dataset.agentId);
		const since = maxLoadedEntryId();
		if (since !== undefined) params.set("since", String(since));
		return `/api/events?${params.toString()}`;
	};

	const close = () => {
		if (source) {
			source.close();
			source = null;
		}
	};

	const open = () => {
		close();
		source = new EventSource(buildUrl());

		source.addEventListener("attention", (event) => {
			const data = JSON.parse(event.data);
			for (const btn of document.querySelectorAll("[data-sessions-button]")) {
				btn.setAttribute("aria-label", data.label);
				let dot = btn.querySelector('[data-testid="attention-dot"]');
				if (data.count > 0 && !dot) {
					dot = document.createElement("span");
					dot.className = "dot badge-dot";
					dot.dataset.testid = "attention-dot";
					btn.appendChild(dot);
				} else if (data.count === 0 && dot) {
					dot.remove();
				}
			}
		});

		source.addEventListener("splash", (event) => {
			const data = JSON.parse(event.data);
			const el = document.getElementById("splash-lists");
			if (el) Idiomorph.morph(el, data.html, { morphStyle: "innerHTML" });
		});

		source.addEventListener("header", (event) => {
			const data = JSON.parse(event.data);
			const header = document.getElementById("session-header-content");
			if (header) Idiomorph.morph(header, data.html, { morphStyle: "innerHTML" });
			if (data.title) document.title = `${data.title} · pigui`;
			if (typeof data.running === "boolean") document.body.dataset.running = String(data.running);
			if (typeof data.workflow === "string") {
				document.body.dataset.workflow = data.workflow;
				setScreensaverActive(page === "session" && data.workflow === "implementing");
			}
			const diffBtn = document.querySelector("[data-diff-button]");
			if (diffBtn && typeof data.diffDisabled === "boolean") diffBtn.disabled = data.diffDisabled;
			const agentStopSlot = document.getElementById("agent-stop-slot");
			if (agentStopSlot && typeof data.live === "boolean" && !data.live) agentStopSlot.innerHTML = "";
			opts.composer?.setState({
				running: data.running,
				disabled: data.composerDisabled,
				placeholder: data.placeholder,
			});
		});

		source.addEventListener("banner", (event) => {
			const data = JSON.parse(event.data);
			const el = document.getElementById("session-banner");
			if (el) Idiomorph.morph(el, data.html, { morphStyle: "innerHTML" });
		});

		source.addEventListener("agents", (event) => {
			const data = JSON.parse(event.data);
			const slot = document.getElementById("agents-button-slot");
			if (slot) Idiomorph.morph(slot, data.buttonHtml || "", { morphStyle: "innerHTML" });
			if (data.panelHtml) updateAgentsPanel(data.panelHtml);
		});

		source.addEventListener("blocks", (event) => {
			const data = JSON.parse(event.data);
			applyBlockOps(data.ops);
		});
	};

	if (document.visibilityState !== "hidden") open();
	return { pause: close, resume: open };
}
