import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { DeliveryResult, SessionDiff } from "../src/shared/api.ts";
import { git } from "../src/server/git.ts";
import { ApiFailure, repoDoc, TestServer } from "./helpers.ts";

/** Commit a file to a branch of the stand-in's bare repository, as someone else pushing to GitHub would. */
async function pushElsewhere(server: TestServer, repo: string, branch: string, path: string, content: string): Promise<void> {
	const work = await mkdtemp(join(tmpdir(), "picloud-other-"));
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
	return (await git(server.github.remoteUrl(repo), ["rev-parse", `refs/heads/${branch}`])).stdout.trim();
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
