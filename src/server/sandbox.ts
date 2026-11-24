// The agent sandbox. Every command an agent runs starts through the pigui-sandbox launcher
// (src/sandbox/pigui-sandbox.c), which confines it with Landlock to a session's grants. The file tools run inside
// pigui's own process, where Landlock cannot reach, so `Grants.confine` applies the same grants to their paths.
import { existsSync, realpathSync } from "node:fs";
import { lstat, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { FileError } from "@earendil-works/pi-durable/env";
import { ConfigError } from "./config.ts";
import { CommandError, run } from "./exec.ts";
import type { Logger } from "./log.ts";

/** The system, read and executed by every command; not /home, /root, /opt, /srv, /var, /run or the shared /tmp. */
const SYSTEM = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/etc", "/sys"];

/**
 * Commands also read /proc, where Landlock already hides processes outside their own domain. The file tools never do:
 * they run in pigui's process, whose /proc/self holds pigui's environment and open files.
 */
export const COMMANDS_ONLY = ["/proc"];

/** Signals and abstract unix sockets are scoped to a command's own processes from this Landlock ABI on. */
export const SCOPED_ABI = 6;

export type Sandbox = { launcher: string; abi: number };

export type Access = "read" | "write";

/** The resolved real paths of a grant list; a grant this user cannot reach is dropped, as the launcher drops one it cannot open. */
type GrantSet = { readable: string[]; writable: string[] };

/** What one session's agent may read and write; everything else is out of reach. */
export class Grants {
	readonly readable: readonly string[];
	readonly writable: readonly string[];
	#real: Promise<GrantSet> | undefined;

	constructor(readable: readonly string[], writable: readonly string[]) {
		this.readable = readable;
		this.writable = writable;
	}

	/** The launcher's arguments for these grants; commands also get /proc, the file tools never do. */
	args(): string[] {
		return [
			...[...COMMANDS_ONLY, ...this.readable].flatMap((path) => ["--ro", path]),
			...this.writable.flatMap((path) => ["--rw", path]),
		];
	}

	/**
	 * Undefined when `path` (absolute) may be used for `access`, else the error to return. The check follows symlinks,
	 * including a dangling one a write would create a file through, so a link planted in the workspace cannot lead out.
	 */
	async confine(path: string, access: Access): Promise<FileError | undefined> {
		let real: string;
		try {
			real = await realTarget(path);
		} catch (error) {
			return new FileError(
				"permission_denied",
				`Refused ${path}: pigui cannot tell where it leads (${error instanceof Error ? error.message : String(error)}).`,
				path,
			);
		}
		const grants = await this.#resolved();
		const inside = (roots: readonly string[]) => roots.some((root) => within(real, root));
		if (inside(grants.writable) || (access === "read" && inside(grants.readable))) return undefined;
		const leads = real === path ? "" : ` (it leads to ${real})`;
		const why = inside(grants.readable) ? "is read-only for this session" : "is outside this session's sandbox";
		return new FileError(
			"permission_denied",
			`Refused ${path}${leads}: it ${why}. Files can be written in the working directory, $HOME and $TMPDIR, and read there and in the system's directories.`,
			path,
		);
	}

	/** The real paths of the grants, resolved once, with the ones this user cannot reach left out. */
	#resolved(): Promise<GrantSet> {
		const real = async (paths: readonly string[]) =>
			(await Promise.all(paths.map((path) => realTarget(path).catch(() => undefined)))).filter(
				(path): path is string => path !== undefined,
			);
		this.#real ??= (async () => ({ readable: await real(this.readable), writable: await real(this.writable) }))();
		return this.#real;
	}
}

/**
 * Where `path` really is: its real path, or for a path that does not exist yet, the real path of its nearest existing
 * ancestor with the rest appended, following a dangling symlink to where it points.
 */
async function realTarget(path: string, hops = 0): Promise<string> {
	try {
		return await realpath(path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
	}
	const link = await lstat(path).catch(() => undefined);
	if (link?.isSymbolicLink()) {
		if (hops >= 40) throw new Error("too many levels of symbolic links");
		return realTarget(resolve(dirname(path), await readlink(path)), hops + 1);
	}
	const parent = dirname(path);
	if (parent === path) return path;
	return join(await realTarget(parent, hops), basename(path));
}

function within(path: string, root: string): boolean {
	const rest = relative(root, path);
	return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

/** Everything every session may read: the system, the files its environment points at, and `extra`. */
export function readableGrants(extra: readonly string[]): string[] {
	const grants = [...SYSTEM];
	// Under systemd-resolved, /etc/resolv.conf links into /run, which is otherwise out of reach.
	const resolver = realOrUndefined("/etc/resolv.conf");
	if (resolver !== undefined && !within(resolver, "/etc")) grants.push(dirname(resolver));
	// The Node.js running pigui, which agent commands find on the same PATH: under /usr in both deployments, but a
	// developer's may live anywhere. Its whole installation when it has the usual bin directory (npm is in its lib),
	// else only the program, so a node placed directly in a home directory never opens up the rest of it.
	const node = realOrUndefined(process.execPath);
	if (node !== undefined) grants.push(basename(dirname(node)) === "bin" ? dirname(dirname(node)) : node);
	// Agent commands get these variables, so they must be able to read the certificates they name.
	for (const name of ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"]) {
		const file = process.env[name];
		if (file !== undefined && file !== "") grants.push(resolve(file));
	}
	return [...grants, ...extra];
}

function realOrUndefined(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

/** The launcher `npm run build` compiled beside the sources, else the one on PATH, where the Docker image installs it. */
function launcher(): string {
	const built = join(import.meta.dirname, "..", "..", "dist", "bin", "pigui-sandbox");
	return existsSync(built) ? built : "pigui-sandbox";
}

/** Check that the launcher confines a program and read the kernel's Landlock ABI; throws what is wrong if not. */
async function probe(): Promise<Sandbox> {
	const path = launcher();
	let printed: string;
	try {
		printed = (await run(path, ["--abi"], { timeoutMs: 10_000 })).stdout;
	} catch (error) {
		if (error instanceof CommandError && error.exitCode === null) {
			throw new Error(
				"its launcher, pigui-sandbox, is not installed. `npm run build` compiles it where a C compiler (cc) is installed.",
				{ cause: error },
			);
		}
		throw error;
	}
	const abi = Number(printed.trim());
	if (!Number.isInteger(abi) || abi < 1) throw new Error(`${path} --abi did not print a Landlock ABI.`);
	await run(path, [...new Grants(readableGrants([]), ["/dev"]).args(), "--", "true"], { timeoutMs: 10_000 });
	return { launcher: path, abi };
}

/**
 * The sandbox agent commands run in, or undefined when it is off. Real mode with the sandbox on refuses to start
 * without it; fake mode uses it where the machine has it, so tests exercise it wherever they can.
 */
export async function openSandbox(options: { enabled: boolean; fake: boolean; log: Logger }): Promise<Sandbox | undefined> {
	const { log } = options;
	if (!options.enabled) {
		if (options.fake) log.info("sandbox.off");
		else log.warn("sandbox.off", { reason: "PIGUI_SANDBOX=off: agent commands run unconfined" });
		return undefined;
	}
	let sandbox: Sandbox;
	try {
		sandbox = await probe();
	} catch (error) {
		if (options.fake) {
			log.info("sandbox.unavailable");
			return undefined;
		}
		throw new ConfigError(
			`The agent sandbox does not work here: ${error instanceof Error ? error.message : String(error)}\n` +
				"Run pigui on a host kernel with Landlock (Linux 5.13 or later; Debian 13 is recommended), " +
				"or set PIGUI_SANDBOX=off to run agent commands unconfined.",
		);
	}
	log.info("sandbox.on", { abi: sandbox.abi });
	if (sandbox.abi < SCOPED_ABI) {
		log.warn("sandbox.unscoped", {
			abi: sandbox.abi,
			reason: "Landlock below ABI 6 does not scope signals and abstract unix sockets",
		});
	}
	return sandbox;
}
