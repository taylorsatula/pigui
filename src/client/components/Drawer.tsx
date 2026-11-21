// The navigation drawer: every session, grouped by whether it needs the person, is working, or is done, each row with
// enough status to decide where to look. On a phone it slides over the session; on a wide screen it stays.
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { needsAttention, type SessionGroup, type SessionRow } from "../../shared/session.ts";
import { describeFailure } from "../api.ts";
import { timeAgo } from "../format.ts";
import { enableNotifications, pushSupported } from "../push.ts";
import { navigate, showToast, store, useStore } from "../store.ts";
import { Icon } from "./Icons.tsx";

const GROUPS: { group: SessionGroup; title: string }[] = [
	{ group: "attention", title: "Needs you" },
	{ group: "working", title: "Working" },
	{ group: "done", title: "Done" },
];

function Row(props: { row: SessionRow; current: boolean }): JSX.Element {
	const { row } = props;
	const attention = needsAttention(row);
	return (
		<li>
			<a
				href={`#/s/${row.id}`}
				class={`row ${props.current ? "current" : ""}`}
				aria-current={props.current ? "page" : undefined}
				onClick={() => store.set({ drawerOpen: false })}
			>
				<span class="row-main">
					<span class="row-title">{row.title}</span>
					<span class="row-meta">
						<span class={`row-label ${row.group}`}>{row.label}</span>
						<span class="row-repo">{row.repo}</span>
					</span>
				</span>
				<span class="row-side">
					<time dateTime={new Date(row.updatedAt).toISOString()}>{timeAgo(row.updatedAt)}</time>
					{attention ? <span class="dot" role="img" aria-label="Needs your attention" /> : null}
				</span>
			</a>
		</li>
	);
}

export function Drawer(): JSX.Element {
	const index = useStore((state) => state.index);
	const route = useStore((state) => state.route);
	const open = useStore((state) => state.drawerOpen);
	const bootstrap = useStore((state) => state.bootstrap);
	const connected = useStore((state) => state.connected);
	const [notifications, setNotifications] = useState(() => (pushSupported() ? Notification.permission : "unsupported"));
	const rows = Object.values(index?.rows ?? {}).sort((a, b) => b.updatedAt - a.updatedAt);
	const current = route.kind === "session" ? route.id : undefined;
	const archived = rows.filter((row) => row.archived);

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

	return (
		<>
			<div class={`backdrop ${open ? "open" : ""}`} onClick={() => store.set({ drawerOpen: false })} aria-hidden="true" />
			<nav class={`drawer ${open ? "open" : ""}`} aria-label="Sessions" id="drawer">
				<header class="drawer-header">
					<h2>Sessions</h2>
					<button
						type="button"
						class="primary small"
						onClick={() => {
							store.set({ drawerOpen: false });
							navigate({ kind: "new" });
						}}
					>
						<Icon name="plus" size={18} /> New
					</button>
				</header>
				<div class="drawer-body">
					{rows.length === 0 ? <p class="empty">No sessions yet. Start one with New.</p> : null}
					{GROUPS.map(({ group, title }) => {
						const members = rows.filter((row) => !row.archived && row.group === group);
						if (members.length === 0) return null;
						return (
							<section key={group} class="group" aria-label={title}>
								<h3>{title}</h3>
								<ul>
									{members.map((row) => (
										<Row key={row.id} row={row} current={row.id === current} />
									))}
								</ul>
							</section>
						);
					})}
					{archived.length > 0 ? (
						<details class="group archived">
							<summary>Archived ({archived.length})</summary>
							<ul>
								{archived.map((row) => (
									<Row key={row.id} row={row} current={row.id === current} />
								))}
							</ul>
						</details>
					) : null}
				</div>
				<footer class="drawer-footer">
					{notifications === "default" || notifications === "denied" ? (
						<button type="button" class="secondary small" onClick={() => void turnOn()}>
							<Icon name="bell" size={18} /> Turn on notifications
						</button>
					) : null}
					<span class={`connection ${connected ? "on" : "off"}`} role="status">
						{connected ? (bootstrap?.fake === true ? "Connected · fake mode" : "Connected") : "Reconnecting…"}
					</span>
				</footer>
			</nav>
		</>
	);
}

/** The ☰ button, with a dot when a session other than the open one needs the person. */
export function DrawerButton(): JSX.Element {
	const index = useStore((state) => state.index);
	const route = useStore((state) => state.route);
	const open = useStore((state) => state.drawerOpen);
	const current = route.kind === "session" ? route.id : undefined;
	const others = Object.values(index?.rows ?? {}).filter((row) => row.id !== current && needsAttention(row)).length;
	return (
		<button
			type="button"
			class="icon-button menu"
			aria-label={others > 0 ? `Sessions, ${others} need${others === 1 ? "s" : ""} you` : "Sessions"}
			aria-expanded={open}
			aria-controls="drawer"
			onClick={() => store.set({ drawerOpen: !open })}
		>
			<Icon name="menu" />
			{others > 0 ? <span class="dot badge-dot" data-testid="attention-dot" /> : null}
		</button>
	);
}
