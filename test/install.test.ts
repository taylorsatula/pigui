// The decision-tree installer at the repository root: where and how pigui runs, chosen by three questions.
// Dry runs only here — never a real install. Each run gets a temporary home, and stand-ins for the SSH client and,
// when asked, for a PATH without Docker.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const install = join(import.meta.dirname, "..", "install.sh");

type Run = { status: number | null; stdout: string; stderr: string; home: string };

function dryRun(args: string[], env: NodeJS.ProcessEnv = {}, hideDocker = false): Run {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "pigui-install-home-")));
	const bin = mkdtempSync(join(tmpdir(), "pigui-install-bin-"));
	const state = mkdtempSync(join(tmpdir(), "pigui-install-state-"));
	const pathDirs = (process.env.PATH ?? "").split(":").filter((dir) => !hideDocker || !existsSync(join(dir, "docker")));
	// A login shell whose profile puts a PATH on, as a person's does and launchd's environment does not.
	writeFileSync(join(bin, "login-shell"), '#!/bin/bash\nPATH=/opt/homebrew/bin:/usr/bin:/bin; eval "${@: -1}"\n');
	chmodSync(join(bin, "login-shell"), 0o755);
	try {
		const result = spawnSync("bash", [install, "--dry-run", ...args], {
			encoding: "utf8",
			env: { ...process.env, HOME: home, SHELL: join(bin, "login-shell"), PATH: `${bin}:${pathDirs.join(":")}`, XDG_CONFIG_HOME: "", XDG_STATE_HOME: state, ...env },
		});
		return { status: result.status, stdout: result.stdout, stderr: result.stderr, home };
	} finally {
		rmSync(bin, { recursive: true, force: true });
		rmSync(state, { recursive: true, force: true });
	}
}

const sshStub = (exit: number) => {
	const bin = mkdtempSync(join(tmpdir(), "pigui-ssh-stub-"));
	const stub = join(bin, "ssh");
	writeFileSync(stub, `#!/bin/bash\nexit ${exit}\n`);
	chmodSync(stub, 0o755);
	return stub;
};

const stepsOf = (stdout: string) => [...stdout.matchAll(/^== \d+\. (.+)$/gm)].map((match) => match[1]);

test("the installer passes a syntax check, and --help says how to use it", () => {
	assert.equal(spawnSync("bash", ["-n", install], { encoding: "utf8" }).status, 0);
	const help = spawnSync("bash", [install, "--help"], { encoding: "utf8" });
	assert.equal(help.status, 0);
	assert.match(help.stdout, /curl -fsSL https:\/\/raw\.githubusercontent\.com\/taylorsatula\/pigui\/main\/install\.sh \| bash -s --/);
	for (const way of ["Remote (sandboxed)", "Remote (full)", "Local (sandboxed)", "Local (full)"]) {
		assert.ok(help.stdout.includes(way), way);
	}
	for (const flag of ["--where", "--how", "--pi-config", "--pi-agent-dir", "--remote", "--dry-run", "-h, --help"]) {
		assert.ok(help.stdout.includes(flag), flag);
	}
});

test("local full with overlap: no standalone directory, no PI_CODING_AGENT_DIR, home untouched", () => {
	const run = dryRun(["--where", "local", "--how", "full", "--pi-config", "overlap"]);
	try {
		assert.equal(run.status, 0, run.stderr);
		assert.doesNotMatch(run.stdout, /Standalone Pi configuration/);
		assert.doesNotMatch(run.stdout, /PI_CODING_AGENT_DIR/);
		assert.deepEqual(readdirSync(run.home), []);
	} finally {
		rmSync(run.home, { recursive: true, force: true });
	}
});

test("local full standalone: a separate Pi configuration, PI_CODING_AGENT_DIR in the service, home untouched", () => {
	const run = dryRun(["--where", "local", "--how", "full", "--pi-config", "standalone", "--pi-agent-dir", join("~", ".pigui", "pi-agent")]);
	try {
		assert.equal(run.status, 0, run.stderr);
		assert.match(run.stdout, /^== \d+\. Standalone Pi configuration/m);
		assert.match(run.stdout, /PI_CODING_AGENT_DIR=\S+\.pigui\/pi-agent/);
		assert.match(run.stdout, /PI_AGENT_DIR=\S+\.pigui\/pi-agent/);
		assert.deepEqual(readdirSync(run.home), []);
	} finally {
		rmSync(run.home, { recursive: true, force: true });
	}
});

test("remote without a key installed raises, and says what to do", () => {
	const stub = sshStub(1);
	const run = dryRun(["--where", "remote", "--remote", "192.0.2.1", "--how", "full"], { PIGUI_SSH: stub });
	try {
		assert.equal(run.status, 1);
		assert.match(run.stderr, /No SSH key installed for root@192\.0\.2\.1/);
		assert.match(run.stderr, /ssh-copy-id root@192\.0\.2\.1/);
	} finally {
		rmSync(run.home, { recursive: true, force: true });
		rmSync(join(stub, ".."), { recursive: true, force: true });
	}
});

test("remote full: creates the user, copies the credentials, installs OnPrem over SSH", () => {
	const stub = sshStub(0);
	const run = dryRun(["--where", "remote", "--remote", "192.0.2.1", "--how", "full", "--pi-config", "standalone"], {
		PIGUI_SSH: stub,
		GH_TOKEN: "test-gh-token",
		AGENT_GH_TOKEN: "test-agent-token",
	});
	try {
		assert.equal(run.status, 0, run.stderr);
		assert.deepEqual(stepsOf(run.stdout), [
			"Create the user taylor on 192.0.2.1",
			"Install Node.js 22, gh and Tailscale on 192.0.2.1",
			"Copy the GitHub credentials to 192.0.2.1",
			"Copy the Pi configuration to 192.0.2.1 (standalone)",
			"Install pigui on 192.0.2.1",
		]);
		assert.match(run.stdout, /useradd -m -s \/bin\/bash 'taylor'/);
		assert.match(run.stdout, /--pi-agent-dir \/home\/taylor\/\.pigui\/pi-agent/);
		assert.match(run.stdout, /--models-unload never/);
		assert.doesNotMatch(run.stdout, /test-gh-token/, "the token is piped, never printed");
	} finally {
		rmSync(run.home, { recursive: true, force: true });
		rmSync(join(stub, ".."), { recursive: true, force: true });
	}
});

test("remote sandboxed: clones the repository and runs the server installer over SSH", () => {
	const stub = sshStub(0);
	const run = dryRun(["--where", "remote", "--remote", "192.0.2.1", "--how", "sandboxed", "--push-subject", "mailto:me@example.com"], {
		PIGUI_SSH: stub,
		GH_TOKEN: "test-gh-token",
		AGENT_GH_TOKEN: "test-agent-token",
	});
	try {
		assert.equal(run.status, 0, run.stderr);
		assert.deepEqual(stepsOf(run.stdout), [
			"Clone pigui (main) on 192.0.2.1",
			"Copy the tokens to 192.0.2.1",
			"Run the server installer on 192.0.2.1",
		]);
		assert.match(run.stdout, /deploy\/install\.sh/);
		assert.match(run.stdout, /--github-token-file \/root\/github-token/);
		assert.match(run.stdout, /--models-unload never/);
		assert.doesNotMatch(run.stdout, /test-gh-token/, "the token is piped, never printed");
	} finally {
		rmSync(run.home, { recursive: true, force: true });
		rmSync(join(stub, ".."), { recursive: true, force: true });
	}
});

test("local sandboxed without Docker says what to install, and stops", () => {
	const run = dryRun(["--where", "local", "--how", "sandboxed"], { GH_TOKEN: "test-gh-token", AGENT_GH_TOKEN: "test-agent-token" }, true);
	try {
		assert.equal(run.status, 1);
		assert.match(run.stderr, /Docker is not installed/);
	} finally {
		rmSync(run.home, { recursive: true, force: true });
	}
});

test("flags it cannot use, and a missing answer, are refused", () => {
	for (const [args, message] of [
		[["--where", "mars"], /--where must be local or remote/],
		[["--how", "sometimes"], /--how must be sandboxed or full/],
		[["--pi-config", "sometimes"], /--pi-config must be overlap or standalone/],
		[["--speech", "maybe"], /--speech must be on or off/],
		[["--models-unload", "always"], /--models-unload must be never, or a whole number of idle minutes/],
		[["--port", "http"], /--port must be a number/],
		[["--sandbox", "on"], /Unknown option: --sandbox/],
	] as const) {
		const run = dryRun([...args]);
		rmSync(run.home, { recursive: true, force: true });
		assert.equal(run.status, 2);
		assert.match(run.stderr, message);
	}
	// Without a terminal, the answers come from flags; missing ones are refused.
	const run = dryRun([]);
	rmSync(run.home, { recursive: true, force: true });
	assert.equal(run.status, 2);
	assert.match(run.stderr, /--where is required/);
});

test("the OnPrem shim runs install.sh's OnPrem path", () => {
	const shim = join(import.meta.dirname, "..", "deploy", "onprem.sh");
	assert.equal(spawnSync("bash", ["-n", shim], { encoding: "utf8" }).status, 0);
	const help = spawnSync("bash", [shim, "--help"], { encoding: "utf8" });
	assert.equal(help.status, 0);
	assert.match(help.stdout, /install\.sh/);
});
