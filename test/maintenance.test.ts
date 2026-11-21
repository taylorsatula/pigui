import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
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
			assert.equal(existsSync(server.workspace(unpushed)), true, "unpushed commits stay");
			assert.equal(existsSync(server.workspace(dirty)), true, "uncommitted changes stay");
			assert.equal(existsSync(server.workspace(recent)), true, "recently archived sessions stay");
			assert.equal(typeof (await server.session(delivered))?.cleanedAt, "number");
		} finally {
			await server.close();
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
