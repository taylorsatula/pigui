import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall, type Message, type ToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { calculateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { ContextView, ConversationId, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { CHECKPOINT_HEADER, renderCheckpoint } from "../src/server/agent/checkpoint.ts";
import { HANDOFF_TRIGGER } from "../src/server/agent/compaction.ts";
import { chooseCut, condensed, durableBounds, spansOf } from "../src/server/agent/cut.ts";
import type { Ground } from "../src/server/agent/facts.ts";
import { RESUME, WRITE_HANDOFF } from "../src/server/agent/handoff.ts";
import type { RequestKind } from "../src/server/fake/model.ts";
import { CHECKPOINT_ENTRY, type CheckpointEntryData, COMPACTION_NOTE_ENTRY, type CompactionNoteData, reportOf, type SessionDoc } from "../src/shared/session.ts";
import { checkpoints, context, modelText, TestServer, type TestOptions } from "./helpers.ts";

/**
 * Context windows for the [long] scenario, whose builds print about 4k tokens each beside a system prompt of about 5k
 * (1k of it picloud's bundled skills). The trigger sits between Durable's thresholds and the agent's start, so these are
 * calibrated by the scenario: at 25k picloud compacts once, after the second build; at 20k after each build; at 34k the
 * [backstop] flood starts Durable's background compaction and the next build its blocking one.
 */
const ONE_COMPACTION = 25_000;
const SEVERAL_COMPACTIONS = 20_000;
const BACKGROUND_THEN_BLOCKING = 34_000;

/** These windows are calibrated to the prompt without long-term memory, whose tool, report part and prompt text add about 2k tokens. */
const start = (options: TestOptions) => TestServer.start({ embedder: { off: "Off in these tests." }, ...options });

function hangUntilAborted(context: Context): Promise<void> {
	return new Promise((_resolve, reject) => {
		context.abortSignal?.addEventListener("abort", () => reject(new Error("cut off")), { once: true });
	});
}

const markers = (entries: readonly EntryRecord[]) => entries.filter((entry) => entry.kind === CHECKPOINT_ENTRY);
const notes = (entries: readonly EntryRecord[], note: CompactionNoteData["note"]) =>
	entries.filter((entry) => entry.kind === COMPACTION_NOTE_ENTRY && (entry.data as CompactionNoteData).note === note);
const dataOf = (entry: EntryRecord) => entry.data as CheckpointEntryData;
const callIn = (entry: EntryRecord | undefined, name?: string): ToolCall | undefined => {
	const message = entry?.model?.[0];
	if (message?.role !== "assistant") return undefined;
	return message.content.find((block): block is ToolCall => block.type === "toolCall" && (name === undefined || block.name === name));
};
const resultOf = (entries: readonly EntryRecord[], name: string) => entries.find((entry) => entry.model?.[0]?.role === "toolResult" && entry.model[0].toolName === name);
const textOf = (message: Message | undefined): string => {
	if (message === undefined || message.role === "system") return "";
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
};

/** Each tool round's context size as the trigger measures it: the request's usage plus the results it got back. */
function roundSizes(entries: readonly EntryRecord[]): { assistant: number; tokens: number }[] {
	const rounds: { assistant: number; tokens: number }[] = [];
	entries.forEach((entry, index) => {
		const message = entry.model?.[0];
		if (message?.role !== "assistant" || !message.content.some((block) => block.type === "toolCall")) return;
		let tokens = calculateContextTokens(message.usage);
		for (const later of entries.slice(index + 1)) {
			const result = later.model?.[0];
			if (result?.role === "toolResult") tokens += estimateMessageTokens(result);
			else if (result?.role !== "system") break;
		}
		rounds.push({ assistant: index, tokens });
	});
	return rounds;
}

/** The context the first request after `entry` was made with. */
async function contextAfter(server: TestServer, id: number, entries: readonly EntryRecord[], entry: EntryRecord): Promise<ContextView> {
	const next = entries.findIndex((each, index) => index > entries.indexOf(entry) && each.kind === "pi.assistant");
	const conversation = await server.app.harness.conversation(id as ConversationId, context);
	return conversation!.context(context, { at: entries[next - 1]!.id });
}

describe("compaction", () => {
	test("picloud asks for a handoff note at the trigger, compacts after it, and the run reaches its report on its own", async () => {
		// An unusable summarizer model falls back to the session's.
		const server = await start({ fakeModel: { contextWindow: ONE_COMPACTION }, env: { PICLOUD_COMPACTION_MODEL: "nowhere/none" } });
		try {
			const id = await server.createSession("Add a shout() function [long]");
			await server.approveThrough(id);
			const done = await server.settled(id, "the report", 60_000);
			const entries = await server.entries(id);
			const [request] = notes(entries, "handoff-request");
			assert.ok(request !== undefined, "a handoff note was asked for");
			const at = entries.indexOf(request);
			const rounds = roundSizes(entries).filter((round) => round.assistant < at);
			const trigger = ONE_COMPACTION * HANDOFF_TRIGGER;
			assert.ok(rounds.at(-1)!.tokens >= trigger, "asked after the round that reached the trigger");
			assert.ok(rounds.slice(0, -1).every((round) => round.tokens < trigger), "and not before it");
			const order = [
				at,
				entries.findIndex((entry) => callIn(entry, WRITE_HANDOFF) !== undefined),
				entries.indexOf(markers(entries)[0]!),
				entries.indexOf(notes(entries, "resume")[0]!),
				entries.indexOf(resultOf(entries, "file_report")!),
			];
			assert.deepEqual(order, [...order].sort((a, b) => a - b), "request, note, checkpoint, resume, report");
			assert.ok(order.every((index) => index >= 0));
			assert.equal(entries.filter((entry) => entry.kind === "pi.compaction").length, 0, "Durable's backstop never ran");
			assert.equal(done.outcome?.kind, "reported");
			assert.deepEqual(done.words.map((word) => word.kind), ["task", "answer", "approval"], "picloud's steers are not the person's words");
			assert.equal(done.continuations, 0);
			assert.equal(done.handoff?.compactions, 1);
			assert.equal(done.handoff?.requestedAt, undefined, "the cycle ended");
			assert.equal(done.workflow, "reported", "the compaction never changed the workflow");
		} finally {
			await server.close();
		}
	});

	test("after it, the model sees the checkpoint at the summarizer's cut, the runway ending with the handoff note, then the resume turn", async () => {
		const server = await start({ fakeModel: { contextWindow: ONE_COMPACTION } });
		try {
			const id = await server.createSession("Add a shout() function [long]");
			await server.approveThrough(id);
			await server.settled(id, "the report", 60_000);
			const entries = await server.entries(id);
			const [marker] = markers(entries);
			assert.equal(dataOf(marker!).selection, "model");
			// The scripted summarizer cuts at its newest scripted call, the second build's.
			assert.match(callIn(entries.find((entry) => entry.id === marker!.head))?.id ?? "", /^build-2:/);
			const resume = notes(entries, "resume")[0]!;
			const view = await contextAfter(server, id, entries, resume);
			assert.equal(view.head?.id, marker!.id);
			assert.equal(view.entries[1]?.id, marker!.head, "the runway starts at the cut");
			const seen = view.messages.filter((message) => message.role !== "system");
			assert.ok(textOf(seen[0]).startsWith(CHECKPOINT_HEADER));
			const call = entries.find((entry) => callIn(entry, WRITE_HANDOFF) !== undefined)!;
			const saved = resultOf(entries, WRITE_HANDOFF)!;
			assert.deepEqual(seen.slice(-3), [call.model![0], saved.model![0], resume.model![0]], "the note's call and result, verbatim, then the resume turn");
			assert.equal(textOf(seen.at(-1)), RESUME);
			assert.equal(textOf(saved.model![0]), "Saved");
		} finally {
			await server.close();
		}
	});

	test("a handoff request the agent ignores still compacts at the end of its next round", async () => {
		const server = await start({ fakeModel: { contextWindow: ONE_COMPACTION } });
		try {
			const id = await server.createSession("Add a shout() function [long] [ignore-handoff]");
			await server.approveThrough(id);
			const done = await server.settled(id, "the report", 60_000);
			const entries = await server.entries(id);
			const request = notes(entries, "handoff-request")[0]!;
			const [marker] = markers(entries);
			assert.ok(marker !== undefined && entries.indexOf(marker) > entries.indexOf(request));
			assert.equal(entries.filter((entry) => callIn(entry, WRITE_HANDOFF) !== undefined).length, 0);
			// Compacted right after the one round between the request and the checkpoint.
			const between = entries.slice(entries.indexOf(request), entries.indexOf(marker)).filter((entry) => entry.kind === "pi.assistant");
			assert.equal(between.length, 1);
			assert.equal(notes(entries, "resume").length, 1);
			assert.equal(entries.filter((entry) => entry.kind === "pi.compaction").length, 0);
			assert.equal(done.outcome?.kind, "reported");
		} finally {
			await server.close();
		}
	});

	test("an invalid cut falls back to the earliest allowed cut, with a note", async () => {
		const server = await start({ fakeModel: { contextWindow: ONE_COMPACTION } });
		try {
			const id = await server.createSession("Add a shout() function [long] [cut-invalid]");
			await server.approveThrough(id);
			const done = await server.settled(id, "the report", 60_000);
			const entries = await server.entries(id);
			const [marker] = markers(entries);
			assert.equal(dataOf(marker!).selection, "fallback");
			assert.match(modelText(marker!), /\(picloud: The summarizer's cut, entry \d+, is not one of the valid cuts it was shown\. The context continues from entry \d+\.\)/);
			// The earliest cut keeps the most the cap allows: here from the first build's progress mark.
			assert.match(callIn(entries.find((entry) => entry.id === marker!.head))?.id ?? "", /^progress-1:/);
			assert.equal(done.outcome?.kind, "reported");
		} finally {
			await server.close();
		}
	});

	test("condensing replaces a kept tool result in what the model sees, while recall_history still returns the original", async () => {
		const server = await start({ fakeModel: { contextWindow: ONE_COMPACTION } });
		try {
			const id = await server.createSession("Add a shout() function [long] [condense]");
			await server.approveThrough(id);
			const done = await server.settled(id, "the report", 60_000);
			const entries = await server.entries(id);
			const [marker] = markers(entries);
			const [edit] = marker!.edits ?? [];
			assert.equal(dataOf(marker!).condensed, 1);
			assert.ok(edit?.action === "replace");
			const original = entries.find((entry) => entry.id === edit.target)!;
			const stored = original.model![0] as ToolResultMessage;
			assert.match(textOf(stored), /^100501\n/, "the stored entry is unchanged");
			const view = await contextAfter(server, id, entries, notes(entries, "resume")[0]!);
			const shown = view.contributions[view.entries.findIndex((entry) => entry.id === edit.target)]?.[0] as ToolResultMessage;
			assert.equal(shown.toolCallId, stored.toolCallId);
			assert.equal(shown.toolName, stored.toolName);
			assert.match(textOf(shown), /^\[Condensed at compaction: Printed a long build log; the build finished\. The full result is entry \d+; recall_history reads it\.\]$/);
			const recalled = resultOf(entries, "recall_history")!;
			assert.match(modelText(recalled), new RegExp(`Entry ${edit.target} \\(pi.tool-result\\)`));
			assert.match(modelText(recalled), /\n100501\n/, "recall reads the original");
			assert.equal(done.outcome?.kind, "reported");
		} finally {
			await server.close();
		}
	});

	test("successive compactions evolve the checkpoint, and the person's words and the plan stay verbatim", async () => {
		const prompts: string[] = [];
		const server = await start({
			fakeModel: { contextWindow: SEVERAL_COMPACTIONS, onRequest: (kind, text) => void (kind === "summary" && prompts.push(text)) },
		});
		try {
			const task = "Add a shout() function [long]\nKeep the change small, and say why.";
			const id = await server.createSession(task);
			await server.until(id, (doc) => doc.card?.kind === "questions", "questions");
			await server.send(id, "Use \"three\" exclamation marks — exactly that.");
			await server.answer(id, (await server.until(id, (doc) => doc.card?.kind === "plan", "plan")).card!.id, { kind: "approve" });
			const done = await server.settled(id, "the report", 60_000);
			const texts = markers(await server.entries(id)).map(modelText);
			assert.ok(texts.length >= 2, `expected several compactions, got ${texts.length}`);
			assert.equal(prompts.length, texts.length);
			for (const text of texts) {
				assert.ok(text.includes(`"""\n${task}\n"""`), "the task, verbatim");
				assert.ok(text.includes('Use "three" exclamation marks — exactly that.'), "the typed answer, verbatim");
				assert.ok(text.includes('Approved the plan "Add shout()" (revision 1).'));
				for (const step of done.plan!.steps) assert.ok(text.includes(step.text), `plan step "${step.text}"`);
				assert.match(text, /"Add shout\(\)", revision 1, approved; \d of 3 steps done\./);
			}
			// Progress is recomputed at each compaction, never carried from an older checkpoint.
			const progress = texts.map((text) => Number(/approved; (\d) of 3/.exec(text)?.[1]));
			assert.deepEqual(progress, [...progress].sort());
			assert.ok(progress.at(-1)! > progress[0]!);
			// Evolved, not rewritten: each summarizer gets the previous working state and the agent's note, and adds to it.
			assert.ok(!prompts[0]!.includes("<previous_checkpoint>"));
			prompts.forEach((prompt, index) => {
				assert.ok(prompt.includes("<agent_handoff>\nI have just finished the"), "the agent's note reaches the summarizer");
				if (index > 0) assert.ok(prompt.includes(`<previous_checkpoint>\nSTATE AT COMPACTION BOUNDARY:`) && prompt.includes(`  - Compaction ${index}:`));
			});
			for (let index = 1; index <= texts.length; index++) assert.ok(texts.at(-1)!.includes(`  - Compaction ${index}:`));
			assert.equal(done.handoff?.compactions, texts.length);
			assert.ok(done.handoff?.body?.includes(`  - Compaction ${texts.length}:`));
		} finally {
			await server.close();
		}
	});

	test("a restart during picloud's compaction makes one summarizer call and places one marker and one resume turn", async () => {
		let summaries = 0;
		let holding = false;
		let reached!: () => void;
		const held = new Promise<void>((resolve) => (reached = resolve));
		const count = { contextWindow: ONE_COMPACTION, onRequest: (kind: RequestKind) => void (kind === "summary" && summaries++) };
		const server = await start({
			fakeModel: count,
			faults: {
				afterSummarizer: async (context) => {
					if (holding) return;
					holding = true;
					reached();
					await hangUntilAborted(context);
				},
			},
		});
		try {
			const id = await server.createSession("Add a shout() function [long]");
			await server.approveThrough(id);
			await held;
			assert.equal(summaries, 1, "the summarizer ran once before the restart");
			await server.restart({ fakeModel: count });
			const done = await server.settled(id, "the report", 60_000);
			assert.equal(done.outcome?.kind, "reported");
			assert.equal(summaries, 1, "the reopened compaction reused the memoized reply");
			const entries = await server.entries(id);
			assert.equal(markers(entries).length, 1);
			assert.equal(notes(entries, "resume").length, 1);
			assert.equal(done.handoff?.compactions, 1, "saved once");
		} finally {
			await server.close();
		}
	});

	test("a summarizer failure or a reply without a checkpoint still yields a usable checkpoint, and the run continues", async () => {
		for (const directive of ["[summarizer-fails]", "[summarizer-garbage]"]) {
			const server = await start({ fakeModel: { contextWindow: ONE_COMPACTION } });
			try {
				const id = await server.createSession(`Add a shout() function [long] ${directive}`);
				await server.approveThrough(id);
				const done = await server.settled(id, "the report", 60_000);
				assert.equal(done.outcome?.kind, "reported", directive);
				const [marker] = markers(await server.entries(id));
				const text = modelText(marker!);
				assert.equal(dataOf(marker!).selection, "fallback");
				assert.match(text, /\(picloud: the working state was not updated at this compaction \(.+\); it is the previous one, carried forward unchanged\.\)/);
				assert.match(text, /No working state has been written yet\./);
				assert.ok(text.includes(`[Task]\n"""\nAdd a shout() function [long] ${directive}\n"""`));
				assert.match(text, /## Repository, computed at compaction\nOn branch pi\//);
				assert.match(text, /## Plan\n"Add shout\(\)", revision 1, approved/);
			} finally {
				await server.close();
			}
		}
	});

	test("a detail that exists only before a compaction can be recalled", async () => {
		const server = await start({ fakeModel: { contextWindow: ONE_COMPACTION } });
		try {
			const id = await server.createSession("Add a shout() function [long] [recall]");
			await server.approveThrough(id);
			const done = await server.settled(id, "the report", 60_000);
			const entries = await server.entries(id);
			const texts = checkpoints(entries);
			assert.ok(texts.length >= 1);
			assert.ok(texts.every((text) => !text.includes("4817")), "the detail is not in any checkpoint");
			const recall = resultOf(entries, "recall_history");
			assert.ok(recall !== undefined, "the agent searched its history");
			assert.match(modelText(recall), /build id: 4817/);
			assert.match(done.report === undefined ? "" : reportOf(done.report).notes.join("\n"), /4817/);
		} finally {
			await server.close();
		}
	});

	test("the backstop: a round that passes Durable's thresholds at once is compacted by Durable, with picloud's checkpoint", async () => {
		const server = await start({ fakeModel: { contextWindow: ONE_COMPACTION } });
		try {
			const id = await server.createSession("Add a shout() function [long] [backstop]");
			await server.approveThrough(id);
			const done = await server.settled(id, "the report", 60_000);
			const entries = await server.entries(id);
			const durable = entries.findIndex((entry) => entry.kind === "pi.compaction");
			assert.ok(durable >= 0, "Durable compacted");
			assert.ok(modelText(entries[durable]!).includes(CHECKPOINT_HEADER), "with picloud's checkpoint as its summary");
			assert.ok(!entries.slice(0, durable).some((entry) => entry.kind === COMPACTION_NOTE_ENTRY), "no handoff was asked for first");
			// Its cut is the summarizer's own, so no marker moves it; the cycle compacts again later as usual.
			assert.ok(markers(entries).every((marker) => dataOf(marker).durableCut === undefined));
			assert.equal(done.outcome?.kind, "reported");
		} finally {
			await server.close();
		}
	});

	test("a run that ends on a compaction error fails, tells the person, and Continue finishes it", async () => {
		let thrown = false;
		const server = await start({
			fakeModel: { contextWindow: ONE_COMPACTION },
			faults: {
				beforeBackstop: async () => {
					if (thrown) return;
					thrown = true;
					throw new Error("checkpoint unavailable");
				},
			},
		});
		try {
			const id = await server.createSession("Add a shout() function [long] [backstop] [compaction-fails]");
			await server.approveThrough(id);
			const failed = await server.settled(id, "the failed run", 60_000);
			assert.equal(failed.outcome?.kind, "failed");
			// Durable retried the summary under its retry settings before the run failed; picloud does not retry again.
			assert.match(failed.outcome?.kind === "failed" ? (failed.outcome.detail ?? "") : "", /^Compaction failed: /);
			assert.ok(failed.notified.some((key) => key.startsWith("run:")), "the person is told");
			await server.post(`/api/sessions/${id}/continue`);
			const done = await server.settled(id, "the report after Continue", 60_000);
			assert.equal(done.outcome?.kind, "reported");
			assert.deepEqual(done.words.map((word) => word.kind), ["task", "answer", "approval"]);
		} finally {
			await server.close();
		}
	});

	test("a checkpoint whose head another compaction has passed is never placed, and nothing it hid comes back", async () => {
		let first = true;
		let release!: () => void;
		const released = new Promise<void>((resolve) => (release = resolve));
		const server = await start({
			fakeModel: { contextWindow: BACKGROUND_THEN_BLOCKING },
			faults: {
				// Holds Durable's background compaction after its summarizer, until the blocking one has finished.
				afterSummarizer: async (context) => {
					if (!first) return;
					first = false;
					await Promise.race([released, hangUntilAborted(context)]);
				},
			},
		});
		try {
			const id = await server.createSession("Add a shout() function [long] [backstop]");
			await server.approveThrough(id);
			await server.until(id, (doc) => (doc.handoff?.compactions ?? 0) >= 1, "the blocking compaction's checkpoint", 60_000);
			release();
			const done = await server.settled(id, "the report", 60_000);
			assert.equal(done.outcome?.kind, "reported");
			assert.equal(done.handoff?.compactions, 2, "both compactions wrote a checkpoint");
			const entries = await server.entries(id);
			const placed = markers(entries);
			const summaries = entries.filter((entry) => entry.kind === "pi.compaction");
			assert.equal(placed.length, 1, "the held compaction's marker was stale");
			assert.equal(summaries.length, 1, "and so was Durable's summary for it");
			assert.equal(dataOf(placed[0]!).task, summaries[0]!.byTaskId, "what was placed is the blocking compaction's");
			const conversation = await server.app.harness.conversation(id as ConversationId, context);
			const view = await conversation!.context(context);
			assert.equal(view.head?.id, placed[0]!.id, "one checkpoint in view");
			assert.ok(view.entries.slice(1).every((entry) => entry.id >= placed[0]!.head!), "no entry it hid is back");
		} finally {
			await server.close();
		}
	});
});

describe("cuts and checkpoint text", () => {
	// Synthetic records: the brand on entry IDs is erased at runtime.
	const id = (value: number) => value as EntryId;
	const call = (callId: string, text = "") => fauxAssistantMessage([...(text === "" ? [] : [fauxText(text)]), fauxToolCall("bash", { command: "make" }, { id: callId })], { stopReason: "toolUse" });
	const result = (callId: string, size: number): ToolResultMessage => ({
		role: "toolResult",
		toolCallId: callId,
		toolName: "bash",
		content: [{ type: "text", text: "x".repeat(size) }],
		isError: false,
		timestamp: 0,
	});
	const view = (messages: Message[]): ContextView => {
		const entries = messages.map((message, index) => ({ id: id(index + 1), conversationId: 1 as ConversationId, kind: "pi.entry", model: [message] }));
		return { head: undefined, entries, contributions: messages.map((message) => [message]), messages };
	};

	test("an over-cap cut moves to the nearest valid cut within the cap; with none, the fallback stands; each says why", () => {
		// Entry 1 the task, compacted; 2 a big call, 3 its big result, 4 a small call, 5 its result. Durable cut at 2.
		const task: Message = { role: "user", content: "Build it.", timestamp: 0 };
		const spans = spansOf(view([task, call("a", "y".repeat(8000)), result("a", 8000), call("b"), result("b", 400)]));
		const bounds = durableBounds(spans, id(2))!;
		const all = new Set([id(2), id(4)]);
		const capped = chooseCut(spans, bounds, all, 2, 1000);
		assert.equal(capped.selection, "capped");
		assert.equal(spans[capped.index]?.entry.id, 4);
		assert.match(capped.note ?? "", /entry 2, would keep about \d+ tokens, over the cap of 1000; the context continues from entry 4, the nearest valid cut within it\./);
		const none = chooseCut(spans, bounds, all, 2, 50);
		assert.equal(none.selection, "fallback");
		assert.equal(spans[none.index]?.entry.id, 2);
		assert.match(none.note ?? "", /no later valid cut is within it\. The context continues from entry 2\./);
		assert.equal(chooseCut(spans, bounds, all, 4, 1000).selection, "model");
		assert.equal(chooseCut(spans, bounds, new Set([id(2)]), 4, 1000).selection, "fallback", "a cut it was not shown is refused");
		assert.equal(chooseCut(spans, bounds, all, 3, 1000).selection, "fallback", "a tool result is never a cut");
		assert.equal(chooseCut(spans, bounds, all, 1, 100_000).selection, "fallback", "nor anything before Durable's cut");
		// Condensing the big result brings the earliest cut within the cap.
		const replaced = condensed(spans, [{ entry: 3, note: "Built." }]);
		assert.equal(chooseCut(spans, bounds, all, 2, 2600, replaced).selection, "model");
	});

	const doc = {
		id: 1,
		title: "t",
		place: "repo",
		repo: "demo/greeter",
		start: { kind: "new", base: "main" },
		branch: "pi/t-1",
		base: "main",
		setup: { status: "ready" },
		workflow: "implementing",
		plan: { title: "Plan", summary: "Do it.", steps: [{ id: "1", text: "First step" }, { id: "2", text: "Second step" }], revision: 1, approved: true, done: ["1"] },
		delivery: {},
		continuations: 0,
		words: [{ at: 1, kind: "task", text: "THE TASK, exactly as typed" }],
		notified: [],
		requests: [],
		archived: false,
		createdAt: 1,
		updatedAt: 1,
		seenAt: 1,
	} satisfies SessionDoc;
	const ground: Ground = {
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

	test("the checkpoint sheds in a fixed order and never sheds the person's words, the plan, the repository state or the working state", () => {
		const body = `STATE AT COMPACTION BOUNDARY:\n- Active task: WORKING-STATE ${"w".repeat(4000)}`;
		const render = (budgetTokens: number) =>
			renderCheckpoint({
				doc,
				ground,
				files: { read: Array.from({ length: 40 }, (_, index) => `docs/read-${index}.md`), modified: Array.from({ length: 20 }, (_, index) => `src/edit-${index}.ts`) },
				number: 2,
				at: 0,
				body,
				notes: ["A NOTE FROM PICLOUD."],
				compacted: { first: id(1), last: id(99) },
				cut: id(100),
				budgetTokens,
			});
		const full = render(100_000);
		assert.ok(full.includes("docs/read-0.md") && full.includes("src/edit-0.ts") && full.includes("src/file-0.ts") && full.includes("c0 commit 0"));
		const medium = render(Math.ceil((full.length - body.length - 300) / 4));
		assert.ok(!medium.includes("docs/read-0.md"), "files read go first");
		assert.ok(medium.includes("src/edit-0.ts") && medium.includes("src/file-0.ts"), "the rest outlast them");
		const tiny = render(100);
		const kept = ["THE TASK, exactly as typed", "1. [x] First step", "2. [ ] Second step", "On branch pi/t-1 at abcdef123456.", "2 commits ahead of origin/main", body, "(picloud: A NOTE FROM PICLOUD.)", "continues verbatim from entry 100", "## Before you act"];
		for (const text of kept) assert.ok(tiny.includes(text), `never shed: ${text.slice(0, 40)}`);
		assert.ok(!tiny.includes("docs/read-0.md") && !tiny.includes("src/edit-0.ts") && !tiny.includes("src/file-0.ts") && !tiny.includes("c0 commit 0"));
		assert.match(tiny, /older files read left out to fit/);
		assert.ok(tiny.startsWith(CHECKPOINT_HEADER));
	});
});
