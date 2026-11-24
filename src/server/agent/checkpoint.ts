// The compaction checkpoint: the text the agent reads in place of the context it lost. What code can recompute (the
// person's words, the plan, the session, the repository, the files touched; see facts.ts) is rebuilt at every
// compaction; only the working state comes from the summarizer, which evolves the previous one. Both ways a compaction
// happens, pigui's own after a handoff note and Durable's through the backstop hook, write their checkpoint here.
import type { Context } from "@earendil-works/chord/context";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ContextView, EntryDraft, EntryId, EntryRecord, HookApi, Tx } from "@earendil-works/pi-durable";
import { CHECKPOINT_ENTRY, type CheckpointEntryData, type SessionDoc } from "../../shared/session.ts";
import { editSession } from "../documents.ts";
import { countSpend } from "./budget.ts";
import { type Bounds, chooseCut, condensed, condenseEdits, retainedMessages, type Span } from "./cut.ts";
import { commitLine, fileLine, type FilesTouched, filesTouched, type Ground, groundTruth, planLines, promptFacts, repositoryLines, sessionLines, wordLines } from "./facts.ts";
import { messagesText, RECALL } from "./recall.ts";
import type { AgentServices } from "./services.ts";
import { summarize, summarizerModel, type SummarizerResult, summarizerPrompt } from "./summarizer.ts";

/** How every checkpoint starts; also how one is recognised inside the summary Durable placed with it. */
export const CHECKPOINT_HEADER = "HISTORICAL CHECKPOINT.";

/** The code-owned part of the checkpoint, as a share of the session model's context window. */
const FACTS_SHARE = 0.1;
/** The summarizer's input, as a share of its context window; the rest is for its instructions and reply. */
const PROMPT_SHARE = 0.6;
const MEMO = "pigui.checkpoint";

/** What both compaction paths may use: committed reads and the compaction task's memos. */
type CheckpointApi = Pick<HookApi, "taskId" | "conversationId" | "models" | "memo" | "snapshot" | "entries">;

/** The session model, its context window and the cap on what a checkpoint keeps verbatim. */
export type Limits = { model: Model<Api> | undefined; window: number; cap: number };

type Sheddable = { lines: string[]; label: string };

/**
 * The checkpoint text. The code-owned part fits `budgetTokens`: over it, lists are shed oldest first, in this order:
 * files read, files modified, the changed-file list, the commit list, each with a note of what was left out. The
 * person's words, the plan, the session and repository state, the instructions and the summarizer's working state are
 * never shed; the working state is bounded by the summarizer's output limit instead.
 */
export function renderCheckpoint(input: {
	doc: Readonly<SessionDoc>;
	/** A repository session's clone; undefined for a local session, which has none. */
	ground: Ground | undefined;
	files: FilesTouched;
	number: number;
	at: number;
	/** The summarizer's working state; undefined before any was written. */
	body: string | undefined;
	/** Notes from pigui on this checkpoint: a cut adjustment, a summarizer failure. */
	notes: string[];
	compacted: { first: EntryId; last: EntryId } | undefined;
	cut: EntryId;
	budgetTokens: number;
}): string {
	const { ground } = input;
	const readList: Sheddable = { lines: [...input.files.read], label: "files read" };
	const modifiedList: Sheddable = { lines: [...input.files.modified], label: "files modified" };
	const fileList: Sheddable = { lines: (ground?.files ?? []).map(fileLine), label: "changed files" };
	const commitList: Sheddable = { lines: (ground?.commits ?? []).map(commitLine), label: "commits" };
	const shedOrder = [readList, modifiedList, fileList, commitList];
	const omitted = new Map<Sheddable, number>();
	const listed = (part: Sheddable, empty: string): string[] => {
		const dropped = omitted.get(part) ?? 0;
		const lines = part.lines.length === 0 && dropped === 0 ? [empty] : [...part.lines];
		if (dropped > 0) lines.unshift(`(${dropped} older ${part.label} left out to fit; ${RECALL} and git recover them)`);
		return lines;
	};
	const working = [
		...input.notes.map((note) => `(pigui: ${note})`),
		...(input.notes.length === 0 ? [] : [""]),
		input.body ?? "No working state has been written yet. Work from the plan progress, the repository state and the messages after this checkpoint.",
	].join("\n");

	const place = (): string[] =>
		ground === undefined
			? ["## Where you work", `In ${input.doc.place === "local" ? input.doc.dir : "your working directory"}, on the person's own computer, in place: no branch, and no commits of this session's.`]
			: [
					"## Repository, computed at compaction",
					...repositoryLines(ground),
					`Commits in this session (${ground.commitTotal}; \`git log\` shows them all):`,
					...listed(commitList, "- none yet"),
					`Files changed in this session (${ground.files.length}; \`git diff --stat\` shows them):`,
					...listed(fileList, "- none yet"),
				];
	const facts = (): string =>
		[
			`${CHECKPOINT_HEADER} pigui compacted this session's earlier context into checkpoint ${input.number}, at ${new Date(input.at).toISOString()}. The files on disk and the messages after this checkpoint are newer than it: where they disagree with it, they win.`,
			"",
			"## Before you act",
			ground === undefined
				? "1. Re-establish ground truth: look again at what the plan changes, and compare it with the plan progress below."
				: "1. Re-establish ground truth: run `git status` and `git log --oneline -10`, and compare them with the plan progress below.",
			"2. Re-read any file before you edit it: this checkpoint describes files, it does not hold them.",
			"3. Do not redo plan steps marked done or commits already made, and do not ask again what the person already answered below.",
			`4. Anything missing here is still in the full history: use ${RECALL} with a query (a file name, an error, a number) or an entry number.`,
			"",
			"## The person's words, verbatim, oldest first",
			...wordLines(input.doc),
			"",
			"## Plan",
			...planLines(input.doc),
			"",
			"## Session",
			...sessionLines(input.doc),
			"",
			...place(),
			"",
			"## Files you read and modified with your file tools",
			`Read: ${listed(readList, "none").join(", ")}`,
			`Modified: ${listed(modifiedList, "none").join(", ")}`,
		].join("\n");
	const recovery = [
		"## Recovery",
		`The context continues verbatim from entry ${input.cut}.${input.compacted === undefined ? "" : ` This compaction covered entries ${input.compacted.first} to ${input.compacted.last}.`} Every entry is still stored: ${RECALL} searches and reads them.`,
	].join("\n");
	const render = () => [facts(), "", "## Working state, written at compaction", working, "", recovery].join("\n");

	const budgetChars = input.budgetTokens * 4;
	const ownLength = () => render().length - working.length;
	for (const part of shedOrder) {
		while (ownLength() > budgetChars && part.lines.length > 0) {
			// Oldest first; with many lines to go, drop several at a time.
			const drop = Math.max(1, Math.ceil(part.lines.length / 4));
			part.lines.splice(0, drop);
			omitted.set(part, (omitted.get(part) ?? 0) + drop);
		}
		if (ownLength() <= budgetChars) break;
	}
	return render();
}

/** Whether a head marker holds a pigui checkpoint: its own marker, or Durable's summary carrying one. */
function isCheckpoint(entry: EntryRecord | undefined): boolean {
	if (entry === undefined) return false;
	return entry.kind === CHECKPOINT_ENTRY || messagesText(entry.model ?? []).includes(CHECKPOINT_HEADER);
}

export type Written = {
	text: string;
	/** The marker to place, or undefined when Durable's own summary already says the same. */
	marker: (EntryDraft & { head: EntryId; data: CheckpointEntryData }) | undefined;
	body: string | undefined;
	usage: SummarizerResult["usage"];
};

/**
 * Write the checkpoint for a compaction of `view` within `bounds`: ask the summarizer (memoized on the compaction task,
 * so a rerun after a restart never asks again), check its cut and condense list, and render the text. When the
 * summarizer errors, returns nothing usable or has no model, the cut is the bounds' fallback and the previous working
 * state is carried forward with a note, so the run always continues. `durableCut` is Durable's own cut, when Durable
 * runs the compaction.
 */
export async function writeCheckpoint(
	services: AgentServices,
	api: CheckpointApi,
	input: {
		doc: Readonly<SessionDoc>;
		view: ContextView;
		spans: readonly Span[];
		bounds: Bounds;
		limits: Limits;
		handoff?: string;
		durableCut?: EntryId;
		signal: AbortSignal | undefined;
	},
	context: Context,
): Promise<Written> {
	const { doc, spans, bounds } = input;
	const { window, cap } = input.limits;
	const previous = doc.handoff?.body;
	// The previous checkpoint's working state is given as such; any other head (Durable's own summary, an older kind of
	// handoff) is history to integrate.
	const start = previous !== undefined && isCheckpoint(input.view.head) ? 1 : 0;
	const earliest = spans[bounds.earliest]?.entry.id;
	if (earliest === undefined) throw new Error("The compaction's bounds are outside its context.");
	const ground = doc.place === "repo" ? await groundTruth(services.workspace(doc.id), doc) : undefined;
	const files = await filesTouched(api, earliest, services.workingDir(doc), context);
	const summarizer = await summarizerModel(services, api, input.limits.model);
	const prompt = summarizerPrompt({
		previous,
		facts: promptFacts(doc, ground, files),
		handoff: input.handoff,
		history: spans.slice(start, bounds.earliest),
		kept: spans.slice(bounds.earliest),
		valid: (index) => bounds.earliest + index <= bounds.latest && spans[bounds.earliest + index]?.cut === true,
		budgetChars: Math.floor((summarizer?.contextWindow ?? window) * 4 * PROMPT_SHARE),
	});

	let result = await api.memo<SummarizerResult>(MEMO, context);
	if (result === undefined) {
		const asked = summarizer === undefined ? { problem: "no model is available" } : await summarize(api.models, summarizer, prompt.text, services.now(), input.signal);
		result = await api.memo<SummarizerResult>(MEMO, asked, context);
	}
	await services.faults.afterSummarizer?.(context);

	const reply = result.reply;
	if (reply === undefined) services.log.warn("compaction.summarizer_failed", { session: api.conversationId, reason: result.problem });
	const requests = reply?.condense ?? [];
	const replaced = condensed(spans, requests);
	const choice = reply === undefined ? { index: bounds.fallback, selection: "fallback" as const } : chooseCut(spans, bounds, prompt.presented, reply.cut, cap, replaced);
	const { edits, note: condenseNote } = condenseEdits(spans, choice.index, replaced, requests);
	const cut = spans[choice.index]?.entry.id ?? earliest;
	const notes = [
		...(reply === undefined ? [`the working state was not updated at this compaction (${result.problem ?? "no reply"}); it is the previous one, carried forward unchanged.`] : []),
		...(choice.note === undefined ? [] : [choice.note]),
		...(condenseNote === undefined ? [] : [condenseNote]),
	];
	// The head marker heads the range from an entry before its own: the range it covers starts after it.
	const compactedIds = spans.slice(input.view.head === undefined ? 0 : 1, choice.index).filter((span) => span.messages.length > 0).map((span) => span.entry.id);
	const first = compactedIds[0];
	const last = compactedIds.at(-1);
	const body = reply?.body ?? previous;
	const text = renderCheckpoint({
		doc,
		ground,
		files: files.all,
		number: doc.handoff?.lastTask === api.taskId ? doc.handoff.compactions : (doc.handoff?.compactions ?? 0) + 1,
		at: services.now(),
		body,
		notes,
		compacted: first === undefined || last === undefined ? undefined : { first, last },
		cut,
		budgetTokens: Math.round(window * FACTS_SHARE),
	});
	const data: CheckpointEntryData = {
		task: api.taskId,
		...(input.durableCut === undefined ? {} : { durableCut: input.durableCut }),
		selection: choice.selection,
		retained: retainedMessages(spans, choice.index),
		condensed: edits.length,
	};
	const sameAsDurable = input.durableCut === cut && edits.length === 0;
	const marker = sameAsDurable
		? undefined
		: {
				kind: CHECKPOINT_ENTRY,
				head: cut,
				model: [{ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: services.now() }],
				...(edits.length === 0 ? {} : { edits }),
				data,
			};
	return { text, marker, body, usage: result.usage };
}

/**
 * Keep what the next compaction needs, once per compaction task, and count the summarizer's spend in `pi.usage` the way
 * Durable counts its own summaries, so the spend cap sees it. Also ends the compaction cycle: a handoff asked for before
 * this compaction is no longer awaited.
 */
export async function saveCheckpoint(tx: Tx, services: AgentServices, api: Pick<CheckpointApi, "conversationId" | "taskId">, written: Written): Promise<void> {
	await editSession(tx, api.conversationId, services.now(), async (doc) => {
		if (doc.handoff?.lastTask === api.taskId) return;
		const compactions = (doc.handoff?.compactions ?? 0) + 1;
		doc.handoff = written.body === undefined ? { compactions, lastTask: api.taskId } : { body: written.body, compactions, lastTask: api.taskId };
		if (written.usage !== undefined) await countSpend(tx, api.conversationId, written.usage);
	});
}
