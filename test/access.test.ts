import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { ApiError } from "../src/shared/api.ts";
import { admits, clientOwner } from "../src/server/callers.ts";
import { ConfigError, readConfig } from "../src/server/config.ts";
import { TestServer } from "./helpers.ts";

/**
 * A request with exactly these headers, Host included, which fetch would not let a test choose. Resolves with the
 * status and the error the body carries.
 */
function raw(url: string, method: string, path: string, headers: Record<string, string>, body = ""): Promise<{ status: number; error?: string }> {
	const { hostname, port } = new URL(url);
	return new Promise((resolve, reject) => {
		const outgoing = httpRequest({ hostname, port, method, path, headers: { ...headers, "content-length": Buffer.byteLength(body) }, setHost: false }, (response) => {
			let text = "";
			response.on("data", (chunk: Buffer) => (text += chunk.toString()));
			response.on("end", () => resolve({ status: response.statusCode ?? 0, error: (JSON.parse(text || "{}") as Partial<ApiError>).error }));
		});
		outgoing.on("error", reject);
		outgoing.end(body);
	});
}

/** A push subscription the server accepts: a POST that changes something, as the app sends one. */
const SUBSCRIPTION = JSON.stringify({
	endpoint: "https://push.example.com/send/abc",
	keys: { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" },
});

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
		const server = await TestServer.start({ checkCallers: true, env: { PICLOUD_ALLOWED_LOGINS: "owner@example.com" } });
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

	test("OnPrem is off unless turned on, listens on 2025 by default, and refuses the settings that would not apply", () => {
		const base = { PICLOUD_DATA_DIR: "/tmp/x" };
		assert.equal(readConfig({ ...base, PICLOUD_AGENT_GH_TOKEN: "agent-token" }).onPrem, undefined);
		assert.throws(() => readConfig({ ...base, PICLOUD_ONPREM: "1" }), /PICLOUD_ONPREM must be on or off/);
		// No agent token is needed, the sandbox is off, and Pi's real configuration is the person's own.
		const onPrem = readConfig({ ...base, PICLOUD_ONPREM: "on", HOME: "/home/someone" });
		assert.deepEqual(onPrem.onPrem, { home: "/home/someone", hosts: [] });
		assert.equal(onPrem.port, 2025);
		assert.equal(onPrem.host, "127.0.0.1", "still loopback only");
		assert.equal(onPrem.sandbox, false);
		assert.equal(onPrem.agentGitHubToken, undefined);
		assert.equal(onPrem.fake, false);
		assert.equal(readConfig({ ...base, PICLOUD_ONPREM: "on", PICLOUD_PORT: "4100" }).port, 4100);
		assert.equal(readConfig({ ...base, PICLOUD_ONPREM: "on", PICLOUD_SANDBOX: "off" }).sandbox, false);
		assert.equal(readConfig({ ...base, PICLOUD_ONPREM: "on", PICLOUD_FAKE: "1" }).fake, true, "fake mode combines with it");
		assert.throws(() => readConfig({ ...base, PICLOUD_ONPREM: "on", PICLOUD_SANDBOX: "on" }), /PICLOUD_SANDBOX=on cannot be combined with PICLOUD_ONPREM=on/);
		// Reached through Tailscale too, from a phone: the names it is served under, and the logins let in through it.
		const tailnet = readConfig({ ...base, PICLOUD_ONPREM: "on", PICLOUD_ALLOWED_HOSTS: " Mac.Tail1234.ts.net., other.example ", PICLOUD_ALLOWED_LOGINS: "Me@Example.com" });
		assert.deepEqual(tailnet.onPrem?.hosts, ["mac.tail1234.ts.net", "other.example"]);
		assert.deepEqual(tailnet.allowedLogins, ["me@example.com"]);
		assert.throws(() => readConfig({ ...base, PICLOUD_ONPREM: "on", PICLOUD_ALLOWED_HOSTS: "https://mac.ts.net" }), /PICLOUD_ALLOWED_HOSTS must be host names/);
		assert.throws(() => readConfig({ ...base, PICLOUD_ONPREM: "on", PICLOUD_ALLOWED_HOSTS: "mac.ts.net:443" }), /without a scheme or port/);
		assert.throws(() => readConfig({ ...base, PICLOUD_AGENT_GH_TOKEN: "t", PICLOUD_ALLOWED_HOSTS: "mac.ts.net" }), /PICLOUD_ALLOWED_HOSTS applies only with PICLOUD_ONPREM=on/);
		assert.throws(() => readConfig({ ...base, PICLOUD_ONPREM: "on", PICLOUD_AGENT_GH_TOKEN: "t" }), /PICLOUD_AGENT_GH_TOKEN cannot be combined/);
		assert.throws(() => readConfig({ ...base, PICLOUD_ONPREM: "on", PICLOUD_HOST: "0.0.0.0" }), /not a loopback address/);
	});

	test("a request that changes something is refused from another site's page, on a server and in OnPrem", async () => {
		const home = await mkdtemp(join(tmpdir(), "picloud-home-"));
		const servers = [await TestServer.start(), await TestServer.start({ env: { PICLOUD_ONPREM: "on", HOME: home } })];
		try {
			for (const server of servers) {
				const { host } = new URL(server.app.url);
				const post = (headers: Record<string, string>, type = "application/json") =>
					raw(server.app.url, "POST", "/api/push/subscribe", { host, "content-type": type, ...headers }, SUBSCRIPTION);
				// A cross-site page's simple POST: text/plain needs no preflight, and the body is JSON all the same.
				const forged = await post({ "sec-fetch-site": "cross-site", origin: "https://evil.example" }, "text/plain");
				assert.equal(forged.status, 403);
				assert.match(forged.error ?? "", /another site/);
				assert.equal((await post({ "sec-fetch-site": "same-site" })).status, 403, "another port of localhost is same-site, not same-origin");
				assert.equal((await post({ origin: "https://evil.example" })).status, 403, "a browser without Sec-Fetch-Site still sends Origin");
				assert.equal((await post({ origin: "null" })).status, 403, "a sandboxed frame or a file: page");
				// The app's own requests, as its page and service worker send them, and a client that is not a browser.
				assert.equal((await post({ "sec-fetch-site": "same-origin", origin: server.app.url })).status, 200);
				assert.equal((await post({})).status, 200);
				assert.equal((await raw(server.app.url, "GET", "/api/bootstrap", { host, "sec-fetch-site": "cross-site" })).status, 200, "reading is not gated");
			}
		} finally {
			for (const server of servers) await server.close();
			await rm(home, { recursive: true, force: true });
		}
	});

	test("on a server, the Origin's host may be the one Tailscale forwards when the proxy names another", async () => {
		const server = await TestServer.start();
		try {
			const headers = { host: "127.0.0.1:8787", "x-forwarded-host": "picloud.tailnet.ts.net", "content-type": "application/json", "sec-fetch-site": "same-origin" };
			assert.equal((await raw(server.app.url, "POST", "/api/push/subscribe", { ...headers, origin: "https://picloud.tailnet.ts.net" }, SUBSCRIPTION)).status, 200);
			assert.equal((await raw(server.app.url, "POST", "/api/push/subscribe", { ...headers, origin: "https://evil.example" }, SUBSCRIPTION)).status, 403);
		} finally {
			await server.close();
		}
	});

	test("OnPrem answers only to localhost at its own port, so a rebound name cannot reach it", async () => {
		const home = await mkdtemp(join(tmpdir(), "picloud-home-"));
		const server = await TestServer.start({ env: { PICLOUD_ONPREM: "on", HOME: home } });
		try {
			const { port } = new URL(server.app.url);
			const get = (host: string) => raw(server.app.url, "GET", "/api/bootstrap", { host });
			for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `LOCALHOST:${port}`]) assert.equal((await get(host)).status, 200, host);
			const rebound = await get(`evil.example:${port}`);
			assert.equal(rebound.status, 403);
			assert.match(rebound.error ?? "", /answers only to localhost/);
			assert.equal((await get(`localhost:${Number(port) + 1}`)).status, 403, "another port");
			assert.equal((await get("localhost")).status, 403);
			assert.equal((await raw(server.app.url, "GET", "/", { host: `evil.example:${port}` })).status, 403, "the app shell too");
			// A server is reached through Tailscale under its own name, so it checks no host.
			const behind = await TestServer.start();
			try {
				assert.equal((await raw(behind.app.url, "GET", "/api/bootstrap", { host: "picloud.tailnet.ts.net" })).status, 200);
			} finally {
				await behind.close();
			}
		} finally {
			await server.close();
			await rm(home, { recursive: true, force: true });
		}
	});

	test("OnPrem answers to its tailnet names too, and lets in through them only the allowed Tailscale logins", async () => {
		const home = await mkdtemp(join(tmpdir(), "picloud-home-"));
		const server = await TestServer.start({ env: { PICLOUD_ONPREM: "on", HOME: home, PICLOUD_ALLOWED_HOSTS: "mac.tail1234.ts.net", PICLOUD_ALLOWED_LOGINS: "me@example.com" } });
		try {
			const { port } = new URL(server.app.url);
			const get = (host: string, login?: string) => raw(server.app.url, "GET", "/api/bootstrap", login === undefined ? { host } : { host, "tailscale-user-login": login });
			// tailscale serve names picloud as the phone asked, without a port on 443, and adds the login.
			assert.equal((await get("mac.tail1234.ts.net", "me@example.com")).status, 200);
			assert.equal((await get("MAC.tail1234.ts.net:443", "Me@Example.com")).status, 200);
			const stranger = await get("mac.tail1234.ts.net", "someone@else.com");
			assert.equal(stranger.status, 403);
			assert.match(stranger.error ?? "", /Tailscale login is not allowed/);
			assert.equal((await get("mac.tail1234.ts.net")).status, 403, "through the tailnet without a login");
			// The computer's own browser, at localhost, needs no login; one that claims a login is held to it.
			assert.equal((await get(`localhost:${port}`)).status, 200);
			assert.equal((await get(`localhost:${port}`, "someone@else.com")).status, 403);
			const elsewhere = await get("other.tail1234.ts.net");
			assert.equal(elsewhere.status, 403);
			assert.match(elsewhere.error ?? "", /PICLOUD_ALLOWED_HOSTS/);
			// A change through the tailnet comes from picloud's page at that name.
			const post = (origin: string) =>
				raw(server.app.url, "POST", "/api/push/subscribe", { host: "mac.tail1234.ts.net", "tailscale-user-login": "me@example.com", "content-type": "application/json", "sec-fetch-site": "same-origin", origin }, SUBSCRIPTION);
			assert.equal((await post("https://mac.tail1234.ts.net")).status, 200);
			assert.equal((await post("https://evil.example")).status, 403);
		} finally {
			await server.close();
			await rm(home, { recursive: true, force: true });
		}
	});

	test("the caller check admits, on a server, anyone but picloud's own user; in OnPrem, that user and root", () => {
		assert.equal(admits("others", 0, 999), true, "tailscaled, as root");
		assert.equal(admits("others", 999, 999), false, "the agent's commands");
		assert.equal(admits("own", 999, 999), true, "the person's browser");
		assert.equal(admits("own", 0, 999), true, "tailscale serve, as root");
		assert.equal(admits("own", 1001, 999), false, "another user of the computer");
	});

	test("OnPrem on Linux lets in only its own user, whose browser it serves, and never trusts a Tailscale header", async () => {
		const home = await mkdtemp(join(tmpdir(), "picloud-home-"));
		const server = await TestServer.start({ checkCallers: true, env: { PICLOUD_ONPREM: "on", HOME: home } });
		try {
			assert.equal((await fetch(`${server.app.url}/api/bootstrap`)).status, 200, "picloud's own user, as the person's browser is");
			// Another user of the computer is refused. Only root can open a connection as someone else.
			if (process.getuid?.() === 0) {
				const script = `fetch(${JSON.stringify(`${server.app.url}/api/bootstrap`)}, { headers: { "Tailscale-User-Login": "owner@example.com" } }).then(async (r) => process.stdout.write(r.status + " " + (await r.json()).error))`;
				const answer = await new Promise<string>((resolve, reject) => {
					const child = spawn(process.execPath, ["-e", script], { uid: 65534, gid: 65534 });
					let out = "";
					child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
					child.on("error", reject);
					child.on("exit", () => resolve(out));
				});
				assert.match(answer, /^403 This connection comes from another user of this computer/);
			}
		} finally {
			await server.close();
			await rm(home, { recursive: true, force: true });
		}
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
