import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CLEANUP_AFTER_MS } from "../src/server/maintenance.ts";
import { context, TestServer } from "./helpers.ts";

describe("maintenance", () => {
	test("cleans up old archived workspaces, and never one with unpushed work", async () => {
		let offset = 0;
		const server = await TestServer.start({ now: () => Date.now() + offset });
		try {
			const delivered = await server.createSession("Add shout");
			await server.approveThrough(delivered);
			await server.settled(delivered);
			await server.post(`/api/sessions/${delivered}/deliver`, { action: "push" });

			const unpushed = await server.createSession("Add shout");
			await server.approveThrough(unpushed);
			assert.equal((await server.settled(unpushed)).outcome?.kind, "reported");

			const dirty = await server.createSession("What is in src?");
			await server.settled(dirty);
			await writeFile(join(server.workspace(dirty), "scratch.txt"), "not committed\n");

			const recent = await server.createSession("What is in test?");
			await server.settled(recent);

			for (const id of [delivered, unpushed, dirty]) await server.post(`/api/sessions/${id}/archive`, { archived: true });
			offset = CLEANUP_AFTER_MS + 60_000;
			await server.post(`/api/sessions/${recent}/archive`, { archived: true });

			const result = await server.app.maintenance.sweep(context);
			assert.deepEqual(result.cleaned, [delivered]);
			assert.deepEqual(result.kept.sort(), [unpushed, dirty].sort());
			assert.equal(existsSync(server.workspace(delivered)), false);
			assert.equal(existsSync(server.scratch(delivered)), false, "its commands' home and tmp go with it");
			assert.equal(existsSync(server.workspace(unpushed)), true, "unpushed commits stay");
			assert.equal(existsSync(server.scratch(unpushed)), true);
			assert.equal(existsSync(server.workspace(dirty)), true, "uncommitted changes stay");
			assert.equal(existsSync(server.workspace(recent)), true, "recently archived sessions stay");
			assert.equal(typeof (await server.session(delivered))?.cleanedAt, "number");
		} finally {
			await server.close();
		}
	});

	test("never touches a local session's directory, only pigui's own directories of it", async () => {
		let offset = 0;
		const home = await mkdtemp(join(tmpdir(), "pigui-home-"));
		await mkdir(join(home, "project"));
		await writeFile(join(home, "project", "keep.txt"), "the person's own file\n");
		const server = await TestServer.start({ now: () => Date.now() + offset, env: { PIGUI_ONPREM: "on", HOME: home } });
		try {
			const local = await server.createLocalSession("What is in this directory?", "~/project");
			await server.settled(local);
			assert.equal(existsSync(server.workspace(local)), true, "pigui keeps its own directory for the session's attachments");

			// A repository session whose clone would go, but which a local session chose to work in.
			const delivered = await server.createSession("Add shout");
			await server.approveThrough(delivered);
			await server.settled(delivered);
			await server.post(`/api/sessions/${delivered}/deliver`, { action: "push" });
			const inside = await server.createLocalSession("What is in this clone?", server.workspace(delivered));
			await server.settled(inside);

			for (const id of [local, delivered, inside]) await server.post(`/api/sessions/${id}/archive`, { archived: true });
			offset = CLEANUP_AFTER_MS + 60_000;
			const result = await server.app.maintenance.sweep(context);
			assert.deepEqual(result.cleaned.sort(), [local, inside].sort());
			assert.deepEqual(result.kept, [delivered], "a clone a local session works in is never removed");
			assert.equal(await readFile(join(home, "project", "keep.txt"), "utf8"), "the person's own file\n");
			assert.equal(existsSync(server.workspace(local)), false, "pigui's own directory of it goes");
			assert.equal(existsSync(join(server.workspace(delivered), "src", "shout.ts")), true);
			assert.equal(existsSync(home), true);
		} finally {
			await server.close();
			await rm(home, { recursive: true, force: true });
		}
	});

	test("archiving can be undone", async () => {
		const server = await TestServer.start();
		try {
			const id = await server.createSession("What is in src?");
			await server.settled(id);
			await server.post(`/api/sessions/${id}/archive`, { archived: true });
			assert.equal((await server.session(id))?.archived, true);
			await server.post(`/api/sessions/${id}/archive`, { archived: false });
			assert.equal((await server.session(id))?.archived, false);
		} finally {
			await server.close();
		}
	});

	test("backs up the database to a consistent copy", async () => {
		const server = await TestServer.start();
		try {
			const id = await server.createSession("What is in src?");
			await server.settled(id);
			const file = await server.app.maintenance.backup();
			const copy = new DatabaseSync(file, { readOnly: true });
			const tables = copy.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number };
			copy.close();
			assert.ok(tables.n > 0);
		} finally {
			await server.close();
		}
	});
});
