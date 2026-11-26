import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Fields, Logger } from "../src/server/log.ts";
import { TestServer } from "./helpers.ts";

type Line = { level: string; event: string } & Fields;

/** A logger that keeps every line, so a test can read the journal. */
function recordingLogger(): { log: Logger; lines: Line[] } {
	const lines: Line[] = [];
	const keep = (level: string) => (event: string, fields?: Fields) => lines.push({ level, event, ...fields });
	return { lines, log: { info: keep("info"), warn: keep("warn"), error: keep("error") } };
}

describe("tool diagnostics", () => {
	let server: TestServer;
	let journal: Line[];
	before(async () => {
		const recording = recordingLogger();
		journal = recording.lines;
		server = await TestServer.start({ log: recording.log });
	});
	after(() => server.close());

	test("a validation-failure diagnostic lands in the journal with the arguments payload cut", async () => {
		const id = await server.createSession("Add shout [bad-report]");
		await server.approveThrough(id);
		const done = await server.settled(id);
		assert.equal(done.outcome?.kind, "reported");
		const diagnostics = journal.filter((line) => line.event === "tool.diagnostics");
		assert.ok(diagnostics.some((line) => line.tool === "file_report" && line.code === "invalid_arguments"), `expected a file_report invalid_arguments line, got ${JSON.stringify(diagnostics)}`);
		for (const line of diagnostics) assert.ok(!String(line.message ?? "").includes("Received arguments"), `payload leaked: ${line.message}`);
		for (const line of diagnostics) assert.ok(!String(line.message ?? "").includes("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"), `arguments leaked: ${line.message}`);
	});
});
