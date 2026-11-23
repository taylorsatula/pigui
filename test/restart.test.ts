import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type ConversationId, LiveDoc } from "@earendil-works/pi-durable";
import { context, TestServer } from "./helpers.ts";

describe("restarts", () => {
	test("a pending question survives a full server restart and completes afterwards", async () => {
		const server = await TestServer.start();
		try {
			const id = await server.createSession("Add a shout() function");
			const waiting = await server.until(id, (doc) => doc.card?.kind === "questions", "questions");
			await server.parked(id);
			// While it waits, nothing runs: the tool is parked on a signal and holds no invocation.
			const tasks = (await server.app.harness.inspect(context)).tasks.filter((task) => task.record.conversationId === id && task.record.kind !== "pigui.notify");
			assert.ok(tasks.some((task) => task.state.kind === "sleeping"));
			assert.ok(tasks.length > 0 && tasks.every((task) => task.state.kind !== "running"), "no task of the session is running");
			await server.restart();
			const after = await server.session(id);
			assert.deepEqual(after?.card, waiting.card, "the card is still waiting after the restart");
			const live = await server.app.harness.snapshot(LiveDoc, id as ConversationId, context);
			assert.equal(live?.tools?.[0]?.status, "sleeping");
			await server.answer(id, waiting.card!.id, { kind: "text", text: "Your recommendations are fine." });
			await server.until(id, (doc) => doc.card?.kind === "plan", "plan after the restart");
			await server.answer(id, (await server.session(id))!.card!.id, { kind: "approve" });
			const done = await server.settled(id);
			assert.equal(done.outcome?.kind, "reported");
		} finally {
			await server.close();
		}
	});

	test("a session caught mid-setup by a restart finishes setting up", async () => {
		const server = await TestServer.start();
		try {
			const id = await server.createSession("What is in src?");
			// Close at once: setup has at most started cloning.
			await server.restart();
			const done = await server.settled(id, "setup and the reply after the restart");
			assert.equal(done.setup.status, "ready");
			assert.equal(done.outcome?.kind, "replied");
		} finally {
			await server.close();
		}
	});

	test("a failed setup is shown with a reason and can be retried", async () => {
		const server = await TestServer.start();
		try {
			const id = await server.createSession("Work on it", { kind: "continue", branch: "no-such-branch" });
			const failed = await server.until(id, (doc) => doc.setup.status === "failed", "setup failure");
			assert.equal(failed.setup.status === "failed" && failed.setup.step, "clone");
			assert.match(failed.setup.status === "failed" ? failed.setup.error : "", /no-such-branch/);
			await server.post(`/api/sessions/${id}/retry-setup`);
			const again = await server.until(id, (doc) => doc.setup.status === "failed" && doc.updatedAt > failed.updatedAt, "second failure");
			assert.equal(again.setup.status, "failed");
		} finally {
			await server.close();
		}
	});
});
