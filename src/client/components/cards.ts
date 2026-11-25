// The plain-TS parts of the cards: the action types, the initial selection, the report's prose and grading, and the tone maps. No markup.
// A waiting card is answered by tapping: recommended options are already chosen, so accepting them is one tap, and free text is always there.
import type { CardAnswer, QuestionCard, Report, ReportMemory } from "../../shared/session.ts";

export type CardActions = {
	answer(cardId: string, answer: CardAnswer): Promise<void>;
	focusComposer(): void;
};

export type DeliveryActions = {
	deliver(action: "push" | "pr"): Promise<void>;
	showDiff(): void;
	focusComposer(): void;
};

export function initialSelection(card: QuestionCard): Record<string, string[]> {
	return Object.fromEntries(card.questions.map((question) => [question.id, question.recommended === undefined ? [] : [question.recommended]]));
}

/** The prose a report card shows, as Markdown to read aloud: what the person reads first, not the record under it. */
export function reportProse(report: Report): string {
	return [
		report.headline,
		report.summary,
		...(report.deviations.length === 0 ? [] : ["## Changed from the plan", report.deviations.map((line) => `- ${line}`).join("\n")]),
		...(report.notes.length === 0 ? [] : ["## Notes", report.notes.map((line) => `- ${line}`).join("\n")]),
	]
		.filter((part) => part !== "")
		.join("\n\n");
}

/** How a report graded long-term memory, in one line: "Rated 3 memories: 2 helpful, 1 not. Removed 1." */
export function grading(memory: ReportMemory): string {
	const rated = memory.helpful + memory.unhelpful;
	return [
		rated === 0 ? "" : `Rated ${rated === 1 ? "1 memory" : `${rated} memories`}: ${memory.helpful} helpful, ${memory.unhelpful} not.`,
		memory.deleted.length === 0 ? "" : `Removed ${memory.deleted.length}.`,
	]
		.filter((part) => part !== "")
		.join(" ");
}

export const OUTCOME: Record<Report["outcome"], { label: string; tone: string }> = {
	complete: { label: "Complete", tone: "good" },
	partial: { label: "Partly done", tone: "warn" },
	blocked: { label: "Blocked", tone: "bad" },
};

export const CHECK_ICON = { passed: "check", failed: "close", "not run": "minus" } as const;
