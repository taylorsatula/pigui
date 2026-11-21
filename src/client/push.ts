import { api } from "./api.ts";

export function pushSupported(): boolean {
	return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
	const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
	const raw = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
	return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

/** Ask for permission (it must follow a tap) and register this device with the server. */
export async function enableNotifications(vapidPublicKey: string): Promise<void> {
	const permission = await Notification.requestPermission();
	if (permission !== "granted") throw new Error("Notifications are turned off for picloud in the system settings.");
	const registration = await navigator.serviceWorker.ready;
	const existing = await registration.pushManager.getSubscription();
	const subscription =
		existing ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapidPublicKey) }));
	await api.subscribe(subscription.toJSON());
}

/** Re-register an existing subscription on start, so a server that lost it gets it back. */
export async function refreshSubscription(): Promise<boolean> {
	if (!pushSupported() || Notification.permission !== "granted") return false;
	const registration = await navigator.serviceWorker.ready;
	const subscription = await registration.pushManager.getSubscription();
	if (subscription === null) return false;
	await api.subscribe(subscription.toJSON());
	return true;
}
