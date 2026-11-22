import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { DeliveryResult, SessionDiff } from "../src/shared/api.ts";
import { MESSAGE_ENTRY, reportOf } from "../src/shared/session.ts";
import { git } from "../src/server/git.ts";
import type { ConversationId } from "@earendil-works/pi-durable";
import { context, TestServer } from "./helpers.ts";

describe("the zero-shot lifecycle", () => {
	let server: TestServer;
	before(async () => {
		server = await TestServer.start();
		await server.post("/api/push/subscribe", {
			endpoint: "https://push.invalid/subscription",
			keys: { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" },
		});
	});
	after(() => server.close());

	test("goes from a task through questions, plan, implementation and report to a pull request", async () => {
		const id = await server.createSession("Add a shout() function with a test");

		const questions = await server.until(id, (doc) => doc.card?.kind === "questions", "questions");
		assert.equal(questions.setup.status, "ready");
		assert.equal(questions.branch.startsWith("pi/add-a-shout-function"), true);
		assert.equal(questions.words[0]?.text, "Add a shout() function with a test");
		const card = questions.card!;
		assert.equal(card.kind, "questions");
		if (card.kind !== "questions") return;
		assert.equal(card.questions.length, 2, "several questions share one card");
		assert.equal(card.questions[0]?.recommended, "o1");
		await server.answer(id, card.id, {
			kind: "questions",
			answers: [
				{ questionId: "q1", selected: ["o2"] },
				{ questionId: "q2", selected: ["o1"], text: "keep it tiny" },
			],
		});

		const planned = await server.until(id, (doc) => doc.card?.kind === "plan", "plan");
		assert.equal(planned.plan?.approved, false);
		assert.equal(planned.workflow, "open");
		await server.answer(id, planned.card!.id, { kind: "approve" });

		const done = await server.settled(id, "report");
		assert.equal(done.workflow, "reported");
		assert.equal(done.outcome?.kind, "reported");
		assert.deepEqual(done.plan?.done, ["1", "2", "3"]);
		assert.match(done.report === undefined ? "" : reportOf(done.report).headline, /shout/);
		assert.equal(done.report?.commit, (await git(server.workspace(id), ["rev-parse", "HEAD"])).stdout.trim());

		// The answer shaped the code: "Three !!!" was chosen.
		const source = (await git(server.workspace(id), ["show", "HEAD:src/shout.ts"])).stdout;
		assert.match(source, /!!!/);

		// Repo memory carries what was learned to the next session on this repository.
		const entries = await server.entries(id);
		const task = entries.find((entry) => entry.kind === MESSAGE_ENTRY);
		assert.deepEqual((task?.data as { text: string }).text, "Add a shout() function with a test");

		const diff = await server.get<SessionDiff>(`/api/sessions/${id}/diff`);
		assert.deepEqual(diff.files.map((file) => [file.path, file.status]).sort(), [["src/shout.ts", "added"], ["test/shout.test.ts", "added"]]);
		assert.ok(diff.files.every((file) => file.added > 0 && file.removed === 0));

		// Nothing has reached the remote yet: the agent commits, the server delivers.
		const remoteBranches = (await server.github.branches("demo/greeter")).branches;
		assert.equal(remoteBranches.includes(done.branch), false);

		const delivered = await server.post<DeliveryResult>(`/api/sessions/${id}/deliver`, { action: "pr" });
		assert.equal(delivered.pushed, done.report?.commit);
		assert.equal(delivered.pr?.created, true);
		assert.equal((await server.github.branches("demo/greeter")).branches.includes(done.branch), true);
		const pulls = await server.github.pulls();
		assert.equal(pulls.length, 1);
		assert.equal(pulls[0]?.head, done.branch);
		assert.equal(pulls[0]?.base, "main");
		// The report, part by part, becomes the pull request: its headline the title, its end state a checklist.
		assert.equal(pulls[0]?.title, "Added shout(), a capitalised greeting, with a test.");
		assert.match(pulls[0]?.body ?? "", /^\*\*Complete\.\*\*/);
		assert.match(pulls[0]?.body ?? "", /## Done when\n- \[x\] `shout\("Ada"\)` returns `"HELLO, ADA!"`: Asserted in/);
		assert.match(pulls[0]?.body ?? "", /## Changes\n- Added `shout\(name\)`, built on `greet\(\)` \(`src\/shout\.ts`\)/);
		assert.match(pulls[0]?.body ?? "", /## Checks\n- passed: `node --test test\/\*\.test\.ts`: 2 tests, 0 failures/);
		const final = await server.session(id);
		assert.deepEqual(final?.delivery.pr, { number: delivered.pr?.number, url: delivered.pr?.url });

		// One notification each for the question, the plan and the report.
		const titles = server.push.sent.map((sent) => (JSON.parse(sent.payload) as { title: string }).title);
		assert.deepEqual(titles.map((title) => title.split(" — ")[1]), ["2 questions", "Plan ready", "Report ready"]);
	});

	test("carries repo memory into the next session's prompt", async () => {
		const id = await server.createSession("Just checking: does greet() handle names?");
		await server.settled(id, "chat reply");
		const conversation = await server.app.harness.conversation(id as ConversationId, context);
		const view = await conversation!.context(context);
		const system = JSON.stringify(view.messages.filter((message) => message.role === "system"));
		assert.match(system, /repo_memory/);
		assert.match(system, /node --test test\/\*\.test\.ts/);
		assert.match(system, /project_instructions path=.*AGENTS\.md/, "the repo's AGENTS.md comes through Pi's loader");
		assert.match(system, /release-notes/, "the repo's skill is listed");
	});
});
