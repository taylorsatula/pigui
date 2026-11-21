// A local stand-in for GitHub: bare repositories that workspaces clone from and push to with ordinary git, and pull
// requests kept in a JSON file, so both survive a restart.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BranchList, FileList, RepoSummary } from "../../shared/api.ts";
import type { PullRequestRef } from "../../shared/session.ts";
import { git } from "../git.ts";
import type { NewPullRequest, PullRequestInfo, RepoHost } from "../host.ts";
import { FIXTURE_REPOS, type FixtureRepo } from "./fixtures.ts";

type StoredPull = PullRequestInfo & {
	repo: string;
	head: string;
	title: string;
	body: string;
	state: "open" | "closed";
};

export class LocalGitHub implements RepoHost {
	readonly root: string;

	private constructor(root: string) {
		this.root = root;
	}

	/** Open the stand-in under `root`, creating the fixture repositories the first time. */
	static async open(root: string): Promise<LocalGitHub> {
		const host = new LocalGitHub(root);
		for (const fixture of FIXTURE_REPOS) {
			if (!existsSync(host.remoteUrl(fixture.name))) await host.#seed(fixture);
		}
		return host;
	}

	async #seed(fixture: FixtureRepo): Promise<void> {
		const bare = this.remoteUrl(fixture.name);
		await mkdir(dirname(bare), { recursive: true });
		const work = await mkdtemp(join(this.root, "seed-"));
		try {
			await git(work, ["init", "--quiet", `--initial-branch=${fixture.defaultBranch}`]);
			await git(work, ["config", "user.name", "Fixture"]);
			await git(work, ["config", "user.email", "fixture@picloud.invalid"]);
			await writeFiles(work, fixture.files);
			await git(work, ["add", "-A"]);
			await git(work, ["commit", "--quiet", "-m", "Initial commit"]);
			for (const branch of fixture.branches) {
				await git(work, ["switch", "--quiet", "-c", branch.name, fixture.defaultBranch]);
				await writeFiles(work, branch.files);
				await git(work, ["add", "-A"]);
				await git(work, ["commit", "--quiet", "-m", branch.message]);
			}
			await git(work, ["switch", "--quiet", fixture.defaultBranch]);
			const staging = `${bare}.seeding`;
			await rm(staging, { recursive: true, force: true });
			await git(this.root, ["clone", "--quiet", "--bare", work, staging]);
			await rename(staging, bare);
		} finally {
			await rm(work, { recursive: true, force: true });
		}
	}

	async listRepos(): Promise<RepoSummary[]> {
		return FIXTURE_REPOS.map((fixture) => ({ name: fixture.name, defaultBranch: fixture.defaultBranch, description: fixture.description }));
	}

	async branches(repo: string): Promise<BranchList> {
		const bare = this.#bare(repo);
		const listing = (await git(bare, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])).stdout;
		const defaultBranch = (await git(bare, ["symbolic-ref", "--short", "HEAD"])).stdout.trim();
		return { defaultBranch, branches: listing.split("\n").filter((name) => name !== "") };
	}

	async files(repo: string, ref: string): Promise<FileList> {
		const listing = (await git(this.#bare(repo), ["ls-tree", "-r", "-z", "--name-only", `refs/heads/${ref}`])).stdout;
		return { files: listing.split("\0").filter((path) => path !== ""), truncated: false };
	}

	async readFile(repo: string, ref: string, path: string): Promise<string | undefined> {
		try {
			return (await git(this.#bare(repo), ["show", `refs/heads/${ref}:${path}`])).stdout;
		} catch {
			return undefined;
		}
	}

	remoteUrl(repo: string): string {
		return join(this.root, "repos", `${repo}.git`);
	}

	#bare(repo: string): string {
		if (!FIXTURE_REPOS.some((fixture) => fixture.name === repo)) throw new Error(`No repository ${repo} in fake mode.`);
		return this.remoteUrl(repo);
	}

	async findPullRequest(repo: string, branch: string): Promise<PullRequestInfo | undefined> {
		const found = (await this.#pulls()).find((pull) => pull.repo === repo && pull.head === branch && pull.state === "open");
		return found === undefined ? undefined : { number: found.number, url: found.url, base: found.base };
	}

	async createPullRequest(repo: string, request: NewPullRequest): Promise<PullRequestRef> {
		this.#bare(repo);
		const pulls = await this.#pulls();
		if (pulls.some((pull) => pull.repo === repo && pull.head === request.head && pull.state === "open")) {
			throw new Error(`A pull request for ${request.head} already exists.`);
		}
		const number = pulls.filter((pull) => pull.repo === repo).length + 1;
		const url = `https://github.invalid/${repo}/pull/${number}`;
		pulls.push({ repo, number, url, state: "open", ...request });
		const file = this.#pullsFile();
		await writeFile(`${file}.tmp`, JSON.stringify(pulls, null, 2));
		await rename(`${file}.tmp`, file);
		return { number, url };
	}

	/** Every pull request, for tests and the README's walkthrough. */
	async pulls(): Promise<readonly StoredPull[]> {
		return this.#pulls();
	}

	#pullsFile(): string {
		return join(this.root, "pulls.json");
	}

	async #pulls(): Promise<StoredPull[]> {
		try {
			return JSON.parse(await readFile(this.#pullsFile(), "utf8")) as StoredPull[];
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}
}

async function writeFiles(root: string, files: Record<string, string | Uint8Array | null>): Promise<void> {
	for (const [path, content] of Object.entries(files)) {
		const target = join(root, path);
		if (content === null) {
			await rm(target, { force: true });
			continue;
		}
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content);
	}
}
