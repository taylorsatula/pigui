import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { UploadedAttachment } from "../src/shared/api.ts";
import { activeTrigger, findReferences, insertReference, narrow } from "../src/shared/references.ts";
import { MESSAGE_ENTRY, type MessageEntryData } from "../src/shared/session.ts";
import { MAX_INCLUDED_FILE_BYTES } from "../src/server/input.ts";
import { git } from "../src/server/git.ts";
import { modelText, TestServer } from "./helpers.ts";

describe("reference syntax", () => {
	test("finds @files and #skills but not emails, issue numbers or mid-word sigils", () => {
		const text = "See @src/greet.ts, then #release-notes. Mail me@example.com about #123 and a#b (@docs/guide.md)";
		assert.deepEqual(
			findReferences(text).map(({ kind, value }) => [kind, value]),
			[
				["file", "src/greet.ts"],
				["skill", "release-notes"],
				["file", "docs/guide.md"],
			],
		);
	});

	test("opens the picker only where a reference can start, and inserts the choice", () => {
		assert.deepEqual(activeTrigger("look at @src/gr", 15), { kind: "file", query: "src/gr", start: 8 });
		assert.deepEqual(activeTrigger("#rel", 4), { kind: "skill", query: "rel", start: 0 });
		assert.equal(activeTrigger("me@exam", 7), undefined);
		assert.equal(activeTrigger("fixes #12", 9), undefined);
		assert.equal(activeTrigger("@src done", 9), undefined);
		const trigger = activeTrigger("read @gre please", 9)!;
		assert.deepEqual(insertReference("read @gre please", trigger, 9, "src/greet.ts"), { text: "read @src/greet.ts please", caret: 18 });
	});

	test("narrows candidates as the person types", () => {
		const files = ["src/greet.ts", "test/greet.test.ts", "docs/guide.md", "README.md"];
		assert.deepEqual(narrow(files, "", 10), files.slice().sort((a, b) => a.length - b.length || a.localeCompare(b)));
		assert.deepEqual(narrow(files, "greet", 10), ["src/greet.ts", "test/greet.test.ts"]);
		assert.deepEqual(narrow(files, "gd", 10), ["docs/guide.md"]);
		assert.deepEqual(narrow(files, "zzz", 10), []);
	});
});

describe("references in messages", () => {
	let server: TestServer;
	let id: number;
	before(async () => {
		server = await TestServer.start();
		id = await server.createSession("What is in src?");
		await server.settled(id);
	});
	after(() => server.close());

	test("a file reference brings its contents and a skill reference invokes the skill as Pi does", async () => {
		const text = "Check @src/greet.ts with #release-notes, not @missing.ts or #unknown-skill. Mail me@example.com about #42?";
		await server.send(id, text);
		await server.settled(id);
		const entry = (await server.entries(id)).filter((candidate) => candidate.kind === MESSAGE_ENTRY).at(-1)!;
		const data = entry.data as MessageEntryData;
		assert.equal(data.text, text, "the person's text is kept exactly as typed");
		assert.deepEqual(
			data.references.map(({ kind, value, status }) => [kind, value, status]),
			[
				["file", "src/greet.ts", "included"],
				["skill", "release-notes", "skill"],
			],
		);
		const sent = modelText(entry);
		assert.match(sent, /<file path="src\/greet\.ts">\nexport function greet/);
		const skillPath = join(server.workspace(id), ".pi", "skills", "release-notes", "SKILL.md");
		assert.ok(sent.includes(`<skill name="release-notes" location="${skillPath}">\nReferences are relative to ${join(server.workspace(id), ".pi", "skills", "release-notes")}.\n\n# Release notes`));
		assert.ok(!sent.includes("description: Write release notes"), "the skill's frontmatter is stripped");
		assert.ok(sent.endsWith(text), "the person's text follows the added context");
		assert.ok(!sent.includes("<file path=\"missing.ts\""));
		assert.ok(!sent.includes("unknown-skill\">"));
	});

	test("large and binary files become pointers", async () => {
		await writeFile(join(server.workspace(id), "big.txt"), "x".repeat(MAX_INCLUDED_FILE_BYTES + 1));
		await server.send(id, "Look at @big.txt and @assets/logo.png?");
		await server.settled(id);
		const entry = (await server.entries(id)).filter((candidate) => candidate.kind === MESSAGE_ENTRY).at(-1)!;
		const data = entry.data as MessageEntryData;
		assert.deepEqual(data.references.map(({ value, status, note }) => [value, status, note]), [
			["big.txt", "pointer", "64 KB"],
			["assets/logo.png", "pointer", "binary"],
		]);
		assert.match(modelText(entry), /Too large to include here/);
		assert.ok(!modelText(entry).includes("xxxxxxxx"));
	});

	test("attachments reach the workspace uncommitted, and images reach the model", async () => {
		const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
		const image = (await (
			await fetch(`${server.app.url}/api/uploads`, { method: "POST", headers: { "content-type": "image/png", "x-filename": "photo.png" }, body: png })
		).json()) as UploadedAttachment;
		const notes = (await (
			await fetch(`${server.app.url}/api/uploads`, { method: "POST", headers: { "content-type": "text/plain", "x-filename": encodeURIComponent("my notes.txt") }, body: "remember this" })
		).json()) as UploadedAttachment;
		assert.equal(notes.name, "my-notes.txt");
		await server.send(id, "What do you see?", [image.id, notes.id]);
		await server.settled(id);
		const entry = (await server.entries(id)).filter((candidate) => candidate.kind === MESSAGE_ENTRY).at(-1)!;
		const data = entry.data as MessageEntryData;
		assert.equal(data.attachments.length, 2);
		assert.equal(data.attachments[0]?.image, true);
		const message = entry.model?.[0];
		assert.ok(message?.role === "user" && Array.isArray(message.content) && message.content.some((block) => block.type === "image"));
		assert.match(modelText(entry), /Attached file \.pigui\/attachments\/my-notes-[0-9a-f]{6}\.txt/);
		const status = (await git(server.workspace(id), ["status", "--porcelain", "--untracked-files=all"])).stdout;
		assert.equal(status.includes(".pigui"), false, "attachments are never part of the work");
	});
});
