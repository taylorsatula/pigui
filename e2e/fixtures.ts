// Each test file gets its own fake-mode server, run as `npm run fake` runs it: a child process on a free port with a
// temporary data directory and an empty Pi configuration. Restarting kills it and starts it again on the same port and
// data, as a real restart would. An OnPrem server also gets a temporary home directory of its own.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() => resolve(typeof address === "object" && address !== null ? address.port : 0));
		});
	});
}

type ServerOptions = { tokensPerSecond: number; memory: "on" | "off"; onPrem: boolean };

export class FakeServer {
	readonly url: string;
	/** OnPrem's stand-in for the person's home directory. */
	readonly home: string | undefined;
	readonly #env: NodeJS.ProcessEnv;
	readonly #dirs: string[];
	#child: ChildProcess | undefined;

	private constructor(port: number, dataDir: string, agentDir: string, home: string | undefined, options: ServerOptions) {
		// OnPrem is opened as the installer opens it, at localhost.
		this.url = `http://${options.onPrem ? "localhost" : "127.0.0.1"}:${port}`;
		this.home = home;
		this.#dirs = [dataDir, agentDir, ...(home === undefined ? [] : [home])];
		this.#env = {
			...process.env,
			PICLOUD_PORT: String(port),
			PICLOUD_DATA_DIR: dataDir,
			PI_CODING_AGENT_DIR: agentDir,
			PICLOUD_FAKE_TOKENS_PER_SECOND: String(options.tokensPerSecond),
			PICLOUD_FAKE_MEMORY: options.memory,
			...(home === undefined ? {} : { PICLOUD_ONPREM: "on", HOME: home }),
		};
	}

	static async start(options: ServerOptions): Promise<FakeServer> {
		const home = options.onPrem ? await mkdtemp(join(tmpdir(), "picloud-home-")) : undefined;
		const server = new FakeServer(await freePort(), await mkdtemp(join(tmpdir(), "picloud-e2e-")), await mkdtemp(join(tmpdir(), "picloud-pi-")), home, options);
		await server.#spawn();
		return server;
	}

	async #spawn(): Promise<void> {
		const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "..", "scripts", "fake.ts")], {
			env: this.#env,
			stdio: ["ignore", "pipe", "inherit"],
		});
		this.#child = child;
		await new Promise<void>((resolve, reject) => {
			let output = "";
			child.stdout?.on("data", (chunk: Buffer) => {
				output += chunk.toString();
				if (output.includes("picloud fake mode on")) resolve();
			});
			child.once("exit", (code) => reject(new Error(`The fake server exited with ${code}`)));
		});
	}

	async stop(): Promise<void> {
		const child = this.#child;
		if (child === undefined || child.exitCode !== null) return;
		const exited = new Promise((resolve) => child.once("exit", resolve));
		child.kill("SIGTERM");
		await exited;
	}

	async restart(): Promise<void> {
		await this.stop();
		await this.#spawn();
	}

	async dispose(): Promise<void> {
		await this.stop();
		for (const dir of this.#dirs) await rm(dir, { recursive: true, force: true });
	}
}

export const test = base.extend<{ errors: string[] }, { server: FakeServer; tokensPerSecond: number; memory: "on" | "off"; onPrem: boolean }>({
	/** How fast the scripted model writes; a test file that needs to watch text arrive slows it. */
	tokensPerSecond: [300, { scope: "worker", option: true }],
	/** Off starts the server as one without an embedder. */
	memory: ["on", { scope: "worker", option: true }],
	/** On starts picloud OnPrem, as on the person's own computer. */
	onPrem: [false, { scope: "worker", option: true }],
	server: [
		async ({ tokensPerSecond, memory, onPrem }, use) => {
			const server = await FakeServer.start({ tokensPerSecond, memory, onPrem });
			await use(server);
			await server.dispose();
		},
		{ scope: "worker" },
	],
	baseURL: async ({ server }, use) => use(server.url),
	errors: async ({ page }, use) => {
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(String(error)));
		page.on("console", (message) => {
			if (message.type() === "error") errors.push(message.text());
		});
		await use(errors);
	},
});

export { expect };

/** Start a session from the New session view and wait for its page. */
export async function startSession(page: Page, text: string): Promise<void> {
	await page.goto("/");
	const composer = page.getByRole("textbox", { name: "Describe the task…" });
	await expect(composer).toBeEnabled();
	await composer.fill(text);
	await page.getByRole("button", { name: "Send", exact: true }).tap();
	await expect(page).toHaveURL(/#\/s\/\d+/);
}

/** Accept the recommended answers, then approve the plan. */
export async function approveThrough(page: Page): Promise<void> {
	await page.getByRole("button", { name: "Send answers" }).tap();
	await page.getByRole("button", { name: "Approve" }).tap();
}
