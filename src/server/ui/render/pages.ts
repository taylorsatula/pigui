// Pure HTML renderers for the pages (New session, session, agent, not found), the dialog fragments (session picker,
// agents panel, diff sheet, the Where and Branch sheets), and live-updatable regions (header, banner).
import type { BranchList, MemoryStatus, RepoSummary, SessionDiff } from "../../../shared/api.ts";
import {
	agentLive,
	needsAttention,
	runFailureText,
	sessionRow,
	type AgentRow,
	type SessionDoc,
	type SessionIndex,
	type SessionRow,
} from "../../../shared/session.ts";
import { formatDollars } from "../../../shared/spend.ts";
import {
	AGENT_LABELS,
	AGENT_TONES,
	agentCounts,
	agentCountText,
	agentDetail,
	agentElapsed,
	type AgentDocs,
	listingDate,
	placeholderFor,
	shortDir,
	spendTone,
	timeAgo,
	whereOfRow,
} from "../format.ts";
import { classes, type Html, html, joinHtml } from "../html.ts";
import { icon } from "../icons.ts";
import type { Block } from "../transcript.ts";
import { renderPatch, renderTranscriptRows } from "./blocks.ts";

export function attentionCount(index: SessionIndex | undefined, currentSessionId?: number): number {
	return Object.values(index?.rows ?? {}).filter((row) => row.id !== currentSessionId && needsAttention(row)).length;
}

export function sessionsButtonLabel(others: number): string {
	return others > 0 ? `Sessions, ${others} need${others === 1 ? "s" : ""} you` : "Sessions";
}

export function renderSessionsButton(index: SessionIndex | undefined, currentSessionId?: number): Html {
	const others = attentionCount(index, currentSessionId);
	return html`<button
		type="button"
		class="icon-button menu"
		data-action="open-picker"
		data-sessions-button
		aria-label="${sessionsButtonLabel(others)}"
		aria-haspopup="dialog"
		aria-controls="session-picker"
	>
		${icon("menu")}
		${others > 0 ? html`<span class="dot badge-dot" data-testid="attention-dot"></span>` : html``}
	</button>`;
}

export function renderAgentsButton(doc: SessionDoc): Html {
	const rows = doc.agents ?? [];
	if (rows.length === 0) return html``;
	const live = agentCounts(rows);
	const total = live.running + live.queued;
	return html`<button
		type="button"
		class="icon-button"
		data-action="open-agents"
		data-session="${doc.id}"
		aria-label="${total === 0 ? "Agents" : `Agents, ${agentCountText(live)}`}"
		aria-haspopup="dialog"
		aria-controls="agents-panel"
	>
		${icon("agents")}
		${total > 0 ? html`<span class="count-badge" aria-hidden="true">${total}</span>` : html``}
	</button>`;
}

// ---- New session page (/)

/** Where a new session will work: what the two chips above the composer show, and what its first send creates. */
export type StartTarget =
	| { place: "local"; dir: string }
	/** A new branch, cut from `base`, or from the repository's default branch when none was chosen. */
	| { place: "repo"; repo: string; mode: "new"; base?: string }
	/** An existing branch; with `from`, taken from that session's clone, unpushed commits and all. */
	| { place: "repo"; repo: string; mode: "continue"; branch: string; from?: number };

/** The query string that names `target`, read back by the server on `/` and by the sheets that change it. */
export function startQuery(target: StartTarget): string {
	const params = new URLSearchParams({ place: target.place });
	if (target.place === "local") params.set("dir", target.dir);
	else {
		params.set("repo", target.repo);
		params.set("mode", target.mode);
		if (target.mode === "new" && target.base !== undefined) params.set("base", target.base);
		if (target.mode === "continue") {
			params.set("branch", target.branch);
			if (target.from !== undefined) params.set("from", String(target.from));
		}
	}
	return params.toString();
}

function repoShortName(repo: string): string {
	return repo.slice(repo.indexOf("/") + 1);
}

/** The two chips that say where the work happens, each opening the sheet that changes it. Carries the target as data. */
export function renderStartTarget(target: StartTarget | undefined, home: string | undefined): Html {
	if (target === undefined) {
		return html`<div class="start-target" data-start-target>
			<button type="button" class="start-chip" data-action="open-place" aria-haspopup="dialog">
				${icon("repo", 17)}<span class="start-chip-label">Choose a repository</span>
			</button>
		</div>`;
	}
	if (target.place === "local") {
		const where = shortDir(target.dir, home);
		return html`<div class="start-target" data-start-target data-place="local" data-dir="${target.dir}">
			<button type="button" class="start-chip" data-action="open-place" aria-haspopup="dialog" aria-label="Where: this computer, ${where}">
				${icon("monitor", 17)}<span class="start-chip-label">${where === "~" ? "This computer" : where}</span>
			</button>
		</div>`;
	}
	const ref = target.mode === "new" ? (target.base ?? "") : target.branch;
	const branchLabel = target.mode === "continue" ? target.branch : target.base === undefined ? "New branch" : `New branch from ${target.base}`;
	return html`<div
		class="start-target"
		data-start-target
		data-place="repo"
		data-repo="${target.repo}"
		data-branch-mode="${target.mode}"
		data-ref="${ref}"
		${target.mode === "continue" && target.from !== undefined ? html` data-from="${target.from}"` : html``}
	>
		<button type="button" class="start-chip" data-action="open-place" aria-haspopup="dialog" aria-label="Repository: ${target.repo}" title="${target.repo}">
			${icon("repo", 17)}<span class="start-chip-label">${repoShortName(target.repo)}</span>
		</button>
		<button type="button" class="start-chip" data-action="open-branch" aria-haspopup="dialog" aria-label="Branch: ${branchLabel}">
			${icon("branch", 17)}<span class="start-chip-label">${branchLabel}</span>
		</button>
	</div>`;
}

export function renderNewSessionPage(ctx: { index: SessionIndex | undefined; target: StartTarget | undefined; home?: string }): Html {
	return html`<div class="session">
		<div class="pinned">
			<header class="topbar">
				${renderSessionsButton(ctx.index)}
				<h1 class="title">New session</h1>
			</header>
		</div>
		<div class="blank-body" aria-hidden="true"></div>
		<div class="composer-dock" id="composer-dock">
			${renderComposerForm({
				mode: "start",
				draftKey: "new",
				placeholder: "Describe the task…",
				running: false,
				disabled: false,
				target: renderStartTarget(ctx.target, ctx.home),
			})}
		</div>
	</div>`;
}

// ---- Composer form primitive

type ComposerOptions = {
	mode: "start" | "session";
	sessionId?: number;
	draftKey: string;
	placeholder: string;
	running: boolean;
	disabled: boolean;
	/** On the New session page, the chips that say where the first send starts the work. */
	target?: Html;
};

function renderComposerForm(opts: ComposerOptions): Html {
	return html`<form
		class="composer"
		data-composer="${opts.mode}"
		data-draft-key="${opts.draftKey}"
		data-running="${opts.running ? "true" : "false"}"
		${opts.sessionId !== undefined ? html` data-session-id="${opts.sessionId}"` : html``}
	>
		<ul class="picker" role="listbox" aria-label="References" data-ref-picker hidden></ul>
		${opts.target ?? html``}
		<div class="attachments" data-attachments hidden></div>
		<div class="field-line">
			<button type="button" class="icon-button" aria-label="Attach files or photos" data-attach-trigger${opts.disabled ? html` disabled` : html``}>
				${icon("clip")}
			</button>
			<input type="file" multiple hidden data-attach-input />
			<textarea
				rows="1"
				placeholder="${opts.placeholder}"
				aria-label="${opts.placeholder}"
				data-composer-input
				${opts.disabled ? html` disabled` : html``}
			></textarea>
			<button type="button" class="halt" data-stop-button${opts.running ? html`` : html` hidden`}>[ HALT WORK ]</button>
			<button type="submit" class="icon-button send" aria-label="Send" data-send-button${opts.running ? html` hidden` : html``} disabled>
				${icon("send", 18)}
			</button>
		</div>
	</form>`;
}

// ---- Session page (/s/:id)

export function renderSessionHeaderContent(doc: SessionDoc, spent: number, home: string | undefined): Html {
	const row = sessionRow(doc);
	const where = doc.place === "local" ? shortDir(doc.dir, home) : `${doc.repo} · ${doc.branch}`;
	return html`<h1 class="title">${doc.title}</h1>
		<p class="subtitle" role="status">
			<span class="${classes("session-status", row.tone)}">${row.label}</span>
			<span class="where">${where}</span>
			${
				spent > 0
					? html`<span class="${classes("spend", spendTone(spent, doc.cap))}">${formatDollars(spent)}${doc.cap === undefined ? "" : ` of ${formatDollars(doc.cap)}`}</span>`
					: html``
			}
		</p>`;
}

export function renderBanner(doc: SessionDoc, spent: number, running: boolean): Html {
	if (doc.setup.status === "failed") {
		return html`<div class="banner error" role="alert">
			<p><strong>Setup failed.</strong> ${doc.setup.error}</p>
			<button type="button" class="primary" data-action="retry-setup" data-session="${doc.id}">Retry setup</button>
		</div>`;
	}
	if (running || doc.outcome === undefined) return html``;
	switch (doc.outcome.kind) {
		case "failed":
			return html`<div class="banner error" role="alert">
				<p><strong>${runFailureText(doc.outcome.reason)}.</strong> ${doc.outcome.detail ?? ""}</p>
				<button type="button" class="primary" data-action="continue" data-session="${doc.id}">Continue</button>
			</div>`;
		case "budget": {
			const raised = Math.max((doc.cap ?? 0) * 2, Math.ceil(spent) + 1);
			return html`<div class="banner warn" role="alert">
				<p><strong>Budget reached.</strong> ${formatDollars(spent)} spent of ${formatDollars(doc.cap ?? 0)}.</p>
				<button type="button" class="primary" data-action="raise-budget" data-session="${doc.id}" data-cap="${raised}">Raise to ${formatDollars(raised)} and continue</button>
			</div>`;
		}
		case "no-report":
			return html`<div class="banner warn" role="alert">
				<p><strong>Pi stopped without a report.</strong> It was continued automatically and still did not finish.</p>
				<button type="button" class="primary" data-action="continue" data-session="${doc.id}">Continue</button>
			</div>`;
		case "stopped":
			return html`<div class="banner" role="status">
				<p>Stopped.</p>
				<button type="button" class="secondary" data-action="continue" data-session="${doc.id}">Continue</button>
			</div>`;
		default:
			return html``;
	}
}

export function renderSessionPage(opts: {
	doc: SessionDoc;
	index: SessionIndex | undefined;
	blocks: readonly Block[];
	spent: number;
	running: boolean;
	speech: boolean;
	home?: string;
}): Html {
	const { doc, index, blocks, spent, running, speech, home } = opts;
	const disabled = doc.setup.status !== "ready" || doc.cleanedAt !== undefined;
	return html`<div class="session">
		<div class="pinned">
			<header class="topbar">
				${renderSessionsButton(index, doc.id)}
				<div class="title-block" id="session-header-content">
					${renderSessionHeaderContent(doc, spent, home)}
				</div>
				${
					doc.place === "repo"
						? html`<button type="button" class="icon-button" aria-label="View changes" data-action="open-diff" data-session="${doc.id}" data-diff-button${doc.setup.status !== "ready" ? html` disabled` : html``}>
								${icon("diff")}
							</button>`
						: html``
				}
				<span id="agents-button-slot">${renderAgentsButton(doc)}</span>
			</header>
		</div>
		<div class="transcript" id="transcript" role="log">
			${renderTranscriptRows(blocks, { session: doc, running, speech })}
		</div>
		<div class="composer-dock" id="composer-dock">
			<div id="session-banner">${renderBanner(doc, spent, running)}</div>
			${renderComposerForm({
				mode: "session",
				sessionId: doc.id,
				draftKey: `session:${doc.id}`,
				placeholder: placeholderFor(doc, running),
				running,
				disabled,
			})}
		</div>
	</div>`;
}

// ---- Subagent viewer page (/s/:id/agent/:agent)

export function renderAgentHeaderContent(row: AgentRow): Html {
	return html`<h1 class="title">${row.description}</h1>
		<p class="subtitle" role="status">
			<span class="${classes("session-status", AGENT_TONES[row.status])}">${AGENT_LABELS[row.status]}</span>
			<span class="where">${row.type}</span>
		</p>`;
}

export function renderAgentPage(opts: {
	sessionId: number;
	row: AgentRow;
	index: SessionIndex | undefined;
	blocks: readonly Block[];
	running: boolean;
	speech: boolean;
}): Html {
	const { sessionId, row, index, blocks, running, speech } = opts;
	return html`<div class="session agent-view">
		<div class="pinned">
			<header class="topbar">
				<a class="icon-button back" href="/s/${sessionId}" aria-label="Back to the session">${icon("back")}</a>
				<div class="title-block" id="session-header-content">
					${renderAgentHeaderContent(row)}
				</div>
				<span id="agent-stop-slot">
					${agentLive(row) ? html`<button type="button" class="secondary agent-stop" data-action="stop-agent" data-session="${sessionId}" data-agent="${row.id}">Stop</button>` : html``}
				</span>
				${renderSessionsButton(index, sessionId)}
			</header>
		</div>
		<div class="transcript" id="transcript" role="log">
			${renderTranscriptRows(blocks, { session: undefined, running, speech })}
		</div>
	</div>`;
}

export function renderNotFoundPage(index: SessionIndex | undefined, message: string, backHref?: string): Html {
	return html`<div class="session">
		<header class="topbar">
			${backHref !== undefined ? html`<a class="icon-button back" href="${backHref}" aria-label="Back to the session">${icon("back")}</a>` : renderSessionsButton(index)}
			<h1 class="title">Not found</h1>
		</header>
		<p class="empty">${message}</p>
	</div>`;
}

// ---- Dialog fragments

const STALE_MS = 12 * 60 * 60 * 1000;
export type PickerColumn = "name" | "where" | "modified" | "status";

const COLUMNS: ReadonlyArray<{ column: PickerColumn; label: string }> = [
	{ column: "name", label: "Name" },
	{ column: "where", label: "Where" },
	{ column: "modified", label: "Modified" },
	{ column: "status", label: "Status" },
];

function rowActive(row: SessionRow, now: number): boolean {
	return !row.archived && row.tone !== "done" && now - row.updatedAt < STALE_MS;
}

function sortRows(rows: readonly SessionRow[], column: PickerColumn, ascending: boolean, home: string | undefined): SessionRow[] {
	const text = (row: SessionRow) => (column === "name" ? row.title : column === "where" ? whereOfRow(row, home) : row.label);
	const cmp = (a: SessionRow, b: SessionRow) => (column === "modified" ? a.updatedAt - b.updatedAt : text(a).localeCompare(text(b)));
	return [...rows].sort((a, b) => (ascending ? cmp(a, b) : cmp(b, a)));
}

function renderSessionEntry(row: SessionRow, opts: { current: boolean; striped: boolean; nested: boolean; home: string | undefined; pinned: boolean; now: number }): Html {
	const action = row.archived ? "Restore" : "Archive";
	const rowCls = classes("row", opts.current && "current", opts.striped && "striped", opts.nested && "nested", needsAttention(row) && "unseen");
	const where = whereOfRow(row, opts.home);
	return html`<li
		class="entry"
		data-sort-name="${row.title}"
		data-sort-where="${where}"
		data-sort-modified="${row.updatedAt}"
		data-sort-status="${row.label}"
	>
		<a href="/s/${row.id}" class="${rowCls}"${opts.current ? html` aria-current="page"` : html``}>
			<span class="row-name">
				<span class="${classes("indicator", row.tone)}" aria-hidden="true"></span>
				<span class="row-title">${row.title}</span>
			</span>
			<span class="row-where">${where}</span>
			<time class="row-modified" datetime="${new Date(row.updatedAt).toISOString()}" data-at="${row.updatedAt}">
				<span class="when-wide">${listingDate(row.updatedAt, opts.now)}</span>
				<span class="when-narrow">${timeAgo(row.updatedAt, opts.now)}</span>
			</time>
			<span class="row-status">${row.label}</span>
		</a>
		<button
			type="button"
			class="icon-button dir-star row-action row-pin"
			aria-label="${opts.pinned ? "Unpin" : "Pin"} ${row.title}"
			aria-pressed="${opts.pinned ? "true" : "false"}"
			data-action="pin"
			data-session="${row.id}"
			data-pinned="${opts.pinned ? "true" : "false"}"
		>${icon("pin", 18)}</button>
		<button
			type="button"
			class="icon-button row-action"
			aria-label="${action} ${row.title}"
			title="${action}"
			data-action="archive"
			data-session="${row.id}"
			data-archived="${row.archived ? "true" : "false"}"
			data-current="${opts.current ? "true" : "false"}"
		>${icon(row.archived ? "restore" : "archive", 18)}</button>
	</li>`;
}

export function renderPickerDialog(opts: {
	index: SessionIndex | undefined;
	current?: number;
	column: PickerColumn;
	ascending: boolean;
	inactiveOpen?: boolean;
	home?: string;
	memory: MemoryStatus;
	now: number;
}): Html {
	const rows = Object.values(opts.index?.rows ?? {});
	const pinnedIds = new Set(opts.index?.pinned ?? []);
	// Pinned sessions head the list, archived or not, since archiving is not unpinning; the rest split by activity.
	const pinned = sortRows(rows.filter((row) => pinnedIds.has(row.id)), opts.column, opts.ascending, opts.home);
	const unpinned = rows.filter((row) => !pinnedIds.has(row.id));
	const underWay = sortRows(unpinned.filter((row) => rowActive(row, opts.now)), opts.column, opts.ascending, opts.home);
	const inactive = sortRows(unpinned.filter((row) => !rowActive(row, opts.now)), opts.column, opts.ascending, opts.home);
	const folderOpen = opts.inactiveOpen ?? inactive.some((row) => row.id === opts.current);

	let stripe = 0;
	const pinnedStripes = pinned.map(() => stripe++ % 2 === 1);
	const underStripes = underWay.map(() => stripe++ % 2 === 1);
	const folderStripe = stripe++ % 2 === 1;
	const nestedStripes = inactive.map(() => stripe++ % 2 === 1);

	return html`<header class="picker-bar">
			<h2>Sessions</h2>
			<a class="link" href="/">${icon("plus", 20)} New</a>
			<button type="button" class="icon-button" aria-label="Close" data-dialog-close>${icon("close", 20)}</button>
		</header>
		<div class="picker-columns" role="group" aria-label="Sort by">
			${COLUMNS.map(({ column, label }) => {
				const isSorted = opts.column === column;
				const nextDir = isSorted ? (opts.ascending ? "desc" : "asc") : column === "modified" ? "desc" : "asc";
				return html`<button
					type="button"
					class="${classes("heading", `heading-${column}`, isSorted && "sorted")}"
					aria-pressed="${isSorted ? "true" : "false"}"
					data-sort-column="${column}"
					data-sort-dir="${nextDir}"
				>
					${label}
					${isSorted ? html`<span class="${classes("sort-mark", opts.ascending ? "up" : "down")}">${icon("chevron", 12)}</span>` : html``}
				</button>`;
			})}
		</div>
		<div class="picker-list" data-picker-list>
			${rows.length === 0 ? html`<p class="empty">No sessions yet. Start one with New.</p>` : html``}
			${
				pinned.length > 0
					? html`<ul class="listing pinned-listing" aria-label="Pinned">
							${pinned.map((row, i) =>
								renderSessionEntry(row, {
									current: row.id === opts.current,
									striped: pinnedStripes[i] ?? false,
									nested: false,
									home: opts.home,
									pinned: true,
									now: opts.now,
								}),
							)}
						</ul>`
					: html``
			}
			<ul class="listing" aria-label="Under way">
				${underWay.map((row, i) =>
					renderSessionEntry(row, {
						current: row.id === opts.current,
						striped: underStripes[i] ?? false,
						nested: false,
						home: opts.home,
						pinned: pinnedIds.has(row.id),
						now: opts.now,
					}),
				)}
				${
					inactive.length > 0
						? html`<li>
								<button type="button" class="${classes("row folder", folderStripe && "striped")}" aria-expanded="${folderOpen ? "true" : "false"}" data-action="toggle-inactive">
									<span class="row-name">
										<span class="disclosure">${icon("chevron", 12)}</span>
										<span class="folder-mark">${icon("folder", 16)}</span>
										<span class="row-title">Inactive</span>
									</span>
									<span class="row-where"></span>
									<span class="row-modified">${inactive.length} ${inactive.length === 1 ? "session" : "sessions"}</span>
									<span class="row-status">Folder</span>
								</button>
								<ul class="listing" aria-label="Inactive" data-inactive-list${folderOpen ? html`` : html` hidden`}>
									${inactive.map((row, i) =>
										renderSessionEntry(row, {
											current: row.id === opts.current,
											striped: nestedStripes[i] ?? false,
											nested: true,
											home: opts.home,
											pinned: pinnedIds.has(row.id),
											now: opts.now,
										}),
									)}
								</ul>
							</li>`
						: html``
				}
			</ul>
		</div>
		<footer class="picker-status">
			<p class="picker-count">${pinned.length > 0 ? `${pinned.length} pinned, ` : ""}${underWay.length} under way, ${inactive.length} inactive</p>
			${
				!opts.memory.on
					? html`<div class="banner warn picker-notice" role="status"><p><strong>Memory is off</strong>${opts.memory.reason}</p></div>`
					: html``
			}
			<span data-push-slot></span>
		</footer>`;
}

export function renderAgentsDialog(doc: SessionDoc, docsByAgent: Readonly<Record<number, Partial<AgentDocs>>>, now?: number): Html {
	const rows = doc.agents ?? [];
	const newest = [...rows].sort((a, b) => b.createdAt - a.createdAt);
	const waiting = rows.filter((row) => row.status === "queued").sort((a, b) => a.task - b.task);
	const live = agentCounts(rows);

	return html`<header class="picker-bar">
			<h2>Agents</h2>
			<p class="agents-count" data-agents-count>${agentCountText(live) || "none at work"}</p>
			<button type="button" class="icon-button" aria-label="Close" data-dialog-close>${icon("close", 20)}</button>
		</header>
		<ul class="agent-list">
			${newest.map((row) => {
				const isLive = agentLive(row);
				const elapsedText = row.endedAt !== undefined || now !== undefined ? agentElapsed(row, now ?? row.endedAt ?? 0) : "—";
				return html`<li id="agent-row-${row.id}" class="${classes("agent-row", row.status)}" data-agent-id="${row.id}">
					<a id="agent-open-${row.id}" class="agent-open" href="/s/${doc.id}/agent/${row.id}" aria-label="${row.type}: ${row.description}, ${AGENT_LABELS[row.status].toLowerCase()}">
						<span class="${classes("indicator", AGENT_TONES[row.status])}" aria-hidden="true"></span>
						<span class="agent-main">
							<span class="agent-line">
								<span class="agent-type">${row.type}</span>
								<span class="agent-description">${row.description}</span>
							</span>
							<span class="agent-detail">${agentDetail(row, docsByAgent[row.id], waiting.indexOf(row) + 1)}</span>
						</span>
						<span id="agent-time-${row.id}" class="agent-time"${row.startedAt !== undefined ? html` data-started-at="${row.startedAt}"` : html``}${row.endedAt !== undefined ? html` data-ended-at="${row.endedAt}"` : html``}>${elapsedText}</span>
					</a>
					${
						isLive
							? html`<button id="agent-stop-${row.id}" type="button" class="secondary agent-stop" aria-label="Stop ${row.type}: ${row.description}" data-action="stop-agent" data-session="${doc.id}" data-agent="${row.id}">Stop</button>`
							: html``
					}
				</li>`;
			})}
		</ul>`;
}

function renderDiffCounts(added: number, removed: number): Html {
	return html`<span class="diff-counts"><span class="${classes("add", added === 0 && "zero")}">+${added}</span> <span class="${classes("del", removed === 0 && "zero")}">−${removed}</span></span>`;
}

export function renderDiffDialog(diff: SessionDiff | undefined, error?: string): Html {
	const added = diff?.files.reduce((sum, file) => sum + file.added, 0) ?? 0;
	const removed = diff?.files.reduce((sum, file) => sum + file.removed, 0) ?? 0;
	return html`<header class="sheet-header" data-sheet-header>
			<span class="grabber" aria-hidden="true"></span>
			<h2 id="diff-title">Changes</h2>
			<button type="button" class="link done" data-dialog-close>Done</button>
		</header>
		<div class="sheet-body" data-sheet-body>
			${
				error !== undefined
					? html`<p class="error-text">${error}</p>`
					: diff === undefined
						? html`<p class="sheet-status"><span class="spinner" aria-hidden="true"></span> Loading…</p>`
						: joinHtml([
								html`<p class="diff-summary">
									<span>${diff.files.length} file${diff.files.length === 1 ? "" : "s"} changed against ${diff.base}</span>
									${diff.files.length > 0 ? renderDiffCounts(added, removed) : html``}
								</p>`,
								diff.uncommitted > 0 ? html`<p class="diff-note warn">${diff.uncommitted} uncommitted, not included</p>` : html``,
								diff.files.length === 0 ? html`<p class="sheet-status">No committed changes yet.</p>` : html``,
								...diff.files.map(
									(file) => html`<details class="diff-file">
										<summary>
											${icon("chevron", 16)}
											<span class="diff-path">${file.from === undefined ? file.path : `${file.from} → ${file.path}`}</span>
											${file.binary ? html`<span class="diff-counts">binary</span>` : renderDiffCounts(file.added, file.removed)}
										</summary>
										${file.binary ? html`<p class="diff-note">A binary file.</p>` : renderPatch(file.patch)}
										${file.truncated ? html`<p class="diff-note">The rest of this file's changes are too long to show here.</p>` : html``}
									</details>`,
								),
							])
			}
		</div>`;
}

/** A sheet of choices: a grabber, a title, Done, then a filter over its rows when it has many. */
function renderChoiceSheet(title: string, filterLabel: string | undefined, body: Html): Html {
	return html`<header class="sheet-header" data-sheet-header>
			<span class="grabber" aria-hidden="true"></span>
			<h2 id="start-sheet-title">${title}</h2>
			<button type="button" class="link done" data-dialog-close>Done</button>
		</header>
		<div class="sheet-body choice-body" data-sheet-body>
			${filterLabel !== undefined ? html`<input type="search" class="choice-filter" placeholder="${filterLabel}" aria-label="${filterLabel}" data-choice-filter />` : html``}
			${body}
		</div>`;
}

const FILTER_FROM = 8;

function renderChoice(opts: { attrs: Html; iconName: "repo" | "monitor" | "branch"; name: string; sub?: string; chosen: boolean; label: string }): Html {
	return html`<button type="button" class="place-choose"${opts.chosen ? html` aria-current="true"` : html``} aria-label="${opts.label}" ${opts.attrs}>
		<span class="place-icon">${icon(opts.iconName, 17)}</span>
		<span class="place-text">
			<span class="place-name">${opts.name}</span>
			${opts.sub !== undefined ? html`<span class="place-sub">${opts.sub}</span>` : html``}
		</span>
		<span class="choice-check" aria-hidden="true">${opts.chosen ? icon("check", 18) : html``}</span>
	</button>`;
}

/** The Where sheet: this computer (OnPrem), then the starred repositories, then every other one, each with its star. */
export function renderPlaceSheet(opts: {
	repos: readonly RepoSummary[];
	starred: readonly string[];
	current: StartTarget | undefined;
	onPrem: boolean;
	error?: string;
}): Html {
	const starred = [...opts.starred].sort((a, b) => a.localeCompare(b));
	const others = opts.repos.map((item) => item.name).filter((name) => !starred.includes(name));
	const described = new Map(opts.repos.map((item) => [item.name, item.description]));
	const currentRepo = opts.current?.place === "repo" ? opts.current.repo : undefined;

	const repoRow = (name: string, isStarred: boolean) => html`<li class="place-row" data-filter-text="${name.toLowerCase()}">
		${renderChoice({
			attrs: html`data-choose-place="repo" data-repo="${name}"`,
			iconName: "repo",
			name,
			...(described.get(name) ? { sub: described.get(name) } : {}),
			chosen: name === currentRepo,
			label: name,
		})}
		<button type="button" class="icon-button dir-star" aria-label="Star ${name}" aria-pressed="${isStarred ? "true" : "false"}" data-action="star-repo" data-repo="${name}" data-starred="${isStarred ? "true" : "false"}">
			${icon("star", 18)}
		</button>
	</li>`;

	const section = (label: string, rows: Html[]) =>
		rows.length === 0
			? html``
			: html`<section class="choice-section" aria-label="${label}" data-choice-section>
					<h3 class="list-heading">${label}</h3>
					<ul class="place-list">${rows}</ul>
				</section>`;

	return renderChoiceSheet(
		"Where",
		starred.length + others.length >= FILTER_FROM ? "Filter repositories" : undefined,
		joinHtml([
			opts.error !== undefined ? html`<p class="error-text">${opts.error}</p>` : html``,
			opts.onPrem
				? section("On this computer", [
						html`<li class="place-row" data-filter-text="this computer">
							${renderChoice({
								attrs: html`data-choose-place="local" data-dir="~"`,
								iconName: "monitor",
								name: "This computer",
								sub: "~",
								chosen: opts.current?.place === "local",
								label: "This computer",
							})}
						</li>`,
					])
				: html``,
			section("Starred", starred.map((name) => repoRow(name, true))),
			section(starred.length > 0 ? "Other repositories" : "Repositories", others.map((name) => repoRow(name, false))),
			opts.error === undefined && starred.length + others.length === 0 ? html`<p class="sheet-status">No repositories. Check the server's GitHub access.</p>` : html``,
		]),
	);
}

/** One branch a session has been working on, as offered for continuing. */
export type SessionBranch = { branch: string; session: SessionRow; unpushed?: number };

/**
 * The Branch sheet: a new branch (the default), then the branches sessions have worked on, newest first, which carry
 * their unpushed commits along, then the rest of the repository's branches on GitHub.
 */
export function renderBranchSheet(opts: {
	current: Extract<StartTarget, { place: "repo" }>;
	sessionBranches: readonly SessionBranch[];
	branches?: BranchList;
	error?: string;
	now: number;
}): Html {
	const { current } = opts;
	const defaultBranch = opts.branches?.defaultBranch;
	const fromSessions = new Set(opts.sessionBranches.map((item) => item.branch));
	const onGitHub = (opts.branches?.branches ?? []).filter((name) => name !== defaultBranch && !fromSessions.has(name));
	const base = current.mode === "new" ? (current.base ?? defaultBranch) : defaultBranch;
	const chosenBranch = current.mode === "continue" ? current.branch : undefined;
	const total = opts.sessionBranches.length + onGitHub.length;

	const section = (label: string, rows: Html[]) =>
		rows.length === 0
			? html``
			: html`<section class="choice-section" aria-label="${label}" data-choice-section>
					<h3 class="list-heading">${label}</h3>
					<ul class="place-list">${rows}</ul>
				</section>`;

	return renderChoiceSheet(
		"Branch",
		total >= FILTER_FROM ? "Filter branches" : undefined,
		joinHtml([
			opts.error !== undefined ? html`<p class="error-text">${opts.error}</p>` : html``,
			html`<section class="choice-section" aria-label="Start fresh" data-choice-section>
				<ul class="place-list">
					<li class="place-row" data-filter-text="new branch">
						${renderChoice({
							attrs: html`data-choose-branch="new"${current.mode === "new" && current.base !== undefined ? html` data-base="${current.base}"` : html``}`,
							iconName: "branch",
							name: "New branch",
							sub: base === undefined ? "from the default branch" : `from ${base}`,
							chosen: current.mode === "new",
							label: "New branch",
						})}
					</li>
				</ul>
			</section>`,
			section(
				"Continue a session's branch",
				opts.sessionBranches.map(({ branch, session, unpushed }) => {
					const facts = [session.title, timeAgo(session.updatedAt, opts.now), ...(unpushed !== undefined && unpushed > 0 ? [`${unpushed} not pushed`] : [])];
					return html`<li class="place-row" data-filter-text="${`${branch} ${session.title}`.toLowerCase()}">
						${renderChoice({
							attrs: html`data-choose-branch="continue" data-branch="${branch}" data-from="${session.id}"`,
							iconName: "branch",
							name: branch,
							sub: facts.join(" · "),
							chosen: chosenBranch === branch,
							label: `Continue ${branch}`,
						})}
					</li>`;
				}),
			),
			section(
				"Continue a branch on GitHub",
				onGitHub.map(
					(branch) => html`<li class="place-row" data-filter-text="${branch.toLowerCase()}">
						${renderChoice({
							attrs: html`data-choose-branch="continue" data-branch="${branch}"`,
							iconName: "branch",
							name: branch,
							chosen: chosenBranch === branch,
							label: `Continue ${branch}`,
						})}
					</li>`,
				),
			),
		]),
	);
}
