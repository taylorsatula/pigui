// From Durable entries to what the session view shows: the person's messages, the agent's prose, its thinking, its
// tool activity grouped into one collapsed line per stretch of work, and cards in place of the tool calls behind them.
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { EntryRecord, LiveState, TranscriptView } from "@earendil-works/pi-durable";
import {
	type CardAnswer,
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

export const CARD_TOOLS = new Set(["ask_single_choice", "ask_multiple_choice", "submit_plan", "file_report"]);

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
	| { kind: "thinking"; key: string; text: string; streaming: boolean }
	| { kind: "activity"; key: string; calls: CallView[] }
	| { kind: "questions"; key: string; card: QuestionCard; answer?: CardAnswer; pending: boolean }
	| { kind: "plan"; key: string; card: PlanCard; answer?: CardAnswer; pending: boolean }
	| { kind: "report"; key: string; report: Report; latest: boolean }
	| { kind: "compaction"; key: string; summary: string }
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

export function buildBlocks(view: TranscriptView | undefined, session: SessionDoc | undefined): Block[] {
	if (view === undefined) return [];
	const live = view.docs["pi.live"] as LiveState | undefined;
	const results = new Map<string, { message: ToolResultMessage; details: Details | undefined }>();
	for (const item of view.items) {
		if (item.kind !== "entry") continue;
		const message = item.entry.model?.[0];
		if (message?.role === "toolResult") results.set(message.toolCallId, { message, details: message.details as Details | undefined });
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
				blocks.push({ kind: "compaction", key, summary: userText(entry).replace(/^[\s\S]*?<summary>\n?/, "").replace(/\n?<\/summary>\s*$/, "") });
				break;
			case "pi.reset":
				flush();
				blocks.push({ kind: "notice", key, tone: "info", text: "The context was reset." });
				break;
		}
	}
	const partial = live?.generation?.message as AssistantMessage | undefined;
	if (partial !== undefined) assistant("streaming", partial, true);
	return blocks;
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
