// Native <dialog> controllers for the Sessions picker, Agents panel, Changes diff sheet, and the New session sheets.
// Browser natively handles top-layer stacking, ::backdrop, Escape key, focus trap, and returning focus to the opener.
import { Idiomorph } from "/vendor/idiomorph.esm.js";
import { describeFailure, getHtml, postJson } from "./api.js";
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

	const pinnedList = dialog.querySelector('ul.listing[aria-label="Pinned"]');
	if (pinnedList) {
		const entries = [...pinnedList.querySelectorAll(":scope > li.entry")].sort(cmp);
		for (const li of entries) pinnedList.appendChild(li);
	}

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

	// Recompute alternating row stripes across pinned, under-way, folder, and inactive rows.
	let stripe = 0;
	if (pinnedList) {
		for (const li of pinnedList.querySelectorAll(":scope > li.entry")) {
			li.querySelector(".row")?.classList.toggle("striped", stripe++ % 2 === 1);
		}
	}
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

// ---- Where and Branch sheets on the New session page

function startTargetEl() {
	return document.querySelector("[data-start-target]");
}

/** The query naming the target the chips show, plus any fields a choice in a sheet replaces. */
function targetQuery(changes) {
	const where = { ...(startTargetEl()?.dataset ?? {}) };
	const next = { ...where, ...changes };
	const params = new URLSearchParams();
	if (next.place === "local") {
		params.set("place", "local");
		params.set("dir", next.dir || "~");
	} else if (next.place === "repo") {
		params.set("place", "repo");
		params.set("repo", next.repo);
		params.set("mode", next.branchMode || "new");
		if (next.branchMode === "continue") {
			params.set("branch", next.ref);
			if (next.from) params.set("from", next.from);
		} else if (next.ref) {
			params.set("base", next.ref);
		}
	}
	return params.toString();
}

/** Swap the chips for the server's rendering of the new target, and keep the address in step so a reload keeps it. */
async function chooseTarget(changes) {
	const query = targetQuery(changes);
	const chips = await getHtml(`/ui/target?${query}`);
	const current = startTargetEl();
	if (!current) return;
	current.outerHTML = chips;
	history.replaceState(null, "", `/?${query}`);
	document.querySelector("[data-composer]")?.dispatchEvent(new CustomEvent("target-change"));
}

function filterChoices(dialog, text) {
	const needle = text.trim().toLowerCase();
	for (const row of dialog.querySelectorAll("[data-filter-text]")) row.hidden = needle !== "" && !row.dataset.filterText.includes(needle);
	for (const section of dialog.querySelectorAll("[data-choice-section]")) {
		section.hidden = [...section.querySelectorAll("[data-filter-text]")].every((row) => row.hidden);
	}
}

let startSheetKind = "place";

async function loadStartSheet(dialog) {
	const query = targetQuery({});
	dialog.innerHTML = await getHtml(`/ui/${startSheetKind === "place" ? "places" : "branches"}?${query}`);
}

function wireStartSheet(dialog) {
	wireDialogBasics(dialog, '[data-action="open-place"]');
	if (dialog.dataset.startWired === "true") return;
	dialog.dataset.startWired = "true";

	attachSwipeDown(dialog, {
		canStart: (target) => {
			const header = dialog.querySelector("[data-sheet-header]");
			const body = dialog.querySelector("[data-sheet-body]");
			return (target instanceof Node && header?.contains(target)) || (body?.scrollTop ?? 0) <= 0;
		},
		distance: (height) => height * 0.25,
		onDismiss: () => dialog.close(),
	});

	dialog.addEventListener("input", (event) => {
		if (event.target.matches?.("[data-choice-filter]")) filterChoices(dialog, event.target.value);
	});

	dialog.addEventListener("click", async (event) => {
		const star = event.target.closest('[data-action="star-repo"]');
		if (star) {
			try {
				await postJson("/api/repos/starred", { repo: star.dataset.repo, starred: star.dataset.starred !== "true" });
				const filter = dialog.querySelector("[data-choice-filter]")?.value ?? "";
				await loadStartSheet(dialog);
				const input = dialog.querySelector("[data-choice-filter]");
				if (input && filter) {
					input.value = filter;
					filterChoices(dialog, filter);
				}
			} catch (error) {
				showToast({ message: describeFailure(error).message });
			}
			return;
		}

		const place = event.target.closest("[data-choose-place]");
		const branch = event.target.closest("[data-choose-branch]");
		if (!place && !branch) return;
		// A new place starts on a new branch from its default; a branch choice keeps the repository.
		const changes = place
			? place.dataset.choosePlace === "local"
				? { place: "local", dir: place.dataset.dir || "~", repo: "", branchMode: "", ref: "", from: "" }
				: { place: "repo", repo: place.dataset.repo, dir: "", branchMode: "new", ref: "", from: "" }
			: branch.dataset.chooseBranch === "new"
				? { branchMode: "new", ref: branch.dataset.base || "", from: "" }
				: { branchMode: "continue", ref: branch.dataset.branch, from: branch.dataset.from || "" };
		try {
			await chooseTarget(changes);
			// The chip that opened the sheet was just replaced; the field is where the person goes next.
			dialog._opener = document.querySelector("[data-composer-input]");
			dialog.close();
		} catch (error) {
			showToast({ message: describeFailure(error).message });
		}
	});
}

export async function openStartSheet(kind, opener) {
	const dialog = document.getElementById("start-sheet");
	if (!dialog) return;
	wireStartSheet(dialog);
	startSheetKind = kind;
	dialog._opener = opener instanceof HTMLElement ? opener : null;
	try {
		await loadStartSheet(dialog);
		if (!dialog.open) dialog.showModal();
		(dialog.querySelector('.place-choose[aria-current="true"]') ?? dialog.querySelector(".place-choose"))?.focus({ preventScroll: true });
	} catch (error) {
		showToast({ message: describeFailure(error).message });
	}
}
