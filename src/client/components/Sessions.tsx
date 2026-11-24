// The session picker: every session listed in columns, as a file browser lists a folder, in a panel over a dimmed and
// blurred page. Switching sessions is deliberate, so the list is not on screen the rest of the time: the ☰ button opens
// it, and choosing a session, Escape, or a tap outside closes it. Sessions under way are listed at the top; those done,
// archived or quiet for half a day sit in a folder under them. The open session is the selection, and the arrow keys
// move through the list as they do in a file browser.
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { needsAttention, type SessionRow } from "../../shared/session.ts";
import { api, describeFailure } from "../api.ts";
import { listingDate, shortDir, timeAgo } from "../format.ts";
import { enableNotifications, pushSupported } from "../push.ts";
import { navigate, showToast, store, useStore } from "../store.ts";
import { Icon } from "./Icons.tsx";

/** A session untouched this long has gone quiet: most are never returned to. */
const STALE_MS = 12 * 60 * 60 * 1000;

/** Under way: not archived, not done, and changed within the last half day. */
function active(row: SessionRow, now: number): boolean {
	return !row.archived && row.tone !== "done" && now - row.updatedAt < STALE_MS;
}

type Column = "name" | "where" | "modified" | "status";
type Sort = { column: Column; ascending: boolean };

const COLUMNS: ReadonlyArray<{ column: Column; label: string }> = [
	{ column: "name", label: "Name" },
	{ column: "where", label: "Where" },
	{ column: "modified", label: "Modified" },
	{ column: "status", label: "Status" },
];

function whereOf(row: SessionRow, home: string | undefined): string {
	return row.place === "local" ? shortDir(row.dir, home) : row.repo;
}

function sorted(rows: readonly SessionRow[], sort: Sort, home: string | undefined): SessionRow[] {
	const text = (row: SessionRow) => (sort.column === "name" ? row.title : sort.column === "where" ? whereOf(row, home) : row.label);
	const order = (a: SessionRow, b: SessionRow) => (sort.column === "modified" ? a.updatedAt - b.updatedAt : text(a).localeCompare(text(b)));
	return [...rows].sort((a, b) => (sort.ascending ? order(a, b) : order(b, a)));
}

/**
 * Archive a session, or put an archived one back, with Undo in the toast rather than a confirmation. Archiving the open
 * session leaves it for New session, as it can no longer be worked in; Undo comes back to it.
 */
async function setArchived(row: SessionRow, archived: boolean, open: boolean): Promise<void> {
	try {
		await api.archive(row.id, archived);
	} catch (error) {
		showToast({ message: describeFailure(error).message });
		return;
	}
	if (archived && open) navigate({ kind: "new" });
	showToast({
		message: archived ? "Session archived." : "Session restored.",
		action: {
			label: "Undo",
			run: () => {
				void api.archive(row.id, !archived).then(() => {
					if (archived && open) navigate({ kind: "session", id: row.id });
				});
			},
		},
	});
}

function Entry(props: { row: SessionRow; current: boolean; striped: boolean; nested: boolean; home: string | undefined }): JSX.Element {
	const { row } = props;
	const classes = ["row", props.current ? "current" : "", props.striped ? "striped" : "", props.nested ? "nested" : "", needsAttention(row) ? "unseen" : ""];
	// Beside the line rather than in it, since a button cannot sit inside a link; it is drawn on the line's right edge.
	const action = row.archived ? "Restore" : "Archive";
	return (
		<li class="entry">
			<a href={`#/s/${row.id}`} class={classes.join(" ")} aria-current={props.current ? "page" : undefined} onClick={() => store.set({ pickerOpen: false })}>
				<span class="row-name">
					<span class={`indicator ${row.tone}`} aria-hidden="true" />
					<span class="row-title">{row.title}</span>
				</span>
				<span class="row-where">{whereOf(row, props.home)}</span>
				<time class="row-modified" dateTime={new Date(row.updatedAt).toISOString()}>
					<span class="when-wide">{listingDate(row.updatedAt)}</span>
					<span class="when-narrow">{timeAgo(row.updatedAt)}</span>
				</time>
				<span class="row-status">{row.label}</span>
			</a>
			<button type="button" class="icon-button row-action" aria-label={`${action} ${row.title}`} title={action} onClick={() => void setArchived(row, !row.archived, props.current)}>
				<Icon name={row.archived ? "restore" : "archive"} size={18} />
			</button>
		</li>
	);
}

/** Up and down move through the list's entries, the folder among them, as in a file browser. */
function moveFocus(list: HTMLElement, event: KeyboardEvent): void {
	if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
	const entries = [...list.querySelectorAll<HTMLElement>(".row")];
	if (entries.length === 0) return;
	event.preventDefault();
	const at = entries.indexOf(document.activeElement as HTMLElement);
	const next = at === -1 ? 0 : Math.min(entries.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)));
	entries[next]?.focus();
	entries[next]?.scrollIntoView({ block: "nearest" });
}

export function SessionPicker(): JSX.Element | null {
	const open = useStore((state) => state.pickerOpen);
	return open ? <Picker /> : null;
}

function Picker(): JSX.Element {
	const index = useStore((state) => state.index);
	const route = useStore((state) => state.route);
	const bootstrap = useStore((state) => state.bootstrap);
	const home = bootstrap?.onPrem?.home;
	const [sort, setSort] = useState<Sort>({ column: "modified", ascending: false });
	const [notifications, setNotifications] = useState(() => (pushSupported() ? Notification.permission : "unsupported"));
	const list = useRef<HTMLDivElement>(null);
	const current = route.kind === "session" ? route.id : undefined;
	const now = Date.now();
	const rows = Object.values(index?.rows ?? {});
	const underWay = sorted(
		rows.filter((row) => active(row, now)),
		sort,
		home,
	);
	const inactive = sorted(
		rows.filter((row) => !active(row, now)),
		sort,
		home,
	);
	// The folder starts open when the open session is in it, so the selection is in view.
	const [folderOpen, setFolderOpen] = useState(() => inactive.some((row) => row.id === current));
	const close = () => store.set({ pickerOpen: false });

	useEffect(() => {
		// The selection takes focus, so the arrow keys start from it; the button that opened the picker gets it back.
		const opener = document.activeElement as HTMLElement | null;
		const selected = list.current?.querySelector<HTMLElement>(".row.current") ?? list.current?.querySelector<HTMLElement>(".row");
		selected?.focus({ preventScroll: true });
		selected?.scrollIntoView({ block: "nearest" });
		const onKey = (event: KeyboardEvent) => event.key === "Escape" && close();
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("keydown", onKey);
			opener?.focus({ preventScroll: true });
		};
		// The picker opens once and closes; there is nothing to re-run this for.
	}, []);

	const turnOn = async () => {
		if (bootstrap === undefined) return;
		try {
			await enableNotifications(bootstrap.vapidPublicKey);
			setNotifications("granted");
			showToast({ message: "Notifications are on." });
		} catch (error) {
			showToast({ message: describeFailure(error).message });
		}
	};

	let stripe = 0;
	const entry = (row: SessionRow, nested: boolean) => <Entry key={row.id} row={row} current={row.id === current} striped={stripe++ % 2 === 1} nested={nested} home={home} />;

	return (
		<>
			<div class="picker-veil" onClick={close} aria-hidden="true" />
			<section class="session-picker" role="dialog" aria-modal="true" aria-label="Sessions" id="session-picker">
				<header class="picker-bar">
					<h2>Sessions</h2>
					<button
						type="button"
						class="link"
						onClick={() => {
							close();
							navigate({ kind: "new" });
						}}
					>
						<Icon name="plus" size={20} /> New
					</button>
					<button type="button" class="icon-button" aria-label="Close" onClick={close}>
						<Icon name="close" size={20} />
					</button>
				</header>
				<div class="picker-columns" role="group" aria-label="Sort by">
					{COLUMNS.map(({ column, label }) => (
						<button
							key={column}
							type="button"
							class={`heading heading-${column} ${sort.column === column ? "sorted" : ""}`}
							aria-pressed={sort.column === column}
							onClick={() => setSort((was) => (was.column === column ? { column, ascending: !was.ascending } : { column, ascending: column !== "modified" }))}
						>
							{label}
							{sort.column === column ? (
								<span class={`sort-mark ${sort.ascending ? "up" : "down"}`}>
									<Icon name="chevron" size={12} />
								</span>
							) : null}
						</button>
					))}
				</div>
				<div class="picker-list" ref={list} onKeyDown={(event) => list.current !== null && moveFocus(list.current, event)}>
					{rows.length === 0 ? <p class="empty">No sessions yet. Start one with New.</p> : null}
					<ul class="listing" aria-label="Under way">
						{underWay.map((row) => entry(row, false))}
						{inactive.length === 0 ? null : (
							<li>
								<button type="button" class={`row folder ${stripe++ % 2 === 1 ? "striped" : ""}`} aria-expanded={folderOpen} onClick={() => setFolderOpen((was) => !was)}>
									<span class="row-name">
										<span class="disclosure">
											<Icon name="chevron" size={12} />
										</span>
										<span class="folder-mark">
											<Icon name="folder" size={16} />
										</span>
										<span class="row-title">Inactive</span>
									</span>
									<span class="row-where" />
									<span class="row-modified">
										{inactive.length} {inactive.length === 1 ? "session" : "sessions"}
									</span>
									<span class="row-status">Folder</span>
								</button>
								{folderOpen ? (
									<ul class="listing" aria-label="Inactive">
										{inactive.map((row) => entry(row, true))}
									</ul>
								) : null}
							</li>
						)}
					</ul>
				</div>
				<footer class="picker-status">
					<p class="picker-count">
						{underWay.length} under way, {inactive.length} inactive
					</p>
					{bootstrap?.memory.on === false ? (
						<div class="banner warn picker-notice" role="status">
							<p>
								<strong>Memory is off</strong>
								{bootstrap.memory.reason}
							</p>
						</div>
					) : null}
					{notifications === "default" || notifications === "denied" ? (
						<button type="button" class="link" onClick={() => void turnOn()}>
							<Icon name="bell" size={18} /> Turn on notifications
						</button>
					) : null}
				</footer>
			</section>
		</>
	);
}

/** The ☰ button that opens the picker, with a dot when a session other than the open one needs the person. */
export function SessionsButton(): JSX.Element {
	const index = useStore((state) => state.index);
	const route = useStore((state) => state.route);
	const open = useStore((state) => state.pickerOpen);
	const current = route.kind === "session" ? route.id : undefined;
	const others = Object.values(index?.rows ?? {}).filter((row) => row.id !== current && needsAttention(row)).length;
	return (
		<button
			type="button"
			class="icon-button menu"
			aria-label={others > 0 ? `Sessions, ${others} need${others === 1 ? "s" : ""} you` : "Sessions"}
			aria-haspopup="dialog"
			aria-expanded={open}
			aria-controls="session-picker"
			onClick={() => store.set({ pickerOpen: !open })}
		>
			<Icon name="menu" />
			{others > 0 ? <span class="dot badge-dot" data-testid="attention-dot" /> : null}
		</button>
	);
}
