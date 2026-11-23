// Session isolation: what an agent's commands and file tools can reach, driven through the scripted model's [probe]
// and read back from the tool results. The environment tests run everywhere; the Landlock tests skip where the kernel
// or the launcher is missing, since fake mode then runs without the sandbox.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, type TestContext, test } from "node:test";
import { SCOPED_ABI } from "../src/server/sandbox.ts";
import { TestServer } from "./helpers.ts";

// pigui's own secrets, in the server's environment as a real deployment has them. No agent command may see them.
const PIGUI_SECRETS = { GH_TOKEN: "pigui-write-token", PIGUI_TEST_SECRET: "pigui-secret", ANTHROPIC_API_KEY: "provider-key" };
const AGENT_TOKEN = "agent-read-token";

/** Every variable an agent command may have: pigui's allowlist, and what bash sets itself. */
const ALLOWED =
	/^(PATH|LANG|LC_\w+|TZ|TERM|USER|LOGNAME|SHELL|HOME|TMPDIR|GH_CONFIG_DIR|GH_TOKEN|GITHUB_TOKEN|GIT_TERMINAL_PROMPT|GCM_INTERACTIVE|GIT_ASKPASS|SSH_ASKPASS|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|PWD|OLDPWD|SHLVL|_)$/;

describe("session isolation", () => {
	let server: TestServer;
	before(async () => {
		Object.assign(process.env, PIGUI_SECRETS);
		server = await TestServer.start({ env: { PIGUI_AGENT_GH_TOKEN: AGENT_TOKEN } });
	});
	after(() => server.close());

	/** Whether this machine runs agent commands in the sandbox; skips the test when it does not. */
	const sandboxed = (t: TestContext): boolean => {
		if (server.app.sandbox !== undefined) return true;
		t.skip("Landlock or the sandbox launcher is unavailable here (npm run build compiles the launcher)");
		return false;
	};

	test("agent commands get the agent's GitHub token and none of pigui's environment", async () => {
		const { results } = await server.probe(["$ env"]);
		const text = results[0]!.text;
		const variables = new Map(text.split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
		assert.equal(variables.get("GH_TOKEN"), AGENT_TOKEN);
		assert.equal(variables.get("GITHUB_TOKEN"), AGENT_TOKEN);
		assert.equal(variables.get("GIT_TERMINAL_PROMPT"), "0");
		for (const secret of Object.values(PIGUI_SECRETS)) assert.doesNotMatch(text, new RegExp(secret));
		assert.deepEqual([...variables.keys()].filter((name) => !ALLOWED.test(name)), []);
	});

	test("their home and tmp are the session's own", async () => {
		const line = '$ echo "$HOME $TMPDIR $GH_CONFIG_DIR" && touch "$HOME/mine" "$TMPDIR/mine" && cd && pwd';
		const first = await server.probe([line]);
		const second = await server.probe([line]);
		for (const { id, results } of [first, second]) {
			const scratch = server.scratch(id);
			assert.equal(results[0]!.text.trim(), `${scratch}/home ${scratch}/tmp ${scratch}/gh\n${scratch}/home`);
			assert.ok(existsSync(join(scratch, "home", "mine")));
			assert.ok(existsSync(join(scratch, "tmp", "mine")));
		}
	});

	test("a command can write its workspace and run programs", async (t) => {
		if (!sandboxed(t)) return;
		const { id, results } = await server.probe(['$ echo hello > made.txt && cat made.txt && node -e "console.log(6 * 7)" && git status --short made.txt']);
		assert.equal(results[0]!.isError, false, results[0]!.text);
		assert.match(results[0]!.text, /^hello\n42\n\?\? made\.txt/);
		assert.ok(existsSync(join(server.workspace(id), "made.txt")));
	});

	test("a command cannot read another session's workspace, pigui's database or Pi's sign-in", async (t) => {
		if (!sandboxed(t)) return;
		const other = await server.probe(["$ echo mine > private.txt"]);
		await writeFile(join(server.agentDir, "auth.json"), '{"provider":"pi-credentials"}\n');
		const { results } = await server.probe([
			`$ cat ${join(server.workspace(other.id), "private.txt")}`,
			`$ cat ${join(server.dataDir, "pigui.sqlite")}`,
			`$ cat ${join(server.agentDir, "auth.json")}`,
			`$ ls ${server.dataDir}`,
			"$ ls /tmp",
		]);
		for (const result of results) {
			assert.equal(result.isError, true, result.text);
			assert.match(result.text, /Permission denied/);
		}
	});

	test("a command can read and run Pi's skills", async (t) => {
		if (!sandboxed(t)) return;
		const skill = join(server.agentDir, "skills", "probe-skill");
		await mkdir(skill, { recursive: true });
		await writeFile(join(skill, "SKILL.md"), "---\nname: probe-skill\ndescription: Says hello.\n---\nRun hello.sh.\n");
		await writeFile(join(skill, "hello.sh"), "#!/bin/sh\necho hello from the skill\n", { mode: 0o755 });
		const { results } = await server.probe([`$ head -2 ${join(skill, "SKILL.md")} && ${join(skill, "hello.sh")}`, `read ${join(skill, "SKILL.md")}`]);
		assert.equal(results[0]!.isError, false, results[0]!.text);
		assert.match(results[0]!.text, /name: probe-skill\nhello from the skill/);
		assert.equal(results[1]!.isError, false, results[1]!.text);
		assert.match(results[1]!.text, /Run hello\.sh\./);
	});

	test("a command cannot signal pigui's process", async (t) => {
		if (!sandboxed(t)) return;
		if (server.app.sandbox!.abi < SCOPED_ABI) {
			t.skip(`Landlock ABI ${server.app.sandbox!.abi} does not scope signals`);
			return;
		}
		const { results } = await server.probe([`$ kill -0 ${process.pid}`]);
		assert.equal(results[0]!.isError, true, results[0]!.text);
		assert.match(results[0]!.text, /Operation not permitted/);
	});

	test("a command cannot read pigui's environment through /proc", { skip: process.getuid?.() === 0 && "Landlock still lets root read /proc/<pid>/environ; pigui runs as its own user" }, async (t) => {
		if (!sandboxed(t)) return;
		const { results } = await server.probe([`$ cat /proc/${process.pid}/environ`]);
		assert.equal(results[0]!.isError, true, results[0]!.text);
		assert.match(results[0]!.text, /Permission denied/);
	});

	test("the file tools refuse paths outside the grants, including through a symlink", async (t) => {
		if (!sandboxed(t)) return;
		const database = join(server.dataDir, "pigui.sqlite");
		const planted = join(server.dataDir, "planted.txt");
		await writeFile(join(server.agentDir, "auth.json"), '{"provider":"pi-credentials"}\n');
		const { results } = await server.probe([
			`read ${database}`,
			`read ${join(server.agentDir, "auth.json")}`,
			"read /proc/self/environ",
			`$ ln -s ${database} database-link && ln -s ${planted} planted-link`,
			"read database-link",
			"write planted-link",
			"write /etc/pigui-probe",
			"write notes/probe.txt",
			"read notes/probe.txt",
		]);
		const [ofDatabase, ofSignIn, ofProc, links, throughLink, throughDangling, system, written, read] = results;
		for (const refused of [ofDatabase, ofSignIn, ofProc]) {
			assert.equal(refused!.isError, true, refused!.text);
			assert.match(refused!.text, /is outside this session's sandbox/);
		}
		assert.equal(links!.isError, false, links!.text);
		assert.match(throughLink!.text, new RegExp(`database-link \\(it leads to ${database}\\): it is outside this session's sandbox`));
		assert.match(throughDangling!.text, new RegExp(`planted-link \\(it leads to ${planted}\\): it is outside this session's sandbox`));
		assert.equal(existsSync(planted), false, "nothing was written through the dangling link");
		assert.match(system!.text, /is read-only for this session/);
		assert.equal(written!.isError, false, written!.text);
		assert.equal(read!.text, "probe\n");
	});
});
