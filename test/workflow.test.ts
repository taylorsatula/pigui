import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { NUDGE_ENTRY } from "../src/shared/session.ts";
import { MAX_CONTINUATIONS } from "../src/server/supervisor.ts";
import { ApiFailure, modelText, TestServer } from "./helpers.ts";

describe("the plan-first workflow", () => {
	let server: TestServer;
	before(async () => {
		server = await TestServer.start();
	});
	after(() => server.close());

	test("revises a plan from the person's feedback before approval", async () => {
		const id = await server.createSession("Add a shout() function");
		const questions = await server.until(id, (doc) => doc.card?.kind === "questions", "questions");
		await server.answer(id, questions.card!.id, { kind: "text", text: "Use your recommendations." });
		const first = await server.until(id, (doc) => doc.card?.kind === "plan", "first plan");
		assert.equal(first.plan?.revision, 1);
		await server.answer(id, first.card!.id, { kind: "revise", feedback: "Mention the README too." });
		const second = await server.until(id, (doc) => doc.card?.kind === "plan" && doc.card.id !== first.card!.id, "revised plan");
		assert.equal(second.plan?.revision, 2);
		assert.equal(second.plan?.approved, false);
		assert.match(second.plan?.summary ?? "", /Mention the README too\./);
		assert.deepEqual(
			second.words.map((word) => word.kind),
			["task", "answer", "feedback"],
		);
		await server.answer(id, second.card!.id, { kind: "approve" });
		const done = await server.settled(id);
		assert.equal(done.workflow, "reported");
		assert.equal(done.plan?.revision, 2);
		assert.equal(done.plan?.approved, true);
	});

	test("continues an approved plan that stops without a report, a bounded number of times", async () => {
		const id = await server.createSession("Add shout [never-report]");
		await server.approveThrough(id);
		const done = await server.settled(id, "continuations to run out");
		assert.equal(done.outcome?.kind, "no-report");
		assert.equal(done.continuations, MAX_CONTINUATIONS);
		const nudges = (await server.entries(id)).filter((entry) => entry.kind === NUDGE_ENTRY);
		assert.equal(nudges.length, MAX_CONTINUATIONS);
		assert.match(modelText(nudges[0]!), /Automatic continuation 1 of 3/);
		assert.ok(done.notified.some((key) => key.startsWith("run:")));
	});

	test("a continuation that leads to a report ends the loop", async () => {
		const id = await server.createSession("Add shout [no-report]");
		await server.approveThrough(id);
		const done = await server.settled(id);
		assert.equal(done.outcome?.kind, "reported");
		assert.equal(done.continuations, 1);
	});

	test("never pushes the agent to continue outside implementation", async () => {
		const id = await server.createSession("What does greet() return?");
		const done = await server.settled(id, "chat reply");
		assert.equal(done.outcome?.kind, "replied");
		assert.equal(done.continuations, 0);
		assert.equal((await server.entries(id)).filter((entry) => entry.kind === NUDGE_ENTRY).length, 0);
		assert.equal(done.workflow, "open");
	});

	test("the report refuses uncommitted changes", async () => {
		const id = await server.createSession("Add shout [dirty-report]");
		await server.approveThrough(id);
		const done = await server.settled(id);
		assert.equal(done.outcome?.kind, "reported");
		const results = (await server.entries(id)).filter((entry) => entry.kind === "pi.tool-result");
		const reports = results.filter((entry) => entry.model?.[0]?.role === "toolResult" && entry.model[0].toolName === "file_report");
		assert.equal(reports.length, 2);
		assert.match(modelText(reports[0]!), /Report refused: 2 uncommitted changes/);
		assert.equal(reports[0]?.model?.[0]?.role === "toolResult" && reports[0].model[0].isError, true);
		assert.match(modelText(reports[1]!), /Report filed/);
	});

	test("a model failure ends the run, and Continue picks it up", async () => {
		const id = await server.createSession("Add shout [model-error]");
		await server.approveThrough(id);
		const failed = await server.settled(id, "the failure");
		assert.equal(failed.outcome?.kind, "failed");
		assert.equal(failed.outcome?.kind === "failed" && failed.outcome.reason, "model_error");
		assert.equal(failed.workflow, "implementing");
		await server.post(`/api/sessions/${id}/continue`);
		const done = await server.settled(id, "the continued run");
		assert.equal(done.outcome?.kind, "reported");
	});

	test("the turn limit ends a runaway run and tells the person", async () => {
		const limited = await TestServer.start({ env: { PICLOUD_MAX_TURNS: "4" } });
		try {
			const id = await limited.createSession("Keep going [spin]");
			const done = await limited.settled(id);
			assert.equal(done.outcome?.kind, "failed");
			assert.equal(done.outcome?.kind === "failed" && done.outcome.reason, "turn_limit");
			assert.ok(done.notified.some((key) => key.startsWith("run:")));
		} finally {
			await limited.close();
		}
	});
});

describe("message routing", () => {
	let server: TestServer;
	before(async () => {
		server = await TestServer.start({ fakeModel: { tokensPerSecond: 400 } });
	});
	after(() => server.close());

	test("typed text answers a waiting card", async () => {
		const id = await server.createSession("Add a shout() function");
		await server.until(id, (doc) => doc.card?.kind === "questions", "questions");
		const { route } = await server.send(id, "Whatever you think is best");
		assert.equal(route, "card");
		const planned = await server.until(id, (doc) => doc.card?.kind === "plan", "plan");
		assert.equal(planned.words.at(-1)?.kind, "answer");
		assert.match(planned.words.at(-1)?.text ?? "", /Whatever you think is best/);
		const { route: feedback } = await server.send(id, "Fewer steps please");
		assert.equal(feedback, "card");
		const revised = await server.until(id, (doc) => doc.card?.kind === "plan" && doc.plan?.revision === 2, "revised plan");
		assert.equal(revised.words.at(-1)?.kind, "feedback");
		await server.post(`/api/sessions/${id}/stop`);
	});

	test("a message during a run steers it", async () => {
		const id = await server.createSession("Keep going [spin]");
		await server.until(id, (doc) => doc.activeRun !== undefined && doc.setup.status === "ready", "the run");
		const { route } = await server.send(id, "please stop now");
		assert.equal(route, "steer");
		const done = await server.settled(id);
		assert.equal(done.outcome?.kind, "replied");
		const entries = await server.entries(id);
		const answer = entries.filter((entry) => entry.kind === "pi.assistant").at(-1);
		assert.match(modelText(answer!), /Stopping, as you said: please stop now/);
	});

	test("a message to a finished session starts a new run", async () => {
		const id = await server.createSession("Add shout");
		await server.approveThrough(id);
		const reported = await server.settled(id);
		assert.equal(reported.workflow, "reported");
		const { route } = await server.send(id, "Also write a short note about it");
		assert.equal(route, "run");
		const followed = await server.settled(id, "the follow-up");
		assert.equal(followed.outcome?.kind, "reported");
		assert.notEqual(followed.report?.commit, reported.report?.commit);
	});

	test("a retried send takes effect once", async () => {
		const id = await server.createSession("What is in src?");
		await server.settled(id);
		const body = { requestId: "retried-request-1", text: "And in test?", attachments: [] };
		const [first, second] = await Promise.all([
			server.post<{ route: string }>(`/api/sessions/${id}/messages`, body),
			server.post<{ route: string }>(`/api/sessions/${id}/messages`, body).catch((error: unknown) => error),
		]);
		assert.equal(first.route, "run");
		const again = await server.post<{ route: string }>(`/api/sessions/${id}/messages`, body);
		assert.equal(again.route, "run");
		await server.settled(id);
		const messages = (await server.entries(id)).filter((entry) => entry.kind === "picloud.message");
		assert.equal(messages.length, 2, `one task and one message, not ${messages.length} (${String(second)})`);
	});

	test("an empty message is refused at the boundary", async () => {
		const id = await server.createSession("What is in src?");
		await server.settled(id);
		await assert.rejects(server.send(id, "   "), (error: unknown) => error instanceof ApiFailure && error.status === 400);
		await assert.rejects(
			server.post(`/api/sessions/${id}/messages`, { requestId: "x", text: "hi", attachments: [] }),
			(error: unknown) => error instanceof ApiFailure && error.status === 400 && /requestId/.test(error.body.error),
		);
	});
});

describe("the spend cap", () => {
	test("stops a run at the cap, and raising it continues", async () => {
		const server = await TestServer.start({ env: { PICLOUD_SPEND_CAP: "0.001" } });
		try {
			const id = await server.createSession("Add a shout() function");
			const stopped = await server.settled(id, "the budget stop");
			assert.equal(stopped.outcome?.kind, "budget");
			assert.equal(stopped.card, undefined, "the run stopped before asking anything");
			assert.ok(stopped.notified.some((key) => key.startsWith("budget:")));
			await assert.rejects(server.send(id, "go on"), (error: unknown) => error instanceof ApiFailure && error.status === 409 && error.body.hint === "Raise the budget to continue.");
			await server.post(`/api/sessions/${id}/budget`, { cap: 100 });
			const resumed = await server.until(id, (doc) => doc.card?.kind === "questions", "the questions after raising the cap");
			assert.equal(resumed.cap, 100);
		} finally {
			await server.close();
		}
	});
});
