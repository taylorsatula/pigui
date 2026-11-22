import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.ts";
import { Drawer } from "./components/Drawer.tsx";
import { NewSession } from "./components/NewSession.tsx";
import { SessionView } from "./components/SessionView.tsx";
import { live } from "./live.ts";
import { exitMs, useSwipeDown } from "./motion.ts";
import { refreshSubscription } from "./push.ts";
import { dismissToast, holdToast, routeFromHash, store, type Toast, useStore } from "./store.ts";
import { watchViewport } from "./viewport.ts";

function ToastCard(props: { toast: Toast; leaving: boolean }): JSX.Element {
	const { toast } = props;
	const element = useRef<HTMLDivElement>(null);
	useSwipeDown({ element, canStart: () => true, distance: () => 45, onDismiss: dismissToast, onHold: holdToast });
	return (
		<div ref={element} class={`toast ${props.leaving ? "leaving" : ""}`} role="status" aria-live="polite">
			<span>{toast.message}</span>
			{toast.action === undefined ? null : (
				<button
					type="button"
					class="link"
					onClick={() => {
						toast.action?.run();
						dismissToast();
					}}
				>
					{toast.action.label}
				</button>
			)}
		</div>
	);
}

/** The current toast, kept on screen while it leaves. A new message is a new toast, so it rises again. */
function Toasts(): JSX.Element | null {
	const current = useStore((state) => state.toast);
	const [shown, setShown] = useState(current);
	useEffect(() => {
		if (current !== undefined) {
			setShown(current);
			return;
		}
		const timer = setTimeout(() => setShown(undefined), exitMs());
		return () => clearTimeout(timer);
	}, [current]);
	const toast = current ?? shown;
	return toast === undefined ? null : <ToastCard key={toast.message} toast={toast} leaving={current === undefined} />;
}

export function App(): JSX.Element {
	const route = useStore((state) => state.route);
	const sidebarHidden = useStore((state) => state.sidebarHidden);

	useEffect(() => {
		api.bootstrap().then(
			(bootstrap) => store.set({ bootstrap }),
			() => undefined,
		);
		void refreshSubscription().catch(() => undefined);
		const onHash = () => store.set({ route: routeFromHash(location.hash), drawerOpen: false });
		// A backgrounded app holds no stream; coming back catches up from where it was.
		const onVisibility = () => {
			// A toast waits for the person to come back rather than timing out unseen.
			holdToast(document.visibilityState === "hidden");
			if (document.visibilityState === "hidden") live.pause();
			else {
				const current = store.get().route;
				live.follow(current.kind === "session" ? current.id : undefined);
			}
		};
		window.addEventListener("hashchange", onHash);
		document.addEventListener("visibilitychange", onVisibility);
		const unwatch = watchViewport();
		return () => {
			window.removeEventListener("hashchange", onHash);
			document.removeEventListener("visibilitychange", onVisibility);
			unwatch();
		};
	}, []);

	useEffect(() => {
		live.follow(route.kind === "session" ? route.id : undefined);
	}, [route.kind === "session" ? route.id : -1]);

	return (
		<div class={`app ${sidebarHidden ? "sidebar-hidden" : ""}`}>
			<Drawer />
			<main class="main">{route.kind === "session" ? <SessionView key={route.id} id={route.id} /> : <NewSession />}</main>
			<Toasts />
		</div>
	);
}
