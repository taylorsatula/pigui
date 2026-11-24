// Local OnPrem sessions: a directory on the person's own computer, picked when the session starts. What the
// person types — a path, or `~` for home — is checked here, and the `@` picker's listing of that directory is
// built here, bounded so that pointing it at "/" stays quick.
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { FileList } from "../shared/api.ts";
import { HttpError } from "./errors.ts";

/** `~` and `~/…` expand against home, the way a shell expands them; every other path is left alone. */
export function expandHome(path: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return path;
}

/** Make what the person typed absolute, expanding `~`; anything not absolute is a 400 saying how to fix it. */
export function absolutePath(given: string, home: string): string {
	const expanded = expandHome(given.trim(), home);
	if (!isAbsolute(expanded)) throw new HttpError(400, `${given} is not an absolute directory.`, "Start it with / or ~, for example ~/code/app.");
	return resolve(expanded);
}

/** The directory a local session would work in, verified to exist and be a directory, or a 400 explaining why not. */
export async function localDirectory(given: string, home: string): Promise<string> {
	const dir = absolutePath(given, home);
	const info = await stat(dir).catch(() => undefined);
	if (info === undefined) throw new HttpError(400, `${dir} does not exist.`, "Choose a directory that exists on this computer.");
	if (!info.isDirectory()) throw new HttpError(400, `${dir} is not a directory.`, "Choose the directory that holds it.");
	return dir;
}

export const LISTING_LIMITS = { entries: 5000, ms: 1500 };

/** Names the picker never shows: dependencies and macOS's caches, beside the dotfiles filtered everywhere. */
const UNLISTABLE_NAMES = new Set(["node_modules", "Library"]);

/**
 * Trees the walk must not enter: kernel interfaces and devices, and where macOS and automounters park network
 * volumes. They are slow to read at best, endless at worst, and one stalled mount can hang the readdir. Linux's
 * network mounts are not listed here; they come from the mount table.
 */
const UNLISTABLE_TREES = new Set(["/proc", "/sys", "/dev", "/run", "/net", "/Network", "/Volumes", "/System/Volumes", "/afs"]);

/** Network and automounted filesystems; their mount points are found in the table, not listed here. */
const NETWORK_FILESYSTEM = /^(nfs4?|cifs|smb3?|smbfs|ncpfs|9p|afs|ceph|glusterfs|lustre|gpfs|beegfs|davfs|autofs|fuse\.(sshfs|rclone|s3fs|davfs2?|glusterfs))$/;

/** The remote mount points Linux reports in its own mount table; none where there is no /proc to read. */
async function networkMountPoints(): Promise<Set<string>> {
	const table = await readFile("/proc/self/mounts", "utf8").catch(() => "");
	const points = new Set<string>();
	for (const line of table.split("\n")) {
		const [, mountPoint, type] = line.split(" ");
		// The table escapes a space in a path as \040.
		if (mountPoint !== undefined && type !== undefined && NETWORK_FILESYSTEM.test(type)) points.add(mountPoint.replace(/\\040/g, " "));
	}
	return points;
}

/** Sorted by name, siblings in a directory listing compare the same everywhere. */
const byName = (a: Dirent, b: Dirent): number => a.name.localeCompare(b.name);

/** Whether the walk may descend into this directory at `absolute`, given the remote mount points found. */
function mayEnter(absolute: string, remote: ReadonlySet<string>): boolean {
	return !UNLISTABLE_TREES.has(absolute) && !remote.has(absolute);
}

/**
 * The files under `root`, relative to it and nearest first, for the `@` picker. Hidden entries, dependency,
 * kernel and device trees and network mounts are skipped; symlinks are listed but never followed; a directory
 * that will not read is passed over. The walk ends at `limits.entries` files or `limits.ms` milliseconds, with
 * `truncated` reporting that the listing stopped short.
 */
export async function listDirectory(root: string, limits: { entries: number; ms: number } = LISTING_LIMITS): Promise<FileList> {
	const deadline = Date.now() + limits.ms;
	const remote = await networkMountPoints();
	const files: string[] = [];
	const queue = [""];
	let cursor = 0;
	while (cursor < queue.length) {
		const relative = queue[cursor] ?? "";
		cursor += 1;
		const remaining = deadline - Date.now();
		if (remaining <= 0) return { files, truncated: true };
		const entries = await readDirectoryWithin(join(root, relative), remaining);
		if (entries === "timeout") return { files, truncated: true };
		for (const entry of entries.sort(byName)) {
			if (entry.name.startsWith(".") || UNLISTABLE_NAMES.has(entry.name)) continue;
			const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
			const absolute = join(root, path);
			if (entry.isDirectory()) {
				if (mayEnter(absolute, remote)) queue.push(path);
				continue;
			}
			if (!entry.isFile() && !entry.isSymbolicLink()) continue;
			if (files.length >= limits.entries) return { files, truncated: true };
			files.push(path);
		}
	}
	return { files, truncated: false };
}

/** A directory's entries within `ms` milliseconds, else "timeout" — a read a stalled mount would never finish. */
async function readDirectoryWithin(dir: string, ms: number): Promise<Dirent[] | "timeout"> {
	let timer: NodeJS.Timeout | undefined;
	const giveUp = new Promise<"timeout">((done) => {
		timer = setTimeout(() => done("timeout"), ms);
	});
	try {
		return await Promise.race([readdir(dir, { withFileTypes: true }).catch((): Dirent[] => []), giveUp]);
	} finally {
		clearTimeout(timer);
	}
}
