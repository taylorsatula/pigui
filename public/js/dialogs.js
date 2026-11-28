// Native <dialog> controllers for Sessions picker, Agents panel, Changes diff sheet, and Repo picker.
// Browser natively handles top-layer stacking, ::backdrop, Escape key, focus trap, and returning focus to the opener.
import { Idiomorph } from "/vendor/idiomorph.esm.js";
import { describeFailure, getHtml, getJson, postJson } from "./api.js";
import { localizeDates } from "./dates.js";
import { enableNotifications, pushSupported } from "./push.js";
import { attachSwipeDown } from "./swipe.js";
import { flashToast, showToast } from "./toast.js";

const BELL_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="icon"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0"></path></svg>`;

function isBackdropClick(dialog, event) {
	if (event.target !== dialog) return false;
	const rect = dialog.getBoundingClientRect();
	return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
}

const CHEVRON_12 = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="icon"><path d="M9 6l6 6-6 6"></path></svg>`;

function restoreFocus(opener, fallbackSelector) {
	if (opener && opener.isConnected) opener.focus({ preventScroll: true });
	else if (fallbackSelector) document.querySelector(fallbackSelector)?.focus({ preventScroll: true });
}

function wireDialogBasics(dialog, fallbackSelector) {
	if (dialog.dataset.wired === "true") return;
	dialog.dataset.wired = "true";
	dialog.addEventListener("click", (event) => {
		if (isBackdropClick(dialog, event)) {
			dialog.close();
			return;
		}
		if (event.target.closest("[data-dialog-close]")) dialog.close();
	});
	dialog.addEventListener("close", () => {
		const opener = dialog._opener;
		dialog._opener = null;
		restoreFocus(opener, fallbackSelector);
	});
}

function sortEntriesInPlace(dialog, column, ascending) {
	const cmp = (a, b) => {
		const order =
			column === "modified"
				? Number(a.dataset.sortModified) - Number(b.dataset.sortModified)
				: (a.dataset[`sort${column[0].toUpperCase()}${column.slice(1)}`] || "").localeCompare(
						b.dataset[`sort${column[0].toUpperCase()}${column.slice(1)}`] || "",
					);
		return ascending ? order : -order;
	};

	const mainList = dialog.querySelector('ul.listing[aria-label="Under way"]');
	const folderItem = mainList?.querySelector(":scope > li:not(.entry)");
	if (mainList) {
		const entries = [...mainList.querySelectorAll(":scope > li.entry")].sort(cmp);
		for (const li of entries) {
			if (folderItem) mainList.insertBefore(li, folderItem);
			else mainList.appendChild(li);
		}
	}

	const inactiveList = dialog.querySelector("[data-inactive-list]");
	if (inactiveList) {
		const entries = [...inactiveList.querySelectorAll(":scope > li.entry")].sort(cmp);
		for (const li of entries) inactiveList.appendChild(li);
	}

	// Recompute alternating row stripes across under-way, folder, and inactive rows.
	let stripe = 0;
	if (mainList) {
		for (const li of mainList.querySelectorAll(":scope > li.entry")) {
			li.querySelector(".row")?.classList.toggle("striped", stripe++ % 2 === 1);
		}
		folderItem?.querySelector(".row.folder")?.classList.toggle("striped", stripe++ % 2 === 1);
	}
	if (inactiveList) {
		for (const li of inactiveList.querySelectorAll(":scope > li.entry")) {
			li.querySelector(".row")?.classList.toggle("striped", stripe++ % 2 === 1);
		}
	}

	// Update sort header buttons synchronously.
	for (const btn of dialog.querySelectorAll("[data-sort-column]")) {
		const col = btn.dataset.sortColumn;
		const isSorted = col === column;
		btn.classList.toggle("sorted", isSorted);
		btn.setAttribute("aria-pressed", String(isSorted));
		btn.dataset.sortDir = isSorted ? (ascending ? "desc" : "asc") : col === "modified" ? "desc" : "asc";
		btn.querySelector(".sort-mark")?.remove();
		if (isSorted) {
			const mark = document.createElement("span");
			mark.className = `sort-mark ${ascending ? "up" : "down"}`;
			mark.innerHTML = CHEVRON_12;
			btn.appendChild(mark);
		}
	}
}

// ---- Session picker dialog

const pickerState = { column: "modified", dir: "desc", inactive: null };

function currentSessionId() {
	const raw = document.body.dataset.sessionId;
	return raw ? Number(raw) : undefined;
}

function renderPushSlot(dialog) {
	const slot = dialog.querySelector("[data-push-slot]");
	if (!slot) return;
	const perm = pushSupported() ? Notification.permission : "unsupported";
	if (perm !== "default" && perm !== "denied") {
		slot.innerHTML = "";
		return;
	}
	const btn = document.createElement("button");
	btn.type = "button";
	btn.className = "link";
	btn.innerHTML = `${BELL_SVG} Turn on notifications`;
	btn.addEventListener("click", async () => {
		try {
			await enableNotifications(document.body.dataset.vapid || "");
			slot.innerHTML = "";
			showToast({ message: "Notifications are on." });
		} catch (error) {
			showToast({ message: describeFailure(error).message });
		}
	});
	slot.replaceChildren(btn);
}

async function loadPickerContent(dialog) {
	const params = new URLSearchParams({ sort: pickerState.column, dir: pickerState.dir });
	const current = currentSessionId();
	if (current !== undefined) params.set("current", String(current));
	if (pickerState.inactive !== null) params.set("inactive", pickerState.inactive ? "1" : "0");
	dialog.innerHTML = await getHtml(`/ui/picker?${params.toString()}`);
	localizeDates(dialog);
	renderPushSlot(dialog);
}

function wirePickerDialog(dialog) {
	wireDialogBasics(dialog, "[data-sessions-button]");
	if (dialog.dataset.pickerWired === "true") return;
	dialog.dataset.pickerWired = "true";

	dialog.addEventListener("keydown", (event) => {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		const list = dialog.querySelector("[data-picker-list]");
		if (!list) return;
		const rows = [...list.querySelectorAll(".row")].filter((el) => el.offsetParent !== null);
		if (rows.length === 0) return;
		event.preventDefault();
		const at = rows.indexOf(document.activeElement);
		const next = at === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)));
		rows[next]?.focus();
		rows[next]?.scrollIntoView({ block: "nearest" });
	});

	dialog.addEventListener("click", async (event) => {
		const sortBtn = event.target.closest("[data-sort-column]");
		if (sortBtn) {
			pickerState.column = sortBtn.dataset.sortColumn;
			pickerState.dir = sortBtn.dataset.sortDir;
			sortEntriesInPlace(dialog, pickerState.column, pickerState.dir === "asc");
			return;
		}

		const folderBtn = event.target.closest('[data-action="toggle-inactive"]');
		if (folderBtn) {
			const expanded = folderBtn.getAttribute("aria-expanded") === "true";
			const next = !expanded;
			pickerState.inactive = next;
			folderBtn.setAttribute("aria-expanded", String(next));
			const list = dialog.querySelector("[data-inactive-list]");
			if (list) list.hidden = !next;
			return;
		}

		const pinBtn = event.target.closest('[data-action="pin"]');
		if (pinBtn) {
			const id = Number(pinBtn.dataset.session);
			const nextPinned = pinBtn.dataset.pinned !== "true";
			try {
				await postJson(`/api/sessions/${id}/pin`, { pinned: nextPinned });
				await loadPickerContent(dialog);
			} catch (error) {
				showToast({ message: describeFailure(error).message });
			}
			return;
		}

		const archiveBtn = event.target.closest('[data-action="archive"]');
		if (archiveBtn) {
			const id = Number(archiveBtn.dataset.session);
			const nextArchived = archiveBtn.dataset.archived !== "true";
			const isCurrent = archiveBtn.dataset.current === "true";
			try {
				await postJson(`/api/sessions/${id}/archive`, { archived: nextArchived });
			} catch (error) {
				showToast({ message: describeFailure(error).message });
				return;
			}
			if (nextArchived && isCurrent) {
				flashToast({ message: "Session archived.", undoArchive: { id, archived: false, reopen: true } });
				location.href = "/";
				return;
			}
			await loadPickerContent(dialog).catch(() => undefined);
			showToast({
				message: nextArchived ? "Session archived." : "Session restored.",
				action: {
					label: "Undo",
					run: () => {
						void postJson(`/api/sessions/${id}/archive`, { archived: !nextArchived }).then(() => {
							if (dialog.open) void loadPickerContent(dialog);
						});
					},
				},
			});
		}
	});
}

export async function openPicker(opener) {
	const dialog = document.getElementById("session-picker");
	if (!dialog) return;
	wirePickerDialog(dialog);
	dialog._opener = opener instanceof HTMLElement ? opener : document.activeElement instanceof HTMLElement ? document.activeElement : null;
	pickerState.inactive = null;
	try {
		await loadPickerContent(dialog);
		if (!dialog.open) dialog.showModal();
		const focusTarget = dialog.querySelector(".row.current") ?? dialog.querySelector(".row");
		focusTarget?.focus({ preventScroll: true });
		focusTarget?.scrollIntoView({ block: "nearest" });
	} catch (error) {
		showToast({ message: describeFailure(error).message });
	}
}

// ---- Agents panel dialog

let agentClock = null;

function formatElapsed(startedAt, endedAt) {
	if (!startedAt) return "—";
	const seconds = Math.max(0, Math.round(((endedAt || Date.now()) - startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function tickAgentClocks(dialog) {
	for (const el of dialog.querySelectorAll(".agent-time[data-started-at]")) {
		if (el.dataset.endedAt) continue;
		el.textContent = formatElapsed(Number(el.dataset.startedAt), 0);
	}
}

function wireAgentsDialog(dialog) {
	wireDialogBasics(dialog, '[data-action="open-agents"]');
	if (dialog.dataset.agentsWired === "true") return;
	dialog.dataset.agentsWired = "true";

	dialog.addEventListener("close", () => {
		clearInterval(agentClock);
		agentClock = null;
	});

	dialog.addEventListener("click", async (event) => {
		const stopBtn = event.target.closest('[data-action="stop-agent"]');
		if (!stopBtn) return;
		const sessionId = Number(stopBtn.dataset.session);
		const agentId = Number(stopBtn.dataset.agent);
		stopBtn.disabled = true;
		try {
			await postJson(`/api/sessions/${sessionId}/agents/${agentId}/stop`);
		} catch (error) {
			stopBtn.disabled = false;
			showToast({ message: describeFailure(error).message });
		}
	});
}

export async function openAgents(sessionId, opener) {
	const dialog = document.getElementById("agents-panel");
	if (!dialog) return;
	wireAgentsDialog(dialog);
	dialog._opener = opener instanceof HTMLElement ? opener : document.activeElement instanceof HTMLElement ? document.activeElement : null;
	try {
		dialog.innerHTML = await getHtml(`/ui/agents/${sessionId}`);
		if (!dialog.open) dialog.showModal();
		dialog.querySelector(".agent-open")?.focus({ preventScroll: true });
		clearInterval(agentClock);
		agentClock = setInterval(() => tickAgentClocks(dialog), 1000);
	} catch (error) {
		showToast({ message: describeFailure(error).message });
	}
}

/** Morph the open Agents dialog in place via Idiomorph so focus, scroll position, and live elapsed clocks survive updates. */
export function updateAgentsPanel(panelHtml) {
	const dialog = document.getElementById("agents-panel");
	if (!dialog || !dialog.open || !panelHtml) return;
	Idiomorph.morph(dialog, panelHtml, {
		morphStyle: "innerHTML",
		callbacks: {
			beforeNodeMorphed(oldNode, newNode) {
				if (
					oldNode instanceof Element &&
					oldNode.matches(".agent-time[data-started-at]") &&
					newNode instanceof Element &&
					!newNode.hasAttribute("data-ended-at")
				) {
					if (newNode.dataset.startedAt) oldNode.dataset.startedAt = newNode.dataset.startedAt;
					return false;
				}
				return true;
			},
		},
	});
	tickAgentClocks(dialog);
}

// ---- Changes diff sheet dialog

const SCROLL_SETTLE = 100;

function wireDiffDialog(dialog) {
	wireDialogBasics(dialog, "[data-diff-button]");
	if (dialog.dataset.diffWired === "true") return;
	dialog.dataset.diffWired = "true";
	let scrolledAt = 0;

	dialog.addEventListener(
		"scroll",
		(event) => {
			if (event.target.matches?.("[data-sheet-body]")) scrolledAt = performance.now();
		},
		{ capture: true, passive: true },
	);

	attachSwipeDown(dialog, {
		canStart: (target) => {
			const header = dialog.querySelector("[data-sheet-header]");
			const body = dialog.querySelector("[data-sheet-body]");
			return (target instanceof Node && header?.contains(target)) || ((body?.scrollTop ?? 0) <= 0 && performance.now() - scrolledAt > SCROLL_SETTLE);
		},
		distance: (height) => height * 0.25,
		onDismiss: () => dialog.close(),
	});
}

export async function openDiff(sessionId, opener) {
	const dialog = document.getElementById("diff-sheet");
	if (!dialog) return;
	wireDiffDialog(dialog);
	dialog._opener = opener instanceof HTMLElement ? opener : document.activeElement instanceof HTMLElement ? document.activeElement : null;
	dialog.innerHTML = `<header class="sheet-header" data-sheet-header><span class="grabber" aria-hidden="true"></span><h2 id="diff-title">Changes</h2><button type="button" class="link done" data-dialog-close>Done</button></header><div class="sheet-body" data-sheet-body><p class="sheet-status"><span class="spinner" aria-hidden="true"></span> Loading…</p></div>`;
	if (!dialog.open) dialog.showModal();
	try {
		dialog.innerHTML = await getHtml(`/ui/diff/${sessionId}`);
	} catch (error) {
		dialog.innerHTML = `<header class="sheet-header" data-sheet-header><span class="grabber" aria-hidden="true"></span><h2 id="diff-title">Changes</h2><button type="button" class="link done" data-dialog-close>Done</button></header><div class="sheet-body" data-sheet-body><p class="error-text">${describeFailure(error).message}</p></div>`;
	}
}

// ---- Repo picker dialog

function wireRepoPicker(dialog) {
	wireDialogBasics(dialog, '[data-action="open-repo-picker"]');
	if (dialog.dataset.repoWired === "true") return;
	dialog.dataset.repoWired = "true";

	dialog.addEventListener("click", (event) => {
		const modeBtn = event.target.closest("[data-repo-mode]");
		if (!modeBtn) return;
		const mode = modeBtn.dataset.repoMode;
		const modeInput = dialog.querySelector("[data-repo-mode-input]");
		const branchLabel = dialog.querySelector("[data-branch-label]");
		const branchSelect = dialog.querySelector("[data-branch-select]");
		if (modeInput) modeInput.value = mode;
		for (const btn of dialog.querySelectorAll("[data-repo-mode]")) {
			const selected = btn.dataset.repoMode === mode;
			btn.classList.toggle("selected", selected);
			btn.setAttribute("aria-checked", String(selected));
		}
		if (branchLabel) branchLabel.textContent = mode === "new" ? "Start from" : "Branch to continue";
		if (branchSelect) {
			branchSelect.name = mode === "new" ? "base" : "branch";
			const target = mode === "new" ? branchSelect.dataset.defaultBranch : branchSelect.dataset.continueBranch;
			if (target && [...branchSelect.options].some((opt) => opt.value === target)) branchSelect.value = target;
		}
	});

	dialog.addEventListener("change", async (event) => {
		const repoSelect = event.target.closest("[data-repo-select]");
		if (!repoSelect) return;
		const repo = repoSelect.value;
		const branchSelect = dialog.querySelector("[data-branch-select]");
		const submit = dialog.querySelector("[data-repo-submit]");
		if (!branchSelect) return;
		branchSelect.disabled = true;
		branchSelect.innerHTML = `<option value="">Loading…</option>`;
		if (submit) submit.disabled = true;
		try {
			const [owner, name] = repo.split("/");
			const list = await getJson(`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches`);
			const mode = dialog.querySelector("[data-repo-mode-input]")?.value || "new";
			const continueBranch = list.branches.find((b) => b !== list.defaultBranch) ?? list.defaultBranch;
			branchSelect.dataset.defaultBranch = list.defaultBranch;
			branchSelect.dataset.continueBranch = continueBranch;
			branchSelect.innerHTML = "";
			for (const b of list.branches) {
				const opt = document.createElement("option");
				opt.value = b;
				opt.textContent = b === list.defaultBranch ? `${b} (default)` : b;
				branchSelect.appendChild(opt);
			}
			branchSelect.value = mode === "new" ? list.defaultBranch : continueBranch;
			branchSelect.disabled = false;
			if (submit) submit.disabled = !branchSelect.value;
		} catch (error) {
			showToast({ message: describeFailure(error).message });
		}
	});
}

export async function openRepoPicker(requestedRepo, opener) {
	const dialog = document.getElementById("repo-picker");
	if (!dialog) return;
	wireRepoPicker(dialog);
	dialog._opener = opener instanceof HTMLElement ? opener : document.activeElement instanceof HTMLElement ? document.activeElement : null;
	try {
		const query = requestedRepo ? `?repo=${encodeURIComponent(requestedRepo)}` : "";
		dialog.innerHTML = await getHtml(`/ui/repos${query}`);
		if (!dialog.open) dialog.showModal();
	} catch (error) {
		showToast({ message: describeFailure(error).message });
	}
}
