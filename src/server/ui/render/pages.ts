// Pure HTML renderers for all four pages (splash, start, session, agent), the four modal dialog fragments (session
// picker, agents panel, diff sheet, repo picker), and live-updatable regions (header, banner, splash lists).
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
	whereOfFavorite,
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

// ---- Splash / New session page

export type SplashContext = {
	index: SessionIndex | undefined;
	onPrem: boolean;
	home?: string;
	starredDefaults: Readonly<Record<string, string>>;
	now: number;
};

function startUrlForRepo(repo: string, mode: "new" | "continue", ref: string): string {
	const params = new URLSearchParams({ place: "repo", repo, mode });
	params.set(mode === "new" ? "base" : "branch", ref);
	return `/start?${params.toString()}`;
}

export function renderSplashLists(ctx: SplashContext): Html {
	const index = ctx.index;
	const rows = Object.values(index?.rows ?? {});
	const starredRepos = [...(index?.starredRepos ?? [])].sort((a, b) => a.localeCompare(b));
	const pinnedIds = index?.pinned ?? [];
	const pinned = rows.filter((row) => pinnedIds.includes(row.id)).sort((a, b) => b.updatedAt - a.updatedAt);

	const newestBranchFor = (name: string): string | undefined => {
		const matching = rows.filter((row): row is SessionRow & { place: "repo" } => row.place === "repo" && row.repo === name && !row.archived);
		matching.sort((a, b) => b.updatedAt - a.updatedAt);
		return matching[0]?.branch;
	};

	const shownElsewhere = new Set<string>([
		...starredRepos.flatMap((name) => {
			const branch = newestBranchFor(name);
			return branch === undefined ? [] : [`${name}@${branch}`];
		}),
		...pinned.flatMap((row) => (row.place === "repo" ? [`${row.repo}@${row.branch}`] : [])),
	]);

	const byPlace = new Map<string, SessionRow & { place: "repo" }>();
	for (const row of rows) {
		if (row.place !== "repo" || row.archived) continue;
		const key = `${row.repo}@${row.branch}`;
		if (shownElsewhere.has(key)) continue;
		const seen = byPlace.get(key);
		if (seen === undefined || row.updatedAt > seen.updatedAt) byPlace.set(key, row);
	}
	const recent = [...byPlace.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);

	return joinHtml([
		starredRepos.length > 0
			? html`<section class="splash-section" aria-label="Starred">
					<h2 class="splash-heading">Starred</h2>
					<ul class="place-list">
						${starredRepos.map((name) => {
							const known = newestBranchFor(name);
							const fallback = ctx.starredDefaults[name];
							const sub = known !== undefined ? `continue ${known}` : fallback !== undefined ? `new branch from ${fallback}` : "Repository";
							const target =
								known !== undefined
									? html`<a class="place-choose" href="${startUrlForRepo(name, "continue", known)}">
											<span class="place-icon">${icon("branch", 17)}</span>
											<span class="place-text"><span class="place-name">${name}</span><span class="place-sub">${sub}</span></span>
										</a>`
									: fallback !== undefined
										? html`<a class="place-choose" href="${startUrlForRepo(name, "new", fallback)}">
												<span class="place-icon">${icon("branch", 17)}</span>
												<span class="place-text"><span class="place-name">${name}</span><span class="place-sub">${sub}</span></span>
											</a>`
										: html`<button type="button" class="place-choose" data-action="open-repo-picker" data-repo="${name}">
												<span class="place-icon">${icon("branch", 17)}</span>
												<span class="place-text"><span class="place-name">${name}</span><span class="place-sub">${sub}</span></span>
											</button>`;
							return html`<li class="place-row">
								${target}
								<button type="button" class="icon-button dir-star" aria-label="Star ${name}" aria-pressed="true" data-action="star-repo" data-repo="${name}" data-starred="true">
									${icon("star", 18)}
								</button>
							</li>`;
						})}
					</ul>
				</section>`
			: html``,
		pinned.length > 0
			? html`<section class="splash-section" aria-label="Pinned">
					<h2 class="splash-heading">Pinned</h2>
					<ul class="place-list">
						${pinned.map(
							(row) => html`<li class="place-row">
								<a href="/s/${row.id}" class="place-choose">
									<span class="place-icon">${icon(row.place === "local" ? "monitor" : "branch", 17)}</span>
									<span class="place-text">
										<span class="place-name">${row.title}</span>
										<span class="place-sub">${whereOfFavorite(row, ctx.home)} · ${timeAgo(row.updatedAt, ctx.now)}</span>
									</span>
								</a>
								<button type="button" class="icon-button dir-star" aria-label="Unpin ${row.title}" aria-pressed="true" data-action="pin" data-session="${row.id}" data-pinned="true">
									${icon("pin", 18)}
								</button>
							</li>`,
						)}
					</ul>
				</section>`
			: html``,
		recent.length > 0
			? html`<section class="splash-section" aria-label="Recent">
					<h2 class="splash-heading">Recent</h2>
					<ul class="place-list">
						${recent.map((row) => {
							const isStarred = starredRepos.includes(row.repo);
							return html`<li class="place-row">
								<a href="/s/${row.id}" class="place-choose">
									<span class="place-icon">${icon("branch", 17)}</span>
									<span class="place-text">
										<span class="place-name">${row.title}</span>
										<span class="place-sub">${row.repo} · ${row.branch} · ${timeAgo(row.updatedAt, ctx.now)}</span>
									</span>
								</a>
								<button type="button" class="icon-button dir-star" aria-label="Star ${row.repo}" aria-pressed="${isStarred ? "true" : "false"}" data-action="star-repo" data-repo="${row.repo}" data-starred="${isStarred ? "true" : "false"}">
									${icon("star", 18)}
								</button>
							</li>`;
						})}
					</ul>
				</section>`
			: html``,
	]);
}

export function renderSplashPage(ctx: SplashContext): Html {
	return html`<div class="session new-session">
		<header class="topbar">
			${renderSessionsButton(ctx.index)}
			<h1 class="title">New session</h1>
		</header>
		<div class="splash">
			<div class="tiles">
				${
					ctx.onPrem
						? html`<a class="tile" href="/start?place=local&amp;dir=~">
								${icon("monitor", 34)}
								<span class="tile-label">This computer</span>
							</a>`
						: html``
				}
				<button type="button" class="tile" data-action="open-repo-picker">
					${icon("branch", 34)}
					<span class="tile-label">Repository</span>
				</button>
			</div>
			<div id="splash-lists">${renderSplashLists(ctx)}</div>
		</div>
	</div>`;
}

// ---- Blank Start page (/start)

export type StartTarget =
	| { place: "local"; dir: string }
	| { place: "repo"; repo: string; mode: "new"; base: string }
	| { place: "repo"; repo: string; mode: "continue"; branch: string };

export function renderStartPage(target: StartTarget): Html {
	const where =
		target.place === "local"
			? target.dir
			: `${target.repo} · ${target.mode === "new" ? `new branch from ${target.base}` : `continue ${target.branch}`}`;
	const ref = target.place === "repo" ? (target.mode === "new" ? target.base : target.branch) : target.dir;

	return html`<div class="session blank">
		<div class="pinned">
			<header class="topbar">
				<a class="icon-button back" href="/" aria-label="Back to New session">${icon("back")}</a>
				<div class="title-block">
					<h1 class="title">New session</h1>
					<p class="subtitle"><span class="where">${where}</span></p>
				</div>
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
				place: target.place,
				dir: target.place === "local" ? target.dir : undefined,
				repo: target.place === "repo" ? target.repo : undefined,
				branchMode: target.place === "repo" ? target.mode : undefined,
				ref,
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
	place?: "local" | "repo";
	dir?: string;
	repo?: string;
	branchMode?: "new" | "continue";
	ref?: string;
};

function renderComposerForm(opts: ComposerOptions): Html {
	return html`<form
		class="composer"
		data-composer="${opts.mode}"
		data-draft-key="${opts.draftKey}"
		data-running="${opts.running ? "true" : "false"}"
		${opts.sessionId !== undefined ? html` data-session-id="${opts.sessionId}"` : html``}
		${opts.place !== undefined ? html` data-place="${opts.place}"` : html``}
		${opts.dir !== undefined ? html` data-dir="${opts.dir}"` : html``}
		${opts.repo !== undefined ? html` data-repo="${opts.repo}"` : html``}
		${opts.branchMode !== undefined ? html` data-branch-mode="${opts.branchMode}"` : html``}
		${opts.ref !== undefined ? html` data-ref="${opts.ref}"` : html``}
	>
		<ul class="picker" role="listbox" aria-label="References" data-ref-picker hidden></ul>
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
	const underWay = sortRows(rows.filter((row) => rowActive(row, opts.now)), opts.column, opts.ascending, opts.home);
	const inactive = sortRows(rows.filter((row) => !rowActive(row, opts.now)), opts.column, opts.ascending, opts.home);
	const folderOpen = opts.inactiveOpen ?? inactive.some((row) => row.id === opts.current);

	let stripe = 0;
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
			<p class="picker-count">${underWay.length} under way, ${inactive.length} inactive</p>
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

export function renderRepoPickerDialog(opts: {
	repos: readonly RepoSummary[];
	selectedRepo?: string;
	branches?: BranchList;
	error?: string;
}): Html {
	const selected = opts.selectedRepo ?? opts.repos[0]?.name ?? "";
	const defaultBranch = opts.branches?.defaultBranch ?? "";
	const continueBranch = opts.branches?.branches.find((name) => name !== defaultBranch) ?? defaultBranch;
	const ready = selected !== "" && opts.branches !== undefined && defaultBranch !== "";

	return html`<header class="topbar">
			<button type="button" class="icon-button back" aria-label="Back" data-dialog-close>${icon("back")}</button>
			<h1 class="title">Repository</h1>
		</header>
		<form class="repo-picker-form" action="/start" method="GET" data-repo-picker-form>
			<input type="hidden" name="place" value="repo" />
			<input type="hidden" name="mode" value="new" data-repo-mode-input />
			<div class="repo-picker-body">
				${opts.error !== undefined ? html`<p class="error-text">${opts.error}</p>` : html``}
				<label class="field">
					<span>Repository</span>
					<select name="repo" data-repo-select${opts.repos.length === 0 ? html` disabled` : html``}>
						${opts.repos.length === 0 ? html`<option value="">No repositories</option>` : html``}
						${opts.repos.map((item) => html`<option value="${item.name}"${item.name === selected ? html` selected` : html``}>${item.name}</option>`)}
					</select>
				</label>
				<div class="segmented" role="radiogroup" aria-label="Branch">
					<button type="button" role="radio" aria-checked="true" class="selected" data-repo-mode="new">New branch</button>
					<button type="button" role="radio" aria-checked="false" data-repo-mode="continue">Continue a branch</button>
				</div>
				<label class="field">
					<span data-branch-label>Start from</span>
					<select
						name="base"
						data-branch-select
						data-default-branch="${defaultBranch}"
						data-continue-branch="${continueBranch}"
						${opts.branches === undefined ? html` disabled` : html``}
					>
						${(opts.branches?.branches ?? []).map(
							(name) => html`<option value="${name}"${name === defaultBranch ? html` selected` : html``}>${name}${name === defaultBranch ? " (default)" : ""}</option>`,
						)}
					</select>
				</label>
			</div>
			<footer class="repo-picker-footer">
				<button type="submit" class="start-button" data-repo-submit${!ready ? html` disabled` : html``}>Start session</button>
			</footer>
		</form>`;
}
