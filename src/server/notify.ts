// Notifications: enqueued in the commit that creates the need (a card, a report, a run's end), delivered by a Durable
// task. Enqueueing is keyed, so a wait notifies once however often the code around it reruns; the task survives a
// restart between the commit and the send.
import type { Context } from "@earendil-works/chord/context";
import type { Draft } from "@earendil-works/chord/delta";
import { type ConversationId, defineTask, type Harness, type Tx } from "@earendil-works/pi-durable";
import type { SessionDoc } from "../shared/session.ts";
import { type NotificationNotice, type Notifications as NotificationsPort } from "./agent/services.ts";
import { PushSubscriptionsToken } from "./documents.ts";
import { errorKind, type Logger } from "./log.ts";
import type { Presence } from "./presence.ts";
import type { PushSender } from "./webpush.ts";

export type Notice = {
	session: number;
	/** Identifies the wait or event; the same key never notifies twice. */
	key: string;
	title: string;
	body: string;
};

/** What the service worker receives. */
export type PushPayload = {
	title: string;
	body: string;
	/** Opened when the notification is tapped. */
	url: string;
	/** One notification per session on the lock screen: a newer one replaces an older one. */
	tag: string;
};

const NOTIFIED_MEMORY = 200;

export type NotificationsDeps = {
	sender: PushSender;
	presence: Presence;
	log: Logger;
	harness: () => Harness;
};

export class Notifications implements NotificationsPort {
	readonly #deps: NotificationsDeps;
	readonly task;

	constructor(deps: NotificationsDeps) {
		this.#deps = deps;
		this.task = defineTask<Notice, { phase: "send" }, null, object>({
			name: "pigui.notify",
			version: 1,
			initial: () => ({ phase: "send" }),
			phases: {
				// A crash between the send and this commit sends again; the shared tag keeps the phone showing one.
				send: async (task, runtime, context) => {
					await this.#deliver(task.input, context);
					await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
				},
			},
			abort: async (_task, runtime, context) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
			},
		});
	}

	/** Enqueue `notice` in this commit unless its key was enqueued before. Call after the commit's submissions. */
	async enqueue(tx: Tx, doc: Draft<SessionDoc>, notice: NotificationNotice): Promise<void> {
		if (doc.notified.includes(notice.key)) return;
		doc.notified.push(notice.key);
		if (doc.notified.length > NOTIFIED_MEMORY) doc.notified.splice(0, doc.notified.length - NOTIFIED_MEMORY);
		const full: Notice = { ...notice, session: doc.id, title: `${doc.title} — ${notice.title}` };
		await tx.createTask(this.task, full, {
			ownership: { kind: "conversation" },
			conversationId: doc.id as ConversationId,
			background: true,
		});
	}

	async #deliver(notice: Notice, context: Context): Promise<void> {
		const { presence, sender, log, harness } = this.#deps;
		if (presence.viewing(notice.session)) {
			log.info("notify.suppressed", { session: notice.session });
			return;
		}
		const subscriptions = (await harness().snapshot(PushSubscriptionsToken, context))?.subscriptions ?? [];
		const payload: PushPayload = { title: notice.title, body: notice.body, url: `/#/s/${notice.session}`, tag: `session-${notice.session}` };
		const gone: string[] = [];
		for (const subscription of subscriptions) {
			try {
				const status = await sender.send(subscription, JSON.stringify(payload), { topic: topicOf(notice.key), ttlSeconds: 24 * 3600 });
				log.info("notify.sent", { session: notice.session, status });
				if (status === 404 || status === 410) gone.push(subscription.endpoint);
			} catch (error) {
				log.warn("notify.failed", { session: notice.session, error: errorKind(error) });
			}
		}
		if (gone.length > 0) {
			await harness().commit(async (tx) => {
				const doc = await tx.doc(PushSubscriptionsToken);
				doc.subscriptions = doc.subscriptions.filter((subscription) => !gone.includes(subscription.endpoint));
			}, context);
		}
	}
}

/** A push Topic header: at most 32 characters of the URL-safe base64 alphabet. */
function topicOf(key: string): string {
	let hash = 0;
	for (const char of key) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0;
	return `n${(hash >>> 0).toString(36)}${key.length.toString(36)}`.slice(0, 32);
}
