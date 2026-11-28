// Composer controller: drafts in localStorage, auto-height textarea, @ file and # skill reference picker, photo
// shrink + upload, Enter/Shift+Enter desktop vs touch Return, Send and [ HALT WORK ] stop.
import { describeFailure, getJson, newRequestId, postJson, RequestFailed, uploadFile } from "./api.js";
import { shrinkPhoto } from "./images.js";
import { activeTrigger, insertReference, narrow } from "/shared/references.js";
import { showToast } from "./toast.js";

const DRAFTS_KEY = "pigui.drafts";
const PICKER_SIZE = 8;
const KEYBOARD = "(hover: hover) and (pointer: fine)";
const CLIP_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="icon"><path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"></path></svg>`;
const CLOSE_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="icon"><path d="M6 6l12 12M18 6L6 18"></path></svg>`;

function readAllDrafts() {
	try {
		const parsed = JSON.parse(localStorage.getItem(DRAFTS_KEY) || "{}");
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function loadDraft(key) {
	const found = readAllDrafts()[key];
	if (!found || typeof found !== "object") return { text: "", attachments: [] };
	return {
		text: typeof found.text === "string" ? found.text : "",
		attachments: Array.isArray(found.attachments) ? found.attachments : [],
		requestId: typeof found.requestId === "string" ? found.requestId : undefined,
	};
}

function saveDraft(key, draft) {
	try {
		const all = readAllDrafts();
		if (draft.text === "" && draft.attachments.length === 0 && draft.requestId === undefined) delete all[key];
		else all[key] = draft;
		localStorage.setItem(DRAFTS_KEY, JSON.stringify(all));
	} catch {
		// Private browsing or quota full.
	}
}

export function initComposer(form, opts = {}) {
	const draftKey = form.dataset.draftKey || "new";
	const mode = form.dataset.composer;
	const textarea = form.querySelector("[data-composer-input]");
	const sendBtn = form.querySelector("[data-send-button]");
	const stopBtn = form.querySelector("[data-stop-button]");
	const attachTrigger = form.querySelector("[data-attach-trigger]");
	const attachInput = form.querySelector("[data-attach-input]");
	const attachmentsEl = form.querySelector("[data-attachments]");
	const pickerEl = form.querySelector("[data-ref-picker]");
	if (!textarea || !sendBtn || !stopBtn) return null;

	// Preserve any text typed into the SSR textarea before this module finished initializing.
	const pretyped = textarea.value;
	let draft = loadDraft(draftKey);
	if (pretyped !== "" && draft.text === "") {
		draft = { ...draft, text: pretyped };
		saveDraft(draftKey, draft);
	}
	let trigger = undefined;
	let candidates = { files: undefined, skills: undefined };
	let currentItems = [];
	let sending = false;
	let uploading = 0;
	let running = form.dataset.running === "true";
	let disabled = textarea.disabled;

	const resizeTextarea = () => {
		textarea.style.height = "auto";
		const maxH = (window.visualViewport?.height ?? window.innerHeight) * 0.4;
		textarea.style.height = `${Math.min(textarea.scrollHeight, maxH)}px`;
	};

	const renderButtons = () => {
		const empty = draft.text.trim() === "" && draft.attachments.length === 0;
		const showStop = mode === "session" && running && empty;
		stopBtn.hidden = !showStop;
		sendBtn.hidden = showStop;
		sendBtn.disabled = empty || sending || uploading > 0 || disabled;
		attachTrigger.disabled = disabled;
		textarea.disabled = disabled;
		form.setAttribute("aria-busy", String(sending));
	};

	const renderAttachments = () => {
		if (!attachmentsEl) return;
		if (draft.attachments.length === 0 && uploading === 0) {
			attachmentsEl.hidden = true;
			attachmentsEl.innerHTML = "";
			return;
		}
		attachmentsEl.hidden = false;
		attachmentsEl.innerHTML = "";
		for (const item of draft.attachments) {
			const chip = document.createElement("span");
			chip.className = "chip";
			chip.innerHTML = `${CLIP_SVG} `;
			chip.appendChild(document.createTextNode(item.name));
			const remove = document.createElement("button");
			remove.type = "button";
			remove.className = "chip-remove";
			remove.setAttribute("aria-label", `Remove ${item.name}`);
			remove.innerHTML = CLOSE_SVG;
			remove.addEventListener("click", () => {
				updateDraft({ ...draft, attachments: draft.attachments.filter((a) => a.id !== item.id) });
			});
			chip.appendChild(remove);
			attachmentsEl.appendChild(chip);
		}
		if (uploading > 0) {
			const chip = document.createElement("span");
			chip.className = "chip";
			chip.innerHTML = `<span class="spinner" aria-hidden="true"></span> Uploading…`;
			attachmentsEl.appendChild(chip);
		}
	};

	const renderPicker = () => {
		if (!pickerEl) return;
		if (!trigger) {
			currentItems = [];
			pickerEl.hidden = true;
			pickerEl.innerHTML = "";
			return;
		}
		if (trigger.kind === "file") {
			currentItems = narrow(candidates.files ?? [], trigger.query, PICKER_SIZE).map((value) => ({ value, detail: "" }));
		} else {
			const skills = candidates.skills ?? [];
			currentItems = narrow(
				skills.map((s) => s.name),
				trigger.query,
				PICKER_SIZE,
			).map((value) => ({ value, detail: skills.find((s) => s.name === value)?.description ?? "" }));
		}
		if (currentItems.length === 0) {
			pickerEl.hidden = true;
			pickerEl.innerHTML = "";
			return;
		}
		pickerEl.setAttribute("aria-label", trigger.kind === "file" ? "Files" : "Skills");
		pickerEl.hidden = false;
		pickerEl.innerHTML = "";
		const sigil = trigger.kind === "file" ? "@" : "#";
		for (const item of currentItems) {
			const li = document.createElement("li");
			li.setAttribute("role", "option");
			li.setAttribute("aria-selected", "false");
			const btn = document.createElement("button");
			btn.type = "button";
			btn.addEventListener("mousedown", (e) => e.preventDefault());
			btn.addEventListener("click", () => choose(item.value));
			const val = document.createElement("span");
			val.className = "picker-value";
			val.textContent = `${sigil}${item.value}`;
			btn.appendChild(val);
			if (item.detail !== "") {
				const det = document.createElement("span");
				det.className = "picker-detail";
				det.textContent = item.detail;
				btn.appendChild(det);
			}
			li.appendChild(btn);
			pickerEl.appendChild(li);
		}
	};

	const updateDraft = (next) => {
		draft = next;
		saveDraft(draftKey, draft);
		if (textarea.value !== draft.text) textarea.value = draft.text;
		resizeTextarea();
		renderAttachments();
		renderButtons();
	};

	const fetchFiles = async () => {
		if (mode === "session") {
			const res = await getJson(`/api/sessions/${form.dataset.sessionId}/files`);
			return res.files ?? [];
		}
		if (form.dataset.place === "local") {
			const res = await getJson(`/api/local/files?dir=${encodeURIComponent(form.dataset.dir || "~")}`);
			return res.files ?? [];
		}
		const [owner, name] = (form.dataset.repo || "").split("/");
		const res = await getJson(`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/files?ref=${encodeURIComponent(form.dataset.ref || "")}`);
		return res.files ?? [];
	};

	const fetchSkills = async () => {
		if (mode === "session") return getJson(`/api/sessions/${form.dataset.sessionId}/skills`);
		if (form.dataset.place === "local") return getJson(`/api/local/skills?dir=${encodeURIComponent(form.dataset.dir || "~")}`);
		const [owner, name] = (form.dataset.repo || "").split("/");
		return getJson(`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/skills?ref=${encodeURIComponent(form.dataset.ref || "")}`);
	};

	const refreshTrigger = () => {
		trigger = activeTrigger(textarea.value, textarea.selectionStart);
		if (trigger?.kind === "file" && candidates.files === undefined) {
			candidates.files = [];
			void fetchFiles().then(
				(list) => {
					candidates.files = list;
					renderPicker();
				},
				() => undefined,
			);
		}
		if (trigger?.kind === "skill" && candidates.skills === undefined) {
			candidates.skills = [];
			void fetchSkills().then(
				(list) => {
					candidates.skills = list;
					renderPicker();
				},
				() => undefined,
			);
		}
		renderPicker();
	};

	const choose = (value) => {
		if (!trigger) return;
		const inserted = insertReference(draft.text, trigger, textarea.selectionStart, value);
		trigger = undefined;
		updateDraft({ ...draft, text: inserted.text });
		renderPicker();
		textarea.focus();
		textarea.setSelectionRange(inserted.caret, inserted.caret);
	};

	const send = async () => {
		const empty = draft.text.trim() === "" && draft.attachments.length === 0;
		if (empty || sending || uploading > 0 || disabled) return;
		const requestId = draft.requestId ?? newRequestId();
		const pending = { ...draft, requestId };
		updateDraft(pending);
		sending = true;
		renderButtons();
		try {
			const attachmentIds = pending.attachments.map((a) => a.id);
			if (mode === "start") {
				const body =
					form.dataset.place === "local"
						? { requestId, place: "local", dir: form.dataset.dir || "~", text: pending.text, attachments: attachmentIds }
						: {
								requestId,
								place: "repo",
								repo: form.dataset.repo,
								start: form.dataset.branchMode === "continue" ? { kind: "continue", branch: form.dataset.ref } : { kind: "new", base: form.dataset.ref },
								text: pending.text,
								attachments: attachmentIds,
							};
				const { id } = await postJson("/api/sessions", body);
				updateDraft({ text: "", attachments: [] });
				location.href = `/s/${id}`;
				return;
			}
			opts.onBeforeSend?.();
			await postJson(`/api/sessions/${form.dataset.sessionId}/messages`, {
				requestId,
				text: pending.text,
				attachments: attachmentIds,
			});
			updateDraft({ text: "", attachments: [] });
			trigger = undefined;
			renderPicker();
		} catch (error) {
			// Keep the draft on failure! If the server answered, drop requestId so a retry sends fresh; if network failed, keep requestId for idempotency.
			if (error instanceof RequestFailed && error.status !== 0) updateDraft({ ...pending, requestId: undefined });
			const failure = describeFailure(error);
			showToast({ message: failure.hint ? `${failure.message} ${failure.hint}` : failure.message });
		} finally {
			sending = false;
			renderButtons();
		}
	};

	textarea.addEventListener("input", () => {
		updateDraft({ ...draft, text: textarea.value });
		refreshTrigger();
	});

	textarea.addEventListener("click", refreshTrigger);

	textarea.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			trigger = undefined;
			renderPicker();
			return;
		}
		if (event.key !== "Enter" || event.isComposing) return;
		const plain = !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
		const first = currentItems[0];
		if (plain && matchMedia(KEYBOARD).matches) {
			event.preventDefault();
			if (first) choose(first.value);
			else void send();
		} else if (event.metaKey || event.ctrlKey) {
			event.preventDefault();
			void send();
		}
	});

	textarea.addEventListener("blur", () => {
		setTimeout(() => {
			trigger = undefined;
			renderPicker();
		}, 150);
	});

	attachTrigger?.addEventListener("click", () => attachInput?.click());
	attachInput?.addEventListener("change", async () => {
		const files = attachInput.files;
		if (!files) return;
		for (const file of Array.from(files)) {
			uploading += 1;
			renderAttachments();
			renderButtons();
			try {
				const { blob, name } = await shrinkPhoto(file);
				const uploaded = await uploadFile(blob, name);
				updateDraft({
					...draft,
					attachments: [...draft.attachments, { id: uploaded.id, name: uploaded.name, image: uploaded.mimeType.startsWith("image/") }],
				});
			} catch (error) {
				showToast({ message: `Could not attach ${file.name}: ${describeFailure(error).message}` });
			} finally {
				uploading -= 1;
				renderAttachments();
				renderButtons();
			}
		}
		attachInput.value = "";
	});

	stopBtn.addEventListener("click", async () => {
		try {
			await postJson(`/api/sessions/${form.dataset.sessionId}/stop`);
			showToast({ message: "Halted. Pi and every agent it started were stopped; it will not resume on its own." });
		} catch (error) {
			showToast({ message: describeFailure(error).message });
		}
	});

	form.addEventListener("submit", (event) => {
		event.preventDefault();
		void send();
	});

	// Hydrate initial draft and focus on keyboard devices (or always on /start).
	textarea.value = draft.text;
	resizeTextarea();
	renderAttachments();
	renderButtons();
	if ((mode === "start" || matchMedia(KEYBOARD).matches) && !disabled) textarea.focus();

	return {
		focus() {
			if (!disabled) textarea.focus();
		},
		setState(next) {
			const wasDisabled = disabled;
			if (typeof next.running === "boolean") running = next.running;
			if (typeof next.disabled === "boolean") disabled = next.disabled;
			if (typeof next.placeholder === "string") {
				textarea.placeholder = next.placeholder;
				textarea.setAttribute("aria-label", next.placeholder);
			}
			renderButtons();
			if (wasDisabled && !disabled && matchMedia(KEYBOARD).matches) textarea.focus();
		},
	};
}
