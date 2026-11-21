import type { JSX } from "preact";
import { useEffect } from "preact/hooks";
import { api } from "./api.ts";
import { Drawer } from "./components/Drawer.tsx";
import { NewSession } from "./components/NewSession.tsx";
import { SessionView } from "./components/SessionView.tsx";
import { live } from "./live.ts";
import { refreshSubscription } from "./push.ts";
import { routeFromHash, store, useStore } from "./store.ts";

function Toast(): JSX.Element | null {
	const toast = useStore((state) => state.toast);
	if (toast === undefined) return null;
	return (
		<div class="toast" role="status" aria-live="polite">
			<span>{toast.message}</span>
			{toast.action === undefined ? null : (
				<button
					type="button"
					class="link"
					onClick={() => {
						toast.action?.run();
						store.set({ toast: undefined });
					}}
				>
					{toast.action.label}
				</button>
			)}
		</div>
	);
}

/** Open the drawer with a swipe from the left edge, and close it with a swipe back. */
function useEdgeSwipe(): void {
	useEffect(() => {
		let start: { x: number; y: number } | undefined;
		const onStart = (event: TouchEvent) => {
			const touch = event.touches[0];
			if (touch === undefined) return;
			const open = store.get().drawerOpen;
			start = open || touch.clientX < 24 ? { x: touch.clientX, y: touch.clientY } : undefined;
		};
		const onEnd = (event: TouchEvent) => {
			const touch = event.changedTouches[0];
			if (start === undefined || touch === undefined) return;
			const dx = touch.clientX - start.x;
			const dy = Math.abs(touch.clientY - start.y);
			if (dy < 60 && dx > 60) store.set({ drawerOpen: true });
			if (dy < 60 && dx < -60) store.set({ drawerOpen: false });
			start = undefined;
		};
		window.addEventListener("touchstart", onStart, { passive: true });
		window.addEventListener("touchend", onEnd, { passive: true });
		return () => {
			window.removeEventListener("touchstart", onStart);
			window.removeEventListener("touchend", onEnd);
		};
	}, []);
}

export function App(): JSX.Element {
	const route = useStore((state) => state.route);
	useEdgeSwipe();

	useEffect(() => {
		api.bootstrap().then(
			(bootstrap) => store.set({ bootstrap }),
			() => undefined,
		);
		void refreshSubscription().catch(() => undefined);
		const onHash = () => store.set({ route: routeFromHash(location.hash), drawerOpen: false });
		// A backgrounded app holds no stream; coming back catches up from where it was.
		const onVisibility = () => {
			if (document.visibilityState === "hidden") live.pause();
			else {
				const current = store.get().route;
				live.follow(current.kind === "session" ? current.id : undefined);
			}
		};
		window.addEventListener("hashchange", onHash);
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			window.removeEventListener("hashchange", onHash);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, []);

	useEffect(() => {
		live.follow(route.kind === "session" ? route.id : undefined);
	}, [route.kind === "session" ? route.id : -1]);

	return (
		<div class="app">
			<Drawer />
			<main class="main">{route.kind === "session" ? <SessionView key={route.id} id={route.id} /> : <NewSession />}</main>
			<Toast />
		</div>
	);
}
