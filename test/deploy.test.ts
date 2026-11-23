import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

// picloud OnPrem's installer, as a dry run only: never for real here. Each run gets a temporary home, and stand-ins
// early on PATH for uname (the system it believes it is on), the login shell (the PATH it captures) and systemctl.
const onprem = join(import.meta.dirname, "..", "deploy", "onprem.sh");

type OnPremRun = { status: number | null; stdout: string; stderr: string; home: string };

function onPremDryRun(system: "Darwin" | "Linux", args: string[], prepare?: (home: string) => void): OnPremRun {
	const home = mkdtempSync(join(tmpdir(), "picloud-onprem-home-"));
	const bin = mkdtempSync(join(tmpdir(), "picloud-onprem-bin-"));
	const stub = (name: string, body: string) => {
		writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
		chmodSync(join(bin, name), 0o755);
	};
	stub("uname", `[ "$1" = -s ] && echo ${system} || echo 1.0`);
	stub("sw_vers", "echo 15.1");
	stub("systemctl", "exit 0");
	// A login shell whose profile puts Homebrew and nvm on PATH, as a person's does and launchd's environment does not.
	stub("login-shell", 'PATH=/opt/homebrew/bin:/home/someone/.nvm/versions/node/v22/bin:/usr/bin:/bin; eval "${@: -1}"');
	try {
		prepare?.(home);
		const result = spawnSync("bash", [onprem, "--dry-run", ...args], {
			encoding: "utf8",
			env: { ...process.env, HOME: home, SHELL: join(bin, "login-shell"), PATH: `${bin}:${process.env.PATH ?? ""}`, XDG_CONFIG_HOME: "", PICLOUD_ONPREM_FETCHED: "" },
		});
		return { status: result.status, stdout: result.stdout, stderr: result.stderr, home };
	} finally {
		rmSync(bin, { recursive: true, force: true });
	}
}

const stepsOf = (stdout: string) => [...stdout.matchAll(/^== \d+\. (.+)$/gm)].map((match) => match[1]);

test("the OnPrem installer passes a syntax check, and says how to use it", () => {
	assert.equal(spawnSync("bash", ["-n", onprem], { encoding: "utf8" }).status, 0);
	const help = spawnSync("bash", [onprem, "--help"], { encoding: "utf8" });
	assert.equal(help.status, 0);
	for (const flag of ["--speech on|off", "--memory-local on|off", "--port PORT", "--ref REF", "--dry-run", "--uninstall", "-h, --help"]) assert.ok(help.stdout.includes(flag), flag);
	assert.match(help.stdout, /curl -fsSL https:\/\/raw\.githubusercontent\.com\/taylorsatula\/picloud\/main\/deploy\/onprem\.sh \| bash -s --/);
});

test("its dry run on macOS writes a LaunchAgent with the login shell's PATH, OnPrem on, and changes nothing", () => {
	const run = onPremDryRun("Darwin", ["--port", "4100"]);
	try {
		assert.equal(run.status, 0, run.stderr);
		assert.deepEqual(stepsOf(run.stdout), [
			"Check this computer",
			"Fetch picloud (main) into " + join(run.home, ".picloud", "app"),
			"Install its packages and build it",
			"Install the local models (speech on, memory off)",
			"Check Pi's sign-in",
			"Install the service (LaunchAgent com.github.taylorsatula.picloud)",
			"Start (or restart) picloud",
		]);
		assert.doesNotMatch(run.stdout, /^ {3}\$ /m, "every command that would change something is shown, not run");
		const app = join(run.home, ".picloud", "app");
		assert.match(run.stdout, new RegExp(`\\[dry run\\] git clone --quiet https://github\\.com/taylorsatula/picloud\\.git ${app}$`, "m"));
		assert.match(run.stdout, /\[dry run\] git -C .*\/\.picloud\/app fetch --quiet origin main$/m);
		assert.ok(run.stdout.includes(`[dry run] ${app}/deploy/models.sh ${app}/models speech\n`));
		const plist = join(run.home, "Library", "LaunchAgents", "com.github.taylorsatula.picloud.plist");
		assert.ok(run.stdout.includes(`[dry run] write ${plist} (mode 0644`), run.stdout);
		const written = run.stdout.slice(run.stdout.indexOf("<?xml")).split("\n").filter((line) => line.startsWith("      | ")).map((line) => line.slice(8)).join("\n");
		const node = process.execPath;
		assert.ok(written.includes(`<string>${node}</string>\n\t\t<string>--disable-warning=ExperimentalWarning</string>\n\t\t<string>${app}/src/server/main.ts</string>`));
		assert.ok(written.includes(`<key>PATH</key>\n\t\t<string>${join(node, "..")}:/opt/homebrew/bin:/home/someone/.nvm/versions/node/v22/bin:/usr/bin:/bin</string>`), "the login shell's PATH, after node's own directory");
		assert.ok(written.includes("<key>PICLOUD_ONPREM</key>\n\t\t<string>on</string>"));
		assert.ok(written.includes(`<key>PICLOUD_DATA_DIR</key>\n\t\t<string>${run.home}/.picloud/data</string>`));
		assert.ok(written.includes("<key>PICLOUD_PORT</key>\n\t\t<string>4100</string>"));
		assert.ok(written.includes("<key>RunAtLoad</key>\n\t<true/>") && written.includes("<key>KeepAlive</key>\n\t<true/>"));
		assert.ok(written.includes(`<key>StandardErrorPath</key>\n\t<string>${run.home}/.picloud/logs/picloud.log</string>`));
		assert.match(run.stdout, new RegExp(`\\[dry run\\] launchctl bootstrap gui/${process.getuid?.()} ${plist}$`, "m"));
		assert.match(run.stdout, /would run at http:\/\/localhost:4100/);
		assert.match(run.stdout, /Full Disk Access/);
		assert.match(run.stdout, /\[dry run\] open http:\/\/localhost:4100$/m);
		assert.deepEqual(readdirSync(run.home), [], "the home directory is untouched");
	} finally {
		rmSync(run.home, { recursive: true, force: true });
	}
});

test("its dry run on Linux writes a systemd user unit, and maps the model flags as the server installer does", () => {
	const run = onPremDryRun("Linux", ["--speech", "off", "--memory-local", "on", "--ref", "v2.0"]);
	try {
		assert.equal(run.status, 0, run.stderr);
		assert.equal(stepsOf(run.stdout).at(-2), "Install the service (systemd user unit picloud.service)");
		assert.match(run.stdout, /fetch --quiet origin v2\.0$/m);
		assert.match(run.stdout, /^== \d+\. Install the local models \(speech off, memory on\)$/m);
		assert.match(run.stdout, /\/deploy\/models\.sh \S+\/models memory$/m);
		assert.doesNotMatch(run.stdout, /npm prune --omit=optional/);
		const unit = join(run.home, ".config", "systemd", "user", "picloud.service");
		assert.ok(run.stdout.includes(`[dry run] write ${unit} (mode 0644`));
		assert.ok(run.stdout.includes(`| Environment="PATH=${join(process.execPath, "..")}:/opt/homebrew/bin:/home/someone/.nvm/versions/node/v22/bin:/usr/bin:/bin"\n`));
		assert.ok(run.stdout.includes("| Environment=PICLOUD_ONPREM=on\n"));
		assert.ok(run.stdout.includes("| Environment=PICLOUD_PORT=2025\n"));
		assert.ok(run.stdout.includes(`| Environment="PICLOUD_DATA_DIR=${run.home}/.picloud/data"\n`));
		assert.ok(run.stdout.includes(`| ExecStart="${process.execPath}" --disable-warning=ExperimentalWarning "${run.home}/.picloud/app/src/server/main.ts"\n`));
		assert.ok(run.stdout.includes("| RestartPreventExitStatus=78 2\n"));
		assert.match(run.stdout, /\[dry run\] systemctl --user restart picloud\.service$/m);
		assert.doesNotMatch(run.stdout, /^ {3}\$ /m);
		assert.deepEqual(readdirSync(run.home), []);
		// Both models off leaves out the packages that run them, too.
		const none = onPremDryRun("Linux", ["--speech", "off"]);
		rmSync(none.home, { recursive: true, force: true });
		assert.match(none.stdout, /\/deploy\/models\.sh \S+\/models$/m);
		assert.match(none.stdout, /npm prune --omit=optional/);
	} finally {
		rmSync(run.home, { recursive: true, force: true });
	}
});

test("its dry run refuses flags it cannot use, and an uninstall removes the service and the app but keeps the data", () => {
	for (const [args, message] of [
		[["--speech", "maybe"], /--speech must be on or off/],
		[["--memory-local", "yes"], /--memory-local must be on or off/],
		[["--port", "http"], /--port must be a number/],
		[["--port", "70000"], /--port must be a number/],
		[["--sandbox", "on"], /Unknown option: --sandbox/],
	] as const) {
		const refused = onPremDryRun("Linux", [...args]);
		rmSync(refused.home, { recursive: true, force: true });
		assert.equal(refused.status, 2);
		assert.match(refused.stderr, message);
	}
	for (const system of ["Darwin", "Linux"] as const) {
		const run = onPremDryRun(system, ["--uninstall"], (home) => {
			mkdirSync(join(home, ".picloud", "app"), { recursive: true });
			mkdirSync(join(home, ".picloud", "data"), { recursive: true });
			const service = system === "Darwin" ? join(home, "Library", "LaunchAgents", "com.github.taylorsatula.picloud.plist") : join(home, ".config", "systemd", "user", "picloud.service");
			mkdirSync(join(service, ".."), { recursive: true });
			writeFileSync(service, "installed\n");
		});
		try {
			assert.equal(run.status, 0, run.stderr);
			assert.deepEqual(stepsOf(run.stdout), ["Stop and remove the service", `Remove the app (${run.home}/.picloud/app)`]);
			if (system === "Linux") assert.match(run.stdout, /\[dry run\] systemctl --user disable --now picloud\.service$/m);
			assert.match(run.stdout, system === "Darwin" ? /\[dry run\] rm \S+\/Library\/LaunchAgents\/com\.github\.taylorsatula\.picloud\.plist$/m : /\[dry run\] rm \S+\/systemd\/user\/picloud\.service$/m);
			assert.match(run.stdout, /\[dry run\] rm -rf \S+\/\.picloud\/app$/m);
			assert.doesNotMatch(run.stdout, /rm -rf \S+\/\.picloud\/data/);
			assert.match(run.stdout, /remain in \S+\/\.picloud\/data/);
			assert.equal(readdirSync(join(run.home, ".picloud")).sort().join(","), "app,data", "a dry run removes nothing");
		} finally {
			rmSync(run.home, { recursive: true, force: true });
		}
	}
});

test("the models script checks sums with shasum where there is no sha256sum, as on macOS", (t) => {
	const kokoro = join(import.meta.dirname, "..", "models", "onnx-community", "Kokoro-82M-v1.0-ONNX");
	if (!existsSync(join(kokoro, "config.json"))) {
		t.skip("needs the speech model, which deploy/models.sh models speech fetches");
		return;
	}
	const dir = mkdtempSync(join(tmpdir(), "picloud-models-"));
	const bin = mkdtempSync(join(tmpdir(), "picloud-models-bin-"));
	try {
		// A PATH with what the script runs, and shasum but no sha256sum.
		for (const tool of ["bash", "cat", "dirname", "mkdir", "cut", "sort", "find", "rm", "mv", "shasum", "perl"]) {
			const found = spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
			if (found !== "") symlinkSync(found, join(bin, tool));
		}
		if (!existsSync(join(bin, "shasum"))) {
			t.skip("no shasum on this machine");
			return;
		}
		cpSync(kokoro, join(dir, "onnx-community", "Kokoro-82M-v1.0-ONNX"), { recursive: true });
		const result = spawnSync(join(bin, "bash"), [join(import.meta.dirname, "..", "deploy", "models.sh"), dir, "speech"], { encoding: "utf8", env: { PATH: bin } });
		assert.equal(result.stderr, "");
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /onnx-community\/Kokoro-82M-v1\.0-ONNX\/config\.json is in place/);
		assert.doesNotMatch(result.stdout, /downloading/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(bin, { recursive: true, force: true });
	}
});
