// Where the kept context starts after a compaction. The summarizer recommends a cut and may ask for tool results to
// be condensed; every recommendation is checked against the view it came from, so a bad answer costs precision, never
// correctness: the context never opens mid-call, never exceeds the cap, and never loses the person's words or the note.
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

export type CutChoice = {
	readonly index: number;
	readonly selection: "model" | "capped" | "fallback";
	/** Why the summarizer's cut was not used, for the agent to read. */
	readonly note?: string;
};

export type CondenseRequest = { readonly entry: number; readonly note: string };

const tokensOf = (messages: readonly Message[]): number => messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);

/**
 * Durable's rule for where a kept range may start (`isCandidate` in pi-durable's compaction, which it does not export):
 * an entry whose contribution starts with an assistant or user message, never a tool result, and never a user entry
 * that a result of the preceding assistant's calls still follows.
 */
function canBeginAt(contributions: readonly (readonly Message[])[], index: number): boolean {
	const first = contributions[index]?.[0];
	if (first?.role === "assistant") return true;
	if (first?.role !== "user") return false;
	// The calls whose results may still be owed to this entry: those of the nearest preceding assistant message.
	let owed = new Set<string>();
	for (let before = index - 1; before >= 0; before--) {
		const assistant = contributions[before]?.findLast((message) => message.role === "assistant");
		if (assistant === undefined) continue;
		owed = new Set(assistant.content.flatMap((content) => (content.type === "toolCall" ? [content.id] : [])));
		break;
	}
	if (owed.size === 0) return true;
	for (let after = index; after < contributions.length; after++) {
		for (const [position, message] of (contributions[after] ?? []).entries()) {
			if (message.role === "assistant" && (after > index || position > 0)) return true;
			if (message.role === "toolResult" && owed.has(message.toolCallId)) return false;
		}
	}
	return true;
}

export function spansOf(view: ContextView): Span[] {
	return view.entries.map((entry, index) => {
		const messages = view.contributions[index] ?? [];
		// The first entry, holding the previous checkpoint, is never a cut, as in Durable.
		const startable = (view.head === undefined || index > 0) && canBeginAt(view.contributions, index);
		return { entry, messages, cut: startable, tokens: tokensOf(messages) };
	});
}

/** Whether cutting at `index` compacts anything: some entry other than the previous checkpoint contributes. */
const compactsAnything = (spans: readonly Span[], index: number, hasHead: boolean): boolean =>
	spans.slice(hasHead ? 1 : 0, index).some((span) => span.messages.length > 0);

export function durableBounds(spans: readonly Span[], firstKept: EntryId): Bounds | undefined {
	const earliest = spans.findIndex((span) => span.entry.id === firstKept);
	return earliest < 1 ? undefined : { earliest, latest: spans.length - 1, fallback: earliest };
}

/**
 * pigui's own bounds: every cut from the earliest that fits the `cap` to the latest, plus `keep` (the handoff note's
 * call, whose result must stay beside it). The earliest of those, the one keeping the most, is the fallback.
 */
export function cappedBounds(spans: readonly Span[], cap: number, hasHead: boolean, keep?: number): Bounds | undefined {
	const latest = keep === undefined ? spans.findLastIndex((span) => span.cut) : spans.findIndex((span) => span.entry.id === keep && span.cut);
	if (latest === -1) return undefined;
	let earliest = latest;
	let running = retainedTokens(spans, latest);
	for (let index = latest - 1; index >= 0; index--) {
		const span = spans[index];
		if (span === undefined) continue;
		running += span.tokens;
		if (running > cap) break;
		if (span.cut) earliest = index;
	}
	return compactsAnything(spans, earliest, hasHead) ? { earliest, latest, fallback: earliest } : undefined;
}

/** Estimated tokens the context keeps from `index`; a condensed result counts by its replacement. */
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
	let count = 0;
	for (const span of spans.slice(index)) count += span.messages.filter((message) => message.role !== "system").length;
	return count;
}

/**
 * Whose cut the context opens at: the summarizer's when it is one of the cuts it was shown and fits the cap; the
 * nearest later one within the cap when it does not; otherwise the bounds' fallback.
 */
export function chooseCut(
	spans: readonly Span[],
	bounds: Bounds,
	presented: ReadonlySet<EntryId>,
	recommended: number | undefined,
	cap: number,
	replaced: ReadonlyMap<EntryId, readonly Message[]> = new Map(),
): CutChoice {
	const idAt = (index: number) => spans[index]?.entry.id;
	const fallback = (why: string): CutChoice => ({ index: bounds.fallback, selection: "fallback", note: `${why} The context continues from entry ${idAt(bounds.fallback)}.` });
	const allowed = (candidate: number): boolean => {
		const span = spans[candidate];
		return candidate >= bounds.earliest && candidate <= bounds.latest && span !== undefined && span.cut && presented.has(span.entry.id);
	};
	if (recommended === undefined) return fallback("The summarizer named no cut.");
	const index = spans.findIndex((span) => span.entry.id === recommended);
	if (index === -1 || !allowed(index)) return fallback(`The summarizer's cut, entry ${recommended}, is not one of the valid cuts it was shown.`);
	const kept = retainedTokens(spans, index, replaced);
	if (kept <= cap) return { index, selection: "model" };
	for (let later = index + 1; later <= bounds.latest; later++) {
		if (allowed(later) && retainedTokens(spans, later, replaced) <= cap) {
			return {
				index: later,
				selection: "capped",
				note: `The summarizer's cut, entry ${recommended}, would keep about ${kept} tokens, over the cap of ${cap}; the context continues from entry ${idAt(later)}, the nearest valid cut within it.`,
			};
		}
	}
	return fallback(`The summarizer's cut, entry ${recommended}, would keep about ${kept} tokens, over the cap of ${cap}, and no later valid cut is within it.`);
}

/**
 * Replacements for the tool results the summarizer asked to condense. Only a tool result is replaced, never a person's
 * message nor the handoff note's result; a condensed result keeps its call ID and name with only its content changed,
 * so the pair stays intact. Stored entries are unchanged: recall reads the original.
 */
export function condensed(spans: readonly Span[], requests: readonly CondenseRequest[]): Map<EntryId, readonly Message[]> {
	const replaced = new Map<EntryId, readonly Message[]>();
	for (const request of requests) {
		const note = request.note.trim();
		if (note === "") continue;
		const span = spans.find((each) => each.entry.id === request.entry);
		const message = span?.messages.length === 1 ? span.messages[0] : undefined;
		if (span === undefined || message?.role !== "toolResult" || message.toolName === WRITE_HANDOFF) continue;
		const text = `[Condensed at compaction: ${note} The full result is entry ${span.entry.id}; ${RECALL} reads it.]`;
		replaced.set(span.entry.id, [{ ...message, content: [{ type: "text", text }] }]);
	}
	return replaced;
}

/** The context edits for the replacements at or after the cut; the rest are left verbatim, with a note saying so. */
export function condenseEdits(
	spans: readonly Span[],
	cut: number,
	replaced: ReadonlyMap<EntryId, readonly Message[]>,
	requests: readonly CondenseRequest[],
): { edits: ContextEdit[]; note?: string } {
	const kept = new Set(spans.slice(cut).map((span) => span.entry.id));
	const edits: ContextEdit[] = [];
	for (const [target, messages] of replaced) if (kept.has(target)) edits.push({ target, action: "replace", messages });
	const edited = new Set<number>(edits.map((edit) => Number(edit.target)));
	const refused = [...new Set(requests.map((request) => request.entry))].filter((entry) => !edited.has(entry));
	if (refused.length === 0) return { edits };
	return { edits, note: `Kept verbatim instead of condensed (not a kept tool result pigui may condense): entr${refused.length === 1 ? "y" : "ies"} ${refused.join(", ")}.` };
}
