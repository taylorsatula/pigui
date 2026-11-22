import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = join(import.meta.dirname, "..", "deploy", "install.sh");

test("the installer passes a syntax check", () => {
	const result = spawnSync("bash", ["-n", script], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
});

test("its dry run lists every step and changes nothing", () => {
	const result = spawnSync("bash", [script, "--dry-run", "--push-subject", "mailto:owner@example.com", "--spend-cap", "5"], {
		encoding: "utf8",
		env: { ...process.env, PICLOUD_DRY_RUN: "", PICLOUD_SPEECH: "", PICLOUD_MEMORY_LOCAL: "" },
	});
	assert.equal(result.status, 0, result.stderr);
	const steps = [...result.stdout.matchAll(/^== \d+\. (.+)$/gm)].map((match) => match[1]);
	assert.deepEqual(steps, [
		"Check the machine",
		"Install system packages",
		"Install Node.js 22 (at least 22.19.0)",
		"Install the GitHub CLI (gh)",
		"Install Tailscale",
		"Create the service user picloud (no sudo)",
		"Create the data, install and configuration directories",
		"Install the pi CLI (1.6.0)",
		"Install the picloud app into /opt/picloud/app",
		"Install the local models (speech on, memory off)",
		"Write the configuration (/etc/picloud/picloud.env)",
		"Sign gh in for the service user",
		"Install the systemd service",
		"Check Pi's sign-in",
		"Start (or restart) picloud",
		"Connect Tailscale and serve picloud over HTTPS",
		"Status",
	]);
	// Every command that would change the system is shown, not run.
	assert.doesNotMatch(result.stdout, /^ {3}\$ /m);
	assert.match(result.stdout, /PICLOUD_SPEND_CAP=5/);
	assert.match(result.stdout, /tailscale serve --bg --https=443 http:\/\/127\.0\.0\.1:8787/);
	assert.match(result.stdout, /== Steps that need a person/);
	assert.match(result.stdout, /Add to Home Screen/);
	// Without the agent's token, picloud cannot start, so creating one is a step for the person.
	assert.match(result.stdout, /PICLOUD_AGENT_GH_TOKEN=$/m);
	assert.match(result.stdout, /read-only \(Contents and Metadata: read\).*--agent-github-token-file FILE/);
	assert.match(result.stdout, /RestartPreventExitStatus=78 2/);
	// Speech is on and local memory off by default: the models are fetched by the script the Docker image uses too.
	assert.match(result.stdout, /\[dry run\] \/opt\/picloud\/app\/deploy\/models\.sh \/opt\/picloud\/app\/models speech$/m);
	assert.doesNotMatch(result.stdout, /npm prune --omit=optional/);
});

test("its dry run switches the local models: memory on, speech off, or both off with their packages", () => {
	const install = (...args: string[]) =>
		spawnSync("bash", [script, "--dry-run", ...args], { encoding: "utf8", env: { ...process.env, PICLOUD_DRY_RUN: "", PICLOUD_SPEECH: "", PICLOUD_MEMORY_LOCAL: "" } });
	const memory = install("--speech", "off", "--memory-local", "on");
	assert.equal(memory.status, 0, memory.stderr);
	assert.match(memory.stdout, /^== \d+\. Install the local models \(speech off, memory on\)$/m);
	assert.match(memory.stdout, /\[dry run\] \/opt\/picloud\/app\/deploy\/models\.sh \/opt\/picloud\/app\/models memory$/m);
	assert.doesNotMatch(memory.stdout, /npm prune --omit=optional/);
	const none = install("--speech", "off");
	assert.equal(none.status, 0, none.stderr);
	// The script with no model named removes those an earlier install fetched.
	assert.match(none.stdout, /\[dry run\] \/opt\/picloud\/app\/deploy\/models\.sh \/opt\/picloud\/app\/models$/m);
	assert.match(none.stdout, /npm prune --omit=optional/);
	for (const [flag, message] of [
		["--speech", /--speech must be on or off/],
		["--memory-local", /--memory-local must be on or off/],
	] as const) {
		const refused = install(flag, "maybe");
		assert.equal(refused.status, 2);
		assert.match(refused.stderr, message);
	}
});

test("the models script removes the model of a feature not named, and refuses a feature it does not know", () => {
	const dir = mkdtempSync(join(tmpdir(), "picloud-models-"));
	const models = join(import.meta.dirname, "..", "deploy", "models.sh");
	try {
		// A speech model an earlier install fetched: left in place, picloud would read aloud with speech switched off.
		mkdirSync(join(dir, "onnx-community", "Kokoro-82M-v1.0-ONNX"), { recursive: true });
		writeFileSync(join(dir, "onnx-community", "Kokoro-82M-v1.0-ONNX", "config.json"), "{}");
		const none = spawnSync("bash", [models, dir], { encoding: "utf8" });
		assert.equal(none.status, 0, none.stderr);
		assert.equal(none.stdout, "   removing onnx-community/Kokoro-82M-v1.0-ONNX (speech is off)\n");
		assert.deepEqual(readdirSync(dir), []);
		const unknown = spawnSync("bash", [models, dir, "vision"], { encoding: "utf8" });
		assert.equal(unknown.status, 2);
		assert.match(unknown.stderr, /There is no model set 'vision'; the sets are: speech memory\./);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("its dry run on Debian 13 picks Tailscale's trixie source and writes the agent's token where only root reads it", () => {
	const dir = mkdtempSync(join(tmpdir(), "picloud-install-"));
	const token = "github_pat_agent_read_only";
	writeFileSync(join(dir, "os-release"), 'ID=debian\nVERSION_ID="13"\nVERSION_CODENAME=trixie\nPRETTY_NAME="Debian GNU/Linux 13 (trixie)"\n');
	writeFileSync(join(dir, "agent-token"), `${token}\n`);
	try {
		const result = spawnSync("bash", [script, "--dry-run", "--agent-github-token-file", join(dir, "agent-token")], {
			encoding: "utf8",
			env: { ...process.env, PICLOUD_DRY_RUN: "", PICLOUD_OS_RELEASE: join(dir, "os-release") },
		});
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /Debian 13 \(trixie\), the recommended system/);
		// A machine that already has Tailscale skips its apt source.
		if (/pkgs\.tailscale\.com/.test(result.stdout)) {
			assert.match(result.stdout, /stable\/debian\/trixie\.noarmor\.gpg/);
			assert.match(result.stdout, /stable\/debian trixie main/);
		}
		assert.match(result.stdout, /write \/etc\/picloud\/picloud\.env \(mode 0600, owner root:root\)/);
		assert.match(result.stdout, /PICLOUD_AGENT_GH_TOKEN=\(hidden\)/);
		assert.doesNotMatch(result.stdout, new RegExp(token), "a dry run never shows the token");
		assert.doesNotMatch(result.stdout, /--agent-github-token-file FILE/);
		// Agent commands have a home of their own, so git's use of gh is configured system-wide.
		assert.match(result.stdout, /git config --system credential\.https:\/\/github\.com\.helper|git uses gh's credentials/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the trim script passes a syntax check", () => {
	const result = spawnSync("bash", ["-n", join(import.meta.dirname, "..", "deploy", "trim.sh")], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
});

test("the trim script's dry run masks only installed units, adds swap, caps the journal and changes nothing", () => {
	// Stand-ins for a machine with three of the units installed (one already masked), no swap, and room for it.
	const bin = mkdtempSync(join(tmpdir(), "picloud-trim-"));
	const stub = (name: string, body: string) => {
		writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
		chmodSync(join(bin, name), 0o755);
	};
	stub("systemctl", 'case "$1" in\n list-unit-files) case "$3" in snapd.service|snapd.socket|rsyslog.service) echo "$3 enabled enabled";; esac;;\n is-enabled) [ "$2" = rsyslog.service ] && { echo masked; exit 1; }; echo enabled;;\nesac');
	stub("swapon", "exit 0");
	stub("df", 'echo " Avail"; echo "20000M"');
	try {
		const result = spawnSync("bash", [join(import.meta.dirname, "..", "deploy", "trim.sh"), "--dry-run"], {
			encoding: "utf8",
			env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, PICLOUD_DRY_RUN: "", PICLOUD_SWAP: "" },
		});
		assert.equal(result.status, 0, result.stderr);
		const steps = [...result.stdout.matchAll(/^== \d+\. (.+)$/gm)].map((match) => match[1]);
		assert.deepEqual(steps, ["Check the machine", "Stop services this machine never uses", "Add a swap file (2G)", "Cap the system journal at 200M", "Status"]);
		assert.doesNotMatch(result.stdout, /^ {3}\$ /m);
		assert.match(result.stdout, /\[dry run\] systemctl mask --now snapd\.service snapd\.socket$/m);
		assert.match(result.stdout, /rsyslog\.service: already off/);
		assert.doesNotMatch(result.stdout, /mask --now .*(multipathd|rsyslog)/);
		assert.match(result.stdout, /\[dry run\] fallocate -l 2G \/swapfile/);
		assert.match(result.stdout, /vm\.swappiness=10/);
		assert.match(result.stdout, /SystemMaxUse=200M/);
		assert.match(result.stdout, /sudo systemctl unmask snapd\.service snapd\.socket rsyslog\.service, then reboot/);
	} finally {
		rmSync(bin, { recursive: true, force: true });
	}
});
