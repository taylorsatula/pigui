// Local sessions (picloud OnPrem): a directory on the person's own computer, chosen when the session starts. What the
// person types is resolved here, and the `@` picker's listing of it is read here, bounded so that "/" stays fast.
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { FileList } from "../shared/api.ts";
import { HttpError } from "./errors.ts";

/** `~` and `~/…` in the person's home, as a shell expands them; anything else unchanged. */
export function expandHome(path: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return path;
}

/** What the person typed as an absolute path, `~` expanded, or a 400 the person can act on. Not checked to exist. */
export function absolutePath(given: string, home: string): string {
	const expanded = expandHome(given.trim(), home);
	if (!isAbsolute(expanded)) throw new HttpError(400, `${given} is not an absolute directory.`, "Start it with / or ~, for example ~/code/app.");
	return resolve(expanded);
}

/** The absolute directory a local session works in, or a 400 the person can act on. */
export async function localDirectory(given: string, home: string): Promise<string> {
	const dir = absolutePath(given, home);
	const info = await stat(dir).catch(() => undefined);
	if (info === undefined) throw new HttpError(400, `${dir} does not exist.`, "Choose a directory that exists on this computer.");
	if (!info.isDirectory()) throw new HttpError(400, `${dir} is not a directory.`, "Choose the directory that holds it.");
	return dir;
}

/** Entries that are never worth offering, and some that are slow to walk: hidden files, dependencies, macOS's caches. */
const SKIPPED_NAMES = new Set(["node_modules", "Library"]);

/**
 * Kernel interfaces and devices, and where macOS and automounters put network volumes. Walking them is slow or endless,
 * and a stalled network mount can hang a read. Linux's other network mounts are found in its mount table.
 */
const SKIPPED_PATHS = new Set(["/proc", "/sys", "/dev", "/run", "/net", "/Network", "/Volumes", "/System/Volumes", "/afs"]);

/** Filesystems reached over a network, or mounted on first use, whose mount points the listing does not enter. */
const REMOTE_TYPES = /^(nfs4?|cifs|smb3?|smbfs|ncpfs|9p|afs|ceph|glusterfs|lustre|gpfs|beegfs|davfs|autofs|fuse\.(sshfs|rclone|s3fs|davfs2?|glusterfs))$/;

/** Mount points of remote filesystems on Linux, from the kernel's mount table; none where there is no /proc. */
async function remoteMounts(): Promise<Set<string>> {
	const table = await readFile("/proc/self/mounts", "utf8").catch(() => "");
	const found = new Set<string>();
	for (const line of table.split("\n")) {
		const [, mountPoint, type] = line.split(" ");
		// The table writes a space in a path as \040.
		if (mountPoint !== undefined && type !== undefined && REMOTE_TYPES.test(type)) found.add(mountPoint.replace(/\\040/g, " "));
	}
	return found;
}

export const LISTING_LIMITS = { entries: 5000, ms: 1500 };

/**
 * The files under `root`, as paths relative to it, nearest first (breadth-first), for the `@` picker. Hidden entries,
 * dependencies, kernel and device trees and network mounts are left out, symlinks are listed but not followed, and the
 * walk stops at a number of entries or a time limit, `truncated` saying so. A directory that cannot be read is skipped.
 */
export async function listDirectory(root: string, limits: { entries: number; ms: number } = LISTING_LIMITS): Promise<FileList> {
	const deadline = Date.now() + limits.ms;
	const remote = await remoteMounts();
	const files: string[] = [];
	const queue: string[] = [""];
	for (let next = 0; next < queue.length; next++) {
		const relative = queue[next] ?? "";
		const left = deadline - Date.now();
		if (left <= 0) return { files, truncated: true };
		const entries = await readWithin(join(root, relative), left);
		if (entries === "timeout") return { files, truncated: true };
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name.startsWith(".") || SKIPPED_NAMES.has(entry.name)) continue;
			const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
			const absolute = join(root, path);
			if (entry.isDirectory()) {
				if (!SKIPPED_PATHS.has(absolute) && !remote.has(absolute)) queue.push(path);
				continue;
			}
			if (!entry.isFile() && !entry.isSymbolicLink()) continue;
			if (files.length >= limits.entries) return { files, truncated: true };
			files.push(path);
		}
	}
	return { files, truncated: false };
}

/** A directory's entries, or "timeout" when reading it takes longer than `ms`, as a stalled mount would. */
async function readWithin(dir: string, ms: number): Promise<Dirent[] | "timeout"> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<"timeout">((done) => {
		timer = setTimeout(() => done("timeout"), ms);
	});
	try {
		return await Promise.race([readdir(dir, { withFileTypes: true }).catch((): Dirent[] => []), timeout]);
	} finally {
		clearTimeout(timer);
	}
}
