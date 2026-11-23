// picloud OnPrem's local sessions: a directory on the person's own computer, worked in place with their full access.
// A temporary directory stands in for the home directory, and another for the rest of the computer.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Bootstrap, FileList, UploadedAttachment } from "../src/shared/api.ts";
import { MESSAGE_ENTRY, type MessageEntryData, reportOf } from "../src/shared/session.ts";
import { ApiFailure, modelText, TestServer } from "./helpers.ts";

/** Whether `promise` is refused with `status`, and a message matching `message`. */
async function refused(promise: Promise<unknown>, status: number, message: RegExp): Promise<void> {
	await assert.rejects(promise, (error: unknown) => {
		assert.ok(error instanceof ApiFailure, String(error));
		assert.equal(error.status, status);
		assert.match(error.body.error, message);
		return true;
	});
}

describe("local sessions in picloud OnPrem", () => {
	let server: TestServer;
	let home: string;
	let elsewhere: string;
	before(async () => {
		home = await mkdtemp(join(tmpdir(), "picloud-home-"));
		elsewhere = await mkdtemp(join(tmpdir(), "picloud-elsewhere-"));
		await writeFile(join(home, "notes.txt"), "a note in the home directory\n");
		await mkdir(join(home, "code", "app"), { recursive: true });
		await writeFile(join(home, "code", "app", "README.md"), "# app\n");
		// What the @ picker offers from a directory, and what it leaves out.
		await mkdir(join(home, "tree", "sub", "deeper"), { recursive: true });
		await writeFile(join(home, "tree", "top.txt"), "\n");
		await writeFile(join(home, "tree", "sub", "near.txt"), "\n");
		await writeFile(join(home, "tree", "sub", "deeper", "far.txt"), "\n");
		await mkdir(join(home, "tree", ".hidden"));
		await writeFile(join(home, "tree", ".hidden", "secret.txt"), "hidden\n");
		await mkdir(join(home, "tree", "node_modules", "dep"), { recursive: true });
		await writeFile(join(home, "tree", "node_modules", "dep", "index.js"), "\n");
		await writeFile(join(elsewhere, "outside.txt"), "outside the working directory\n");
		// picloud's own settings, in the server's environment as an installed OnPrem has them; commands never see them.
		process.env.PICLOUD_TEST_SETTING = "picloud-only";
		server = await TestServer.start({ env: { PICLOUD_ONPREM: "on", HOME: home } });
	});
	after(async () => {
		await server.close();
		await rm(home, { recursive: true, force: true });
		await rm(elsewhere, { recursive: true, force: true });
	});

	test("the app is told it runs on this computer, and where home is", async () => {
		const bootstrap = await server.get<Bootstrap>("/api/bootstrap");
		assert.deepEqual(bootstrap.onPrem, { home });
	});

	test("a session in ~ starts without a clone, works there, and reports with nothing to deliver", async () => {
		const id = await server.createLocalSession("Add a shout() function", "~");
		await server.approveThrough(id);
		const done = await server.settled(id, "the report");
		assert.equal(done.place, "local");
		if (done.place !== "local") return;
		assert.equal(done.dir, home, "~ is resolved when the session is created");
		assert.equal(done.outcome?.kind, "reported");
		assert.equal(reportOf(done.report!).commit, undefined, "a directory worked in place has no commit to report");
		// The agent's file tools and commands ran in the chosen directory, never in a clone of picloud's.
		assert.match(await readFile(join(home, "src", "shout.ts"), "utf8"), /export function shout/);
		assert.equal(existsSync(join(server.workspace(id), ".git")), false, "nothing was cloned");
		assert.equal(existsSync(join(server.workspace(id), "src")), false);
		const listed = (await server.entries(id)).find((entry) => entry.model?.[0]?.role === "toolResult" && entry.model[0].toolCallId.startsWith("commit:"));
		assert.equal(modelText(listed!).split("\n")[0], home, "commands start in the chosen directory");

		await refused(server.post(`/api/sessions/${id}/deliver`, { action: "push" }), 409, /no branch to push/);
		await refused(server.post(`/api/sessions/${id}/deliver`, { action: "pr" }), 409, /no branch to push/);
		await refused(server.get(`/api/sessions/${id}/diff`), 409, /no diff to show/);

		// What the agent was told: the person's full access from this directory, and none of a clone's rules.
		const prompt = JSON.stringify((await server.entries(id)).filter((entry) => entry.kind === "pi.system").map((entry) => entry.model));
		assert.match(prompt, new RegExp(`Working directory: ${home}, on the person's own computer`));
		assert.match(prompt, /full access to the whole filesystem, their tools, credentials and local services/);
		assert.match(prompt, /Before anything destructive or irreversible the task did not name/);
		assert.doesNotMatch(prompt, /Never push, switch to or create another branch/);
		assert.doesNotMatch(prompt, /runs confined/);
	});

	test("nothing confines it: file tools and commands reach outside its directory, with the person's environment", async () => {
		const outside = join(elsewhere, "outside.txt");
		const id = await server.createLocalSession(
			["Look around [probe]", "$ pwd", `read ${outside}`, `$ cd ${elsewhere} && ls`, `write ${join(elsewhere, "written.txt")}`, "$ env"].join("\n"),
			"~/code/app",
		);
		await server.settled(id, "the probe");
		const results = (await server.entries(id)).flatMap((entry) => {
			const message = entry.model?.[0];
			return message?.role === "toolResult" && message.toolCallId.startsWith("probe:") ? [{ text: modelText(entry), isError: message.isError }] : [];
		});
		assert.equal(results.length, 5);
		const [pwd, read, ls, write, env] = results;
		assert.equal(pwd?.text.trim(), join(home, "code", "app"));
		assert.equal(read?.isError, false, read?.text);
		assert.match(read?.text ?? "", /outside the working directory/, "the read tool reads anywhere");
		assert.match(ls?.text ?? "", /outside\.txt/, "a command runs anywhere");
		assert.equal(write?.isError, false, write?.text);
		assert.equal(await readFile(join(elsewhere, "written.txt"), "utf8"), "probe\n", "the write tool writes anywhere");
		const variables = new Map((env?.text ?? "").split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
		assert.equal(variables.get("HOME"), home, "commands have the person's home");
		assert.equal(variables.get("PATH"), process.env.PATH, "and their PATH");
		assert.equal(variables.get("GIT_TERMINAL_PROMPT"), "0", "nobody can answer a prompt");
		assert.equal(variables.has("GH_CONFIG_DIR"), false, "gh reads the person's own configuration");
		assert.equal(variables.has("GH_TOKEN"), process.env.GH_TOKEN !== undefined, "no token is injected");
		assert.deepEqual([...variables.keys()].filter((name) => name.startsWith("PICLOUD_")), [], "picloud's own settings stay picloud's");
		// What the earlier local session's report learned is this computer's memory, carried into the next one.
		const prompt = JSON.stringify((await server.entries(id)).filter((entry) => entry.kind === "pi.system").map((entry) => entry.model));
		assert.match(prompt, /What earlier sessions learned about working on this computer/);
	});

	test("a repository session keeps its clone and branch rules, told truthfully that nothing confines its commands", async () => {
		const id = await server.createSession("What is in src?");
		const done = await server.settled(id);
		assert.equal(done.place, "repo");
		assert.equal(existsSync(join(server.workspace(id), ".git")), true, "it works in a clone of its own");
		const prompt = JSON.stringify((await server.entries(id)).filter((entry) => entry.kind === "pi.system").map((entry) => entry.model));
		assert.match(prompt, /Never push, switch to or create another branch/);
		assert.match(prompt, /Commands run as the person, unconfined, with their own credentials, which could push: never use them to\./);
		assert.doesNotMatch(prompt, /runs confined|GitHub token is read-only/);
	});

	test("@ references reach anywhere, by ~ and absolute paths, and attachments stay in picloud's own directory", async () => {
		const id = await server.createLocalSession("What is here?", "~/code/app");
		await server.settled(id);
		const upload = (await (
			await fetch(`${server.app.url}/api/uploads`, { method: "POST", headers: { "content-type": "text/plain", "x-filename": "todo.txt" }, body: "remember this" })
		).json()) as UploadedAttachment;
		await server.send(id, `Compare @~/notes.txt with @${join(elsewhere, "outside.txt")} and @README.md?`, [upload.id]);
		await server.settled(id);
		const entry = (await server.entries(id)).filter((candidate) => candidate.kind === MESSAGE_ENTRY).at(-1)!;
		const data = entry.data as MessageEntryData;
		assert.deepEqual(
			data.references.map(({ value, status }) => [value, status]),
			[
				["~/notes.txt", "included"],
				[join(elsewhere, "outside.txt"), "included"],
				["README.md", "included"],
			],
		);
		assert.match(modelText(entry), /<file path="~\/notes\.txt">\na note in the home directory/);
		const attached = data.attachments[0]?.path ?? "";
		assert.ok(attached.startsWith(join(server.workspace(id), ".picloud", "attachments")), attached);
		assert.equal(await readFile(attached, "utf8"), "remember this");
		assert.match(modelText(entry), new RegExp(`Attached file ${attached.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "the agent is given its absolute path");
		assert.equal(existsSync(join(home, "code", "app", ".picloud")), false, "nothing of picloud's is written into the directory");
	});

	test("the @ picker lists the chosen directory, nearest first, without hidden entries or dependencies", async () => {
		const expected: FileList = { files: ["top.txt", "sub/near.txt", "sub/deeper/far.txt"], truncated: false };
		// Before the session exists, for its first message, and once it does.
		assert.deepEqual(await server.get<FileList>(`/api/local/files?dir=${encodeURIComponent("~/tree")}`), expected);
		const id = await server.createLocalSession("What is here?", "~/tree");
		await server.settled(id);
		assert.deepEqual(await server.get<FileList>(`/api/sessions/${id}/files`), expected);
	});

	test("listing / stays bounded, and never walks the kernel's or the devices' trees", async () => {
		const started = Date.now();
		const listed = await server.get<FileList>(`/api/local/files?dir=${encodeURIComponent("/")}`);
		assert.ok(Date.now() - started < 5000, `the listing took ${Date.now() - started} ms`);
		assert.ok(listed.files.length > 0);
		assert.ok(listed.files.every((path) => !/^(proc|sys|dev)\//.test(path)), "no /proc, /sys or /dev");
	});

	test("a directory that does not exist, is a file, or is not absolute is refused before anything starts", async () => {
		await refused(server.createLocalSession("Hello", join(home, "missing")), 400, /does not exist/);
		await refused(server.createLocalSession("Hello", "~/notes.txt"), 400, /is not a directory/);
		await refused(server.createLocalSession("Hello", "code/app"), 400, /is not an absolute directory/);
	});
});

describe("local sessions outside OnPrem", () => {
	test("are refused: a server's sessions stay in their clones", async () => {
		const server = await TestServer.start();
		try {
			await refused(server.createLocalSession("Hello", "/"), 403, /picloud OnPrem/);
			await refused(server.get(`/api/local/files?dir=/`), 404, /picloud OnPrem/);
			assert.equal((await server.get<Bootstrap>("/api/bootstrap")).onPrem, undefined);
		} finally {
			await server.close();
		}
	});
});
