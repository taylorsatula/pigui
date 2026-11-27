// Canceling a steering message that is queued behind a run, through the HTTP boundary: the person's queued words can
// be withdrawn before Pi sees them, idempotently, and pigui's own steers cannot be.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { type ConversationId, InboxDoc } from "@earendil-works/pi-durable";
import { COMPACTION_NOTE_ENTRY, MESSAGE_ENTRY, type CompactionNoteData } from "../src/shared/session.ts";
import { ApiFailure, context, TestServer } from "./helpers.ts";

describe("canceling a queued steering message", () => {
	let server: TestServer;
	before(async () => {
		server = await TestServer.start();
	});
	after(() => server.close());

	test("a queued steer can be canceled before Pi sees it", async () => {
		const id = await server.createSession("Probe the machine [probe]\n$ sleep 5");
		await server.until(id, (doc) => doc.activeRun !== undefined && doc.setup.status === "ready", "the probe run");
		// The bash call parks for five seconds; until it returns, the message queues in Durable's inbox.
		const { route } = await server.send(id, "please hurry");
		assert.equal(route, "steer");
		const inbox = await server.app.harness.snapshot(InboxDoc, id as ConversationId, context);
		const queued = inbox!.items.find((item) => item.mode === "steer" && (item.entry as { kind?: string } | undefined)?.kind === MESSAGE_ENTRY);
		assert.ok(queued, "the person's steer is in the inbox");

		const canceled = await server.post<{ result: string }>(`/api/sessions/${id}/queued/${queued.id}/cancel`);
		assert.deepEqual(canceled, { result: "aborted" });
		// Idempotent: a retry or a double tap is a settled no-op, not an error.
		assert.deepEqual(await server.post(`/api/sessions/${id}/queued/${queued.id}/cancel`), { result: "settled" });
		// The message never reached the conversation.
		const reached = (await server.entries(id)).filter((entry) => entry.kind === MESSAGE_ENTRY && (entry.data as { text?: string } | undefined)?.text === "please hurry");
		assert.equal(reached.length, 0);
		await server.post(`/api/sessions/${id}/stop`);
	});

	test("a steer whose entry is not the person's words cannot be canceled", async () => {
		const id = await server.createSession("Probe the machine [probe]\n$ sleep 3");
		await server.until(id, (doc) => doc.activeRun !== undefined && doc.setup.status === "ready", "the probe run");
		const conversation = await server.app.harness.conversation(id as ConversationId, context);
		assert.ok(conversation);
		// pigui's own steer, say the compaction resume turn: honest to queue, not the person's to withdraw.
		const own = await conversation.submit(
			{ type: "input", content: "resume", whenBusy: "steer", requestId: `test:own-steer-${id}`, entry: { kind: COMPACTION_NOTE_ENTRY, data: { note: "resume" } satisfies CompactionNoteData } },
			context,
		);
		const refused = await server.post(`/api/sessions/${id}/queued/${own.id}/cancel`).then(
			() => undefined,
			(error: unknown) => error,
		);
		assert.ok(refused instanceof ApiFailure);
		assert.equal(refused.status, 409);
		// One of the person's own queued messages cancels fine alongside it.
		await server.send(id, "please hurry");
		const inbox = await server.app.harness.snapshot(InboxDoc, id as ConversationId, context);
		const person = inbox!.items.find((item) => item.mode === "steer" && (item.entry as { kind?: string } | undefined)?.kind === MESSAGE_ENTRY);
		assert.ok(person);
		assert.deepEqual(await server.post(`/api/sessions/${id}/queued/${person!.id}/cancel`), { result: "aborted" });
		await server.post(`/api/sessions/${id}/stop`);
	});

	test("canceling something that was never queued is a settled no-op", async () => {
		const id = await server.createSession("Add a shout() function");
		await server.until(id, (doc) => doc.setup.status === "ready", "the session is ready");
		assert.deepEqual(await server.post(`/api/sessions/${id}/queued/999999999/cancel`), { result: "settled" });
		await server.post(`/api/sessions/${id}/stop`).catch(() => undefined);
	});
});
