// `npm test` runs only against an installed tree: without node_modules, every test file that imports an
// @earendil-works package fails with ERR_MODULE_NOT_FOUND, which looks like a mass regression instead of a missing
// install. One clear line beats sixteen scary ones.
import { existsSync } from "node:fs";
import { join } from "node:path";

if (!existsSync(join(import.meta.dirname, "..", "node_modules", "@earendil-works"))) {
	console.error("node_modules is missing — run `npm ci` first; the dependencies come from the lockfile.");
	process.exit(1);
}
