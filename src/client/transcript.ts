// From Durable entries to what the session view shows: the person's messages, the agent's prose, each stretch of work
// between its prose (its thinking and tool calls, in the order they happened), cards in place of the tool calls behind
// them, and a speaker under each finished reply.
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { EntryRecord, LiveState, TranscriptView } from "@earendil-works/pi-durable";
import {
	type CardAnswer,
	CHECKPOINT_ENTRY,
	type CheckpointEntryData,
	COMPACTION_NOTE_ENTRY,
	type CompactionNoteData,
	MESSAGE_ENTRY,
	type MessageEntryData,
	NUDGE_ENTRY,
	type NudgeEntryData,
	type PlanCard,
	type QuestionCard,
	type Report,
	reportOf,
	type SessionDoc,
	type StoredReport,
} from "../shared/session.ts";
import type { Gap } from "./live.ts";

const CARD_TOOLS = new Set(["ask_single_choice", "ask_multiple_choice", "submit_plan", "file_report"]);

/** What a stretch of work holds, in order: the agent's thinking and its tool calls. */
export type WorkItem = { kind: "thinking"; key: string; text: string; streaming: boolean } | { kind: "call"; key: string; call: CallView };

export type CallView = {
	id: string;
	name: string;
	args: Record<string, unknown>;
	status: "running" | "waiting" | "done" | "failed";
	output?: string;
};

export type Block = (
	| { kind: "earlier"; key: string }
	| { kind: "gap"; key: string; gap: Gap }
	| { kind: "person"; key: string; data: MessageEntryData }
	| { kind: "nudge"; key: string; data: NudgeEntryData }
	| { kind: "text"; key: string; text: string; streaming: boolean }
	/** After a finished reply: its text, to read aloud. */
	| { kind: "speak"; key: string; text: string }
	/** A stretch of work between two pieces of prose. `live` while the turn it belongs to is still running. */
	| { kind: "work"; key: string; items: WorkItem[]; live: boolean }
	| { kind: "questions"; key: string; card: QuestionCard; answer?: CardAnswer; pending: boolean }
	| { kind: "plan"; key: string; card: PlanCard; answer?: CardAnswer; pending: boolean }
	| { kind: "report"; key: string; report: Report; latest: boolean }
	/** `retained`: messages kept verbatim after it, when picloud placed the checkpoint. */
	| { kind: "compaction"; key: string; summary: string; retained?: number }
	| { kind: "notice"; key: string; text: string; tone: "info" | "error" }
) & {
	/** When it was written, to date the transcript by: its message's time, or the latest time before it. */
	at?: number;
};

function resultText(message: ToolResultMessage): string {
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : ["[image]"])).join("\n");
}

function userText(entry: EntryRecord): string {
	const message = entry.model?.[0];
	if (message?.role !== "user") return "";
	return typeof message.content === "string" ? message.content : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** The time on an entry's message; display and bookkeeping entries carry none. */
function entryTime(entry: EntryRecord): number | undefined {
	return entry.model?.[0]?.timestamp;
}

type Details = { card?: QuestionCard | PlanCard; answer?: CardAnswer; report?: StoredReport };

const NOTES: Record<CompactionNoteData["note"], string> = {
	"handoff-request": "Asked Pi for a handoff note before compacting the context",
	resume: "Asked Pi to resume after compacting the context",
};

/** A compaction row from picloud's checkpoint marker, or from Durable's summary, which wraps its text. */
function compactionBlock(key: string, entry: EntryRecord): Block {
	if (entry.kind === CHECKPOINT_ENTRY) return { kind: "compaction", key, summary: userText(entry), retained: (entry.data as CheckpointEntryData).retained };
	return { kind: "compaction", key, summary: userText(entry).replace(/^[\s\S]*?<summary>\n?/, "").replace(/\n?<\/summary>\s*$/, "") };
}

/** `running`: a run is under way, so the newest reply may not be finished even while nothing streams. */
export function buildBlocks(view: TranscriptView | undefined, session: SessionDoc | undefined, running: boolean): Block[] {
	if (view === undefined) return [];
	const live = view.docs["pi.live"] as LiveState | undefined;
	const results = new Map<string, { message: ToolResultMessage; details: Details | undefined }>();
	for (const item of view.items) {
		if (item.kind !== "entry") continue;
		const message = item.entry.model?.[0];
		if (message?.role === "toolResult") results.set(message.toolCallId, { message, details: message.details as Details | undefined });
	}
	// picloud's marker for a compaction Durable ran supersedes Durable's summary of it: one row for the two, where the
	// compaction happened, showing what the agent sees.
	const markers = new Map<number, EntryRecord>();
	const summarized = new Set<number>();
	for (const item of view.items) {
		if (item.kind !== "entry") continue;
		const cut = item.entry.kind === CHECKPOINT_ENTRY ? (item.entry.data as CheckpointEntryData).durableCut : undefined;
		if (cut !== undefined) markers.set(cut, item.entry);
		if (item.entry.kind === "pi.compaction" && item.entry.head !== undefined) summarized.add(item.entry.head);
	}
	const slots = new Map((live?.tools ?? []).map((slot) => [slot.callId, slot]));
	const lastReport = [...results.values()].filter((result) => result.message.toolName === "file_report" && !result.message.isError).at(-1);

	const blocks: Block[] = [];
	// Each block takes the latest time seen, so an entry without one is dated with the one before it.
	let now: number | undefined;
	const add = (block: Block) => {
		blocks.push(now === undefined ? block : { ...block, at: now });
	};
	// Thinking and calls gather into one stretch of work until the agent writes prose or something else interrupts.
	let work: WorkItem[] | undefined;
	const flush = () => {
		work = undefined;
	};
	const addWork = (item: WorkItem) => {
		if (work === undefined) {
			work = [];
			add({ kind: "work", key: item.key, items: work, live: false });
		}
		work.push(item);
	};

	const assistant = (key: string, message: AssistantMessage, streaming: boolean) => {
		now = message.timestamp;
		message.content.forEach((block, index) => {
			const blockKey = `${key}:${index}`;
			if (block.type === "thinking") {
				if (block.thinking.trim() !== "") addWork({ kind: "thinking", key: blockKey, text: block.thinking, streaming });
				return;
			}
			if (block.type === "text") {
				if (block.text.trim() === "") return;
				flush();
				add({ kind: "text", key: blockKey, text: block.text, streaming });
				return;
			}
			if (streaming) return;
			const result = results.get(block.id);
			if (CARD_TOOLS.has(block.name)) {
				flush();
				cardBlock(add, blockKey, block.id, block.name, result, session, lastReport);
				return;
			}
			const slot = slots.get(block.id);
			const status: CallView["status"] =
				result !== undefined ? (result.message.isError ? "failed" : "done") : slot?.status === "sleeping" || slot?.status === "waiting" ? "waiting" : "running";
			const output = result !== undefined ? resultText(result.message) : slot?.output;
			const call: CallView = { id: block.id, name: block.name, args: block.arguments, status };
			addWork({ kind: "call", key: blockKey, call: output === undefined ? call : { ...call, output } });
		});
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			flush();
			add({
				kind: "notice",
				key: `${key}:stop`,
				tone: message.stopReason === "error" ? "error" : "info",
				text: message.stopReason === "error" ? `The model returned an error: ${message.errorMessage ?? "unknown"}` : "Stopped.",
			});
		}
	};

	for (const item of view.items) {
		if (item.kind === "earlier") {
			add({ kind: "earlier", key: "earlier" });
			continue;
		}
		if (item.kind === "gap") {
			flush();
			add({ kind: "gap", key: `gap:${item.after}`, gap: item });
			continue;
		}
		const entry = item.entry;
		const key = String(entry.id);
		now = entryTime(entry) ?? now;
		switch (entry.kind) {
			case MESSAGE_ENTRY:
				flush();
				add({ kind: "person", key, data: entry.data as MessageEntryData });
				break;
			case NUDGE_ENTRY:
				flush();
				add({ kind: "nudge", key, data: entry.data as NudgeEntryData });
				break;
			case "pi.user":
				flush();
				add({ kind: "person", key, data: { text: userText(entry), references: [], attachments: [] } });
				break;
			case "pi.assistant": {
				const message = entry.model?.[0];
				if (message?.role === "assistant") assistant(key, message, false);
				break;
			}
			case "pi.compaction":
				flush();
				add(compactionBlock(key, (entry.head === undefined ? undefined : markers.get(entry.head)) ?? entry));
				break;
			case CHECKPOINT_ENTRY: {
				const cut = (entry.data as CheckpointEntryData).durableCut;
				if (cut !== undefined && summarized.has(cut)) break;
				flush();
				add(compactionBlock(key, entry));
				break;
			}
			case COMPACTION_NOTE_ENTRY:
				flush();
				add({ kind: "notice", key, tone: "info", text: NOTES[(entry.data as CompactionNoteData).note] });
				break;
			case "pi.reset":
				flush();
				add({ kind: "notice", key, tone: "info", text: "The context was reset." });
				break;
		}
	}
	const partial = live?.generation?.message as AssistantMessage | undefined;
	if (partial !== undefined) assistant("streaming", partial, true);
	return withSpeakers(withLiveWork(blocks, running && session?.card === undefined), running);
}

/** What starts a turn of work: the person writing, an automatic continuation, or a card they answered. */
const TURN_STARTS = new Set<Block["kind"]>(["person", "nudge", "questions", "plan", "report"]);

/**
 * The work of the turn under way stays open to watch: everything since the turn started, while the agent is working
 * rather than waiting for the person. Once the turn ends, its work folds away.
 */
function withLiveWork(blocks: readonly Block[], working: boolean): Block[] {
	const turnStart = blocks.findLastIndex((block) => TURN_STARTS.has(block.kind));
	return blocks.map((block, index) => (block.kind === "work" && working && index > turnStart ? { ...block, live: true } : block));
}

/**
 * A speaker after the last text of each finished reply. A reply is the agent's text in one turn, read as one, with the
 * work between its parts left out. Anything else ends the turn, and the newest ends with the run.
 */
function withSpeakers(blocks: readonly Block[], running: boolean): Block[] {
	const result: Block[] = [];
	let texts: Extract<Block, { kind: "text" }>[] = [];
	let after = 0;
	const finish = () => {
		const first = texts[0];
		if (first !== undefined && !texts.some((text) => text.streaming)) {
			result.splice(after, 0, { kind: "speak", key: `${first.key}:speak`, text: texts.map((text) => text.text).join("\n\n") });
		}
		texts = [];
	};
	for (const block of blocks) {
		if (block.kind === "text") {
			texts.push(block);
			result.push(block);
			after = result.length;
			continue;
		}
		if (block.kind !== "work") finish();
		result.push(block);
	}
	if (!running) finish();
	return result;
}

function cardBlock(
	add: (block: Block) => void,
	key: string,
	callId: string,
	name: string,
	result: { message: ToolResultMessage; details: Details | undefined } | undefined,
	session: SessionDoc | undefined,
	lastReport: { message: ToolResultMessage } | undefined,
): void {
	const details = result?.details;
	if (name === "file_report") {
		if (details?.report !== undefined) add({ kind: "report", key, report: reportOf(details.report), latest: result?.message === lastReport?.message });
		else if (result?.message.isError === true) add({ kind: "notice", key, tone: "info", text: resultText(result.message) });
		return;
	}
	const pending = session?.card?.id === callId ? session.card : undefined;
	const card = (details?.card ?? pending) as QuestionCard | PlanCard | undefined;
	if (card === undefined) return;
	const answer = details?.answer;
	if (card.kind === "questions") {
		add(answer === undefined ? { kind: "questions", key, card, pending: pending !== undefined } : { kind: "questions", key, card, answer, pending: false });
	} else {
		add(answer === undefined ? { kind: "plan", key, card, pending: pending !== undefined } : { kind: "plan", key, card, answer, pending: false });
	}
}
