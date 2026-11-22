// The sidebar: a listing of the sessions under way, each one line with a coloured mark for its status, newest first,
// so a glance says what the other sessions are doing. Sessions that are done, archived or untouched for half a day sit
// folded under it. On a phone it slides over the session; on a wide screen it stays, unless put away.
import type { JSX } from "preact";
import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { needsAttention, type SessionRow } from "../../shared/session.ts";
import { describeFailure } from "../api.ts";
import { FingerSpeed, projected } from "../motion.ts";
import { timeAgo } from "../format.ts";
import { enableNotifications, pushSupported } from "../push.ts";
import { navigate, setSidebarHidden, showToast, store, useStore } from "../store.ts";
import { Icon } from "./Icons.tsx";

/** A session untouched this long has gone quiet: most are never returned to. */
const STALE_MS = 12 * 60 * 60 * 1000;

/** Under way: not archived, not done, and changed within the last half day. */
function active(row: SessionRow, now: number): boolean {
	return !row.archived && row.tone !== "done" && now - row.updatedAt < STALE_MS;
}

function Row(props: { row: SessionRow; current: boolean }): JSX.Element {
	const { row } = props;
	return (
		<li>
			<a
				href={`#/s/${row.id}`}
				class={`row ${props.current ? "current" : ""} ${needsAttention(row) ? "unseen" : ""}`}
				aria-current={props.current ? "page" : undefined}
				title={`${row.label} · ${row.repo}`}
				onClick={() => store.set({ drawerOpen: false })}
			>
				<span class={`indicator ${row.tone}`} aria-hidden="true" />
				<span class="row-title">{row.title}</span>
				<span class="visually-hidden">{row.label}</span>
				<time dateTime={new Date(row.updatedAt).toISOString()}>{timeAgo(row.updatedAt)}</time>
			</a>
		</li>
	);
}

/** Where the drawer becomes a sidebar; app.css draws the same line. */
const WIDE = "(min-width: 900px)";

/** How near the left edge a touch must start to open the drawer. */
const EDGE = 24;

/**
 * Drag the drawer open from the left edge and drag it shut from anywhere while it is open. It tracks the finger and,
 * on release, settles on whichever side the drag's momentum would carry it to. Vertical drags stay scrolls.
 */
function useDrawerDrag(drawer: RefObject<HTMLElement>, backdrop: RefObject<HTMLElement>): void {
	useEffect(() => {
		const wide = window.matchMedia(WIDE);
		let drag: { x: number; y: number; open: boolean; width: number; moving: boolean; offset: number; speed: FingerSpeed } | undefined;

		const onMove = (event: TouchEvent) => {
			const touch = event.touches[0];
			const panel = drawer.current;
			const scrim = backdrop.current;
			if (drag === undefined || touch === undefined || panel === null || scrim === null) return;
			const dx = touch.clientX - drag.x;
			drag.speed.add(touch.clientX, event.timeStamp);
			if (!drag.moving) {
				const dy = touch.clientY - drag.y;
				if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
				if (Math.abs(dy) > Math.abs(dx)) {
					document.removeEventListener("touchmove", onMove);
					drag = undefined;
					return;
				}
				drag.moving = true;
				panel.classList.add("dragging");
				scrim.classList.add("dragging");
			}
			event.preventDefault();
			drag.offset = Math.min(drag.width, Math.max(0, (drag.open ? drag.width : 0) + dx));
			panel.style.transform = `translateX(${drag.offset - drag.width}px)`;
			scrim.style.opacity = String(drag.offset / drag.width);
		};

		const finish = (event: TouchEvent) => {
			document.removeEventListener("touchmove", onMove);
			if (drag?.moving) {
				const open = projected(drag.offset, drag.speed.at(event.timeStamp)) > drag.width / 2;
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
			drag = { x: touch.clientX, y: touch.clientY, open, width: panel.offsetWidth, moving: false, offset: open ? panel.offsetWidth : 0, speed: new FingerSpeed() };
			drag.speed.add(touch.clientX, event.timeStamp);
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
	const now = Date.now();
	const underWay = rows.filter((row) => active(row, now));
	const inactive = rows.filter((row) => !active(row, now));

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
					<button type="button" class="icon-button hide-sidebar" aria-label="Hide the sidebar" onClick={() => setSidebarHidden(true)}>
						<Icon name="sidebar" size={20} />
					</button>
				</header>
				<div class="drawer-body">
					{rows.length === 0 ? <p class="empty">No sessions yet. Start one with New.</p> : null}
					{rows.length > 0 && underWay.length === 0 ? <p class="empty">Nothing under way.</p> : null}
					{underWay.length === 0 ? null : (
						<ul class="listing" aria-label="Under way">
							{underWay.map((row) => (
								<Row key={row.id} row={row} current={row.id === current} />
							))}
						</ul>
					)}
					{inactive.length === 0 ? null : (
						<details class="inactive">
							<summary>
								<Icon name="chevron" size={14} />
								Inactive ({inactive.length})
							</summary>
							<ul class="listing" aria-label="Inactive">
								{inactive.map((row) => (
									<Row key={row.id} row={row} current={row.id === current} />
								))}
							</ul>
						</details>
					)}
				</div>
				{/* Outside the scrolling listing, so it stays in view while memory is off: sessions still run, without it. */}
				{bootstrap?.memory.on === false ? (
					<div class="banner warn drawer-notice" role="status">
						<p>
							<strong>Memory is off</strong>
							{bootstrap.memory.reason}
						</p>
					</div>
				) : null}
				{notifications === "default" || notifications === "denied" ? (
					<footer class="drawer-footer">
						<button type="button" class="link" onClick={() => void turnOn()}>
							<Icon name="bell" size={18} /> Turn on notifications
						</button>
					</footer>
				) : null}
			</nav>
		</>
	);
}

/**
 * The ☰ button, with a dot when a session other than the open one needs the person. On a phone it slides the drawer
 * over the session; on a wide screen it shows only while the sidebar is put away, and brings it back.
 */
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
			onClick={() => (matchMedia(WIDE).matches ? setSidebarHidden(false) : store.set({ drawerOpen: !open }))}
		>
			<Icon name="menu" />
			{others > 0 ? <span class="dot badge-dot" data-testid="attention-dot" /> : null}
		</button>
	);
}
