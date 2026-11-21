// Where repositories live: GitHub through `gh` in real mode, a local stand-in in fake mode. Workspaces clone from and
// push to `remoteUrl()` with plain git either way, so only listing and pull requests differ.
import type { BranchList, FileList, RepoSummary } from "../shared/api.ts";
import type { PullRequestRef } from "../shared/session.ts";
import { CommandError, run } from "./exec.ts";
import { GIT_ENV } from "./git.ts";

export type PullRequestInfo = PullRequestRef & { base: string };

export type NewPullRequest = {
	head: string;
	base: string;
	title: string;
	body: string;
};

export interface RepoHost {
	listRepos(): Promise<RepoSummary[]>;
	branches(repo: string): Promise<BranchList>;
	/** Files at `ref`, read without cloning, for the `@` picker of a session not started yet. */
	files(repo: string, ref: string): Promise<FileList>;
	/** A file's text at `ref`, or undefined when it is absent. */
	readFile(repo: string, ref: string, path: string): Promise<string | undefined>;
	remoteUrl(repo: string): string;
	/** The open pull request whose head is `branch`. */
	findPullRequest(repo: string, branch: string): Promise<PullRequestInfo | undefined>;
	createPullRequest(repo: string, request: NewPullRequest): Promise<PullRequestRef>;
}

/** A GitHub call that failed, with what to check. */
class HostError extends Error {}

const MAX_FILES = 20_000;

/** GitHub through the `gh` CLI, authenticated as the service user (`gh auth login`). */
export class GhHost implements RepoHost {
	async #gh(args: readonly string[], input?: string): Promise<string> {
		try {
			const options = input === undefined ? { env: GIT_ENV, timeoutMs: 60_000 } : { env: GIT_ENV, timeoutMs: 60_000, input };
			return (await run("gh", args, options)).stdout;
		} catch (error) {
			if (error instanceof CommandError && error.exitCode === null) {
				throw new HostError("The gh CLI is not installed for the picloud service user.", { cause: error });
			}
			if (error instanceof CommandError && /auth login|not logged|authentication/i.test(error.stderr)) {
				throw new HostError("gh is not signed in. As the service user, run `gh auth login` with a fine-grained token.", {
					cause: error,
				});
			}
			throw new HostError(error instanceof Error ? error.message : String(error), { cause: error });
		}
	}

	#lines(text: string): unknown[] {
		return text
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line) as unknown);
	}

	async listRepos(): Promise<RepoSummary[]> {
		const text = await this.#gh([
			"api",
			"--paginate",
			"user/repos?per_page=100&sort=pushed",
			"--jq",
			".[] | {name: .full_name, defaultBranch: .default_branch, description: (.description // \"\")}",
		]);
		return this.#lines(text).map((row) => {
			const { name, defaultBranch, description } = row as { name: string; defaultBranch: string; description: string };
			return description === "" ? { name, defaultBranch } : { name, defaultBranch, description };
		});
	}

	async branches(repo: string): Promise<BranchList> {
		const defaultBranch = (await this.#gh(["api", `repos/${repo}`, "--jq", ".default_branch"])).trim();
		const names = await this.#gh(["api", "--paginate", `repos/${repo}/branches?per_page=100`, "--jq", ".[].name"]);
		return { defaultBranch, branches: names.split("\n").filter((name) => name !== "") };
	}

	async files(repo: string, ref: string): Promise<FileList> {
		const text = await this.#gh([
			"api",
			`repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
			"--jq",
			"{truncated: .truncated, files: [.tree[] | select(.type == \"blob\") | .path]}",
		]);
		const listing = JSON.parse(text) as { truncated: boolean; files: string[] };
		return { files: listing.files.slice(0, MAX_FILES), truncated: listing.truncated || listing.files.length > MAX_FILES };
	}

	async readFile(repo: string, ref: string, path: string): Promise<string | undefined> {
		try {
			const encoded = path.split("/").map(encodeURIComponent).join("/");
			return await this.#gh(["api", `repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, "-H", "Accept: application/vnd.github.raw"]);
		} catch {
			return undefined;
		}
	}

	remoteUrl(repo: string): string {
		return `https://github.com/${repo}.git`;
	}

	async findPullRequest(repo: string, branch: string): Promise<PullRequestInfo | undefined> {
		const text = await this.#gh([
			"pr",
			"list",
			"--repo",
			repo,
			"--head",
			branch,
			"--state",
			"open",
			"--limit",
			"1",
			"--json",
			"number,url,baseRefName",
		]);
		const [found] = JSON.parse(text) as { number: number; url: string; baseRefName: string }[];
		return found === undefined ? undefined : { number: found.number, url: found.url, base: found.baseRefName };
	}

	async createPullRequest(repo: string, request: NewPullRequest): Promise<PullRequestRef> {
		const url = (
			await this.#gh(
				["pr", "create", "--repo", repo, "--head", request.head, "--base", request.base, "--title", request.title, "--body-file", "-"],
				request.body,
			)
		).trim();
		const number = Number(url.slice(url.lastIndexOf("/") + 1));
		if (!Number.isInteger(number)) throw new HostError(`gh pr create returned an unexpected URL: ${url}`);
		return { number, url };
	}
}
