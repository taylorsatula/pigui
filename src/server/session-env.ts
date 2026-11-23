// Where a session's agent works: Durable's Node environment, with commands run in an environment picloud chooses
// rather than its own, inside the sandbox when it is on, and the file tools confined to the same grants. In picloud
// OnPrem the agent works as the person instead: their environment, home and credentials, with nothing confined.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord/context";
import type { EnvTarget } from "@earendil-works/pi-durable";
import {
	type BinaryReader,
	type DirReader,
	type ExecutionEnv,
	err,
	type ExecutionError,
	FileError,
	type FileChange,
	type FileInfo,
	type FileWatcher,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type TextLineReader,
	type WatchTarget,
} from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { OnPrem } from "./config.ts";
import { NO_PROMPT_ENV } from "./git.ts";
import { type Access, Grants, type Sandbox } from "./sandbox.ts";

/** Durable's shell for a command string, chosen here because the launcher, not Durable, starts it. */
const SHELL = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";

/**
 * What agent commands take from picloud's environment, when set: what programs need to run, and the proxy and
 * certificates to reach the network through. Never picloud's own settings, tokens or provider keys.
 */
const PASSED = new Set([
	"PATH", "LANG", "TZ", "TERM", "USER", "LOGNAME", "SHELL",
	"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
]);

/** A session's scratch directory holds these: the agent's own home, tmp and gh configuration. */
const SCRATCH = ["home", "tmp", "gh"] as const;

/** The whole environment of a session's commands. */
function agentEnvironment(scratch: string, gitHubToken: string | undefined): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (value !== undefined && (PASSED.has(name) || name.startsWith("LC_"))) env[name] = value;
	}
	Object.assign(env, NO_PROMPT_ENV, {
		HOME: join(scratch, "home"),
		TMPDIR: join(scratch, "tmp"),
		// gh would otherwise read the service user's hosts.yml, which holds picloud's own token under the installer.
		GH_CONFIG_DIR: join(scratch, "gh"),
	});
	// gh reads GH_TOKEN, and git through gh's credential helper; other tools look for GITHUB_TOKEN.
	if (gitHubToken !== undefined) Object.assign(env, { GH_TOKEN: gitHubToken, GITHUB_TOKEN: gitHubToken });
	return env;
}

/**
 * OnPrem's environment for commands: the person's own, as picloud was started with it, without picloud's `PICLOUD_*`
 * settings, and with their home. Their tools, credentials and TMPDIR come with it. Nobody can answer a prompt, so git's
 * are still turned off.
 */
function personEnvironment(home: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (value !== undefined && !name.startsWith("PICLOUD_")) env[name] = value;
	}
	return Object.assign(env, NO_PROMPT_ENV, { HOME: home });
}

type SessionEnvOptions = {
	cwd: string;
	/** What `~` is for the file tools, as it is in commands: the session's own home, or in OnPrem the person's. */
	home: string;
	/** Where the agent's temporary directories go. */
	tmp: string;
	environment: Record<string, string>;
	/** Undefined when the sandbox is off: commands and file tools are then unconfined. */
	sandbox?: { launcher: string; grants: Grants };
};

class SessionEnv extends NodeExecutionEnv {
	readonly #home: string;
	readonly #tmp: string;
	readonly #environment: Record<string, string>;
	readonly #sandbox: SessionEnvOptions["sandbox"];

	constructor(options: SessionEnvOptions) {
		super({ cwd: options.cwd });
		this.#home = options.home;
		this.#tmp = options.tmp;
		this.#environment = options.environment;
		this.#sandbox = options.sandbox;
	}

	/** A path as Durable resolves it, except that `~` is the home the session's commands have. */
	#resolve(path: string): string {
		if (path === "~") return this.#home;
		if (path.startsWith("~/")) return join(this.#home, path.slice(2));
		if (path.startsWith("file://")) {
			try {
				return resolve(fileURLToPath(path));
			} catch {
				// A malformed URL stays an ordinary path, as in Durable.
			}
		}
		return resolve(this.cwd, path);
	}

	async #confined<T>(path: string, access: Access, use: (resolved: string) => Promise<Result<T, FileError>>): Promise<Result<T, FileError>> {
		const resolved = this.#resolve(path);
		const refused = await this.#sandbox?.grants.confine(resolved, access);
		return refused === undefined ? use(resolved) : err(refused);
	}

	override exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
		const confined = { ...options, env: { ...this.#environment, ...options?.env }, inheritEnv: false };
		const argv = typeof command === "string" ? [SHELL, "-c", command] : command;
		if (this.#sandbox === undefined || argv.length === 0) return super.exec(command, confined, context);
		return super.exec([this.#sandbox.launcher, ...this.#sandbox.grants.args(), "--", ...argv], confined, context);
	}

	override async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
		return ok(this.#resolve(path));
	}

	override readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.#confined(path, "read", (resolved) => super.readTextFile(resolved, context));
	}

	override openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		return this.#confined(path, "read", (resolved) => super.openTextLineReader(resolved, context));
	}

	override readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
		return this.#confined(path, "read", (resolved) => super.readTextLines(resolved, options, context));
	}

	override readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		return this.#confined(path, "read", (resolved) => super.readBinaryFile(resolved, context));
	}

	override openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
		return this.#confined(path, "read", (resolved) => super.openBinaryReader(resolved, options, context));
	}

	override writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.#confined(path, "write", (resolved) => super.writeFile(resolved, content, context));
	}

	override appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.#confined(path, "write", (resolved) => super.appendFile(resolved, content, context));
	}

	override truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
		return this.#confined(path, "write", (resolved) => super.truncateFile(resolved, size, context));
	}

	override flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
		return this.#confined(path, "write", (resolved) => super.flushFile(resolved, context));
	}

	override renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
		return this.#confined(sourcePath, "write", (source) =>
			this.#confined(destinationPath, "write", (destination) => super.renameFile(source, destination, context)),
		);
	}

	override fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		return this.#confined(path, "read", (resolved) => super.fileInfo(resolved, context));
	}

	override exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		return this.#confined(path, "read", (resolved) => super.exists(resolved, context));
	}

	override listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		return this.#confined(path, "read", (resolved) => super.listDir(resolved, context));
	}

	override openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		return this.#confined(path, "read", (resolved) => super.openDirReader(resolved, context));
	}

	override canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.#confined(path, "read", (resolved) => super.canonicalPath(resolved, context));
	}

	override createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
		return this.#confined(path, "write", (resolved) => super.createDir(resolved, options, context));
	}

	override remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
		return this.#confined(path, "write", (resolved) => super.remove(resolved, options, context));
	}

	override async watch(targets: readonly WatchTarget[], onChange: (change: FileChange) => void, context: Context): Promise<Result<FileWatcher, FileError>> {
		const resolved: WatchTarget[] = [];
		for (const target of targets) {
			const path = this.#resolve(target.path);
			const refused = await this.#sandbox?.grants.confine(path, "read");
			if (refused !== undefined) return err(refused);
			resolved.push({ ...target, path });
		}
		return super.watch(resolved, onChange, context);
	}

	/** In the tmp its commands have, so they can read what lands there, such as a long command's full output. */
	override async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		if (context.abortSignal?.aborted) return err(new FileError("aborted", "aborted"));
		try {
			return ok(await mkdtemp(join(this.#tmp, prefix ?? "tmp-")));
		} catch (error) {
			return err(new FileError("unknown", error instanceof Error ? error.message : String(error), this.#tmp));
		}
	}
}

export type SessionEnvsOptions = {
	/** A session's workspace and scratch directory. */
	dirs: (session: number) => { workspace: string; scratch: string };
	/** The agent's read-only GitHub token. */
	gitHubToken: string | undefined;
	sandbox: Sandbox | undefined;
	/** What every session may read besides its own directories. */
	readable: readonly string[];
	/** OnPrem: commands run as the person, with their home, and none of the above applies. */
	onPrem: OnPrem | undefined;
};

/**
 * Durable's `env` option: each session's environment, built at each use. Commands start in the conversation's cwd:
 * a repository session's clone, or a local session's chosen directory.
 */
export function sessionEnvs(options: SessionEnvsOptions): (target: EnvTarget) => Promise<ExecutionEnv> {
	return async ({ conversationId, cwd }) => {
		const { workspace, scratch } = options.dirs(conversationId as number);
		if (options.onPrem !== undefined) {
			const { home } = options.onPrem;
			return new SessionEnv({ cwd: cwd ?? workspace, home, tmp: tmpdir(), environment: personEnvironment(home) });
		}
		// Made here rather than at setup, so a session from before the sandbox gets them on its next command.
		for (const dir of SCRATCH) await mkdir(join(scratch, dir), { recursive: true });
		const sandbox = options.sandbox;
		return new SessionEnv({
			cwd: cwd ?? workspace,
			home: join(scratch, "home"),
			tmp: join(scratch, "tmp"),
			environment: agentEnvironment(scratch, options.gitHubToken),
			...(sandbox === undefined
				? {}
				: { sandbox: { launcher: sandbox.launcher, grants: new Grants(options.readable, [workspace, scratch, "/dev"]) } }),
		});
	};
}
