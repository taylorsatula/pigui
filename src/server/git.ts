// Every git operation pigui performs on a workspace, run as plain `git` without a shell.
import { rename, rm } from "node:fs/promises";
import type { DiffFile } from "../shared/api.ts";
import { CommandError, run, type RunResult } from "./exec.ts";

/** Never prompt: a prompt would hang a run with nobody at the keyboard. Agent commands get these too. */
export const NO_PROMPT_ENV: Readonly<Record<string, string>> = {
	GIT_TERMINAL_PROMPT: "0",
	GCM_INTERACTIVE: "never",
	GIT_ASKPASS: "",
	SSH_ASKPASS: "",
};

/** pigui's own git calls run in its environment and also fix the locale, so the output it parses is always the same. */
export const GIT_ENV: NodeJS.ProcessEnv = { ...process.env, ...NO_PROMPT_ENV, LC_ALL: "C" };

export function git(cwd: string, args: readonly string[], timeoutMs = 120_000): Promise<RunResult> {
	return run("git", args, { cwd, env: GIT_ENV, timeoutMs });
}

async function stdoutOf(cwd: string, args: readonly string[]): Promise<string> {
	return (await git(cwd, args)).stdout.trim();
}

/**
 * Clone `ref` of `url` into `dir`. It clones beside `dir` and renames into place, so a clone a crash interrupted never
 * looks like a workspace; a rerun after a crash starts the clone over.
 */
export async function cloneInto(url: string, ref: string, dir: string): Promise<void> {
	const staging = `${dir}.cloning`;
	await rm(staging, { recursive: true, force: true });
	await run("git", ["clone", "--quiet", "--branch", ref, "--", url, staging], { env: GIT_ENV, timeoutMs: 15 * 60_000 });
	await rename(staging, dir);
}

export async function isRepository(dir: string): Promise<boolean> {
	try {
		return (await stdoutOf(dir, ["rev-parse", "--is-inside-work-tree"])) === "true";
	} catch {
		return false;
	}
}

export function head(cwd: string): Promise<string> {
	return stdoutOf(cwd, ["rev-parse", "HEAD"]);
}

export function currentBranch(cwd: string): Promise<string> {
	return stdoutOf(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
	try {
		await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
		return true;
	} catch {
		return false;
	}
}

/** Paths with uncommitted changes, as `git status` lists them (ignored and excluded files left out). */
export async function uncommitted(cwd: string): Promise<string[]> {
	const status = (await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
	const paths: string[] = [];
	const records = status.split("\0");
	for (let index = 0; index < records.length; index++) {
		const record = records[index] ?? "";
		if (record.length < 4) continue;
		paths.push(record.slice(3));
		// A rename or copy is followed by its source path as a record of its own.
		if (record[0] === "R" || record[0] === "C") index++;
	}
	return paths;
}

export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
	try {
		await git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
		return true;
	} catch (error) {
		if (error instanceof CommandError && error.exitCode === 1) return false;
		throw error;
	}
}

async function mergeBase(cwd: string, a: string, b: string): Promise<string | undefined> {
	try {
		return await stdoutOf(cwd, ["merge-base", a, b]);
	} catch {
		return undefined;
	}
}

export async function refExists(cwd: string, ref: string): Promise<boolean> {
	try {
		await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
		return true;
	} catch {
		return false;
	}
}

/** Update the remote-tracking ref of `branch`; a failure is returned, not thrown, since callers can go on without it. */
export async function fetchBranch(cwd: string, branch: string): Promise<string | undefined> {
	try {
		await git(cwd, ["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], 120_000);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

export type Commit = { sha: string; subject: string };

export async function commits(cwd: string, range: string, max: number): Promise<{ commits: Commit[]; total: number }> {
	const total = Number(await stdoutOf(cwd, ["rev-list", "--count", range]));
	const log = await stdoutOf(cwd, ["log", `--max-count=${max}`, "--format=%h%x09%s", range]);
	if (log === "") return { commits: [], total };
	const list = log.split("\n").map((line) => {
		const [sha = "", ...rest] = line.split("\t");
		return { sha, subject: rest.join("\t") };
	});
	return { commits: list, total };
}

/**
 * The commit a session's changes are measured from. A new branch starts at its base's tip; when Pi later merges a newer
 * base, the fork point moves with it, so the base's own changes never count as the session's. A continued branch starts
 * at its tip when the session began, so its earlier commits do not count either.
 */
export async function comparisonPoint(cwd: string, startCommit: string, base: string): Promise<string> {
	const baseRef = `refs/remotes/origin/${base}`;
	if (!(await refExists(cwd, baseRef))) return startCommit;
	const fork = await mergeBase(cwd, "HEAD", baseRef);
	if (fork !== undefined && (await isAncestor(cwd, startCommit, fork))) return fork;
	return startCommit;
}

/** Commits on `branch`, or on any local branch, that no `origin` branch has. */
export async function unpushedCount(cwd: string, branch?: string): Promise<number> {
	const from = branch === undefined ? "--branches" : `refs/heads/${branch}`;
	return Number(await stdoutOf(cwd, ["rev-list", "--count", from, "--not", "--remotes=origin"]));
}

export class PushRejected extends Error {}

/** Push HEAD to `branch` on origin, never forcing. A remote that moved on is a `PushRejected` the person can act on. */
export async function push(cwd: string, branch: string): Promise<void> {
	try {
		await git(cwd, ["push", "--porcelain", "--set-upstream", "origin", `HEAD:refs/heads/${branch}`], 5 * 60_000);
	} catch (error) {
		const output = error instanceof CommandError ? error.stdout + error.stderr : "";
		if (error instanceof CommandError && /\[rejected\]|non-fast-forward|fetch first/.test(output)) {
			throw new PushRejected(
				`GitHub's ${branch} has commits this session does not have, so the push was refused.`,
				{ cause: error },
			);
		}
		throw error;
	}
}

/** How many commits HEAD has that `ref` does not, and the other way round. */
export async function aheadBehind(cwd: string, ref: string): Promise<{ ahead: number; behind: number }> {
	const [behind = "0", ahead = "0"] = (await stdoutOf(cwd, ["rev-list", "--left-right", "--count", `${ref}...HEAD`])).split(/\s+/);
	return { ahead: Number(ahead), behind: Number(behind) };
}

const MAX_PATCH_BYTES = 200_000;

/** The changes between `from` and HEAD, one entry per file, with added and removed line counts but no patches. */
export async function changedFiles(cwd: string, from: string): Promise<DiffFile[]> {
	const range = [from, "HEAD"];
	const numstat = (await git(cwd, ["diff", "--numstat", "-z", "-M", ...range])).stdout;
	const files: DiffFile[] = [];
	const records = numstat.split("\0");
	for (let index = 0; index < records.length; index++) {
		const record = records[index] ?? "";
		if (record === "") continue;
		const [added = "", removed = "", path = ""] = record.split("\t");
		const binary = added === "-";
		let file: DiffFile;
		if (path === "") {
			// A rename: the counts stand alone and the old and new paths follow as records of their own.
			const fromPath = records[index + 1] ?? "";
			const toPath = records[index + 2] ?? "";
			index += 2;
			file = { path: toPath, from: fromPath, status: "renamed", added: 0, removed: 0, binary, patch: "", truncated: false };
		} else {
			file = { path, status: "modified", added: 0, removed: 0, binary, patch: "", truncated: false };
		}
		file.added = binary ? 0 : Number(added);
		file.removed = binary ? 0 : Number(removed);
		files.push(file);
	}
	const status = (await git(cwd, ["diff", "--name-status", "-z", "-M", ...range])).stdout.split("\0");
	for (let index = 0; index < status.length; index++) {
		const code = status[index] ?? "";
		if (code === "") continue;
		const path = status[index + 1] ?? "";
		const file = files.find((candidate) => candidate.path === path || candidate.from === path);
		if (code.startsWith("R")) {
			index += 2;
			continue;
		}
		index += 1;
		if (file !== undefined) file.status = code === "A" ? "added" : code === "D" ? "deleted" : "modified";
	}
	return files;
}

/** `changedFiles` with each text file's patch. */
export async function diffFiles(cwd: string, from: string): Promise<DiffFile[]> {
	const range = [from, "HEAD"];
	const files = await changedFiles(cwd, from);
	for (const file of files) {
		if (file.binary) continue;
		const paths = file.from === undefined ? [file.path] : [file.from, file.path];
		const patch = (await git(cwd, ["diff", "-M", "--no-color", "--no-ext-diff", ...range, "--", ...paths])).stdout;
		const body = patch.slice(Math.max(0, patch.indexOf("\n@@") + 1));
		file.truncated = body.length > MAX_PATCH_BYTES;
		file.patch = file.truncated ? body.slice(0, MAX_PATCH_BYTES) : body;
	}
	return files;
}

/** Files tracked at HEAD, for the `@` picker. */
export async function trackedFiles(cwd: string): Promise<string[]> {
	const listing = (await git(cwd, ["ls-files", "-z"])).stdout;
	return listing.split("\0").filter((path) => path !== "");
}
