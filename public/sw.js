// Plain JS service worker; BUILD_ID and SHELL are prepended dynamically by the server when serving /sw.js.
// Network-first with offline cache fallback for static assets and navigations, plus Web Push notifications.
const CACHE = `pigui-shell-${BUILD_ID}`;

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(SHELL))
			.then(() => self.skipWaiting()),
	);
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
	if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/ui/")) {
		return;
	}
	const key = event.request.mode === "navigate" ? "/" : url.pathname;
	event.respondWith(
		fetch(event.request)
			.then((response) => {
				if (response.ok) {
					const copy = response.clone();
					void caches.open(CACHE).then((cache) => cache.put(key, copy));
				}
				return response;
			})
			.catch(async () => (await caches.match(key)) ?? Response.error()),
	);
});

self.addEventListener("push", (event) => {
	let data = {};
	try {
		data = event.data ? event.data.json() : {};
	} catch {
		data = { title: "pigui", body: event.data ? event.data.text() : "" };
	}
	event.waitUntil(
		self.registration.showNotification(data.title || "pigui", {
			body: data.body || "",
			tag: data.tag,
			icon: "/icons/icon-192.png",
			badge: "/icons/icon-192.png",
			data: { url: data.url || "/" },
		}),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const targetUrl = (event.notification.data && event.notification.data.url) || "/";
	event.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
			for (const client of clients) {
				if ("focus" in client) {
					client.postMessage({ type: "open", url: targetUrl });
					return client.focus();
				}
			}
			return self.clients.openWindow(targetUrl);
		}),
	);
});
