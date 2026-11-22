import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { ApiError } from "../src/shared/api.ts";
import { clientOwner } from "../src/server/callers.ts";
import { ConfigError, readConfig } from "../src/server/config.ts";
import { TestServer } from "./helpers.ts";

describe("access and configuration", () => {
	test("only listed Tailscale logins get in", async () => {
		const server = await TestServer.start({ env: { PICLOUD_ALLOWED_LOGINS: "owner@example.com, Second@Example.com" } });
		try {
			const anonymous = await fetch(`${server.app.url}/api/bootstrap`);
			assert.equal(anonymous.status, 403);
			const stranger = await fetch(`${server.app.url}/api/bootstrap`, { headers: { "Tailscale-User-Login": "stranger@example.com" } });
			assert.equal(stranger.status, 403);
			const shell = await fetch(`${server.app.url}/`, { headers: { "Tailscale-User-Login": "stranger@example.com" } });
			assert.equal(shell.status, 403, "the app shell is behind the allowlist too");
			const owner = await fetch(`${server.app.url}/api/bootstrap`, { headers: { "Tailscale-User-Login": "owner@example.com" } });
			assert.equal(owner.status, 200);
			const second = await fetch(`${server.app.url}/api/bootstrap`, { headers: { "Tailscale-User-Login": "second@example.com" } });
			assert.equal(second.status, 200, "logins compare without case");
		} finally {
			await server.close();
		}
	});

	test("without an allowlist, everyone who can reach the server gets in", async () => {
		const server = await TestServer.start();
		try {
			assert.equal((await fetch(`${server.app.url}/api/bootstrap`)).status, 200);
		} finally {
			await server.close();
		}
	});

	test("a caller running as picloud's own user, as the agent's commands do, is refused even with Tailscale's header", async () => {
		const server = await TestServer.start({ refuseOwnUser: true, env: { PICLOUD_ALLOWED_LOGINS: "owner@example.com" } });
		try {
			const forged = await fetch(`${server.app.url}/api/bootstrap`, { headers: { "Tailscale-User-Login": "owner@example.com" } });
			assert.equal(forged.status, 403);
			assert.match(((await forged.json()) as ApiError).error, /picloud's own user/);
			// Another user, as Tailscale is, gets in. Only root can open a connection as someone else.
			if (process.getuid?.() === 0) {
				const script = `fetch(${JSON.stringify(`${server.app.url}/api/bootstrap`)}, { headers: { "Tailscale-User-Login": "owner@example.com" } }).then((r) => process.stdout.write(String(r.status)))`;
				const status = await new Promise<string>((resolve, reject) => {
					const child = spawn(process.execPath, ["-e", script], { uid: 65534, gid: 65534 });
					let out = "";
					child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
					child.on("error", reject);
					child.on("exit", () => resolve(out));
				});
				assert.equal(status, "200");
			}
		} finally {
			await server.close();
		}
	});

	test("the client end of a connection is found in the kernel's socket table, IPv4 and IPv6", () => {
		// As a little-endian machine prints them: 127.0.0.1 is 0100007F, ::1 ends in 01000000; ports are big-endian hex.
		const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
		const v4 = [
			header,
			"   0: 0100007F:2253 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 11111 1",
			"   1: 0100007F:D431 0100007F:2253 01 00000000:00000000 00:00000000 00000000     0        0 22222 1",
			"   2: 0100007F:2253 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1001        0 33333 1",
		].join("\n");
		const server = { address: "127.0.0.1", port: 8787 };
		assert.equal(clientOwner(v4, { address: "127.0.0.1", port: 54321 }, server), 0);
		assert.equal(clientOwner(v4, { address: "::ffff:127.0.0.1", port: 54321 }, { address: "::ffff:127.0.0.1", port: 8787 }), 0);
		assert.equal(clientOwner(v4, { address: "127.0.0.1", port: 54322 }, server), undefined, "no such connection");
		const loop6 = "00000000000000000000000001000000";
		const v6 = [header, `   0: ${loop6}:D431 ${loop6}:2253 01 00000000:00000000 00:00000000 00000000  1001        0 44444 1`].join("\n");
		assert.equal(clientOwner(v6, { address: "::1", port: 54321 }, { address: "::1", port: 8787 }), 1001);
	});

	test("listens on loopback only and validates the rest of its configuration", () => {
		assert.throws(() => readConfig({ PICLOUD_DATA_DIR: "/tmp/x", PICLOUD_HOST: "0.0.0.0" }), ConfigError);
		assert.throws(() => readConfig({ PICLOUD_DATA_DIR: "/tmp/x", PICLOUD_PORT: "http" }), ConfigError);
		assert.throws(() => readConfig({ PICLOUD_DATA_DIR: "/tmp/x", PICLOUD_SPEND_CAP: "-1" }), ConfigError);
		assert.throws(() => readConfig({ PICLOUD_DATA_DIR: "/tmp/x", PICLOUD_PUSH_SUBJECT: "picloud" }), ConfigError);
		assert.throws(() => readConfig({}), ConfigError);
		const real = { PICLOUD_DATA_DIR: "/tmp/x", PICLOUD_AGENT_GH_TOKEN: "agent-token" };
		assert.throws(() => readConfig({ ...real, PICLOUD_COMPACTION_MODEL: "claude-sonnet" }), /PICLOUD_COMPACTION_MODEL/);
		assert.throws(() => readConfig({ ...real, PICLOUD_COMPACTION_MODEL: "anthropic/" }), /PICLOUD_COMPACTION_MODEL/);
		assert.deepEqual(readConfig({ ...real, PICLOUD_COMPACTION_MODEL: "openrouter/anthropic/claude-sonnet-4.5" }).compactionModel, {
			provider: "openrouter",
			modelId: "anthropic/claude-sonnet-4.5",
		});
		const config = readConfig({ ...real, PICLOUD_HOST: "::1", PICLOUD_SPEND_CAP: "5", PICLOUD_ALLOWED_LOGINS: "A@b.c" });
		assert.equal(config.host, "::1");
		assert.equal(config.spendCap, 5);
		assert.deepEqual(config.allowedLogins, ["a@b.c"]);
		assert.equal(config.port, 8787);
		assert.equal(config.compactionModel, undefined, "each session's own model by default");
		assert.equal(config.agentGitHubToken, "agent-token");
		assert.equal(config.sandbox, true);
	});

	test("real mode needs the agent's own GitHub token; the sandbox is on unless turned off", () => {
		assert.throws(() => readConfig({ PICLOUD_DATA_DIR: "/tmp/x" }), /PICLOUD_AGENT_GH_TOKEN is not set/);
		assert.equal(readConfig({ PICLOUD_DATA_DIR: "/tmp/x", PICLOUD_FAKE: "1" }).agentGitHubToken, undefined);
		const off = readConfig({ PICLOUD_DATA_DIR: "/tmp/x", PICLOUD_FAKE: "1", PICLOUD_SANDBOX: "off" });
		assert.equal(off.sandbox, false);
		assert.throws(() => readConfig({ PICLOUD_DATA_DIR: "/tmp/x", PICLOUD_FAKE: "1", PICLOUD_SANDBOX: "0" }), /PICLOUD_SANDBOX must be on or off/);
	});

	test("real mode without a Pi sign-in exits with instructions before touching the data directory", async () => {
		const parent = await mkdtemp(join(tmpdir(), "picloud-real-"));
		const dataDir = join(parent, "data");
		const agentDir = await mkdtemp(join(tmpdir(), "picloud-pi-"));
		const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "..", "src", "server", "main.ts")], {
			env: { ...process.env, PICLOUD_DATA_DIR: dataDir, PICLOUD_PORT: "0", PI_CODING_AGENT_DIR: agentDir, PICLOUD_FAKE: "", PICLOUD_AGENT_GH_TOKEN: "agent-token" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
		assert.equal(code, 78);
		assert.match(stderr, /\/login/);
		assert.match(stderr, /\/model/);
		assert.deepEqual(await readdir(parent), [], "the data directory was never created");
	});
});
