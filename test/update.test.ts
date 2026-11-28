// End-to-end tests for deploy/update.sh against a real local bare git remote and HTTP health endpoint:
// no-op when up to date, pulls new commits on origin/main, skips dirty trees, rolls back on failed health checks, and
// remembers failed SHAs so broken commits are not retried in a loop.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const updater = join(import.meta.dirname, "..", "deploy", "update.sh");

function git(cwd: string, ...args: string[]): string {
	const res = spawnSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "test",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
	});
	assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
	return res.stdout.trim();
}

function makeFixture() {
	const dir = mkdtempSync(join(tmpdir(), "pigui-updater-"));
	const remote = join(dir, "remote.git");
	const work = join(dir, "work");
	const root = join(dir, "pigui");
	const app = join(root, "app");

	git(dir, "init", "--bare", "--initial-branch=main", remote);
	git(dir, "clone", remote, work);
	writeFileSync(join(work, "version.txt"), "v1\n");
	git(work, "add", "version.txt");
	git(work, "commit", "-m", "v1");
	git(work, "push", "origin", "main");

	git(dir, "clone", remote, app);
	const v1 = git(app, "rev-parse", "HEAD");
	git(app, "checkout", "--detach", v1);
	writeFileSync(join(root, "onprem.conf"), "REF=main\nPORT=2025\nAUTO_UPDATE=on\n");

	const pushCommit = (content: string, msg: string) => {
		writeFileSync(join(work, "version.txt"), `${content}\n`);
		git(work, "add", "version.txt");
		git(work, "commit", "-m", msg);
		git(work, "push", "origin", "main");
		return git(work, "rev-parse", "HEAD");
	};

	const runUpdater = (env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> =>
		new Promise((resolve, reject) => {
			const child = spawn("bash", [updater], {
				env: {
					...process.env,
					PIGUI_ROOT: root,
					PIGUI_APP_DIR: app,
					PIGUI_CONF: join(root, "onprem.conf"),
					PIGUI_UPDATE_SKIP_NPM: "1",
					PIGUI_UPDATE_HEALTH_TIMEOUT: "2",
					...env,
				},
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
			child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
			child.once("error", reject);
			child.once("close", (status) => resolve({ status, stdout, stderr }));
		});

	return { dir, root, app, v1, pushCommit, runUpdater };
}

test("deploy/update.sh passes syntax check, no-ops when current, pulls new commits, and skips dirty checkouts", async () => {
	assert.equal(spawnSync("bash", ["-n", updater], { encoding: "utf8" }).status, 0);

	const fx = makeFixture();
	const server = createServer((_req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end("{}");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const port = (server.address() as AddressInfo).port;
	const restartsFile = join(fx.dir, "restarts.log");
	const env = {
		PIGUI_UPDATE_HEALTH_URL: `http://127.0.0.1:${port}/api/bootstrap`,
		PIGUI_UPDATE_RESTART_CMD: `echo restarted >> '${restartsFile}'`,
	};

	try {
		// 1. Up to date: exits 0 and does not restart.
		const noop = await fx.runUpdater(env);
		assert.equal(noop.status, 0, noop.stderr);
		assert.match(noop.stdout, /up to date/);
		assert.throws(() => readFileSync(restartsFile), "no restart when already current");

		// 2. New commit on origin/main: updates cleanly and restarts once.
		const v2 = fx.pushCommit("v2", "v2");
		const updated = await fx.runUpdater(env);
		assert.equal(updated.status, 0, updated.stderr + updated.stdout);
		assert.match(updated.stdout, /verified healthy/);
		assert.equal(git(fx.app, "rev-parse", "HEAD"), v2);
		assert.equal(readFileSync(join(fx.app, "version.txt"), "utf8"), "v2\n");
		assert.equal(readFileSync(restartsFile, "utf8").trim().split("\n").length, 1);

		// 3. Dirty tracked file: skips update without clobbering local changes.
		fx.pushCommit("v3", "v3");
		writeFileSync(join(fx.app, "version.txt"), "local-edit\n");
		const dirty = await fx.runUpdater(env);
		assert.equal(dirty.status, 0, dirty.stderr);
		assert.match(dirty.stdout, /tracked local changes present/);
		assert.equal(git(fx.app, "rev-parse", "HEAD"), v2);
		assert.equal(readFileSync(join(fx.app, "version.txt"), "utf8"), "local-edit\n");
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test("deploy/update.sh rolls back on failed health check and skips the broken commit on the next run", async () => {
	const fx = makeFixture();
	const server = createServer((_req, res) => {
		res.writeHead(500);
		res.end("broken");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const port = (server.address() as AddressInfo).port;
	const restartsFile = join(fx.dir, "restarts.log");
	const env = {
		PIGUI_UPDATE_HEALTH_URL: `http://127.0.0.1:${port}/api/bootstrap`,
		PIGUI_UPDATE_RESTART_CMD: `echo restarted >> '${restartsFile}'`,
	};

	try {
		const broken = fx.pushCommit("broken", "broken commit");
		const failed = await fx.runUpdater(env);
		assert.equal(failed.status, 1);
		assert.match(failed.stdout, /rolling back/);
		assert.equal(git(fx.app, "rev-parse", "HEAD"), fx.v1, "rolled back to v1");
		assert.equal(readFileSync(join(fx.root, "update-failed-sha"), "utf8").trim(), broken);
		// Restarted once for broken commit, once on rollback.
		assert.equal(readFileSync(restartsFile, "utf8").trim().split("\n").length, 2);

		// Next daily tick skips the already-failed SHA without restarting again.
		const skipped = await fx.runUpdater(env);
		assert.equal(skipped.status, 0, skipped.stderr);
		assert.match(skipped.stdout, /previous update attempt failed/);
		assert.equal(readFileSync(restartsFile, "utf8").trim().split("\n").length, 2);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(fx.dir, { recursive: true, force: true });
	}
});
