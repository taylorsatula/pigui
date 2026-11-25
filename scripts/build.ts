// Builds the sandbox launcher into dist/bin. The web UI is being rebuilt on the svelte-rewrite branch; until it
// lands, this script builds only the launcher. On non-Linux the app still builds and pigui falls back to a launcher
// on PATH (the Docker image and the installer install one there).
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = join(import.meta.dirname, "..");

const launcher = join(root, "dist", "bin", "pigui-sandbox");
if (process.platform !== "linux") {
	process.stdout.write("Skipped the sandbox launcher: Landlock is Linux's.\n");
} else {
	await mkdir(dirname(launcher), { recursive: true });
	const compiled = spawnSync("cc", ["-O2", "-Wall", "-o", launcher, join(root, "src", "sandbox", "pigui-sandbox.c")], { stdio: "inherit" });
	if (compiled.error !== undefined) process.stdout.write("Skipped the sandbox launcher: no C compiler (cc) here.\n");
	else if (compiled.status !== 0) throw new Error("Compiling src/sandbox/pigui-sandbox.c failed.");
	else process.stdout.write(`Built the sandbox launcher into ${launcher}.\n`);
}
