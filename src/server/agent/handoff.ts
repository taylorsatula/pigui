// picloud's compaction handoff, in place of Durable's built-in summary. What code can recompute (repository state,
// plan, session state, the person's words) is rebuilt at every compaction from the workspace and the session document;
// only the working notes (resume point, findings, failures, open items) come from the model, and they accumulate:
// each compaction updates the stored notes from the newly compacted messages, never by summarizing a summary.
import type { Context } from "@earendil-works/chord/context";
import type { Api, Model } from "@earendil-works/pi-ai";
import { AgentDoc, CompactionTask, type ConversationId, type EntryRecord, hook, type HookApi, UsageDoc } from "@earendil-works/pi-durable";
import { arr, compile, obj, str } from "@earendil-works/pi-schema";
import type { HandoffNotes, NoteItem, SessionDoc } from "../../shared/session.ts";
import { editSession, SessionDocToken } from "../docs.ts";
import { aheadBehind, changedFiles, commits, comparisonPoint, currentBranch, head, refExists, uncommitted } from "../git.ts";
import { errorKind } from "../log.ts";
import { describePlan } from "./plan.ts";
import { entryText, RECALL } from "./recall.ts";
import type { AgentServices } from "./services.ts";

/** Proportions of the model's context window. */
export const HANDOFF_SHARE = 0.1;

/** Compaction thresholds for a model, as proportions of its context window. */
export function compactionFor(contextWindow: number) {
	return {
		enabled: true,
		reserveTokens: Math.round(contextWindow * 0.15),
		keepRecentTokens: Math.round(contextWindow * 0.25),
		backgroundTokens: Math.round(contextWindow * 0.1),
	};
}

export function emptyNotes(): HandoffNotes {
	return { resume: { inProgress: "", latestResult: "", nextAction: "" }, findings: [], failed: [], open: [] };
}

type NotesUpdate = {
	resume: HandoffNotes["resume"];
	addFindings: string[];
	addFailed: string[];
	addOpen: string[];
	resolve: string[];
};

const NotesUpdateSchema = obj({
	resume: obj({ inProgress: str(), latestResult: str(), nextAction: str() }),
	addFindings: arr(str()),
	addFailed: arr(str()),
	addOpen: arr(str()),
	resolve: arr(str()),
});
const checkUpdate = compile(NotesUpdateSchema);

export const SUMMARIZER_PROMPT = `You maintain the handoff notes that let a coding agent continue its work after its context is compacted. You get the current notes as JSON and the part of the transcript being compacted. Update the notes from that transcript.

Reply with JSON only, in this shape:
{"resume":{"inProgress":"what was being done at the end of the transcript","latestResult":"the most recent result: a test run, an error, a finding","nextAction":"the exact next action, specific enough to act on without rereading: the command to run, or the file and the change"},
"addFindings":["facts learned and decisions made that later work depends on"],
"addFailed":["what was tried and failed, and why"],
"addOpen":["problems or questions not resolved yet"],
"resolve":["ids of open items now resolved, or of findings and failures now obsolete"]}

Rules:
- Do not restate the person's messages, the plan, its progress, or repository state: those are carried separately, verbatim and recomputed.
- Be specific: name files, functions, commands and exact error messages.
- Point to large content (a path and line numbers, a command to rerun) instead of copying it.
- Add only what is new in this transcript; the current notes are kept unless you resolve them.`;

type StoredNotes = { notes: HandoffNotes; degraded: boolean; usage?: { key: string; cost: number; input: number; output: number } };

/** Merge a model's update into the notes: new items get the next IDs, resolved ones leave, the resume point is replaced. */
export function mergeNotes(previous: HandoffNotes, update: NotesUpdate): HandoffNotes {
	const resolved = new Set(update.resolve);
	const keep = (items: NoteItem[]) => items.filter((item) => !resolved.has(item.id));
	const append = (items: NoteItem[], prefix: string, added: string[]): NoteItem[] => {
		let next = Math.max(0, ...items.map((item) => Number(item.id.slice(prefix.length)) || 0)) + 1;
		return [...items, ...added.filter((text) => text.trim() !== "").map((text) => ({ id: `${prefix}${next++}`, text: text.trim() }))];
	};
	return {
		resume: update.resume,
		findings: append(keep(previous.findings), "f", update.addFindings),
		failed: append(keep(previous.failed), "x", update.addFailed),
		open: append(keep(previous.open), "o", update.addOpen),
	};
}

/** Entries as the summarizer reads them: each with its number, long tool results cut, the previous summary left out. */
function transcriptFor(entries: readonly EntryRecord[], budgetChars: number): string {
	const blocks: string[] = [];
	for (const entry of entries) {
		if (entry.kind === "pi.compaction" || entry.kind === "pi.system") continue;
		let text = entryText(entry);
		const limit = entry.kind === "pi.tool-result" ? 1500 : 4000;
		if (text.length > limit) text = `${text.slice(0, limit)} […${text.length - limit} more characters; ${RECALL} entry ${entry.id}]`;
		if (text.trim() !== "") blocks.push(`[${entry.id}] ${text}`);
	}
	// The end of the transcript holds the resume point; past the budget, older blocks go first.
	let total = 0;
	let start = blocks.length;
	while (start > 0 && total + (blocks[start - 1]?.length ?? 0) <= budgetChars) total += blocks[--start]?.length ?? 0;
	const omitted = start > 0 ? `[${start} earlier entries left out to fit; ${RECALL} finds them]\n` : "";
	return omitted + blocks.slice(start).join("\n");
}

function parseUpdate(text: string): NotesUpdate | undefined {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) return undefined;
	try {
		const value: unknown = JSON.parse(text.slice(start, end + 1));
		return checkUpdate.check(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Pointers into the compacted history: the tool calls made, with where to find their full results. */
function pointers(entries: readonly EntryRecord[]): string[] {
	const results = new Map<string, EntryRecord>();
	for (const entry of entries) {
		const message = entry.model?.[0];
		if (message?.role === "toolResult") results.set(message.toolCallId, entry);
	}
	const lines: string[] = [];
	for (const entry of entries) {
		const message = entry.model?.[0];
		if (message?.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			const args = JSON.stringify(block.arguments);
			const result = results.get(block.id);
			const resultMessage = result?.model?.[0];
			const failed = resultMessage?.role === "toolResult" && resultMessage.isError ? " (failed)" : "";
			const where = result === undefined ? `call in entry ${entry.id}` : `result in entry ${result.id}`;
			lines.push(`- ${block.name} ${args.length > 120 ? `${args.slice(0, 120)}…` : args}${failed}: ${where}`);
		}
	}
	return lines;
}

/** Without a model update, the latest tool result and reply still say where things stood. */
function fallbackResume(entries: readonly EntryRecord[]): HandoffNotes["resume"] {
	let latest = "";
	for (const entry of [...entries].reverse()) {
		if (entry.kind === "pi.compaction" || entry.kind === "pi.system") continue;
		latest = entryText(entry).slice(0, 400).replace(/\s+/g, " ");
		if (latest !== "") {
			latest = `Entry ${entry.id}: ${latest}`;
			break;
		}
	}
	return {
		inProgress: "Unknown: the working notes could not be updated at this compaction. Work it out from the plan progress, the repository state and the recent messages.",
		latestResult: latest,
		nextAction: "Run git status and git log --oneline -10, compare them with the plan progress, then continue with the first step not done.",
	};
}

async function writeNotes(
	services: AgentServices,
	api: HookApi,
	model: Model<Api> | undefined,
	previous: HandoffNotes,
	entries: readonly EntryRecord[],
	context: Context,
): Promise<StoredNotes> {
	const degraded = (): StoredNotes => ({ notes: { ...previous, resume: fallbackResume(entries) }, degraded: true });
	if (model === undefined) return degraded();
	const transcript = transcriptFor(entries, Math.floor(model.contextWindow * 4 * 0.5));
	try {
		const options = context.abortSignal === undefined ? { maxTokens: 4000 } : { maxTokens: 4000, signal: context.abortSignal };
		const reply = await api.models.completeSimple(
			model,
			{
				systemPrompt: SUMMARIZER_PROMPT,
				messages: [
					{
						role: "user",
						content: `Current notes:\n${JSON.stringify(previous)}\n\nTranscript being compacted:\n${transcript}`,
						timestamp: services.now(),
					},
				],
			},
			options,
		);
		const usage = { key: `${model.provider}/${model.id}`, cost: reply.usage.cost.total, input: reply.usage.input, output: reply.usage.output };
		if (reply.stopReason === "error" || reply.stopReason === "aborted") return { ...degraded(), usage };
		const text = reply.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
		const update = parseUpdate(text);
		return update === undefined ? { ...degraded(), usage } : { notes: mergeNotes(previous, update), degraded: false, usage };
	} catch (error) {
		services.log.warn("handoff.summarizer_failed", { session: api.conversationId, error: errorKind(error) });
		return degraded();
	}
}

type Ground = {
	branch: string;
	head: string;
	base: string;
	baseKnown: boolean;
	ahead: number;
	behind: number;
	uncommitted: string[];
	commits: { sha: string; subject: string }[];
	commitTotal: number;
	files: { path: string; added: number; removed: number; status: string }[];
	error?: string;
};

/** The repository as it is now, read from the workspace. */
async function groundTruth(workspace: string, doc: Readonly<SessionDoc>): Promise<Ground> {
	const ground: Ground = { branch: doc.branch, head: "", base: doc.base, baseKnown: false, ahead: 0, behind: 0, uncommitted: [], commits: [], commitTotal: 0, files: [] };
	try {
		ground.branch = await currentBranch(workspace);
		ground.head = await head(workspace);
		ground.uncommitted = await uncommitted(workspace);
		const baseRef = `refs/remotes/origin/${doc.base}`;
		ground.baseKnown = await refExists(workspace, baseRef);
		if (ground.baseKnown) Object.assign(ground, await aheadBehind(workspace, baseRef));
		const from = doc.startCommit === undefined ? undefined : await comparisonPoint(workspace, doc.startCommit, doc.base);
		if (from !== undefined) {
			const log = await commits(workspace, `${from}..HEAD`, 15);
			ground.commits = log.commits;
			ground.commitTotal = log.total;
			ground.files = (await changedFiles(workspace, from)).map(({ path, added, removed, status }) => ({ path, added, removed, status }));
		}
	} catch (error) {
		ground.error = error instanceof Error ? error.message.split("\n")[0] : String(error);
	}
	return ground;
}

const WORD_LABEL: Record<string, string> = {
	task: "Task",
	message: "Message",
	answer: "Answer to a card",
	approval: "Plan approval",
	feedback: "Plan feedback",
};

type Sheddable = { lines: string[]; label: string };

/**
 * The handoff text within `budgetTokens`. What it never sheds: the resume point, the person's words, the plan, the
 * session state, the repository's state and the instructions. What it sheds, in this order, oldest first within each:
 * history pointers, the changed-file list, the commit list, findings, failed attempts, open items.
 */
export function renderHandoff(input: {
	doc: Readonly<SessionDoc>;
	notes: HandoffNotes;
	degraded: boolean;
	ground: Ground;
	pointers: string[];
	compactedRange: { first: number; last: number } | undefined;
	budgetTokens: number;
}): string {
	const { doc, notes, ground } = input;
	const pointerList: Sheddable = { lines: [...input.pointers], label: "history pointers" };
	const fileList: Sheddable = {
		lines: ground.files.map((file) => `- ${file.path} (${file.status}, +${file.added} −${file.removed})`),
		label: "changed files",
	};
	const commitList: Sheddable = { lines: ground.commits.map((commit) => `- ${commit.sha} ${commit.subject}`), label: "commits" };
	const findings: Sheddable = { lines: notes.findings.map((item) => `- [${item.id}] ${item.text}`), label: "findings" };
	const failed: Sheddable = { lines: notes.failed.map((item) => `- [${item.id}] ${item.text}`), label: "failed attempts" };
	const open: Sheddable = { lines: notes.open.map((item) => `- [${item.id}] ${item.text}`), label: "open items" };
	const shedOrder = [pointerList, fileList, commitList, findings, failed, open];
	const omitted = new Map<Sheddable, number>();

	const listed = (part: Sheddable, empty: string): string[] => {
		const dropped = omitted.get(part) ?? 0;
		const lines = part.lines.length === 0 && dropped === 0 ? [empty] : [...part.lines];
		if (dropped > 0) lines.unshift(`(${dropped} older ${part.label} left out to fit; ${RECALL} and git recover them)`);
		return lines;
	};

	const render = (): string => {
		const plan = doc.plan;
		const lines = [
			"This session's earlier context was compacted. This handoff carries it forward. The repository, plan and session sections were computed by picloud from the workspace and its records at the moment of compaction; the person's words are exact.",
			"",
			"## Resume point",
			...(input.degraded ? ["(The working notes could not be updated at this compaction; the resume point is reconstructed from the last messages.)"] : []),
			`In progress: ${notes.resume.inProgress || "(not recorded)"}`,
			`Latest result: ${notes.resume.latestResult || "(not recorded)"}`,
			`Next action: ${notes.resume.nextAction || "(not recorded)"}`,
			"",
			"## Before you act",
			"1. Re-establish ground truth: run `git status` and `git log --oneline -10`, and re-read any file before changing it. Trust what you see over this handoff.",
			"2. Do not redo plan steps marked done or commits already made, and do not ask again what the person already answered below.",
			`3. Anything not here is still in the full history: use ${RECALL} with a query (a file name, an error, a number) or an entry number.`,
			"",
			"## The person's words, verbatim, oldest first",
			...(doc.words.length === 0 ? ["(none)"] : doc.words.map((word) => `[${WORD_LABEL[word.kind] ?? word.kind}]\n"""\n${word.text}\n"""`)),
			"",
			"## Plan",
			...(plan === undefined
				? ["No plan has been proposed."]
				: [
						`"${plan.title}", revision ${plan.revision}, ${plan.approved ? "approved" : "not approved yet"}; ${plan.done.length} of ${plan.steps.length} steps done.`,
						plan.summary,
						describePlan(plan),
					]),
			"",
			"## Session",
			`Workflow: ${doc.workflow === "implementing" ? "implementing the approved plan; no report filed yet" : doc.workflow === "reported" ? "report filed" : "open (no approved plan)"}.`,
			`Repository ${doc.repo}; your branch ${doc.branch}; base ${doc.base}.`,
			...(doc.report === undefined ? [] : [`Last report (${new Date(doc.report.filedAt).toISOString()}): ${doc.report.summary}`]),
			"",
			"## Repository, computed at compaction",
			...(ground.error === undefined ? [] : [`(Could not read all of it: ${ground.error})`]),
			`On branch ${ground.branch} at ${ground.head.slice(0, 12) || "unknown"}.`,
			ground.baseKnown
				? `${ground.ahead} commit${ground.ahead === 1 ? "" : "s"} ahead of origin/${ground.base}, ${ground.behind} behind.`
				: `origin/${ground.base} is not fetched.`,
			ground.uncommitted.length === 0
				? "No uncommitted changes."
				: `Uncommitted changes (${ground.uncommitted.length}): ${ground.uncommitted.slice(0, 30).join(", ")}${ground.uncommitted.length > 30 ? ", …" : ""}`,
			`Commits in this session (${ground.commitTotal}; \`git log\` shows them all):`,
			...listed(commitList, "- none yet"),
			`Files changed in this session (${ground.files.length}; \`git diff --stat\` shows them):`,
			...listed(fileList, "- none yet"),
			"",
			"## Findings",
			...listed(findings, "- none recorded"),
			"",
			"## Tried and failed",
			...listed(failed, "- none recorded"),
			"",
			"## Open items",
			...listed(open, "- none recorded"),
			"",
			"## Pointers into the full history",
			...(input.compactedRange === undefined
				? []
				: [`Entries ${input.compactedRange.first} to ${input.compactedRange.last} were compacted; all of them are still stored.`]),
			...listed(pointerList, "- no tool calls in the compacted part"),
		];
		return lines.join("\n");
	};

	const budgetChars = input.budgetTokens * 4;
	let text = render();
	for (const part of shedOrder) {
		while (text.length > budgetChars && part.lines.length > 0) {
			// Oldest first; with many lines to go, drop several at a time.
			const drop = Math.max(1, Math.ceil(part.lines.length / 4));
			part.lines.splice(0, drop);
			omitted.set(part, (omitted.get(part) ?? 0) + drop);
			text = render();
		}
		if (text.length <= budgetChars) break;
	}
	return text;
}

async function conversationModel(services: AgentServices, api: HookApi, context: Context): Promise<Model<Api> | undefined> {
	const agent = await api.snapshot(AgentDoc, api.conversationId, context);
	const ref = agent?.model;
	return ref === undefined ? undefined : services.model(ref.provider, ref.modelId);
}

export function handoff(services: AgentServices) {
	return hook(CompactionTask, {
		beforeCompact: async (compaction, api, context) => {
			const doc = await api.snapshot(SessionDocToken, api.conversationId, context);
			if (doc?.id === undefined) return undefined;
			const model = await conversationModel(services, api, context);
			// Memoized: a compaction rerun after a restart reuses the notes instead of asking the model again.
			let stored = await api.memo<StoredNotes>("picloud.handoff", context);
			if (stored === undefined) {
				const written = await writeNotes(services, api, model, doc.handoff?.notes ?? emptyNotes(), compaction.entries, context);
				stored = await api.memo("picloud.handoff", written as StoredNotes, context);
			}
			await services.faults.afterHandoffNotes?.(context);
			await saveNotes(services, api.conversationId, api.taskId, stored, context);
			const ground = await groundTruth(services.workspace(doc.id), doc);
			const kept = compaction.entries.filter((entry) => entry.kind !== "pi.compaction");
			const first = kept[0]?.id;
			const last = kept.at(-1)?.id;
			return {
				summary: renderHandoff({
					doc,
					notes: stored.notes,
					degraded: stored.degraded,
					ground,
					pointers: pointers(compaction.entries).slice(-40),
					compactedRange: first === undefined || last === undefined ? undefined : { first, last },
					budgetTokens: Math.round((model?.contextWindow ?? 128_000) * HANDOFF_SHARE),
				}),
			};
		},
	});
}

/**
 * Keep the notes for the next compaction, once per compaction task, and count the summarizer's spend in `pi.usage`
 * the way Durable counts its own summaries, so the spend cap sees it.
 */
async function saveNotes(services: AgentServices, conversationId: ConversationId, taskId: number, stored: StoredNotes, context: Context): Promise<void> {
	await services.harness().commit(async (tx) => {
		await editSession(tx, conversationId, services.now(), async (doc) => {
			if (doc.handoff?.lastTask === taskId) return;
			doc.handoff = { notes: stored.notes, compactions: (doc.handoff?.compactions ?? 0) + 1, lastTask: taskId };
			if (stored.usage === undefined) return;
			const usage = await tx.doc(UsageDoc, conversationId);
			const bucket = (usage.models[stored.usage.key] ??= {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			});
			bucket.input += stored.usage.input;
			bucket.output += stored.usage.output;
			bucket.totalTokens += stored.usage.input + stored.usage.output;
			bucket.cost.total += stored.usage.cost;
		});
	}, context);
}
