// The facts a checkpoint carries that code computes, never the summarizer: the repository as git sees it, the files the
// agent read and changed with its file tools, and picloud's own records of the person's words, the plan and the session.
import type { Context } from "@earendil-works/chord/context";
import type { Cursor, EntryId, HookApi } from "@earendil-works/pi-durable";
import type { SessionDoc } from "../../shared/session.ts";
import { aheadBehind, changedFiles, commits, comparisonPoint, currentBranch, head, refExists, uncommitted } from "../git.ts";
import { describePlan } from "./plan.ts";

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

/** The repository as it is now, read from the workspace. */
export async function groundTruth(workspace: string, doc: Readonly<SessionDoc>): Promise<Ground> {
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

export type FilesTouched = { read: string[]; modified: string[] };

/**
 * Files the agent read and changed through its file tools, from the whole stored history: before `split` (everything
 * compacted, now and earlier) and from it (the kept range). A file both read and changed counts as changed.
 */
export async function filesTouched(api: Pick<HookApi, "entries">, split: EntryId, workspace: string, context: Context): Promise<{ compacted: FilesTouched; kept: FilesTouched; all: FilesTouched }> {
	const sets = { compacted: { read: new Set<string>(), modified: new Set<string>() }, kept: { read: new Set<string>(), modified: new Set<string>() } };
	const relative = (path: string) => (path.startsWith(`${workspace}/`) ? path.slice(workspace.length + 1) : path);
	let cursor: Cursor | undefined;
	do {
		const page = await api.entries({ order: "ascending" }, 500, cursor, context);
		for (const entry of page.items) {
			const message = entry.model?.[0];
			if (message?.role !== "assistant") continue;
			const side = entry.id < split ? sets.compacted : sets.kept;
			for (const block of message.content) {
				if (block.type !== "toolCall" || typeof block.arguments.path !== "string") continue;
				if (block.name === "read") side.read.add(relative(block.arguments.path));
				else if (block.name === "write" || block.name === "edit") side.modified.add(relative(block.arguments.path));
			}
		}
		cursor = page.next;
	} while (cursor !== undefined);
	const lists = (read: Set<string>, modified: Set<string>): FilesTouched => ({ read: [...read].filter((path) => !modified.has(path)).sort(), modified: [...modified].sort() });
	return {
		compacted: lists(sets.compacted.read, sets.compacted.modified),
		kept: lists(sets.kept.read, sets.kept.modified),
		all: lists(new Set([...sets.compacted.read, ...sets.kept.read]), new Set([...sets.compacted.modified, ...sets.kept.modified])),
	};
}

const WORD_LABEL: Record<string, string> = {
	task: "Task",
	message: "Message",
	answer: "Answer to a card",
	approval: "Plan approval",
	feedback: "Plan feedback",
};

export function wordLines(doc: Readonly<SessionDoc>): string[] {
	return doc.words.length === 0 ? ["(none)"] : doc.words.map((word) => `[${WORD_LABEL[word.kind] ?? word.kind}]\n"""\n${word.text}\n"""`);
}

export function planLines(doc: Readonly<SessionDoc>): string[] {
	const plan = doc.plan;
	if (plan === undefined) return ["No plan has been proposed."];
	return [`"${plan.title}", revision ${plan.revision}, ${plan.approved ? "approved" : "not approved yet"}; ${plan.done.length} of ${plan.steps.length} steps done.`, plan.summary, describePlan(plan)];
}

export function sessionLines(doc: Readonly<SessionDoc>): string[] {
	const workflow = doc.workflow === "implementing" ? "implementing the approved plan; no report filed yet" : doc.workflow === "reported" ? "report filed" : "open (no approved plan)";
	return [
		`Workflow: ${workflow}.`,
		`Repository ${doc.repo}; your branch ${doc.branch}; base ${doc.base}.`,
		...(doc.report === undefined ? [] : [`Last report (${new Date(doc.report.filedAt).toISOString()}): ${doc.report.summary}`]),
	];
}

export function repositoryLines(ground: Ground): string[] {
	return [
		...(ground.error === undefined ? [] : [`(Could not read all of it: ${ground.error})`]),
		`On branch ${ground.branch} at ${ground.head.slice(0, 12) || "unknown"}.`,
		ground.baseKnown ? `${ground.ahead} commit${ground.ahead === 1 ? "" : "s"} ahead of origin/${ground.base}, ${ground.behind} behind.` : `origin/${ground.base} is not fetched.`,
		ground.uncommitted.length === 0
			? "No uncommitted changes."
			: `Uncommitted changes (${ground.uncommitted.length}): ${ground.uncommitted.slice(0, 30).join(", ")}${ground.uncommitted.length > 30 ? ", …" : ""}`,
	];
}

export const commitLine = (commit: { sha: string; subject: string }) => `- ${commit.sha} ${commit.subject}`;
export const fileLine = (file: Ground["files"][number]) => `- ${file.path} (${file.status}, +${file.added} −${file.removed})`;
const pathList = (paths: readonly string[]) => (paths.length === 0 ? "none" : paths.join(", "));

/** The facts the summarizer is given, in full; the checkpoint carries the same ones, shed to fit if need be. */
export function promptFacts(doc: Readonly<SessionDoc>, ground: Ground, files: { compacted: FilesTouched; kept: FilesTouched }): string {
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
		"Repository:",
		...repositoryLines(ground),
		`Commits in this session (${ground.commitTotal}):`,
		...(ground.commits.length === 0 ? ["- none yet"] : ground.commits.map(commitLine)),
		`Files changed in this session (${ground.files.length}):`,
		...(ground.files.length === 0 ? ["- none yet"] : ground.files.map(fileLine)),
		"",
		`Files read, compacted range: ${pathList(files.compacted.read)}`,
		`Files modified, compacted range: ${pathList(files.compacted.modified)}`,
		`Files read, kept range: ${pathList(files.kept.read)}`,
		`Files modified, kept range: ${pathList(files.kept.modified)}`,
	].join("\n");
}
