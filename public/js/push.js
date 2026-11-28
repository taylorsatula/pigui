// Web Push permission request, VAPID key conversion, subscription POST, and silent startup refresh.
import { postJson } from "./api.js";

export function pushSupported() {
	return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function keyBytes(base64url) {
	const padded = base64url + "=".repeat((4 - (base64url.length % 4)) % 4);
	const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
	const out = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
	return out;
}

async function sendSubscription(subscription) {
	const json = subscription.toJSON();
	if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) throw new Error("Browser returned an incomplete push subscription.");
	await postJson("/api/push/subscribe", {
		endpoint: json.endpoint,
		keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
	});
}

export async function enableNotifications(vapidPublicKey) {
	if (!pushSupported()) throw new Error("Notifications are not supported in this browser.");
	const permission = await Notification.requestPermission();
	if (permission !== "granted") throw new Error("Notifications were blocked by the browser.");
	const registration = await navigator.serviceWorker.ready;
	const existing = await registration.pushManager.getSubscription();
	const subscription = existing ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapidPublicKey) }));
	await sendSubscription(subscription);
}

export async function refreshSubscription() {
	if (!pushSupported() || Notification.permission !== "granted") return;
	const registration = await navigator.serviceWorker.getRegistration();
	const subscription = await registration?.pushManager.getSubscription();
	if (subscription) await sendSubscription(subscription);
}
