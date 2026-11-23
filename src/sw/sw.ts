// The service worker: keeps the app shell so pigui opens offline, shows push notifications, and opens the right
// session when one is tapped. API calls are never cached: they are live state.
/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;
/** Replaced at build time, so each build gets its own cache. */
declare const BUILD_ID: string;
/** The font files app.css loads, replaced at build time from the list scripts/build.ts copies. */
declare const FONT_FILES: string[];

const CACHE = `pigui-shell-${BUILD_ID}`;
const SHELL = ["/", "/app.js", "/app.css", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png", ...FONT_FILES];

type PushPayload = { title: string; body: string; url: string; tag: string };

self.addEventListener("install", (event) => {
	event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", (event) => {
	const url = new URL(event.request.url);
	if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
	const key = event.request.mode === "navigate" ? "/" : url.pathname;
	// Network first, so an update shows at once; the cached shell when offline.
	event.respondWith(
		fetch(event.request)
			.then(async (response) => {
				if (response.ok && SHELL.includes(key)) await (await caches.open(CACHE)).put(key, response.clone());
				return response;
			})
			.catch(async () => (await caches.match(key)) ?? Response.error()),
	);
});

self.addEventListener("push", (event) => {
	const payload = (event.data?.json() ?? { title: "pigui", body: "", url: "/", tag: "pigui" }) as PushPayload;
	event.waitUntil(
		self.registration.showNotification(payload.title, {
			body: payload.body,
			tag: payload.tag,
			icon: "/icons/icon-192.png",
			badge: "/icons/icon-192.png",
			data: { url: payload.url },
		}),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const url = (event.notification.data as { url?: string } | undefined)?.url ?? "/";
	event.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
			const client = clients[0];
			if (client !== undefined) {
				client.postMessage({ type: "open", url });
				await client.focus();
				return;
			}
			await self.clients.openWindow(url);
		}),
	);
});
