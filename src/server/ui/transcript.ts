// Projects Durable entries and live state into renderable transcript blocks on the server. The browser never imports
// pi-durable or runs this projection.
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ConversationView, EntryRecord, InboxItem, InboxState, LiveState, TranscriptItem } from "@earendil-works/pi-durable";
import {
	AGENT_RESULT_ENTRY,
	AGENT_STOPPED_ENTRY,
	type AgentResultData,
	type AgentStoppedData,
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
} from "../../shared/session.ts";

export type Gap = Extract<TranscriptItem, { kind: "gap" }>;

const CARD_TOOLS = new Set(["ask_single_choice", "ask_multiple_choice", "submit_plan", "file_report"]);

export type WorkItem = { kind: "thinking"; key: string; text: string; streaming: boolean } | { kind: "call"; key: string; call: CallView };

export type CallView = {
	id: string;
	name: string;
	args: Record<string, unknown>;
	status: "running" | "waiting" | "done" | "failed";
	output?: string;
	diff?: string;
};

export type Block = (
	| { kind: "earlier"; key: string; before: number }
	| { kind: "person"; key: string; data: MessageEntryData }
	| { kind: "queued"; key: string; data: MessageEntryData; submission: number }
	| { kind: "nudge"; key: string; data: NudgeEntryData }
	| { kind: "agent-result"; key: string; data: AgentResultData }
	| { kind: "agent-stopped"; key: string; data: AgentStoppedData }
	| { kind: "text"; key: string; text: string; streaming: boolean }
	| { kind: "speak"; key: string; text: string }
	| { kind: "work"; key: string; items: WorkItem[]; live: boolean }
	| { kind: "questions"; key: string; card: QuestionCard; answer?: CardAnswer; pending: boolean }
	| { kind: "plan"; key: string; card: PlanCard; answer?: CardAnswer; pending: boolean }
	| { kind: "report"; key: string; report: Report; latest: boolean }
	| { kind: "compaction"; key: string; summary: string; retained?: number }
	| { kind: "notice"; key: string; text: string; tone: "info" | "error" }
) & {
	at?: number;
};

export type TranscriptSource = {
	items: readonly TranscriptItem[];
	docs: ConversationView["docs"];
};

const HARNESS = /<harness>[\s\S]*?<\/harness>/g;
const RECEIVED = /\n\s*Received arguments:/;
const DIAGNOSTICS_MAX = 300;
const NOTE_MAX = 140;

function boundDiagnostics(diagnostics: string): string {
	const cut = RECEIVED.exec(diagnostics);
	const kept = (cut === null ? diagnostics : diagnostics.slice(0, cut.index)).trim();
	return kept.length <= DIAGNOSTICS_MAX ? kept : `${kept.slice(0, DIAGNOSTICS_MAX).trimEnd()}…`;
}

function failureNote(split: { text?: string; diagnostics?: string }, lead: string): string {
	const source = split.diagnostics ?? split.text ?? "";
	const lines = source
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	const bullet = lines.find((line) => line.startsWith("- ")) ?? lines.find((line) => !/^Validation failed/.test(line) && !line.startsWith("[")) ?? lines[0];
	const reason = (bullet ?? "").replace(/^-\s*/, "").replace(/^\[error\]\s*/, "");
	if (reason === "") return `${lead}.`;
	const capped = reason.length <= NOTE_MAX ? reason : `${reason.slice(0, NOTE_MAX).trimEnd()}…`;
	return `${lead}: ${capped}`;
}

function stripHarness(text: string): string {
	return text.replace(HARNESS, "").replace(/\n{3,}/g, "\n\n");
}

function splitResult(message: ToolResultMessage): { text?: string; diagnostics?: string } {
	const diagnostics: string[] = [];
	const text = message.content
		.flatMap((block) => {
			if (block.type !== "text") return ["[image]"];
			const kept = block.text
				.replace(HARNESS, (match) => {
					const inner = match.slice(match.indexOf(">") + 1, match.lastIndexOf("<")).trim();
					if (inner !== "") diagnostics.push(inner);
					return "";
				})
				.replace(/\n{3,}/g, "\n\n")
				.trim();
			return kept === "" ? [] : [kept];
		})
		.join("\n");
	const joined = diagnostics.join("\n");
	const shown = text === "" ? undefined : text;
	const kept = shown === undefined ? {} : { text: shown };
	return joined === "" ? kept : { ...kept, diagnostics: boundDiagnostics(joined) };
}

function userText(entry: EntryRecord): string {
	const message = entry.model?.[0];
	if (message?.role !== "user") return "";
	return typeof message.content === "string" ? message.content : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function entryTime(entry: EntryRecord): number | undefined {
	return entry.model?.[0]?.timestamp;
}

type Details = { card?: QuestionCard | PlanCard; answer?: CardAnswer; report?: StoredReport; diff?: string; patch?: string };

const NOTES: Record<CompactionNoteData["note"], string> = {
	"handoff-request": "Asked Pi for a handoff note before compacting the context",
	resume: "Asked Pi to resume after compacting the context",
};

function queuedPersonInputs(docs: ConversationView["docs"]): { submission: number; data: MessageEntryData }[] {
	const items = ((docs["pi.inbox"] as InboxState | undefined)?.items ?? []) as InboxItem[];
	const out: { submission: number; data: MessageEntryData }[] = [];
	for (const item of items) {
		if (item.mode !== "steer") continue;
		const entry = item.entry;
		if (entry?.kind !== MESSAGE_ENTRY) continue;
		const data = entry.data as MessageEntryData | undefined;
		if (data === undefined || typeof data.text !== "string" || !Array.isArray(data.references) || !Array.isArray(data.attachments)) continue;
		out.push({ submission: Number(item.id), data });
	}
	return out;
}

function compactionBlock(key: string, entry: EntryRecord): Block {
	if (entry.kind === CHECKPOINT_ENTRY) return { kind: "compaction", key, summary: userText(entry), retained: (entry.data as CheckpointEntryData).retained };
	return { kind: "compaction", key, summary: userText(entry).replace(/^[\s\S]*?<summary>\n?/, "").replace(/\n?<\/summary>\s*$/, "") };
}

/** Build a TranscriptSource from raw entries (used for SSR initial render and paginated earlier/gap loads). */
export function sourceFromEntries(entries: readonly EntryRecord[], docs: ConversationView["docs"], hasEarlier: boolean): TranscriptSource {
	const items: TranscriptItem[] = [];
	if (hasEarlier) items.push({ kind: "earlier" });
	for (const entry of entries) items.push({ kind: "entry", entry });
	return { items, docs };
}

/** Project entries and live docs into renderable blocks. */
export function buildBlocks(source: TranscriptSource | undefined, session: SessionDoc | undefined, running: boolean): Block[] {
	if (source === undefined) return [];
	const live = source.docs["pi.live"] as LiveState | undefined;
	const results = new Map<string, { message: ToolResultMessage; details: Details | undefined }>();
	let firstEntryId: number | undefined;
	for (const item of source.items) {
		if (item.kind !== "entry") continue;
		if (firstEntryId === undefined) firstEntryId = Number(item.entry.id);
		const message = item.entry.model?.[0];
		if (message?.role === "toolResult") results.set(message.toolCallId, { message, details: message.details as Details | undefined });
	}

	const markers = new Map<number, EntryRecord>();
	const summarized = new Set<number>();
	for (const item of source.items) {
		if (item.kind !== "entry") continue;
		const cut = item.entry.kind === CHECKPOINT_ENTRY ? (item.entry.data as CheckpointEntryData).durableCut : undefined;
		if (cut !== undefined) markers.set(cut, item.entry);
		if (item.entry.kind === "pi.compaction" && item.entry.head !== undefined) summarized.add(item.entry.head);
	}
	const slots = new Map((live?.tools ?? []).map((slot) => [slot.callId, slot]));
	const lastReport = [...results.values()].filter((result) => result.message.toolName === "file_report" && !result.message.isError).at(-1);

	const blocks: Block[] = [];
	let now: number | undefined;
	const add = (block: Block) => {
		if (now !== undefined) (block as { at?: number }).at = now;
		blocks.push(block);
	};
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
			const split = result !== undefined ? splitResult(result.message) : undefined;
			const output = split?.text ?? (slot?.output === undefined ? undefined : stripHarness(slot.output));
			const call: CallView = { id: block.id, name: block.name, args: block.arguments, status };
			if (output !== undefined) call.output = output;
			if (result?.details?.diff !== undefined) call.diff = result.details.diff;
			addWork({ kind: "call", key: blockKey, call });
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

	for (const item of source.items) {
		if (item.kind === "earlier") {
			if (firstEntryId !== undefined) add({ kind: "earlier", key: "earlier", before: firstEntryId });
			continue;
		}
		if (item.kind === "gap") continue;
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
			case AGENT_RESULT_ENTRY:
				flush();
				add({ kind: "agent-result", key, data: entry.data as AgentResultData });
				break;
			case AGENT_STOPPED_ENTRY:
				flush();
				add({ kind: "agent-stopped", key, data: entry.data as AgentStoppedData });
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
	flush();
	for (const item of queuedPersonInputs(source.docs)) blocks.push({ kind: "queued", key: `queued:${item.submission}`, data: item.data, submission: item.submission });
	return withSpeakers(withLiveWork(blocks, running && session?.card === undefined), running);
}

const TURN_STARTS = new Set<Block["kind"]>(["person", "nudge", "questions", "plan", "report", "agent-result"]);

export function turnStart(blocks: readonly Block[]): number {
	return blocks.findLastIndex((block) => TURN_STARTS.has(block.kind));
}

function withLiveWork(blocks: readonly Block[], working: boolean): Block[] {
	const start = turnStart(blocks);
	return blocks.map((block, index) => (block.kind === "work" && working && index > start && !block.live ? { ...block, live: true } : block));
}

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
		if (block.kind !== "work" && block.kind !== "queued") finish();
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
		else if (result?.message.isError === true) add({ kind: "notice", key, tone: "info", text: failureNote(splitResult(result.message), "The report was not accepted") });
		return;
	}
	const pending = session?.card?.id === callId ? session.card : undefined;
	const card = (details?.card ?? pending) as QuestionCard | PlanCard | undefined;
	if (card === undefined) {
		if (result?.message.isError === true) {
			const refused = name === "submit_plan" ? "The plan was not submitted" : "The questions were not sent";
			add({ kind: "notice", key, tone: "info", text: failureNote(splitResult(result.message), refused) });
		}
		return;
	}
	const answer = details?.answer;
	if (card.kind === "questions") {
		add(answer === undefined ? { kind: "questions", key, card, pending: pending !== undefined } : { kind: "questions", key, card, answer, pending: false });
	} else {
		add(answer === undefined ? { kind: "plan", key, card, pending: pending !== undefined } : { kind: "plan", key, card, answer, pending: false });
	}
}
