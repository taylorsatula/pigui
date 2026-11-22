// The navigation drawer: every session, grouped by whether it needs the person, is working, or is done, each row with
// enough status to decide where to look. On a phone it slides over the session; on a wide screen it stays.
import type { JSX } from "preact";
import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
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

/** How near the left edge a touch must start to open the drawer. */
const EDGE = 24;
/** A flick faster than this, in px/ms, settles the drawer the way it was going. */
const FLICK = 0.4;

/**
 * Drag the drawer open from the left edge and drag it shut from anywhere while it is open. It tracks the finger,
 * a flick finishes the move, and otherwise it settles on whichever side it is nearer. Vertical drags stay scrolls.
 */
function useDrawerDrag(drawer: RefObject<HTMLElement>, backdrop: RefObject<HTMLElement>): void {
	useEffect(() => {
		const wide = window.matchMedia("(min-width: 900px)");
		let drag: { x: number; y: number; open: boolean; width: number; moving: boolean; offset: number; lastX: number; lastT: number; speed: number } | undefined;

		const onMove = (event: TouchEvent) => {
			const touch = event.touches[0];
			const panel = drawer.current;
			const scrim = backdrop.current;
			if (drag === undefined || touch === undefined || panel === null || scrim === null) return;
			const dx = touch.clientX - drag.x;
			if (!drag.moving) {
				const dy = touch.clientY - drag.y;
				if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
				if (Math.abs(dy) > Math.abs(dx)) {
					finish();
					return;
				}
				drag.moving = true;
				panel.classList.add("dragging");
				scrim.classList.add("dragging");
			}
			event.preventDefault();
			drag.offset = Math.min(drag.width, Math.max(0, (drag.open ? drag.width : 0) + dx));
			drag.speed = (touch.clientX - drag.lastX) / Math.max(1, event.timeStamp - drag.lastT);
			drag.lastX = touch.clientX;
			drag.lastT = event.timeStamp;
			panel.style.transform = `translateX(${drag.offset - drag.width}px)`;
			scrim.style.opacity = String(drag.offset / drag.width);
		};

		const finish = () => {
			document.removeEventListener("touchmove", onMove);
			if (drag?.moving) {
				const open = Math.abs(drag.speed) > FLICK ? drag.speed > 0 : drag.offset > drag.width / 2;
				for (const element of [drawer.current, backdrop.current]) {
					element?.classList.remove("dragging");
					element?.style.removeProperty("transform");
					element?.style.removeProperty("opacity");
				}
				store.set({ drawerOpen: open });
			}
			drag = undefined;
		};

		const onStart = (event: TouchEvent) => {
			const touch = event.touches[0];
			const panel = drawer.current;
			const open = store.get().drawerOpen;
			if (wide.matches || event.touches.length !== 1 || touch === undefined || panel === null) return;
			if (!open && touch.clientX > EDGE) return;
			drag = { x: touch.clientX, y: touch.clientY, open, width: panel.offsetWidth, moving: false, offset: open ? panel.offsetWidth : 0, lastX: touch.clientX, lastT: event.timeStamp, speed: 0 };
			// Only while a drag may be starting, so ordinary scrolling never waits on this listener.
			document.addEventListener("touchmove", onMove, { passive: false });
		};

		document.addEventListener("touchstart", onStart, { passive: true });
		document.addEventListener("touchend", finish);
		document.addEventListener("touchcancel", finish);
		return () => {
			document.removeEventListener("touchstart", onStart);
			document.removeEventListener("touchmove", onMove);
			document.removeEventListener("touchend", finish);
			document.removeEventListener("touchcancel", finish);
		};
	}, [drawer, backdrop]);
}

export function Drawer(): JSX.Element {
	const index = useStore((state) => state.index);
	const route = useStore((state) => state.route);
	const open = useStore((state) => state.drawerOpen);
	const bootstrap = useStore((state) => state.bootstrap);
	const connected = useStore((state) => state.connected);
	const [notifications, setNotifications] = useState(() => (pushSupported() ? Notification.permission : "unsupported"));
	const panel = useRef<HTMLElement>(null);
	const backdrop = useRef<HTMLDivElement>(null);
	useDrawerDrag(panel, backdrop);
	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent) => event.key === "Escape" && store.set({ drawerOpen: false });
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open]);
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
			<div ref={backdrop} class={`backdrop ${open ? "open" : ""}`} onClick={() => store.set({ drawerOpen: false })} aria-hidden="true" />
			<nav ref={panel} class={`drawer ${open ? "open" : ""}`} aria-label="Sessions" id="drawer">
				<header class="drawer-header">
					<h2>Sessions</h2>
					<button
						type="button"
						class="link"
						onClick={() => {
							store.set({ drawerOpen: false });
							navigate({ kind: "new" });
						}}
					>
						<Icon name="plus" size={20} /> New
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
							<summary>
								<Icon name="chevron" size={16} />
								Archived ({archived.length})
							</summary>
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
						<button type="button" class="link" onClick={() => void turnOn()}>
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
