import { mount } from "svelte";
import "./app.css";
import App from "./app.svelte";
import { navigate, routeFromHash } from "./store.svelte.ts";

// iOS applies :active, the app's press feedback, only where a touch listener is present.
document.addEventListener("touchstart", () => undefined, { passive: true });

// The system switching between light and dark recolours everything in one frame: for that frame nothing transitions,
// or elements with a colour transition would fade a beat behind the rest (see .theme-changing in base.css).
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
	const root = document.documentElement;
	root.classList.add("theme-changing");
	requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-changing")));
});

const target = document.getElementById("app");
if (target !== null) mount(App, { target });

if ("serviceWorker" in navigator) {
	void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
	// A tapped notification asks an open app to show its session.
	navigator.serviceWorker.addEventListener("message", (event: MessageEvent<{ type?: string; url?: string }>) => {
		if (event.data.type === "open" && typeof event.data.url === "string") navigate(routeFromHash(new URL(event.data.url, location.origin).hash));
	});
}
