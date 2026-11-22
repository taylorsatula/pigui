// Sessions from before plans and reports were structured keep their older shapes in storage; they still read as the
// current ones, so their cards, pull requests and checkpoints show what they hold.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { planOf, reportOf } from "../src/shared/session.ts";

describe("plans and reports stored in their older shapes", () => {
	test("a plan's summary reads as its goal, and its steps as steps with no files", () => {
		const plan = planOf({ title: "Add shout()", summary: "Add a shout() function.", steps: [{ id: "1", text: "Add src/shout.ts" }] });
		assert.equal(plan.goal, "Add a shout() function.");
		assert.deepEqual(plan.steps, [{ id: "1", text: "Add src/shout.ts", files: [] }]);
		assert.deepEqual([plan.endState, plan.decisions, plan.verification, plan.outOfScope, plan.risks, plan.citations], [[], [], [], [], [], []]);
	});

	test("a report's first line reads as its headline, and its verification prose as a note rather than a check", () => {
		const report = reportOf({
			summary: "Added shout().\nIt capitalises greet().",
			changes: ["src/shout.ts: shout(name)"],
			verification: "node --test passes.",
			notes: "",
			learned: "Run node --test.",
			commit: "abc",
			filedAt: 1,
		});
		assert.equal(report.headline, "Added shout().");
		assert.equal(report.summary, "It capitalises greet().");
		assert.deepEqual(report.changes, [{ change: "src/shout.ts: shout(name)", files: [] }]);
		assert.deepEqual(report.checks, []);
		assert.deepEqual(report.notes, ["node --test passes."]);
		assert.equal(report.outcome, "complete");
	});
});
