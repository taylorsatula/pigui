// Transcript scroll management, dock/viewport sizing (without iOS margin-top scroll feedback loops), and delegated
// handlers for cards, banners, queued steering cancel, pagination, and Read aloud.
import { describeFailure, getJson, newRequestId, postJson } from "./api.js";
import { localizeDates } from "./dates.js";
import { openDiff } from "./dialogs.js";
import { toggleSpeak } from "./speech.js";
import { showToast } from "./toast.js";

const AT_END = 120;
let following = true;
let scrollFrame = 0;

function scroller() {
	return document.getElementById("transcript");
}

export function followEnd() {
	if (!following || scrollFrame !== 0) return;
	scrollFrame = requestAnimationFrame(() => {
		scrollFrame = 0;
		const el = scroller();
		if (following && el) el.scrollTop = el.scrollHeight;
	});
}

export function pinToEnd() {
	following = true;
	followEnd();
}

export function keepPosition() {
	following = false;
	const el = scroller();
	if (!el) return () => undefined;
	const fromEnd = el.scrollHeight - el.scrollTop;
	return () => {
		el.scrollTop = el.scrollHeight - fromEnd;
	};
}

export function watchViewportAndDock() {
	const root = document.documentElement;
	const visual = window.visualViewport;
	let lastHeight = 0;

	const updateHeight = () => {
		if ((visual?.scale ?? 1) > 1) return;
		const next = Math.round(visual?.height ?? window.innerHeight);
		if (Math.abs(next - lastHeight) < 2) return;
		lastHeight = next;
		root.style.setProperty("--viewport-height", `${next}px`);
		followEnd();
	};

	updateHeight();
	window.addEventListener("resize", updateHeight, { passive: true });
	visual?.addEventListener("resize", updateHeight, { passive: true });

	const dock = document.getElementById("composer-dock");
	if (dock && typeof ResizeObserver !== "undefined") {
		const observer = new ResizeObserver(() => {
			root.style.setProperty("--dock-height", `${dock.offsetHeight}px`);
			followEnd();
		});
		observer.observe(dock);
	}

	const el = scroller();
	if (el) {
		el.addEventListener(
			"scroll",
			() => {
				following = el.scrollHeight - el.scrollTop - el.clientHeight < AT_END;
			},
			{ passive: true },
		);
		// Start pinned at the end of the conversation.
		el.scrollTop = el.scrollHeight;
	}
}

export function wireTranscriptInteractions(opts) {
	const transcript = scroller();
	const dock = document.getElementById("composer-dock");

	// Delegated click & input handlers inside transcript.
	if (transcript) {
		transcript.addEventListener("click", async (event) => {
			const speakBtn = event.target.closest('[data-action="speak"]');
			if (speakBtn) {
				void toggleSpeak(
					speakBtn.dataset.speakId,
					Number(speakBtn.dataset.speakSession),
					speakBtn.dataset.speakText || "",
					speakBtn.dataset.speakKind || "reply",
				);
				return;
			}

			const freeformBtn = event.target.closest('[data-action="show-freeform"]');
			if (freeformBtn) {
				const fieldset = freeformBtn.closest("fieldset");
				const note = fieldset?.querySelector(`[data-freeform-for="${CSS.escape(freeformBtn.dataset.questionId)}"]`);
				freeformBtn.hidden = true;
				if (note) {
					note.hidden = false;
					note.focus();
				}
				return;
			}

			const approveBtn = event.target.closest('[data-action="approve-plan"]');
			if (approveBtn) {
				approveBtn.disabled = true;
				try {
					await postJson(`/api/sessions/${approveBtn.dataset.session}/answer`, {
						requestId: newRequestId(),
						cardId: approveBtn.dataset.cardId,
						answer: { kind: "approve" },
					});
				} catch (error) {
					approveBtn.disabled = false;
					showToast({ message: describeFailure(error).message });
				}
				return;
			}

			if (event.target.closest('[data-action="focus-composer"]')) {
				opts.focusComposer?.();
				return;
			}

			const diffBtn = event.target.closest('[data-action="open-diff"]');
			if (diffBtn) {
				void openDiff(Number(diffBtn.dataset.session));
				return;
			}

			const deliverBtn = event.target.closest('[data-action="deliver"]');
			if (deliverBtn) {
				const action = deliverBtn.dataset.deliver;
				const sessionId = Number(deliverBtn.dataset.session);
				const card = deliverBtn.closest(".card-actions");
				const allDeliver = card ? [...card.querySelectorAll(".deliver")] : [deliverBtn];
				const originalHtml = deliverBtn.innerHTML;
				for (const btn of allDeliver) btn.disabled = true;
				deliverBtn.innerHTML = `<span class="spinner" aria-hidden="true"></span> ${action === "pr" ? (originalHtml.includes("Update") ? "Updating…" : "Opening…") : "Pushing…"}`;
				try {
					const result = await postJson(`/api/sessions/${sessionId}/deliver`, { action });
					showToast({
						message: result.pr === undefined ? "Pushed." : result.pr.created ? `Opened PR #${result.pr.number}.` : `Updated PR #${result.pr.number}.`,
					});
				} catch (error) {
					const failure = describeFailure(error);
					showToast({ message: failure.hint ? `${failure.message} ${failure.hint}` : failure.message }, 10_000);
					deliverBtn.innerHTML = originalHtml;
					for (const btn of allDeliver) btn.disabled = false;
				}
				return;
			}

			const cancelBtn = event.target.closest('[data-action="cancel-queued"]');
			if (cancelBtn) {
				cancelBtn.disabled = true;
				cancelBtn.textContent = "Canceling…";
				try {
					const { result } = await postJson(`/api/sessions/${cancelBtn.dataset.session}/queued/${cancelBtn.dataset.submission}/cancel`);
					if (result === "already_placed") showToast({ message: "That message already reached Pi." });
					else if (result === "aborted") showToast({ message: "Message canceled." });
				} catch (error) {
					cancelBtn.disabled = false;
					cancelBtn.textContent = "Cancel";
					showToast({ message: describeFailure(error).message });
				}
				return;
			}

			const earlierBtn = event.target.closest('[data-action="load-earlier"]');
			if (earlierBtn) {
				const sessionId = document.body.dataset.sessionId;
				const agentId = document.body.dataset.agentId;
				const before = earlierBtn.dataset.before;
				earlierBtn.disabled = true;
				earlierBtn.textContent = "Loading…";
				const restore = keepPosition();
				try {
					const qs = new URLSearchParams({ before });
					if (agentId) qs.set("agent", agentId);
					const { html, hasMore } = await getJson(`/ui/sessions/${sessionId}/earlier?${qs.toString()}`);
					const entryEl = earlierBtn.closest(".entry");
					const tpl = document.createElement("template");
					tpl.innerHTML = html;
					for (const child of [...tpl.content.querySelectorAll("[data-block-key]")]) {
						const key = child.dataset.blockKey;
						if (key && key !== "earlier" && transcript.querySelector(`[data-block-key="${CSS.escape(key)}"]`)) {
							tpl.content.querySelector(`[data-day-for="${CSS.escape(key)}"]`)?.remove();
							child.remove();
						}
					}
					const nextEarlier = tpl.content.querySelector('[data-block-key="earlier"]');
					if (nextEarlier) nextEarlier.dataset.paginated = "true";
					if (entryEl) entryEl.replaceWith(tpl.content);
					localizeDates(transcript);
					if (!hasMore) transcript.dataset.allLoaded = "true";
					restore();
				} catch (error) {
					earlierBtn.disabled = false;
					earlierBtn.textContent = "Load earlier messages";
					showToast({ message: describeFailure(error).message });
				}
			}
		});

		// Questions card option selection & mutually exclusive freeform typing.
		transcript.addEventListener("change", (event) => {
			const input = event.target.closest("fieldset.question input[type='radio'], fieldset.question input[type='checkbox']");
			if (!input) return;
			const fieldset = input.closest("fieldset.question");
			if (!fieldset) return;
			const note = fieldset.querySelector("textarea.note");
			if (note && note.value.trim() !== "") {
				note.value = "";
				fieldset.classList.remove("freeform");
			}
			for (const label of fieldset.querySelectorAll("label.option")) {
				const cb = label.querySelector("input");
				label.classList.toggle("chosen", Boolean(cb?.checked));
			}
		});

		transcript.addEventListener("input", (event) => {
			const note = event.target.closest("fieldset.question textarea.note");
			if (!note) return;
			const fieldset = note.closest("fieldset.question");
			if (!fieldset) return;
			const hasText = note.value.trim() !== "";
			fieldset.classList.toggle("freeform", hasText);
			if (hasText) {
				for (const input of fieldset.querySelectorAll("input[type='radio'], input[type='checkbox']")) {
					input.checked = false;
					input.closest("label.option")?.classList.remove("chosen");
				}
			}
		});

		transcript.addEventListener("submit", async (event) => {
			const form = event.target.closest("[data-questions-form]");
			if (!form) return;
			event.preventDefault();
			const card = form.closest("[data-card-id]");
			const cardId = card?.dataset.cardId;
			const sessionId = card?.dataset.session;
			if (!cardId || !sessionId) return;
			const submitBtn = form.querySelector('button[type="submit"]');
			if (submitBtn) submitBtn.disabled = true;

			const answers = [];
			for (const fieldset of form.querySelectorAll("fieldset.question")) {
				const questionId = fieldset.dataset.questionId;
				const selected = [...fieldset.querySelectorAll("input:checked")].map((i) => i.value);
				const text = fieldset.querySelector("textarea.note")?.value.trim();
				const item = { questionId, selected };
				if (text) item.text = text;
				answers.push(item);
			}
			try {
				await postJson(`/api/sessions/${sessionId}/answer`, {
					requestId: newRequestId(),
					cardId,
					answer: { kind: "questions", answers },
				});
			} catch (error) {
				if (submitBtn) submitBtn.disabled = false;
				showToast({ message: describeFailure(error).message });
			}
		});
	}

	// Banner action buttons in #composer-dock.
	if (dock) {
		dock.addEventListener("click", async (event) => {
			const retryBtn = event.target.closest('[data-action="retry-setup"]');
			const continueBtn = event.target.closest('[data-action="continue"]');
			const budgetBtn = event.target.closest('[data-action="raise-budget"]');
			const btn = retryBtn || continueBtn || budgetBtn;
			if (!btn) return;
			btn.disabled = true;
			try {
				const id = btn.dataset.session;
				if (retryBtn) await postJson(`/api/sessions/${id}/retry-setup`);
				else if (continueBtn) await postJson(`/api/sessions/${id}/continue`);
				else if (budgetBtn) await postJson(`/api/sessions/${id}/budget`, { cap: Number(budgetBtn.dataset.cap) });
			} catch (error) {
				btn.disabled = false;
				const failure = describeFailure(error);
				showToast({ message: failure.hint ? `${failure.message} ${failure.hint}` : failure.message });
			}
		});
	}
}
