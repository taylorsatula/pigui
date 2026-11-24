// The summarizer: one model call that writes the checkpoint's working state and recommends where the kept context
// starts. What code can compute (the person's words, the plan, the repository, the files touched) arrives as facts and
// is never asked for; the model's job is the race report, not the record-keeping.
import type { Api, AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import type { EntryId, HookApi } from "@earendil-works/pi-durable";
import { type ModelSpend, modelSpend } from "./budget.ts";
import type { CondenseRequest, Span } from "./cut.ts";
import { messagesText, RECALL } from "./recall.ts";
import type { AgentServices } from "./services.ts";

/** The most the summarizer may write, or less when the model's own limit is lower. */
const MAX_OUTPUT_TOKENS = 12_000;
/** Tool results are bulky and their outcomes usually fit; messages from the person carry decisions. */
const TOOL_RESULT_CHARS = 1500;
const MESSAGE_CHARS = 4000;

export const SUMMARIZER_PROMPT = `You are the compaction engine of a coding agent that works unattended on a person's repository. What you write here is the working state of an engineering checkpoint, not a chat reply: once its older context is removed, the same agent continues from it.

The session is a hurdle race, and the checkpoint is its record to this point: what was attempted, decided, changed and learned, and why. The entries kept verbatim after the checkpoint are just enough runway for the next hurdle: live context to regain stride, not a replay of the race.

What you receive:
- <previous_checkpoint> (after the first compaction): the working state written at the previous compaction. Treat it as frozen history and evolve it.
- <pigui_facts>: computed by pigui from its records and the workspace: the person's words verbatim, the plan and its progress, the session state, the repository state, and the files read and modified. pigui places them in the checkpoint unchanged, so rely on them rather than restating them.
- <agent_handoff> (when present): the agent's own first-person note, written just now, on what it is doing, what it learned and its exact next step. It is the freshest account and stays verbatim after the checkpoint; use it, but do not copy it.
- <new_history_to_compact>: the entries this checkpoint replaces. Integrate all of them.
- <kept_recent_context>: the entries that follow, as boundary evidence. Where the verbatim runway starts is your choice.

How to work:
- Write one complete successor checkpoint, not a delta. Keep what still holds from the previous checkpoint, correct what newer entries contradict, and update completed and pending work.
- Integrate every entry before your cut: those entries leave the context. Do not recap entries at or after your cut; those stay verbatim.
- STATE AT COMPACTION BOUNDARY, WORK QUEUE and OPEN THREADS must reflect the newest evidence, including <kept_recent_context> and <agent_handoff>. Do not leave stale claims such as "not implemented yet" when later entries show otherwise.
- Separate verified facts, the person's requirements and your inferences. Do not invent file contents, test results, commands, decisions or failures.
- Keep exact file paths, symbols, commands, error messages, test names and identifiers. Point to large content (a path and lines, a command to rerun, or an entry number, which ${RECALL} reads) instead of copying it.
- Include substantive tool activity: commands and tests with their outcomes, failures, decisions and observations that changed the plan. Do not list every routine call.
- Use bounded phrasing such as "as of this checkpoint" or "during the compacted range". No greetings, praise or filler.

Choosing the cut:
- The cut is the first entry kept verbatim. Choose an entry ID from <kept_recent_context> marked valid_cutpoint="true"; nothing else is accepted.
- Prefer a message from the person, if one is in range: it gives the agent a concrete instruction.
- Keep at least one coherent unit: a request and its response, or the start of the current action. Do not leave the agent looking at an orphaned result.
- Between tasks, cut late: routine reads, searches and edits are safe to summarize, since their outcomes are on disk and in the checkpoint. Mid-task, keep the active instruction and the partial results or errors needed to finish the current step.
- pigui caps how much is kept and may move your cut later. Write as if your cut is honoured.

Condensing, optional: a tool result at or after your cut that the agent no longer needs verbatim, such as a long log whose outcome you recorded, can be condensed. pigui replaces its content, in what the agent sees, with your one-line note and a pointer to the full result. Only tool results can be condensed, and never the handoff note's.

Reply in exactly this form, without a code fence. Leave out <condense> when you condense nothing.

<cutpoint_decision>
<recommended_cut_before_entry_id>ENTRY_ID</recommended_cut_before_entry_id>
<cutpoint_reasoning>One sentence on why this cut lets the agent continue.</cutpoint_reasoning>
</cutpoint_decision>
<condense>
<tool_result entry_id="ENTRY_ID">One line on what the result showed.</tool_result>
</condense>

STATE AT COMPACTION BOUNDARY:
- Active task:
- Most recent request from the person:
- Current implementation state:
- Context needed to continue:

EVIDENCE TIERS:
- Verified from session and tool history:
- Requirements the person stated:
- Inferences:

CODE REFERENCES:
- Files and paths:
- Symbols, functions and types:
- Config keys, constants and identifiers:
- Verbatim error messages, command lines and test names (lookup strings only):

DECISIONS AND RATIONALE:
- Decisions made:
- Rationale:
- Ruled out:

COMMANDS, TESTS, AND FAILURES:
- Commands run:
- Tests run:
- Current failures:
- Validation still pending:

WORK QUEUE:
- Completed:
- In progress:
- Next exact steps:
- Blockers:
- Risks:

OPEN THREADS:
- Unresolved requests:
- Pending actions:
- Open questions:

COMPACTED HISTORY SYNOPSIS:
One paragraph on the arc of the session: what kind of work happened, the major turns, and why the approach changed. Leave specifics to the sections above.`;

/** The section every usable reply starts its body with. */
const FIRST_SECTION = "STATE AT COMPACTION BOUNDARY:";

type SummarizerReply = { cut?: number; reasoning: string; condense: CondenseRequest[]; body: string };

/** Memoized as JSON: what the summarizer returned, or why nothing usable came back, and what it cost. */
export type SummarizerResult = {
	reply?: SummarizerReply;
	problem?: string;
	usage?: ModelSpend;
};

/** A long text is shown head and tail: a log's outcome usually sits at its end. */
function clip(text: string, limit: number, id: EntryId): string {
	if (text.length <= limit) return text;
	const half = Math.floor(limit / 2);
	return `${text.slice(0, half)}\n[… ${text.length - limit} characters left out; ${RECALL} entry ${id} reads them …]\n${text.slice(-half)}`;
}

function entryBlock(span: Span, cutpoint: boolean | undefined): string {
	const role = span.messages[0]?.role ?? "none";
	const flag = cutpoint === undefined ? "" : ` valid_cutpoint="${cutpoint}"`;
	const body = clip(messagesText(span.messages), role === "toolResult" ? TOOL_RESULT_CHARS : MESSAGE_CHARS, span.entry.id);
	return `<entry id="${span.entry.id}" kind="${span.entry.kind}" role="${role}"${flag}>\n${body}\n</entry>`;
}

const shown = (span: Span) => span.messages.some((message) => message.role !== "system");

/** History blocks within `budget` characters; past it, the oldest go first, since the newest lead to the boundary. */
function historyText(spans: readonly Span[], budget: number): string {
	const blocks = spans.filter(shown).map((span) => entryBlock(span, undefined));
	if (blocks.length === 0) return "(none)";
	let used = 0;
	let start = blocks.length;
	while (start > 0) {
		const block = blocks[start - 1];
		if (block === undefined || used + block.length > budget) break;
		used += block.length;
		start -= 1;
	}
	const omitted = start > 0 ? `[${start} earlier entries left out to fit; ${RECALL} reads them]\n` : "";
	return omitted + blocks.slice(start).join("\n");
}

/**
 * Kept blocks within `budget` characters, trimmed from the middle: the first entries are the earliest cuts and the last
 * are the newest evidence. Only the valid cuts actually shown count as presented.
 */
function keptText(spans: readonly Span[], valid: (index: number) => boolean, budget: number): { text: string; presented: Set<EntryId> } {
	const blocks = spans.flatMap((span, index) => (shown(span) ? [{ span, valid: valid(index), text: entryBlock(span, valid(index)) }] : []));
	const whole = blocks.reduce((sum, block) => sum + block.text.length, 0);
	let head = blocks.length;
	let tail = blocks.length;
	if (whole > budget) {
		// Keep a quarter of the budget from the start, the rest from the end.
		head = 0;
		let used = 0;
		while (head < blocks.length) {
			const block = blocks[head];
			if (block === undefined || used + block.text.length > budget / 4) break;
			used += block.text.length;
			head += 1;
		}
		tail = blocks.length;
		while (tail > head) {
			const block = blocks[tail - 1];
			if (block === undefined || used + block.text.length > budget) break;
			used += block.text.length;
			tail -= 1;
		}
	}
	const gap = tail > head ? [`[${tail - head} entries left out of the middle to fit; they are not valid cuts here]`] : [];
	const visible = [...blocks.slice(0, head), ...blocks.slice(Math.max(head, tail))];
	return {
		text: [...blocks.slice(0, head).map((block) => block.text), ...gap, ...blocks.slice(Math.max(head, tail)).map((block) => block.text)].join("\n"),
		presented: new Set(visible.filter((block) => block.valid).map((block) => block.span.entry.id)),
	};
}

/**
 * The summarizer's user message. `history` is compacted whatever the cut; `kept` starts at the earliest allowed cut, and
 * `valid` says which of its entries may be chosen. `budgetChars` bounds the history and the kept entries together.
 */
export function summarizerPrompt(input: {
	previous: string | undefined;
	facts: string;
	handoff: string | undefined;
	history: readonly Span[];
	kept: readonly Span[];
	valid: (keptIndex: number) => boolean;
	budgetChars: number;
}): { text: string; presented: Set<EntryId> } {
	const kept = keptText(input.kept, input.valid, Math.floor(input.budgetChars / 3));
	const parts = [
		...(input.previous === undefined ? [] : [`<previous_checkpoint>\n${input.previous}\n</previous_checkpoint>`]),
		`<pigui_facts>\n${input.facts}\n</pigui_facts>`,
		...(input.handoff === undefined ? [] : [`<agent_handoff>\n${input.handoff}\n</agent_handoff>`]),
		`<new_history_to_compact>\n${historyText(input.history, input.budgetChars - kept.text.length)}\n</new_history_to_compact>`,
		`<kept_recent_context>\nBoundary evidence, oldest first. Its first valid cut keeps the most that pigui allows.\n${kept.text}\n</kept_recent_context>`,
		'Choose the cut from <kept_recent_context> (valid_cutpoint="true" only), then write the checkpoint in the required form.',
	];
	return { text: parts.join("\n\n"), presented: kept.presented };
}

const fenced = (text: string) => text.replace(/^\s*```\w*\s*/, "").replace(/```\s*$/, "");
const tag = (text: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1];
const tagNumber = (text: string, name: string) => {
	const match = new RegExp(`<${name}>\\s*(\\d+)\\s*</${name}>`).exec(text)?.[1];
	return match === undefined ? undefined : Number(match);
};

/** The decision block, the condense list and the body, or undefined when the body is missing. */
function parseReply(text: string): SummarizerReply | undefined {
	const cleaned = fenced(text);
	const cut = tagNumber(cleaned, "recommended_cut_before_entry_id");
	const reasoning = tag(cleaned, "cutpoint_reasoning")?.trim() ?? "";
	const condenseBlock = tag(cleaned, "condense") ?? "";
	const condense = [...condenseBlock.matchAll(/<tool_result\s+entry_id="(\d+)"\s*>([\s\S]*?)<\/tool_result>/g)].map((match) => ({
		entry: Number(match[1]),
		note: (match[2] ?? "").trim().replace(/\s+/g, " "),
	}));
	const start = cleaned.indexOf(FIRST_SECTION);
	if (start === -1) return undefined;
	const body = cleaned.slice(start).trim();
	return cut === undefined ? { reasoning, condense, body } : { cut, reasoning, condense, body };
}

/**
 * Ask the summarizer. An error or an unusable reply comes back as `problem`, to be memoized like a reply. It throws only
 * once `signal` is aborted (the server is stopping), so that outcome is never memoized and the compaction asks again.
 */
export async function summarize(models: Models, model: Model<Api>, prompt: string, now: number, signal: AbortSignal | undefined): Promise<SummarizerResult> {
	const maxTokens = Math.min(MAX_OUTPUT_TOKENS, model.maxTokens > 0 ? model.maxTokens : MAX_OUTPUT_TOKENS);
	let reply: AssistantMessage;
	try {
		reply = await models.completeSimple(
			model,
			{ systemPrompt: SUMMARIZER_PROMPT, messages: [{ role: "user", content: prompt, timestamp: now }] },
			signal === undefined ? { maxTokens } : { maxTokens, signal },
		);
	} catch (error) {
		signal?.throwIfAborted();
		return { problem: error instanceof Error ? (error.message.split("\n")[0] ?? "the request failed") : String(error) };
	}
	signal?.throwIfAborted();
	const usage = modelSpend(model, reply);
	if (reply.stopReason === "error" || reply.stopReason === "aborted") return { problem: reply.errorMessage ?? reply.stopReason, usage };
	const parsed = parseReply(reply.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""));
	return parsed === undefined ? { problem: "the reply had no checkpoint sections", usage } : { reply: parsed, usage };
}

/**
 * The summarizer's model: the one configured with `PIGUI_COMPACTION_MODEL` while Pi can sign in to it, or the
 * session's otherwise. A configured model Pi cannot sign in to falls back to the session's, with a warning, so a
 * compaction never waits on a credential the server does not hold.
 */
export async function summarizerModel(services: AgentServices, api: Pick<HookApi, "conversationId" | "models">, session: Model<Api> | undefined): Promise<Model<Api> | undefined> {
	const configured = services.compactionModel;
	if (configured === undefined) return session;
	const model = api.models.getModel(configured.provider, configured.modelId);
	const signedIn = model !== undefined && (await api.models.checkAuth(configured.provider).catch(() => undefined)) !== undefined;
	if (signedIn) return model;
	services.log.warn("compaction.model_unusable", { model: `${configured.provider}/${configured.modelId}`, session: api.conversationId });
	return session;
}
