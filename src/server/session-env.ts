// Where a session's agent works. Durable's Node environment, with commands started in an environment pigui
// composes rather than the server's own, wrapped in the sandbox when it is on, and the file tools held to the
// same grants. In pigui OnPrem the agent works as the person instead: their environment, their home, their
// credentials, and nothing confined.
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
import { agentSession } from "./subagents/extension.ts";

/** Which shell runs a command string; the launcher, not Durable, starts it, so bash when there is one. */
const SHELL = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";

/**
 * The variables of pigui's own environment an agent command may see, when set: what programs need in order to
 * run, and the proxy and certificate settings for reaching the network through them. Never pigui's settings,
 * tokens or provider keys.
 */
const COMMAND_ENV_VARS = new Set([
	"PATH", "LANG", "TZ", "TERM", "USER", "LOGNAME", "SHELL",
	"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
]);

/** Made inside a session's scratch directory: the agent's own home, tmp and gh configuration. */
const SCRATCH_DIRS = ["home", "tmp", "gh"] as const;

/** A command's whole environment: the whitelist, the no-prompt git settings, the scratch home and gh token. */
function commandEnvironment(scratch: string, gitHubToken: string | undefined): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (COMMAND_ENV_VARS.has(name) || name.startsWith("LC_")) environment[name] = value;
	}
	Object.assign(environment, NO_PROMPT_ENV, {
		HOME: join(scratch, "home"),
		TMPDIR: join(scratch, "tmp"),
		// gh would otherwise read the service user's hosts.yml, which holds pigui's own token under the installer.
		GH_CONFIG_DIR: join(scratch, "gh"),
	});
	// gh reads GH_TOKEN, and git through gh's credential helper; other tools look for GITHUB_TOKEN.
	if (gitHubToken !== undefined) Object.assign(environment, { GH_TOKEN: gitHubToken, GITHUB_TOKEN: gitHubToken });
	return environment;
}

/**
 * OnPrem's command environment: the person's own, as pigui was started with it, minus pigui's `PIGUI_*`
 * settings, with their home restored. Their tools, credentials and TMPDIR come along; only git's prompts are
 * still silenced, since nobody can answer one.
 */
function onPremEnvironment(home: string): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (value === undefined || name.startsWith("PIGUI_")) continue;
		environment[name] = value;
	}
	return Object.assign(environment, NO_PROMPT_ENV, { HOME: home });
}

export type SessionEnvOptions = {
	cwd: string;
	/** What `~` means to the file tools, as it does to commands: the session's own home, or the person's in OnPrem. */
	home: string;
	/** Where the agent's temporary directories go. */
	tmp: string;
	environment: Record<string, string>;
	/** Undefined when the sandbox is off: commands and file tools are then unconfined. */
	sandbox?: { launcher: string; grants: Grants };
};

/** One session's environment: Pi's Node environment under pigui's rules. */
export class SessionEnv extends NodeExecutionEnv {
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

	/** A path the way Durable resolves it, except that `~` is the home this session's commands have. */
	#locate(path: string): string {
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

	/** Run `use` on the resolved path, unless the sandbox refuses it. */
	async #guarded<T>(path: string, access: Access, use: (resolved: string) => Promise<Result<T, FileError>>): Promise<Result<T, FileError>> {
		const resolved = this.#locate(path);
		const refused = await this.#sandbox?.grants.confine(resolved, access);
		return refused === undefined ? use(resolved) : err(refused);
	}

	override exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
		const spawn: ShellExecOptions = { ...options, env: { ...this.#environment, ...options?.env }, inheritEnv: false };
		const argv = typeof command === "string" ? [SHELL, "-c", command] : command;
		if (this.#sandbox === undefined || argv.length === 0) return super.exec(command, spawn, context);
		return super.exec([this.#sandbox.launcher, ...this.#sandbox.grants.args(), "--", ...argv], spawn, context);
	}

	override async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
		return ok(this.#locate(path));
	}

	override readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.#guarded(path, "read", (resolved) => super.readTextFile(resolved, context));
	}

	override openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		return this.#guarded(path, "read", (resolved) => super.openTextLineReader(resolved, context));
	}

	override readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
		return this.#guarded(path, "read", (resolved) => super.readTextLines(resolved, options, context));
	}

	override readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		return this.#guarded(path, "read", (resolved) => super.readBinaryFile(resolved, context));
	}

	override openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
		return this.#guarded(path, "read", (resolved) => super.openBinaryReader(resolved, options, context));
	}

	override writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.#guarded(path, "write", (resolved) => super.writeFile(resolved, content, context));
	}

	override appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.#guarded(path, "write", (resolved) => super.appendFile(resolved, content, context));
	}

	override truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
		return this.#guarded(path, "write", (resolved) => super.truncateFile(resolved, size, context));
	}

	override flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
		return this.#guarded(path, "write", (resolved) => super.flushFile(resolved, context));
	}

	override renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
		return this.#guarded(sourcePath, "write", (source) =>
			this.#guarded(destinationPath, "write", (destination) => super.renameFile(source, destination, context)),
		);
	}

	override fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		return this.#guarded(path, "read", (resolved) => super.fileInfo(resolved, context));
	}

	override exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		return this.#guarded(path, "read", (resolved) => super.exists(resolved, context));
	}

	override listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		return this.#guarded(path, "read", (resolved) => super.listDir(resolved, context));
	}

	override openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		return this.#guarded(path, "read", (resolved) => super.openDirReader(resolved, context));
	}

	override canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.#guarded(path, "read", (resolved) => super.canonicalPath(resolved, context));
	}

	override createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
		return this.#guarded(path, "write", (resolved) => super.createDir(resolved, options, context));
	}

	override remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
		return this.#guarded(path, "write", (resolved) => super.remove(resolved, options, context));
	}

	override async watch(targets: readonly WatchTarget[], onChange: (change: FileChange) => void, context: Context): Promise<Result<FileWatcher, FileError>> {
		const resolved: WatchTarget[] = [];
		for (const target of targets) {
			const path = this.#locate(target.path);
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
 * Durable's `env` option: each session's environment, built at each use. Commands start in the conversation's
 * cwd: a repository session's clone, or a local session's chosen directory. An agent's conversation is its
 * session's for this, so the agent's commands run exactly where and as the session's own agent's do.
 */
export function sessionEnvs(options: SessionEnvsOptions): (target: EnvTarget, context: Context) => Promise<ExecutionEnv> {
	return async ({ conversationId, cwd, read }, context) => {
		const session = (await agentSession(read, conversationId, context)) ?? conversationId;
		const { workspace, scratch } = options.dirs(session as number);
		if (options.onPrem !== undefined) {
			const { home } = options.onPrem;
			return new SessionEnv({ cwd: cwd ?? workspace, home, tmp: tmpdir(), environment: onPremEnvironment(home) });
		}
		// Made here rather than at setup, so a session from before the sandbox gets them on its next command.
		for (const dir of SCRATCH_DIRS) await mkdir(join(scratch, dir), { recursive: true });
		const sandbox = options.sandbox;
		return new SessionEnv({
			cwd: cwd ?? workspace,
			home: join(scratch, "home"),
			tmp: join(scratch, "tmp"),
			environment: commandEnvironment(scratch, options.gitHubToken),
			...(sandbox === undefined ? {} : { sandbox: { launcher: sandbox.launcher, grants: new Grants(options.readable, [workspace, scratch, "/dev"]) } }),
		});
	};
}
