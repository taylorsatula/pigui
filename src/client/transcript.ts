// From Durable entries to what the session view shows: the person's messages, the agent's prose, its thinking, its
// tool activity grouped into one collapsed line per stretch of work, cards in place of the tool calls behind them, and a
// speaker under each finished reply.
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
	type SessionDoc,
} from "../shared/session.ts";
import type { Gap } from "./live.ts";

const CARD_TOOLS = new Set(["ask_single_choice", "ask_multiple_choice", "submit_plan", "file_report"]);

export type CallView = {
	id: string;
	name: string;
	args: Record<string, unknown>;
	status: "running" | "waiting" | "done" | "failed";
	output?: string;
};

export type Block =
	| { kind: "earlier"; key: string }
	| { kind: "gap"; key: string; gap: Gap }
	| { kind: "person"; key: string; data: MessageEntryData }
	| { kind: "nudge"; key: string; data: NudgeEntryData }
	| { kind: "text"; key: string; text: string; streaming: boolean }
	/** After a finished reply: its text, to read aloud. */
	| { kind: "speak"; key: string; text: string }
	| { kind: "thinking"; key: string; text: string; streaming: boolean }
	| { kind: "activity"; key: string; calls: CallView[] }
	| { kind: "questions"; key: string; card: QuestionCard; answer?: CardAnswer; pending: boolean }
	| { kind: "plan"; key: string; card: PlanCard; answer?: CardAnswer; pending: boolean }
	| { kind: "report"; key: string; report: Report; latest: boolean }
	/** `retained`: messages kept verbatim after it, when picloud placed the checkpoint. */
	| { kind: "compaction"; key: string; summary: string; retained?: number }
	| { kind: "notice"; key: string; text: string; tone: "info" | "error" };

function resultText(message: ToolResultMessage): string {
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : ["[image]"])).join("\n");
}

function userText(entry: EntryRecord): string {
	const message = entry.model?.[0];
	if (message?.role !== "user") return "";
	return typeof message.content === "string" ? message.content : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

type Details = { card?: QuestionCard | PlanCard; answer?: CardAnswer; report?: Report };

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
	let activity: CallView[] | undefined;
	const flush = () => {
		activity = undefined;
	};
	const addCall = (key: string, call: CallView) => {
		if (activity === undefined) {
			activity = [];
			blocks.push({ kind: "activity", key, calls: activity });
		}
		activity.push(call);
	};

	const assistant = (key: string, message: AssistantMessage, streaming: boolean) => {
		message.content.forEach((block, index) => {
			const blockKey = `${key}:${index}`;
			if (block.type === "thinking") {
				if (block.thinking.trim() !== "") blocks.push({ kind: "thinking", key: blockKey, text: block.thinking, streaming });
				return;
			}
			if (block.type === "text") {
				if (block.text.trim() === "") return;
				flush();
				blocks.push({ kind: "text", key: blockKey, text: block.text, streaming });
				return;
			}
			if (streaming) return;
			const result = results.get(block.id);
			if (CARD_TOOLS.has(block.name)) {
				flush();
				cardBlock(blocks, blockKey, block.id, block.name, result, session, lastReport);
				return;
			}
			const slot = slots.get(block.id);
			const status: CallView["status"] =
				result !== undefined ? (result.message.isError ? "failed" : "done") : slot?.status === "sleeping" || slot?.status === "waiting" ? "waiting" : "running";
			const output = result !== undefined ? resultText(result.message) : slot?.output;
			addCall(blockKey, output === undefined ? { id: block.id, name: block.name, args: block.arguments, status } : { id: block.id, name: block.name, args: block.arguments, status, output });
		});
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			flush();
			blocks.push({
				kind: "notice",
				key: `${key}:stop`,
				tone: message.stopReason === "error" ? "error" : "info",
				text: message.stopReason === "error" ? `The model returned an error: ${message.errorMessage ?? "unknown"}` : "Stopped.",
			});
		}
	};

	for (const item of view.items) {
		if (item.kind === "earlier") {
			blocks.push({ kind: "earlier", key: "earlier" });
			continue;
		}
		if (item.kind === "gap") {
			flush();
			blocks.push({ kind: "gap", key: `gap:${item.after}`, gap: item });
			continue;
		}
		const entry = item.entry;
		const key = String(entry.id);
		switch (entry.kind) {
			case MESSAGE_ENTRY:
				flush();
				blocks.push({ kind: "person", key, data: entry.data as MessageEntryData });
				break;
			case NUDGE_ENTRY:
				flush();
				blocks.push({ kind: "nudge", key, data: entry.data as NudgeEntryData });
				break;
			case "pi.user":
				flush();
				blocks.push({ kind: "person", key, data: { text: userText(entry), references: [], attachments: [] } });
				break;
			case "pi.assistant": {
				const message = entry.model?.[0];
				if (message?.role === "assistant") assistant(key, message, false);
				break;
			}
			case "pi.compaction":
				flush();
				blocks.push(compactionBlock(key, (entry.head === undefined ? undefined : markers.get(entry.head)) ?? entry));
				break;
			case CHECKPOINT_ENTRY: {
				const cut = (entry.data as CheckpointEntryData).durableCut;
				if (cut !== undefined && summarized.has(cut)) break;
				flush();
				blocks.push(compactionBlock(key, entry));
				break;
			}
			case COMPACTION_NOTE_ENTRY:
				flush();
				blocks.push({ kind: "notice", key, tone: "info", text: NOTES[(entry.data as CompactionNoteData).note] });
				break;
			case "pi.reset":
				flush();
				blocks.push({ kind: "notice", key, tone: "info", text: "The context was reset." });
				break;
		}
	}
	const partial = live?.generation?.message as AssistantMessage | undefined;
	if (partial !== undefined) assistant("streaming", partial, true);
	return withSpeakers(blocks, running);
}

/**
 * A speaker after the last text of each finished reply. A reply is the agent's text in one turn, read as one, with the
 * thinking and tool activity between its parts left out. Anything else ends the turn, and the newest ends with the run.
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
		if (block.kind !== "thinking" && block.kind !== "activity") finish();
		result.push(block);
	}
	if (!running) finish();
	return result;
}

function cardBlock(
	blocks: Block[],
	key: string,
	callId: string,
	name: string,
	result: { message: ToolResultMessage; details: Details | undefined } | undefined,
	session: SessionDoc | undefined,
	lastReport: { message: ToolResultMessage } | undefined,
): void {
	const details = result?.details;
	if (name === "file_report") {
		if (details?.report !== undefined) blocks.push({ kind: "report", key, report: details.report, latest: result?.message === lastReport?.message });
		else if (result?.message.isError === true) blocks.push({ kind: "notice", key, tone: "info", text: resultText(result.message) });
		return;
	}
	const pending = session?.card?.id === callId ? session.card : undefined;
	const card = (details?.card ?? pending) as QuestionCard | PlanCard | undefined;
	if (card === undefined) return;
	const answer = details?.answer;
	if (card.kind === "questions") {
		blocks.push(answer === undefined ? { kind: "questions", key, card, pending: pending !== undefined } : { kind: "questions", key, card, answer, pending: false });
	} else {
		blocks.push(answer === undefined ? { kind: "plan", key, card, pending: pending !== undefined } : { kind: "plan", key, card, answer, pending: false });
	}
}
