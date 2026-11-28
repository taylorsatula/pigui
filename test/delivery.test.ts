import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import type { DeliveryResult, SessionDiff } from "../src/shared/api.ts";
import { git } from "../src/server/git.ts";
import { ApiFailure, repoDoc, TestServer } from "./helpers.ts";

/** Commit a file to a branch of the stand-in's bare repository, as someone else pushing to GitHub would. */
async function pushElsewhere(server: TestServer, repo: string, branch: string, path: string, content: string): Promise<void> {
	const work = await mkdtemp(join(tmpdir(), "pigui-other-"));
	try {
		await git(work, ["clone", "--quiet", "--branch", branch, server.github.remoteUrl(repo), "."]);
		await git(work, ["-c", "user.name=Other", "-c", "user.email=other@invalid", "commit", "--quiet", "--allow-empty", "-m", "noop"]);
		await writeFile(join(work, path), content);
		await git(work, ["add", "-A"]);
		await git(work, ["-c", "user.name=Other", "-c", "user.email=other@invalid", "commit", "--quiet", "-m", `Change ${path}`]);
		await git(work, ["push", "--quiet", "origin", branch]);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

async function remoteHead(server: TestServer, repo: string, branch: string): Promise<string> {
	return (await git(fileURLToPath(server.github.remoteUrl(repo)), ["rev-parse", `refs/heads/${branch}`])).stdout.trim();
}

describe("delivery", () => {
	let server: TestServer;
	before(async () => {
		server = await TestServer.start();
	});
	after(() => server.close());

	test("continuing a branch commits on top of it, and pushing updates it and its open PR", async () => {
		const tip = await remoteHead(server, "demo/greeter", "feature/farewell");
		// A pull request already open for the branch, as someone opened on GitHub.
		const existing = await server.github.createPullRequest("demo/greeter", { head: "feature/farewell", base: "main", title: "Farewell", body: "" });
		const id = await server.createSession("Add shout", { kind: "continue", branch: "feature/farewell" });
		await server.approveThrough(id);
		const done = repoDoc(await server.settled(id));
		assert.equal(done.branch, "feature/farewell");
		assert.equal(done.base, "main");
		assert.deepEqual(done.delivery.pr, existing, "the open PR is known from the start");
		assert.equal(done.startCommit, tip);
		const workspace = server.workspace(id);
		assert.equal((await git(workspace, ["merge-base", "--is-ancestor", tip, "HEAD"]).then(() => true)), true, "the work sits on the branch's tip");
		assert.equal((await git(workspace, ["rev-parse", "HEAD~1"])).stdout.trim(), tip);

		const diff = await server.get<SessionDiff>(`/api/sessions/${id}/diff`);
		assert.deepEqual(diff.files.map((file) => file.path).sort(), ["src/shout.ts", "test/shout.test.ts"], "the branch's earlier work is not this session's");

		const delivered = await server.post<DeliveryResult>(`/api/sessions/${id}/deliver`, { action: "pr" });
		assert.equal(await remoteHead(server, "demo/greeter", "feature/farewell"), delivered.pushed);
		assert.deepEqual(delivered.pr, { ...existing, created: false }, "the existing PR is reused");
		assert.equal((await server.github.pulls()).length, 1);
	});

	test("push and PR creation for a new branch, refused while Pi works, and a clear message when the remote moved", async () => {
		const id = await server.createSession("Add shout");
		const waiting = await server.until(id, (doc) => doc.card?.kind === "questions", "questions");
		await assert.rejects(server.post(`/api/sessions/${id}/deliver`, { action: "push" }), (error: unknown) => {
			assert.ok(error instanceof ApiFailure);
			assert.equal(error.status, 409);
			assert.match(error.body.error, /still working/);
			return true;
		});
		await server.answer(id, waiting.card!.id, { kind: "text", text: "Use your recommendations." });
		await server.answer(id, (await server.until(id, (doc) => doc.card?.kind === "plan", "plan")).card!.id, { kind: "approve" });
		const done = repoDoc(await server.settled(id));

		const pushed = await server.post<DeliveryResult>(`/api/sessions/${id}/deliver`, { action: "push" });
		assert.equal(pushed.pr, undefined);
		assert.equal(await remoteHead(server, "demo/greeter", done.branch), pushed.pushed);
		const opened = await server.post<DeliveryResult>(`/api/sessions/${id}/deliver`, { action: "pr" });
		assert.equal(opened.pr?.created, true);
		const again = await server.post<DeliveryResult>(`/api/sessions/${id}/deliver`, { action: "pr" });
		assert.equal(again.pr?.created, false);
		assert.equal(again.pr?.number, opened.pr?.number);

		await pushElsewhere(server, "demo/greeter", done.branch, "OTHER.md", "someone else\n");
		await server.send(id, "Also write a short note about it");
		await server.settled(id, "the follow-up");
		await assert.rejects(server.post(`/api/sessions/${id}/deliver`, { action: "push" }), (error: unknown) => {
			assert.ok(error instanceof ApiFailure);
			assert.equal(error.status, 409);
			assert.match(error.body.error, /has commits this session does not have/);
			assert.match(error.body.hint ?? "", /merge/i);
			return true;
		});
		assert.match(repoDoc(await server.session(id)).delivery.error?.message ?? "", /refused/);
	});

	test("a new session can continue another session's branch, unpushed commits and all, and push it", async () => {
		const first = await server.createSession("Add shout");
		await server.approveThrough(first);
		const earlier = repoDoc(await server.settled(first));
		const tip = (await git(server.workspace(first), ["rev-parse", "HEAD"])).stdout.trim();
		assert.notEqual(tip, earlier.startCommit, "the earlier session committed work");

		// The Branch sheet offers the branch, saying how much of it GitHub does not have.
		const sheet = await (await fetch(`${server.app.url}/ui/branches?place=repo&repo=demo/greeter&mode=new`)).text();
		assert.match(sheet, new RegExp(`data-branch="${earlier.branch}" data-from="${first}"`));
		assert.match(sheet, /\d+ not pushed/);

		const second = await server.createSession("What does greet() return?", { kind: "continue", branch: earlier.branch, from: first });
		const later = repoDoc(await server.settled(second, "the continued session's reply"));
		assert.equal(later.setup.status, "ready");
		assert.equal(later.branch, earlier.branch);
		assert.equal(later.base, earlier.base, "the base comes from the session it continues");
		assert.equal(later.startCommit, tip, "the work picks up at the earlier session's unpushed tip");
		const workspace = server.workspace(second);
		assert.equal((await git(workspace, ["remote", "get-url", "origin"])).stdout.trim(), server.github.remoteUrl("demo/greeter"), "it pushes to GitHub, not to the other clone");

		const delivered = await server.post<DeliveryResult>(`/api/sessions/${second}/deliver`, { action: "push" });
		assert.equal(await remoteHead(server, "demo/greeter", earlier.branch), delivered.pushed);
		assert.equal(delivered.pushed, tip);
	});

	test("continuing a session's branch is refused for a branch it does not work on, and fails plainly once nothing has it", async () => {
		const first = await server.createSession("Add shout");
		await server.approveThrough(first);
		const earlier = repoDoc(await server.settled(first));
		await assert.rejects(server.createSession("Go on", { kind: "continue", branch: "feature/farewell", from: first }), (error: unknown) => {
			assert.ok(error instanceof ApiFailure);
			assert.equal(error.status, 400);
			return true;
		});

		// The earlier clone is gone and the branch never reached GitHub: there is nothing to continue.
		await rm(server.workspace(first), { recursive: true, force: true });
		const id = await server.createSession("Go on", { kind: "continue", branch: earlier.branch, from: first });
		const failed = await server.until(id, (doc) => doc.setup.status === "failed", "setup failure");
		assert.match(failed.setup.status === "failed" ? failed.setup.error : "", /cleaned up and GitHub has no/);
	});

	test("a new branch without a base starts from the default branch", async () => {
		const id = await server.createSession("What does greet() return?", { kind: "new" });
		const doc = repoDoc(await server.settled(id));
		assert.equal(doc.base, "main");
		assert.deepEqual(doc.start, { kind: "new", base: "main" });
	});

	test("the diff shows only the session's changes when the base moves on", async () => {
		const id = await server.createSession("Add shout");
		await server.approveThrough(id);
		await server.settled(id);
		await pushElsewhere(server, "demo/greeter", "main", "BASE.md", "moved on\n");
		await git(server.workspace(id), ["fetch", "--quiet", "origin"]);
		await git(server.workspace(id), ["-c", "user.name=Pi", "-c", "user.email=pi@invalid", "merge", "--quiet", "--no-edit", "origin/main"]);
		const diff = await server.get<SessionDiff>(`/api/sessions/${id}/diff`);
		assert.deepEqual(diff.files.map((file) => file.path).sort(), ["src/shout.ts", "test/shout.test.ts"]);
		assert.equal(diff.uncommitted, 0);
		const file = diff.files.find((candidate) => candidate.path === "src/shout.ts");
		assert.equal(file?.added, 5);
		assert.match(file?.patch ?? "", /^@@ -0,0 \+1,5 @@/);
	});
});
