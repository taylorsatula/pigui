import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { ConversationId, EntryRecord } from "@earendil-works/pi-durable";
import { MemoryToken } from "../src/server/docs.ts";
import { SCRIPTED_MEMORY } from "../src/server/fake/model.ts";
import { MARK, SURFACE_MEMORIES } from "../src/server/memory/directives.ts";
import { fakeEmbedder } from "../src/server/memory/embedder.ts";
import type { Bootstrap } from "../src/shared/api.ts";
import { reportOf } from "../src/shared/session.ts";
import { context, modelText, TestServer } from "./helpers.ts";

/** The results of every call to `tool` in a session, in order. */
async function results(server: TestServer, id: number, tool: string): Promise<{ text: string; isError: boolean }[]> {
	return (await server.entries(id)).flatMap((entry: EntryRecord) => {
		const message = entry.model?.[0];
		return message?.role === "toolResult" && message.toolName === tool ? [{ text: modelText(entry), isError: message.isError }] : [];
	});
}

/** A session through its questions, plan approval and report. */
async function reported(server: TestServer, task: string): Promise<number> {
	const id = await server.createSession(task);
	await server.approveThrough(id);
	const done = await server.settled(id, "the report");
	assert.equal(done.outcome?.kind, "reported");
	return id;
}

async function memoryDoc(server: TestServer) {
	return server.app.harness.snapshot(MemoryToken, context);
}

describe("long-term memory", () => {
	let server: TestServer;
	let remembered: string;
	before(async () => {
		server = await TestServer.start();
	});
	after(() => server.close());

	test("a report records a memory, which a later session surfaces, rates and keeps", async () => {
		const first = await reported(server, "Add a shout() function [memory]");
		const [empty] = await results(server, first, SURFACE_MEMORIES);
		assert.match(empty!.text, /The memory store is empty/);
		assert.ok(empty!.text.includes(`${MARK} WHEN YOU FILE YOUR REPORT`), "every search ends with the report reminder");
		const filed = reportOf((await server.session(first))!.report!);
		assert.equal(filed.memory?.created.length, 1);
		assert.equal(filed.memory.created[0]!.text, SCRIPTED_MEMORY);
		remembered = filed.memory.created[0]!.id;
		assert.match(remembered, /^[0-9a-f]{8}$/);
		const stored = (await memoryDoc(server))!;
		assert.equal(stored.embedder, "fake-words");
		assert.deepEqual(stored.rows[remembered]?.sessions, [String(first)]);
		assert.equal(stored.rows[remembered]?.score, 0);

		const second = await reported(server, "Add a shout() function [memory]");
		const [found] = await results(server, second, SURFACE_MEMORIES);
		assert.match(found!.text, /^1 of 1 stored memories matched\. Highest relevance first\./);
		assert.match(found!.text, new RegExp(`\\[1\\] id: ${remembered}   similarity: 0\\.\\d+   helpfulness: 0\\n`));
		assert.ok(found!.text.includes(`    ${SCRIPTED_MEMORY}\n    ↳ last written by session ${first}\n`));
		const done = (await server.session(second))!;
		// Rated in the report's own commit, which also settles what the session was shown.
		assert.deepEqual(reportOf(done.report!).memory, { created: [], edited: [], deleted: [], helpful: 1, unhelpful: 0 });
		assert.equal(done.memoryShown, undefined);
		assert.equal((await memoryDoc(server))!.rows[remembered]?.score, 0.5);
	});

	test("a report is refused while a surfaced memory is unrated, naming it with its text", async () => {
		const id = await reported(server, "Add a shout() function [memory] [unrated]");
		const reports = await results(server, id, "file_report");
		assert.equal(reports.length, 2);
		assert.equal(reports[0]!.isError, true);
		assert.match(reports[0]!.text, /^Report refused:\n1 memory surfaced in this session is not rated\./);
		assert.ok(reports[0]!.text.includes(`- ${remembered}: ${SCRIPTED_MEMORY}`));
		assert.match(reports[1]!.text, /Report filed/);
		assert.equal(reportOf((await server.session(id))!.report!).memory?.helpful, 1);
	});

	test("an embedding model with another name re-embeds every stored memory before searching", async () => {
		await server.restart({ embedder: fakeEmbedder("fake-words-2") });
		const id = await reported(server, "Add a shout() function [memory]");
		// Vectors from the old model would not clear the floor: the memory is found only because it was re-embedded.
		const [found] = await results(server, id, SURFACE_MEMORIES);
		assert.match(found!.text, new RegExp(`id: ${remembered} `));
		const stored = (await memoryDoc(server))!;
		assert.equal(stored.embedder, "fake-words-2");
		assert.equal(Object.keys(stored.rows).length, 1);
	});
});

describe("long-term memory, when embeddings fail", () => {
	test("the report is filed without memory, and says why", async () => {
		const server = await TestServer.start({
			embedder: {
				model: "fake-words",
				floor: 0.44,
				embed: async () => {
					throw new Error("The embedding service is down.");
				},
			},
		});
		try {
			const id = await reported(server, "Add a shout() function [memory]");
			const [search] = await results(server, id, SURFACE_MEMORIES);
			assert.equal(search!.isError, true);
			const report = reportOf((await server.session(id))!.report!);
			assert.equal(report.memory, undefined);
			assert.ok(report.notes.includes("Memory was not recorded: The embedding service is down."));
			assert.deepEqual((await memoryDoc(server))?.rows ?? {}, {});
		} finally {
			await server.close();
		}
	});
});

describe("long-term memory, when off", () => {
	test("offers no search tool and no memory part, the report works as before, and the app says why", async () => {
		const off = await TestServer.start({ embedder: { off: "Off in this test." } });
		const on = await TestServer.start();
		try {
			assert.deepEqual((await off.get<Bootstrap>("/api/bootstrap")).memory, { on: false, reason: "Off in this test." });
			assert.deepEqual((await on.get<Bootstrap>("/api/bootstrap")).memory, { on: true, model: fakeEmbedder().model });
			const tools = async (server: TestServer, id: number) => {
				const conversation = await server.app.harness.conversation(id as ConversationId, context);
				return (await conversation!.agent(context)).tools;
			};
			const reportSchema = (list: Awaited<ReturnType<typeof tools>>) => list.find((tool) => tool.name === "file_report")?.parameters as { properties: Record<string, unknown>; required: string[] };
			const prompt = async (server: TestServer, id: number) => JSON.stringify((await server.entries(id)).filter((entry) => entry.kind === "pi.system").map((entry) => entry.model));

			const id = await reported(off, "Add a shout() function [memory]");
			const offered = await tools(off, id);
			assert.equal(offered.some((tool) => tool.name === SURFACE_MEMORIES), false);
			assert.equal(reportSchema(offered).properties.memory, undefined);
			assert.doesNotMatch(await prompt(off, id), /Long-term memory|surface_memories/);
			assert.equal(reportOf((await off.session(id))!.report!).memory, undefined);
			assert.equal(await memoryDoc(off), undefined);

			const other = await on.createSession("What does greet() return?");
			await on.settled(other);
			const withMemory = await tools(on, other);
			assert.ok(withMemory.some((tool) => tool.name === SURFACE_MEMORIES));
			assert.ok(reportSchema(withMemory).required.includes("memory"));
			assert.match(await prompt(on, other), /Long-term memory:/);
		} finally {
			await off.close();
			await on.close();
		}
	});
});
