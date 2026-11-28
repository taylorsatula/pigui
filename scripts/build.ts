// Generates the PWA icons and copies the self-hosted fonts into dist/assets, and compiles the Linux sandbox launcher
// into dist/bin. Zero frontend JS bundler: HTML is server-rendered and CSS/JS under public/ are served straight from disk.
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { generateAssets } from "../src/server/assets.ts";

const root = join(import.meta.dirname, "..");
const assetsDir = join(root, "dist", "assets");

await generateAssets(root, assetsDir, true);
process.stdout.write(`Generated fonts and icons into ${assetsDir}.\n`);

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
