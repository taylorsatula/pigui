import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
		env: { ...process.env, PICLOUD_DRY_RUN: "" },
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
