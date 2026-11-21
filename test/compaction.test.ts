import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Context } from "@earendil-works/chord/context";
import type { SessionDoc } from "../src/shared/session.ts";
import { emptyNotes, mergeNotes, renderHandoff } from "../src/server/agent/handoff.ts";
import { compactions, modelText, TestServer } from "./helpers.ts";

/** Context windows small enough that the [long] scenario compacts during implementation, once or several times. */
const ONE_COMPACTION = 16_000;
const SEVERAL_COMPACTIONS = 12_000;

function hangUntilAborted(context: Context): Promise<void> {
	return new Promise((_resolve, reject) => {
		context.abortSignal?.addEventListener("abort", () => reject(new Error("cut off")), { once: true });
	});
}

describe("compaction", () => {
	test("a compaction mid-implementation is followed by the run reaching its report, with no input from the person", async () => {
		const server = await TestServer.start({ fakeModel: { contextWindow: ONE_COMPACTION } });
		try {
			const id = await server.createSession("Add a shout() function [long]");
			await server.approveThrough(id);
			const done = await server.settled(id, "the report", 60_000);
			const entries = await server.entries(id);
			const approval = entries.findIndex((entry) => entry.model?.[0]?.role === "toolResult" && entry.model[0].toolName === "submit_plan");
			const compaction = entries.findIndex((entry) => entry.kind === "pi.compaction");
			const report = entries.findIndex((entry) => entry.model?.[0]?.role === "toolResult" && entry.model[0].toolName === "file_report");
			assert.ok(approval < compaction && compaction < report, "compacted between plan approval and the report");
			assert.equal(done.outcome?.kind, "reported");
			assert.deepEqual(done.words.map((word) => word.kind), ["task", "answer", "approval"], "the person said nothing more");
			assert.equal(done.continuations, 0);
			assert.equal(done.handoff?.compactions, 1);
			assert.equal(done.workflow, "reported", "the compaction never changed the workflow");
		} finally {
			await server.close();
		}
	});

	test("the person's words and the plan survive several successive compactions verbatim", async () => {
		const server = await TestServer.start({ fakeModel: { contextWindow: SEVERAL_COMPACTIONS } });
		try {
			const task = "Add a shout() function [long]\nKeep the change small, and say why.";
			const id = await server.createSession(task);
			await server.until(id, (doc) => doc.card?.kind === "questions", "questions");
			await server.send(id, "Use \"three\" exclamation marks — exactly that.");
			await server.answer(id, (await server.until(id, (doc) => doc.card?.kind === "plan", "plan")).card!.id, { kind: "approve" });
			const done = await server.settled(id, "the report", 60_000);
			const summaries = compactions(await server.entries(id));
			assert.ok(summaries.length >= 2, `expected several compactions, got ${summaries.length}`);
			for (const summary of summaries) {
				assert.ok(summary.includes(`"""\n${task}\n"""`), "the task, verbatim");
				assert.ok(summary.includes('Use "three" exclamation marks — exactly that.'), "the typed answer, verbatim");
				assert.ok(summary.includes('Approved the plan "Add shout()" (revision 1).'));
				for (const step of done.plan!.steps) assert.ok(summary.includes(step.text), `plan step "${step.text}"`);
				assert.match(summary, /"Add shout\(\)", revision 1, approved; \d of 3 steps done\./);
			}
			// Progress is recomputed at each compaction, never carried from an older summary.
			const progress = summaries.map((summary) => Number(/approved; (\d) of 3/.exec(summary)?.[1]));
			assert.deepEqual(progress, [...progress].sort());
			assert.ok(progress.at(-1)! > progress[0]!);
			assert.equal(done.handoff?.compactions, summaries.length);
			// Accumulated, not re-summarized: findings from every compaction are still listed in the last one.
			assert.equal(done.handoff?.notes.findings.length, summaries.length);
			assert.ok(summaries.at(-1)!.includes("[f1]") && summaries.at(-1)!.includes(`[f${summaries.length}]`));
		} finally {
			await server.close();
		}
	});

	test("a failed summarization still yields a usable handoff and the run continues", async () => {
		const server = await TestServer.start({ fakeModel: { contextWindow: ONE_COMPACTION } });
		try {
			const id = await server.createSession("Add a shout() function [long] [summarizer-fails]");
			await server.approveThrough(id);
			const done = await server.settled(id, "the report", 60_000);
			assert.equal(done.outcome?.kind, "reported");
			const [summary] = compactions(await server.entries(id));
			assert.ok(summary !== undefined);
			assert.match(summary, /working notes could not be updated/);
			assert.match(summary, /Next action: Run git status/);
			assert.match(summary, /\[Task\]\n"""\nAdd a shout\(\) function \[long\] \[summarizer-fails\]/);
			assert.match(summary, /## Repository, computed at compaction\nOn branch pi\//);
			assert.match(summary, /## Plan\n"Add shout\(\)", revision 1, approved/);
		} finally {
			await server.close();
		}
	});

	test("a restart during compaction does not regenerate the model-written part", async () => {
		let summaries = 0;
		let held = false;
		const server = await TestServer.start({
			fakeModel: { contextWindow: ONE_COMPACTION, onRequest: (kind) => void (kind === "summary" && summaries++) },
			faults: {
				afterHandoffNotes: async (context) => {
					if (held) return;
					held = true;
					await hangUntilAborted(context);
				},
			},
		});
		try {
			const id = await server.createSession("Add a shout() function [long]");
			await server.approveThrough(id);
			await server.until(id, (doc) => doc.plan?.done.length === 1, "the first step");
			while (!held) await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(summaries, 1, "the summarizer ran once before the restart");
			let after = 0;
			await server.restart({ fakeModel: { contextWindow: ONE_COMPACTION, onRequest: (kind) => void (kind === "summary" && after++) } });
			const done = await server.settled(id, "the report", 60_000);
			assert.equal(done.outcome?.kind, "reported");
			assert.equal(after, 0, "the reopened compaction reused the memoized notes");
			const [summary] = compactions(await server.entries(id));
			assert.match(summary ?? "", /\[f1\] Compacted \d+ tool results\./);
			assert.equal(done.handoff?.compactions, 1, "the notes were saved once");
		} finally {
			await server.close();
		}
	});

	test("a detail that exists only before a compaction can be recalled", async () => {
		const server = await TestServer.start({ fakeModel: { contextWindow: ONE_COMPACTION } });
		try {
			const id = await server.createSession("Add a shout() function [long] [recall]");
			await server.approveThrough(id);
			const done = await server.settled(id, "the report", 60_000);
			const entries = await server.entries(id);
			const summaries = compactions(entries);
			assert.ok(summaries.length >= 1);
			assert.ok(summaries.every((summary) => !summary.includes("4817")), "the detail is not in any handoff");
			const recall = entries.find((entry) => entry.model?.[0]?.role === "toolResult" && entry.model[0].toolName === "recall_history");
			assert.ok(recall !== undefined, "the agent searched its history");
			assert.match(modelText(recall), /build id: 4817/);
			assert.match(done.report?.notes ?? "", /4817/);
		} finally {
			await server.close();
		}
	});

	test("a run that ends on a compaction error is resumed automatically", async () => {
		let thrown = false;
		const server = await TestServer.start({
			fakeModel: { contextWindow: ONE_COMPACTION },
			faults: {
				beforeHandoff: async () => {
					if (thrown) return;
					thrown = true;
					throw new Error("handoff unavailable");
				},
			},
		});
		try {
			const id = await server.createSession("Add a shout() function [long] [compaction-fails]");
			await server.approveThrough(id);
			const done = await server.settled(id, "the resumed report", 60_000);
			assert.equal(done.outcome?.kind, "reported");
			assert.equal(done.resumes, 1, "resumed once, without the person");
			assert.deepEqual(done.words.map((word) => word.kind), ["task", "answer", "approval"]);
		} finally {
			await server.close();
		}
	});
});

describe("the handoff text", () => {
	const doc = {
		id: 1,
		title: "t",
		repo: "demo/greeter",
		start: { kind: "new", base: "main" },
		branch: "pi/t-1",
		base: "main",
		setup: { status: "ready" },
		workflow: "implementing",
		plan: { title: "Plan", summary: "Do it.", steps: [{ id: "1", text: "First step" }, { id: "2", text: "Second step" }], revision: 1, approved: true, done: ["1"] },
		delivery: {},
		continuations: 0,
		resumes: 0,
		words: [{ at: 1, kind: "task", text: "THE TASK, exactly as typed" }],
		notified: [],
		requests: [],
		archived: false,
		createdAt: 1,
		updatedAt: 1,
		seenAt: 1,
	} satisfies SessionDoc;
	const ground = {
		branch: "pi/t-1",
		head: "abcdef1234567890",
		base: "main",
		baseKnown: true,
		ahead: 2,
		behind: 0,
		uncommitted: [],
		commits: Array.from({ length: 15 }, (_, index) => ({ sha: `c${index}`, subject: `commit ${index}` })),
		commitTotal: 15,
		files: Array.from({ length: 30 }, (_, index) => ({ path: `src/file-${index}.ts`, added: 1, removed: 0, status: "modified" })),
	};

	test("sheds in a fixed order and never sheds the resume point, the person's words, the plan or the repository state", () => {
		let notes = mergeNotes(emptyNotes(), {
			resume: { inProgress: "RESUME-IN-PROGRESS", latestResult: "RESUME-LATEST", nextAction: "RESUME-NEXT" },
			addFindings: Array.from({ length: 20 }, (_, index) => `finding ${index} ${"f".repeat(80)}`),
			addFailed: Array.from({ length: 20 }, (_, index) => `failure ${index} ${"x".repeat(80)}`),
			addOpen: ["open question one"],
			resolve: [],
		});
		const render = (budgetTokens: number) =>
			renderHandoff({
				doc,
				notes,
				degraded: false,
				ground,
				pointers: Array.from({ length: 40 }, (_, index) => `- bash pointer ${index}`),
				compactedRange: { first: 1, last: 99 },
				budgetTokens,
			});
		const full = render(100_000);
		assert.ok(full.includes("bash pointer 0") && full.includes("finding 0") && full.includes("src/file-0.ts"));
		const kept = ["RESUME-IN-PROGRESS", "RESUME-LATEST", "RESUME-NEXT", "THE TASK, exactly as typed", "1. [x] First step", "2. [ ] Second step", "On branch pi/t-1 at abcdef123456.", "2 commits ahead of origin/main"];
		const medium = render(Math.ceil((full.length - 1500) / 4));
		assert.ok(!medium.includes("bash pointer 0"), "pointers go first");
		assert.ok(medium.includes("finding 0"), "findings outlast pointers");
		const tiny = render(100);
		for (const text of kept) assert.ok(tiny.includes(text), `never shed: ${text}`);
		assert.ok(!tiny.includes("finding 0") && !tiny.includes("failure 0") && !tiny.includes("src/file-0.ts"));
		assert.match(tiny, /older findings left out to fit/);
		// Accumulating: a later update adds to and resolves the stored notes.
		notes = mergeNotes(notes, { resume: notes.resume, addFindings: ["new"], addFailed: [], addOpen: [], resolve: ["o1", "f1"] });
		assert.equal(notes.open.length, 0);
		assert.equal(notes.findings.at(-1)?.id, "f21");
		assert.equal(notes.findings.some((item) => item.id === "f1"), false);
	});
});
