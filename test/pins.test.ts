import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiFailure, TestServer } from "./helpers.ts";

describe("pinning sessions as favorites", () => {
	test("a pin persists in the index, survives a restart, and is not activity", async () => {
		const server = await TestServer.start();
		try {
			const id = await server.createSession("Hello");
			const before = (await server.session(id))?.updatedAt;
			await server.post(`/api/sessions/${id}/pin`, { pinned: true });
			assert.deepEqual((await server.index())?.pinned, [id]);
			assert.equal((await server.session(id))?.updatedAt, before, "pinning is not activity");

			await server.restart();
			assert.deepEqual((await server.index())?.pinned, [id]);

			await server.post(`/api/sessions/${id}/pin`, { pinned: false });
			assert.deepEqual((await server.index())?.pinned, []);
			await server.restart();
			assert.deepEqual((await server.index())?.pinned, []);
		} finally {
			await server.close();
		}
	});

	test("pinning twice keeps one entry; pinning an unknown session answers 404", async () => {
		const server = await TestServer.start();
		try {
			const id = await server.createSession("Hello");
			await server.post(`/api/sessions/${id}/pin`, { pinned: true });
			await server.post(`/api/sessions/${id}/pin`, { pinned: true });
			assert.deepEqual((await server.index())?.pinned, [id]);

			await assert.rejects(server.post("/api/sessions/424242/pin", { pinned: true }), (error: unknown) => {
				assert.ok(error instanceof ApiFailure);
				assert.equal(error.status, 404);
				return true;
			});
		} finally {
			await server.close();
		}
	});
});
