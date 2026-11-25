// The derivation from Durable entries to what the session view shows, pinned against the behavior the deleted client
// shipped. The incremental rewrite of buildBlocks must keep every case here green.
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { EntryRecord, TranscriptItem, TranscriptView } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
	AGENT_RESULT_ENTRY,
	AGENT_STOPPED_ENTRY,
	CHECKPOINT_ENTRY,
	MESSAGE_ENTRY,
	NUDGE_ENTRY,
	type SessionDoc,
} from "../shared/session.ts";
import { buildBlocks, turnStart, type Block } from "./transcript.ts";

const TS = 1_700_000_000_000;

const entry = (id: number, kind: string, over: Partial<EntryRecord> = {}): EntryRecord =>
	({ id: id as unknown as EntryRecord["id"], conversationId: "conversation" as unknown as EntryRecord["conversationId"], kind, ...over }) as EntryRecord;
const userMessage = (content: string, timestamp = TS) => ({ role: "user" as const, content, timestamp });
const assistantMessage = (content: unknown[], over: Record<string, unknown> = {}): AssistantMessage =>
	({ role: "assistant", content, timestamp: TS, ...over }) as unknown as AssistantMessage;
const toolResultMessage = (toolCallId: string, toolName: string, text: string, over: Record<string, unknown> = {}): ToolResultMessage =>
	({ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, timestamp: TS, ...over }) as unknown as ToolResultMessage;
const entryItem = (e: EntryRecord): TranscriptItem => ({ kind: "entry", entry: e });
const viewOf = (items: TranscriptItem[], docs: Record<string, unknown> = {}): TranscriptView =>
	({ conversation: {}, docs, items }) as unknown as TranscriptView;
const session = (over: Record<string, unknown> = {}): SessionDoc => ({ id: 1, card: undefined, ...over }) as unknown as SessionDoc;
const personData = { text: "Do the thing", references: [], attachments: [] };

describe("buildBlocks", () => {
	it("no view, no blocks", () => {
		expect(buildBlocks(undefined, undefined, false)).toEqual([]);
	});

	it("a person's message", () => {
		const blocks = buildBlocks(viewOf([entryItem(entry(1, MESSAGE_ENTRY, { data: personData }))]), undefined, false);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({ kind: "person", key: "1", data: personData });
		expect(blocks[0]).not.toHaveProperty("at");
	});

	it("a pi.user entry is the person's words, dated", () => {
		const blocks = buildBlocks(viewOf([entryItem(entry(2, "pi.user", { model: [userMessage("Hello")] }))]), undefined, false);
		expect(blocks[0]).toMatchObject({ kind: "person", key: "2", data: { text: "Hello", references: [], attachments: [] }, at: TS });
	});

	it("a finished reply gets a speaker", () => {
		const blocks = buildBlocks(viewOf([entryItem(entry(3, "pi.assistant", { model: [assistantMessage([{ type: "text", text: "Done." }])] }))]), undefined, false);
		expect(blocks.map((block) => block.kind)).toEqual(["text", "speak"]);
		expect(blocks[0]).toMatchObject({ kind: "text", key: "3:0", text: "Done.", streaming: false });
		expect(blocks[1]).toMatchObject({ kind: "speak", key: "3:0:speak", text: "Done." });
	});

	it("a streaming reply has no speaker yet", () => {
		const docs = { "pi.live": { generation: { message: assistantMessage([{ type: "text", text: "Hel" }]) } } };
		const blocks = buildBlocks(viewOf([], docs), undefined, true);
		expect(blocks.map((block) => block.kind)).toEqual(["text"]);
		expect(blocks[0]).toMatchObject({ kind: "text", text: "Hel", streaming: true });
	});

	it("a tool call that finished", () => {
		const items = [
			entryItem(entry(3, "pi.assistant", { model: [assistantMessage([{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }])] })),
			entryItem(entry(4, "pi.toolResult", { model: [toolResultMessage("c1", "bash", "file.txt")] })),
		];
		const blocks = buildBlocks(viewOf(items), undefined, false);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({ kind: "work", key: "3:0", live: false });
		const work = blocks[0] as Extract<Block, { kind: "work" }>;
		expect(work.items[0]).toMatchObject({ kind: "call", call: { id: "c1", name: "bash", status: "done", output: "file.txt" } });
	});

	it("a tool call still running", () => {
		const items = [entryItem(entry(3, "pi.assistant", { model: [assistantMessage([{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }])] }))];
		const blocks = buildBlocks(viewOf(items), undefined, true);
		const work = blocks[0] as Extract<Block, { kind: "work" }>;
		expect(work.items[0]).toMatchObject({ kind: "call", call: { status: "running" } });
		expect((work.items[0] as Extract<Block, { kind: "work" }>["items"][number] & { call: { output?: string } }).call.output).toBeUndefined();
	});

	it("a failed tool call", () => {
		const items = [
			entryItem(entry(3, "pi.assistant", { model: [assistantMessage([{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "false" } }])] })),
			entryItem(entry(4, "pi.toolResult", { model: [toolResultMessage("c1", "bash", "boom", { isError: true })] })),
		];
		const blocks = buildBlocks(viewOf(items), undefined, false);
		const work = blocks[0] as Extract<Block, { kind: "work" }>;
		expect(work.items[0]).toMatchObject({ kind: "call", call: { status: "failed", output: "boom" } });
	});

	it("a waiting tool call", () => {
		const docs = { "pi.live": { tools: [{ callId: "c1", status: "sleeping" }] } };
		const items = [entryItem(entry(3, "pi.assistant", { model: [assistantMessage([{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "sleep 5" } }])] }))];
		const blocks = buildBlocks(viewOf(items, docs), undefined, true);
		const work = blocks[0] as Extract<Block, { kind: "work" }>;
		expect(work.items[0]).toMatchObject({ kind: "call", call: { status: "waiting" } });
	});

	const questionsCard = {
		id: "c1",
		kind: "questions",
		questions: [{ id: "q1", prompt: "Which?", options: [{ id: "o1", label: "A" }], multiple: false }],
	};

	it("a questions card waiting for the person", () => {
		const items = [entryItem(entry(3, "pi.assistant", { model: [assistantMessage([{ type: "toolCall", id: "c1", name: "ask_single_choice", arguments: {} }])] }))];
		const blocks = buildBlocks(viewOf(items), session({ card: questionsCard }), false);
		expect(blocks[0]).toMatchObject({ kind: "questions", key: "3:0", pending: true, card: { id: "c1" } });
		expect(blocks[0]).not.toHaveProperty("answer");
	});

	it("a questions card answered", () => {
		const answer = { kind: "questions", answers: [{ questionId: "q1", selected: ["o1"] }] };
		const items = [
			entryItem(entry(3, "pi.assistant", { model: [assistantMessage([{ type: "toolCall", id: "c1", name: "ask_single_choice", arguments: {} }])] })),
			entryItem(entry(4, "pi.toolResult", { model: [toolResultMessage("c1", "ask_single_choice", "ok", { details: { card: questionsCard, answer } })] })),
		];
		const blocks = buildBlocks(viewOf(items), session(), false);
		expect(blocks[0]).toMatchObject({ kind: "questions", pending: false, answer });
	});

	const storedReport = {
		headline: "Did it",
		summary: "It is done",
		outcome: "complete",
		endState: [],
		changes: [],
		checks: [],
		deviations: [],
		notes: [],
		learned: "",
		commit: "abc1234",
		filedAt: TS,
	};

	it("a report is filed, latest", () => {
		const items = [
			entryItem(entry(3, "pi.assistant", { model: [assistantMessage([{ type: "toolCall", id: "c1", name: "file_report", arguments: {} }])] })),
			entryItem(entry(4, "pi.toolResult", { model: [toolResultMessage("c1", "file_report", "ok", { details: { report: storedReport } })] })),
		];
		const blocks = buildBlocks(viewOf(items), session(), false);
		expect(blocks[0]).toMatchObject({ kind: "report", key: "3:0", latest: true, report: { headline: "Did it", commit: "abc1234" } });
	});

	it("only the newest report is latest", () => {
		const items = [
			entryItem(entry(3, "pi.assistant", { model: [assistantMessage([{ type: "toolCall", id: "c1", name: "file_report", arguments: {} }])] })),
			entryItem(entry(4, "pi.toolResult", { model: [toolResultMessage("c1", "file_report", "ok", { details: { report: storedReport } })] })),
			entryItem(entry(5, "pi.assistant", { model: [assistantMessage([{ type: "toolCall", id: "c2", name: "file_report", arguments: {} }])] })),
			entryItem(entry(6, "pi.toolResult", { model: [toolResultMessage("c2", "file_report", "ok", { details: { report: storedReport } })] })),
		];
		const blocks = buildBlocks(viewOf(items), session(), false);
		const reports = blocks.filter((block) => block.kind === "report");
		expect(reports.map((block) => (block as Extract<Block, { kind: "report" }>).latest)).toEqual([false, true]);
	});

	it("a compaction checkpoint supersedes Durable's summary", () => {
		const items = [
			entryItem(entry(5, "pi.compaction", { head: 9 as EntryRecord["head"], model: [userMessage("<summary>\nDurable text\n</summary>")] })),
			entryItem(entry(6, CHECKPOINT_ENTRY, { model: [userMessage("Checkpoint text")], data: { task: 1, durableCut: 9, selection: "model", retained: 4, condensed: 0 } })),
		];
		const blocks = buildBlocks(viewOf(items), undefined, false);
		const compactions = blocks.filter((block) => block.kind === "compaction");
		expect(compactions).toHaveLength(1);
		expect(compactions[0]).toMatchObject({ kind: "compaction", key: "5", summary: "Checkpoint text", retained: 4 });
	});

	it("Durable's compaction without a checkpoint strips the summary tags", () => {
		const items = [entryItem(entry(5, "pi.compaction", { model: [userMessage("<summary>\nCarried forward\n</summary>")] }))];
		const blocks = buildBlocks(viewOf(items), undefined, false);
		expect(blocks[0]).toMatchObject({ kind: "compaction", key: "5", summary: "Carried forward" });
		expect(blocks[0]).not.toHaveProperty("retained");
	});

	it("a lone checkpoint keeps its retained count", () => {
		const items = [entryItem(entry(6, CHECKPOINT_ENTRY, { model: [userMessage("Checkpoint text")], data: { task: 1, selection: "fallback", retained: 2, condensed: 1 } }))];
		const blocks = buildBlocks(viewOf(items), undefined, false);
		expect(blocks[0]).toMatchObject({ kind: "compaction", key: "6", summary: "Checkpoint text", retained: 2 });
	});

	it("a nudge", () => {
		const blocks = buildBlocks(viewOf([entryItem(entry(7, NUDGE_ENTRY, { data: { attempt: 2, limit: 3 } }))]), undefined, false);
		expect(blocks[0]).toMatchObject({ kind: "nudge", data: { attempt: 2, limit: 3 } });
	});

	it("an agent's answer", () => {
		const data = { agent: 2, type: "scout", description: "look", status: "done", text: "Found." };
		const blocks = buildBlocks(viewOf([entryItem(entry(8, AGENT_RESULT_ENTRY, { data }))]), undefined, false);
		expect(blocks[0]).toMatchObject({ kind: "agent-result", data });
	});

	it("an agent stopped", () => {
		const data = { agent: 2, type: "scout", description: "look" };
		const blocks = buildBlocks(viewOf([entryItem(entry(9, AGENT_STOPPED_ENTRY, { data }))]), undefined, false);
		expect(blocks[0]).toMatchObject({ kind: "agent-stopped", data });
	});

	it("a gap and the earlier marker", () => {
		const blocks = buildBlocks(viewOf([{ kind: "earlier" }, { kind: "gap", after: 3 as EntryRecord["id"], upTo: 8 as EntryRecord["id"] }]), undefined, false);
		expect(blocks[0]).toMatchObject({ kind: "earlier", key: "earlier" });
		expect(blocks[1]).toMatchObject({ kind: "gap", key: "gap:3" });
	});

	it("a reset", () => {
		const blocks = buildBlocks(viewOf([entryItem(entry(10, "pi.reset"))]), undefined, false);
		expect(blocks[0]).toMatchObject({ kind: "notice", tone: "info", text: "The context was reset." });
	});

	it("an error stop", () => {
		const blocks = buildBlocks(viewOf([entryItem(entry(11, "pi.assistant", { model: [assistantMessage([{ type: "text", text: "partial" }], { stopReason: "error", errorMessage: "boom" })] }))]), undefined, false);
		expect(blocks.map((block) => block.kind)).toEqual(["text", "speak", "notice"]);
		expect(blocks[2]).toMatchObject({ kind: "notice", tone: "error", text: "The model returned an error: boom" });
	});

	it("an aborted stop", () => {
		const blocks = buildBlocks(viewOf([entryItem(entry(12, "pi.assistant", { model: [assistantMessage([{ type: "text", text: "partial" }], { stopReason: "aborted" })] }))]), undefined, false);
		expect(blocks.map((block) => block.kind)).toEqual(["text", "speak", "notice"]);
		expect(blocks[2]).toMatchObject({ kind: "notice", tone: "info", text: "Stopped." });
	});

	it("thinking then prose", () => {
		const blocks = buildBlocks(viewOf([entryItem(entry(13, "pi.assistant", { model: [assistantMessage([{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Done." }])] }))]), undefined, false);
		expect(blocks.map((block) => block.kind)).toEqual(["work", "text", "speak"]);
		const work = blocks[0] as Extract<Block, { kind: "work" }>;
		expect(work.items[0]).toMatchObject({ kind: "thinking", text: "hmm", streaming: false });
	});

	it("the turn under way stays open while the agent works", () => {
		const items = [
			entryItem(entry(14, MESSAGE_ENTRY, { data: personData })),
			entryItem(entry(15, "pi.assistant", { model: [assistantMessage([{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }])] })),
		];
		const blocks = buildBlocks(viewOf(items), session(), true);
		const work = blocks.find((block) => block.kind === "work") as Extract<Block, { kind: "work" }>;
		expect(work.live).toBe(true);
	});

	it("a finished turn folds its work", () => {
		const items = [
			entryItem(entry(16, MESSAGE_ENTRY, { data: personData })),
			entryItem(entry(17, "pi.assistant", { model: [assistantMessage([{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }])] })),
		];
		const blocks = buildBlocks(viewOf(items), session(), false);
		const work = blocks.find((block) => block.kind === "work") as Extract<Block, { kind: "work" }>;
		expect(work.live).toBe(false);
	});

	it("two texts in one turn read as one", () => {
		const blocks = buildBlocks(viewOf([entryItem(entry(18, "pi.assistant", { model: [assistantMessage([{ type: "text", text: "Part one." }, { type: "text", text: "Part two." }])] }))]), undefined, false);
		expect(blocks.map((block) => block.kind)).toEqual(["text", "text", "speak"]);
		expect(blocks[2]).toMatchObject({ kind: "speak", text: "Part one.\n\nPart two." });
	});

	it("work between texts does not split the reading", () => {
		const items = [
			entryItem(entry(19, "pi.assistant", { model: [assistantMessage([{ type: "text", text: "First." }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }, { type: "text", text: "Second." }])] })),
		];
		const blocks = buildBlocks(viewOf(items), undefined, false);
		expect(blocks.map((block) => block.kind)).toEqual(["text", "work", "text", "speak"]);
		expect(blocks[3]).toMatchObject({ kind: "speak", text: "First.\n\nSecond." });
	});

	it("entries without times inherit the last one", () => {
		const items = [entryItem(entry(20, "pi.user", { model: [userMessage("Hi")] })), entryItem(entry(21, MESSAGE_ENTRY, { data: personData }))];
		const blocks = buildBlocks(viewOf(items), undefined, false);
		expect(blocks[1]).toMatchObject({ kind: "person", key: "21", at: TS });
	});
});

describe("turnStart", () => {
	const person = { kind: "person", key: "p", data: personData } as Block;
	const text = { kind: "text", key: "t", text: "x", streaming: false } as Block;

	it("finds the last turn start", () => {
		expect(turnStart([person, text, person, text])).toBe(2);
	});

	it("is -1 when no turn start is loaded", () => {
		expect(turnStart([text])).toBe(-1);
		expect(turnStart([])).toBe(-1);
	});
});
