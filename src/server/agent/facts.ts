// The checkpoint's code-owned facts: what the repository looks like to git, which files the agent touched with its
// file tools, and pigui's own records of the person's words, the plan and the session. The summarizer never computes
// these; it is handed them, and the checkpoint re-renders them from the same source.
import type { Context } from "@earendil-works/chord/context";
import type { Cursor, EntryId, HookApi } from "@earendil-works/pi-durable";
import { planOf, reportOf, type RepoSessionDoc, type SessionDoc } from "../../shared/session.ts";
import { aheadBehind, changedFiles, commits, comparisonPoint, currentBranch, head, refExists, uncommitted } from "../git.ts";
import { describeEndState, describePlan } from "./plan.ts";

/** The repository's state as of the compaction. Every field is recomputed each time; nothing is carried forward. */
export type Ground = {
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

const emptyGround = (doc: Readonly<RepoSessionDoc>): Ground => ({
	branch: doc.branch,
	head: "",
	base: doc.base,
	baseKnown: false,
	ahead: 0,
	behind: 0,
	uncommitted: [],
	commits: [],
	commitTotal: 0,
	files: [],
});

/** Read a repository session's clone as it stands. A local session has no clone, so this is only called for repos. */
export async function groundTruth(workspace: string, doc: Readonly<RepoSessionDoc>): Promise<Ground> {
	const ground = emptyGround(doc);
	try {
		ground.branch = await currentBranch(workspace);
		ground.head = await head(workspace);
		ground.uncommitted = await uncommitted(workspace);
		const baseRef = `refs/remotes/origin/${doc.base}`;
		ground.baseKnown = await refExists(workspace, baseRef);
		if (ground.baseKnown) Object.assign(ground, await aheadBehind(workspace, baseRef));
		const from = doc.startCommit === undefined ? undefined : await comparisonPoint(workspace, doc.startCommit, doc.base);
		if (from === undefined) return ground;
		const range = await commits(workspace, `${from}..HEAD`, 15);
		ground.commits = range.commits;
		ground.commitTotal = range.total;
		ground.files = (await changedFiles(workspace, from)).map(({ path, added, removed, status }) => ({ path, added, removed, status }));
	} catch (error) {
		// A broken or half-set-up clone still yields a checkpoint: what could be read is kept, the rest is noted.
		ground.error = error instanceof Error ? (error.message.split("\n")[0] ?? String(error)) : String(error);
	}
	return ground;
}

export type FilesTouched = { read: string[]; modified: string[] };

type Tally = { read: Set<string>; modified: Set<string> };
const freshTally = (): Tally => ({ read: new Set(), modified: new Set() });
const asLists = (tally: Tally): FilesTouched => ({
	read: [...tally.read].filter((path) => !tally.modified.has(path)).sort(),
	modified: [...tally.modified].sort(),
});

const FILE_TOOL_READ = "read";
const FILE_TOOL_WRITE = new Set(["write", "edit"]);

/**
 * The files the agent's file tools touched, over the whole stored history, split by `split`: before it, what the
 * compaction condenses; from it, what it keeps. A path both read and changed counts as changed.
 */
export async function filesTouched(
	api: Pick<HookApi, "entries">,
	split: EntryId,
	workspace: string,
	context: Context,
): Promise<{ compacted: FilesTouched; kept: FilesTouched; all: FilesTouched }> {
	const before = freshTally();
	const after = freshTally();
	const shorten = (path: string) => (path.startsWith(`${workspace}/`) ? path.slice(workspace.length + 1) : path);
	let cursor: Cursor | undefined;
	do {
		const page = await api.entries({ order: "ascending" }, 500, cursor, context);
		for (const entry of page.items) {
			const message = entry.model?.[0];
			if (message?.role !== "assistant") continue;
			const side = entry.id < split ? before : after;
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const path = block.arguments.path;
				if (typeof path !== "string") continue;
				if (block.name === FILE_TOOL_READ) side.read.add(shorten(path));
				else if (FILE_TOOL_WRITE.has(block.name)) side.modified.add(shorten(path));
			}
		}
		cursor = page.next;
	} while (cursor !== undefined);
	const compacted = asLists(before);
	const kept = asLists(after);
	const all = asLists({
		read: new Set([...before.read, ...after.read]),
		modified: new Set([...before.modified, ...after.modified]),
	});
	return { compacted, kept, all };
}

const WORD_HEADINGS: Record<string, string> = {
	task: "Task",
	message: "Message",
	answer: "Answer to a card",
	approval: "Plan approval",
	feedback: "Plan feedback",
};

/** The person's words, verbatim, oldest first: the one part of the history that never degrades. */
export function wordLines(doc: Readonly<SessionDoc>): string[] {
	if (doc.words.length === 0) return ["(none)"];
	return doc.words.map((word) => `[${WORD_HEADINGS[word.kind] ?? word.kind}]\n"""\n${word.text}\n"""`);
}

export function planLines(doc: Readonly<SessionDoc>): string[] {
	const plan = doc.plan;
	if (plan === undefined) return ["No plan has been proposed."];
	const progress = `"${plan.title}", revision ${plan.revision}, ${plan.approved ? "approved" : "not approved yet"}; ${plan.done.length} of ${plan.steps.length} steps done.`;
	return [progress, planOf(plan).goal, describePlan(plan), describeEndState(plan)].filter((line) => line !== "");
}

export function sessionLines(doc: Readonly<SessionDoc>): string[] {
	const workflow =
		doc.workflow === "implementing"
			? "implementing the approved plan; no report filed yet"
			: doc.workflow === "reported"
				? "report filed"
				: "open (no approved plan)";
	const where = doc.place === "local" ? `Working directory ${doc.dir}, on the person's own computer, worked in place.` : `Repository ${doc.repo}; your branch ${doc.branch}; base ${doc.base}.`;
	const report = doc.report === undefined ? [] : [`Last report (${new Date(doc.report.filedAt).toISOString()}): ${reportOf(doc.report).headline}`];
	return [`Workflow: ${workflow}.`, where, ...report];
}

export function repositoryLines(ground: Ground): string[] {
	const note = ground.error === undefined ? [] : [`(Could not read all of it: ${ground.error})`];
	const aheadLine = ground.baseKnown
		? `${ground.ahead} commit${ground.ahead === 1 ? "" : "s"} ahead of origin/${ground.base}, ${ground.behind} behind.`
		: `origin/${ground.base} is not fetched.`;
	const uncommittedLine =
		ground.uncommitted.length === 0
			? "No uncommitted changes."
			: `Uncommitted changes (${ground.uncommitted.length}): ${ground.uncommitted.slice(0, 30).join(", ")}${ground.uncommitted.length > 30 ? ", …" : ""}`;
	return [...note, `On branch ${ground.branch} at ${ground.head.slice(0, 12) || "unknown"}.`, aheadLine, uncommittedLine];
}

export const commitLine = (commit: { sha: string; subject: string }) => `- ${commit.sha} ${commit.subject}`;
export const fileLine = (file: Ground["files"][number]) => `- ${file.path} (${file.status}, +${file.added} −${file.removed})`;

const listOrNone = (paths: readonly string[]) => (paths.length === 0 ? "none" : paths.join(", "));

/** The facts the summarizer is given. The checkpoint inlines the same ones; nothing here depends on the reply. */
export function promptFacts(
	doc: Readonly<SessionDoc>,
	ground: Ground | undefined,
	files: { compacted: FilesTouched; kept: FilesTouched },
): string {
	const repository =
		ground === undefined
			? []
			: [
					"Repository:",
					...repositoryLines(ground),
					`Commits in this session (${ground.commitTotal}):`,
					...(ground.commits.length === 0 ? ["- none yet"] : ground.commits.map(commitLine)),
					`Files changed in this session (${ground.files.length}):`,
					...(ground.files.length === 0 ? ["- none yet"] : ground.files.map(fileLine)),
					"",
				];
	const touched = [
		`Files read, compacted range: ${listOrNone(files.compacted.read)}`,
		`Files modified, compacted range: ${listOrNone(files.compacted.modified)}`,
		`Files read, kept range: ${listOrNone(files.kept.read)}`,
		`Files modified, kept range: ${listOrNone(files.kept.modified)}`,
	];
	return [
		"The person's words, verbatim, oldest first:",
		...wordLines(doc),
		"",
		"Plan:",
		...planLines(doc),
		"",
		"Session:",
		...sessionLines(doc),
		"",
		...repository,
		...touched,
	].join("\n");
}
