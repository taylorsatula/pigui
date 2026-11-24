// Hiding one program from a test's PATH. Dropping every directory that holds the program also drops whatever else
// lives there: on a merged-/usr machine bash and docker share /usr/bin, so hiding docker by filtering PATH leaves the
// spawn without bash (ENOENT). Instead the directories holding the program are dropped, but every other entry in them
// is symlinked into `bin`, so the rest of the system stays reachable and only the named program is gone.
import { existsSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";

/** A PATH string with `program` hidden; the other entries of its directories are symlinked into `bin`. */
export function pathWithout(bin: string, program: string): string {
	const dirs = (process.env.PATH ?? "").split(":");
	for (const dir of dirs) {
		if (!existsSync(join(dir, program))) continue;
		for (const entry of readdirSync(dir)) {
			if (entry === program || existsSync(join(bin, entry))) continue;
			try {
				symlinkSync(join(dir, entry), join(bin, entry));
			} catch {
				// A dangling or duplicate entry is fine to skip.
			}
		}
	}
	const kept = dirs.filter((dir) => !existsSync(join(dir, program)));
	return `${bin}:${kept.join(":")}`;
}
