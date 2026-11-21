import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Context } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { encryptPayload } from "../src/server/webpush.ts";
import { context, TestServer } from "./helpers.ts";

const SUBSCRIPTION = {
	endpoint: "https://push.invalid/subscription",
	keys: { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" },
};

/** Parks until the invocation is cut off, like a process that dies after the card's commit and before the park. */
function hangUntilAborted(context: Context): Promise<void> {
	return new Promise((_resolve, reject) => {
		const signal = context.abortSignal;
		if (signal === undefined) return;
		signal.addEventListener("abort", () => reject(new Error("cut off")), { once: true });
	});
}

async function notifications(server: TestServer, id: number) {
	const page = await server.app.harness.commit((tx) => tx.scanTasks({ conversationId: id as ConversationId, kind: "picloud.notify" }, 100), context);
	return [...page.items];
}

describe("notifications", () => {
	test("exactly one notification per wait, even when the waiting tool reruns", async () => {
		let reruns = 0;
		const server = await TestServer.start({
			faults: {
				afterCard: async (context) => {
					reruns++;
					if (reruns === 1) await hangUntilAborted(context);
				},
			},
		});
		try {
			await server.post("/api/push/subscribe", SUBSCRIPTION);
			const id = await server.createSession("Add a shout() function");
			const waiting = await server.until(id, (doc) => doc.card?.kind === "questions", "questions");
			const firstSender = server.push;
			await server.restart({ faults: { afterCard: async () => void reruns++ } });
			const after = await server.until(id, (doc) => doc.card?.id === waiting.card?.id, "the card after the rerun");
			await new Promise((resolve) => setTimeout(resolve, 300));
			assert.ok(reruns >= 2, "the tool ran again after the restart");
			assert.equal(after.notified.filter((key) => key === `card:${waiting.card!.id}`).length, 1);
			const notifyTasks = await notifications(server, id);
			assert.equal(notifyTasks.length, 1, "one notification task for the card");
			await server.app.harness.waitForTask(notifyTasks[0]!.id, context);
			const total = firstSender.sent.length + server.push.sent.length;
			assert.equal(total, 1, "one push sent across both processes");
		} finally {
			await server.close();
		}
	});

	test("no notification for a session the person is looking at", async () => {
		const server = await TestServer.start();
		try {
			await server.post("/api/push/subscribe", SUBSCRIPTION);
			const id = await server.createSession("Add a shout() function");
			const controller = new AbortController();
			const response = await fetch(`${server.app.url}/api/live?session=${id}`, { signal: controller.signal });
			const reader = response.body!.getReader();
			await reader.read();
			await server.until(id, (doc) => doc.card?.kind === "questions", "questions");
			// The notification task ran while the stream was open, so it sent nothing.
			for (const task of await notifications(server, id)) await server.app.harness.waitForTask(task.id, context);
			assert.equal(server.push.sent.length, 0);
			controller.abort();
			await reader.cancel().catch(() => undefined);
			// The server learns of the closed stream when its socket closes.
			while (server.app.presence.viewing(id)) await new Promise((resolve) => setTimeout(resolve, 10));
			await server.answer(id, (await server.session(id))!.card!.id, { kind: "text", text: "go" });
			await server.until(id, (doc) => doc.card?.kind === "plan", "plan");
			for (const task of await notifications(server, id)) await server.app.harness.waitForTask(task.id, context);
			assert.equal(server.push.sent.length, 1, "the plan notifies once nobody is looking");
			const payload = JSON.parse(server.push.sent[0]!.payload) as { url: string; tag: string };
			assert.equal(payload.url, `/#/s/${id}`, "tapping opens the session");
			assert.equal(payload.tag, `session-${id}`);
		} finally {
			await server.close();
		}
	});

	test("Web Push messages are encrypted as RFC 8291 specifies", () => {
		const body = encryptPayload(SUBSCRIPTION, "When I grow up, I want to be a watermelon", {
			salt: Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url"),
			senderPrivateKey: Buffer.from("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", "base64url"),
		});
		assert.equal(
			body.toString("base64url"),
			"DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
		);
	});
});
