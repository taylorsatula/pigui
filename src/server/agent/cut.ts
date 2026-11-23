// Where a checkpoint cuts the context, and what it condenses after the cut. The summarizer recommends both; code checks
// every choice against the context it was shown, so a bad answer can cost precision but never correctness: the context
// never starts mid-call, never keeps more than the cap, and never loses a message from the person or the handoff note.
import type { Message } from "@earendil-works/pi-ai";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { ContextEdit, ContextView, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { WRITE_HANDOFF } from "./handoff.ts";
import { RECALL } from "./recall.ts";

/** One active entry with what it contributes to the model's context. */
export type Span = {
	readonly entry: EntryRecord;
	readonly messages: readonly Message[];
	/** Whether the context may start here. */
	readonly cut: boolean;
	readonly tokens: number;
};

/** Index range of allowed cuts, both ends included, and the cut used when the summarizer's cannot be. */
export type Bounds = { readonly earliest: number; readonly latest: number; readonly fallback: number };

type CutChoice = {
	readonly index: number;
	readonly selection: "model" | "capped" | "fallback";
	/** Why the summarizer's cut was not used, for the agent to read. */
	readonly note?: string;
};

export type CondenseRequest = { readonly entry: number; readonly note: string };

const tokensOf = (messages: readonly Message[]): number => messages.reduce((total, message) => total + estimateMessageTokens(message), 0);

export function spansOf(view: ContextView): Span[] {
	return view.entries.map((entry, index) => {
		const messages = view.contributions[index] ?? [];
		// The head marker is the previous checkpoint: never a cut, as in Durable.
		const cut = (view.head === undefined || index > 0) && isCutCandidate(view.contributions, index);
		return { entry, messages, cut, tokens: tokensOf(messages) };
	});
}

/**
 * Durable's rule for where a kept range may start (`isCandidate` in pi-durable's compaction, which it does not export):
 * an entry whose contribution starts with an assistant or user message, never a tool result, and never a user entry
 * that a result of the preceding assistant's calls still follows.
 */
function isCutCandidate(contributions: readonly (readonly Message[])[], index: number): boolean {
	const first = contributions[index]?.[0];
	if (first?.role === "assistant") return true;
	if (first?.role !== "user") return false;
	let calls = new Set<string>();
	for (let before = index - 1; before >= 0; before--) {
		const assistant = contributions[before]?.findLast((message) => message.role === "assistant");
		if (assistant === undefined) continue;
		calls = new Set(assistant.content.flatMap((content) => (content.type === "toolCall" ? [content.id] : [])));
		break;
	}
	if (calls.size === 0) return true;
	for (let after = index; after < contributions.length; after++) {
		for (const [position, message] of (contributions[after] ?? []).entries()) {
			if (message.role === "assistant" && (after > index || position > 0)) return true;
			if (message.role === "toolResult" && calls.has(message.toolCallId)) return false;
		}
	}
	return true;
}

/** Whether anything before `index` would be compacted: some entry other than the previous checkpoint contributes. */
function compactsSomething(spans: readonly Span[], index: number, hasHead: boolean): boolean {
	return spans.slice(hasHead ? 1 : 0, index).some((span) => span.messages.length > 0);
}

/** For a compaction Durable runs: its own cut is the earliest allowed and its fallback; any later cut may be chosen. */
export function durableBounds(spans: readonly Span[], firstKept: EntryId): Bounds | undefined {
	const earliest = spans.findIndex((span) => span.entry.id === firstKept);
	return earliest < 1 ? undefined : { earliest, latest: spans.length - 1, fallback: earliest };
}

/**
 * For a compaction pigui runs: any cut that keeps at most `cap` tokens, and, given `keep`, keeps that entry (the
 * handoff note's call, so the call and its result stay where they are). The earliest such cut, the one that keeps the
 * most, is the fallback. Undefined when nothing would be compacted.
 */
export function cappedBounds(spans: readonly Span[], cap: number, hasHead: boolean, keep?: number): Bounds | undefined {
	const latest = keep === undefined ? spans.findLastIndex((span) => span.cut) : spans.findIndex((span) => span.entry.id === keep && span.cut);
	if (latest < 0) return undefined;
	let earliest = latest;
	let kept = retainedTokens(spans, latest);
	for (let index = latest - 1; index >= 0; index--) {
		kept += spans[index]?.tokens ?? 0;
		if (kept > cap) break;
		if (spans[index]?.cut === true) earliest = index;
	}
	return compactsSomething(spans, earliest, hasHead) ? { earliest, latest, fallback: earliest } : undefined;
}

/** Estimated tokens the context keeps from `index`, counting condensed results by their replacements. */
function retainedTokens(spans: readonly Span[], index: number, replaced: ReadonlyMap<EntryId, readonly Message[]> = new Map()): number {
	let total = 0;
	for (const span of spans.slice(index)) {
		const replacement = replaced.get(span.entry.id);
		total += replacement === undefined ? span.tokens : tokensOf(replacement);
	}
	return total;
}

/** Model messages kept from `index`, without system messages, which the next request replaces with a fresh baseline. */
export function retainedMessages(spans: readonly Span[], index: number): number {
	return spans.slice(index).reduce((count, span) => count + span.messages.filter((message) => message.role !== "system").length, 0);
}

/**
 * The cut: the summarizer's when it is one of the valid cuts it was shown (`presented`) and keeps at most `cap`; the
 * nearest later valid cut within the cap when it keeps more; otherwise the bounds' fallback.
 */
export function chooseCut(
	spans: readonly Span[],
	bounds: Bounds,
	presented: ReadonlySet<EntryId>,
	recommended: number | undefined,
	cap: number,
	replaced: ReadonlyMap<EntryId, readonly Message[]> = new Map(),
): CutChoice {
	const at = (index: number) => spans[index]?.entry.id;
	const fallback = (why: string): CutChoice => ({ index: bounds.fallback, selection: "fallback", note: `${why} The context continues from entry ${at(bounds.fallback)}.` });
	if (recommended === undefined) return fallback("The summarizer named no cut.");
	const index = spans.findIndex((span) => span.entry.id === recommended);
	const allowed = (candidate: number) => {
		const span = spans[candidate];
		return candidate >= bounds.earliest && candidate <= bounds.latest && span !== undefined && span.cut && presented.has(span.entry.id);
	};
	if (index < 0 || !allowed(index)) return fallback(`The summarizer's cut, entry ${recommended}, is not one of the valid cuts it was shown.`);
	const kept = retainedTokens(spans, index, replaced);
	if (kept <= cap) return { index, selection: "model" };
	for (let later = index + 1; later <= bounds.latest; later++) {
		if (allowed(later) && retainedTokens(spans, later, replaced) <= cap) {
			return {
				index: later,
				selection: "capped",
				note: `The summarizer's cut, entry ${recommended}, would keep about ${kept} tokens, over the cap of ${cap}; the context continues from entry ${at(later)}, the nearest valid cut within it.`,
			};
		}
	}
	return fallback(`The summarizer's cut, entry ${recommended}, would keep about ${kept} tokens, over the cap of ${cap}, and no later valid cut is within it.`);
}

/**
 * Replacements for the tool results the summarizer asked to condense. Only a tool result is replaced, never a message
 * from the person or the handoff note's result; the replacement keeps its call ID and name and changes only its content,
 * so the call still pairs with it. Stored entries are unchanged: recall reads the original.
 */
export function condensed(spans: readonly Span[], requests: readonly CondenseRequest[]): Map<EntryId, readonly Message[]> {
	const replaced = new Map<EntryId, readonly Message[]>();
	for (const request of requests) {
		const span = spans.find((each) => each.entry.id === request.entry);
		const message = span?.messages.length === 1 ? span.messages[0] : undefined;
		if (span === undefined || message?.role !== "toolResult" || message.toolName === WRITE_HANDOFF || request.note.trim() === "") continue;
		const text = `[Condensed at compaction: ${request.note.trim()} The full result is entry ${span.entry.id}; ${RECALL} reads it.]`;
		replaced.set(span.entry.id, [{ ...message, content: [{ type: "text", text }] }]);
	}
	return replaced;
}

/** The context edits for the replacements at or after the cut; the rest are left verbatim, with a note saying so. */
export function condenseEdits(spans: readonly Span[], cut: number, replaced: ReadonlyMap<EntryId, readonly Message[]>, requests: readonly CondenseRequest[]): { edits: ContextEdit[]; note?: string } {
	const keptIds = new Set(spans.slice(cut).map((span) => span.entry.id));
	const edits: ContextEdit[] = [];
	for (const [target, messages] of replaced) if (keptIds.has(target)) edits.push({ target, action: "replace", messages });
	const refused = [...new Set(requests.map((request) => request.entry))].filter((entry) => !edits.some((edit) => edit.target === entry));
	if (refused.length === 0) return { edits };
	return { edits, note: `Kept verbatim instead of condensed (not a kept tool result pigui may condense): entr${refused.length === 1 ? "y" : "ies"} ${refused.join(", ")}.` };
}
