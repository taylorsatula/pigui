// Builds the phone app into dist/public: Vite bundles the client (index.html, main.ts, app.css), this script copies the
// fonts and draws the icons, then hashes the whole output for the service worker's cache name and bundles the service
// worker with that hash. The repository holds no binary assets. The sandbox launcher builds into dist/bin as before.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { build as viteBuild } from "vite";

const root = join(import.meta.dirname, "..");
const out = join(root, "dist", "public");

// The client: Vite bundles src/client into dist/public (emptyOutDir in vite.config.ts).
await viteBuild();

await mkdir(join(out, "icons"), { recursive: true });
await mkdir(join(out, "fonts"), { recursive: true });

// The Latin faces app.css's @font-face rules name, with each family's licence (the SIL OFL asks that it travels with
// the fonts). Pinned Fontsource packages keep the faces working offline and the CSP free of a font host.
const FONTS = [
	{ dir: "@fontsource-variable/source-serif-4", files: ["source-serif-4-latin-opsz-normal.woff2"], licence: "LICENSE-source-serif-4.txt" },
	{ dir: "@fontsource-variable/ibm-plex-sans", files: ["ibm-plex-sans-latin-wght-normal.woff2", "ibm-plex-sans-latin-wght-italic.woff2"], licence: "LICENSE-ibm-plex-sans.txt" },
	{ dir: "@fontsource/ibm-plex-mono", files: ["ibm-plex-mono-latin-400-normal.woff2"], licence: "LICENSE-ibm-plex-mono.txt" },
];
for (const font of FONTS) {
	const dir = join(root, "node_modules", font.dir);
	for (const file of font.files) await copyFile(join(dir, "files", file), join(out, "fonts", file));
	await copyFile(join(dir, "LICENSE"), join(out, "fonts", font.licence));
}

// ---- The icons: an ink π on the highlighter's yellow, drawn as PNGs the repository need not carry.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

function png(size: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
	const stride = size * 3 + 1;
	const rows = Buffer.alloc(size * stride);
	for (let y = 0; y < size; y++) {
		const offset = y * stride;
		for (let x = 0; x < size; x++) rows.set(pixel(x, y), offset + 1 + x * 3);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr.set([8, 2, 0, 0, 0], 8);
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(rows)),
		chunk("IEND", new Uint8Array()),
	]);
}

/** A π in unit coordinates: a bar across the top, two legs, the right one curling out at its foot. */
function insidePi(u: number, v: number): boolean {
	const bar = v > 0.28 && v < 0.38 && u > 0.2 && u < 0.82;
	const leftLeg = u > 0.34 && u < 0.44 && v >= 0.33 && v < 0.74 - (0.44 - u) * 0.4;
	const rightLeg = u > 0.58 && u < 0.68 && v >= 0.33 && v < 0.72;
	const rightFoot = v > 0.64 && v < 0.74 && u > 0.6 && u < 0.78;
	return bar || leftLeg || rightLeg || rightFoot;
}

function icon(size: number, inset: number): Buffer {
	const paper: [number, number, number] = [255, 212, 0];
	const ink: [number, number, number] = [27, 25, 21];
	return png(size, (x, y) => {
		const u = (x / size - inset) / (1 - 2 * inset);
		const v = (y / size - inset) / (1 - 2 * inset);
		return insidePi(u, v) ? ink : paper;
	});
}

await writeFile(join(out, "icons", "icon-192.png"), icon(192, 0));
await writeFile(join(out, "icons", "icon-512.png"), icon(512, 0));
await writeFile(join(out, "icons", "apple-touch-icon.png"), icon(180, 0));
// Maskable icons keep the glyph inside the central safe zone.
await writeFile(join(out, "icons", "icon-maskable-512.png"), icon(512, 0.12));

// Everything the build emitted, hashed for the service worker's cache name; the worker precaches exactly this set.
async function filesIn(dir: string, prefix = ""): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await filesIn(path, `${prefix}${entry.name}/`)));
		else files.push(`${prefix}${entry.name}`);
	}
	return files.sort();
}
const emitted = await filesIn(out);
const hash = createHash("sha256");
for (const file of emitted) {
	hash.update(file);
	hash.update(await readFile(join(out, file)));
}
const buildId = hash.digest("hex").slice(0, 12);
// Sourcemaps ship for debugging but are not part of the offline shell.
const shell = ["/", ...emitted.filter((file) => !file.endsWith(".map")).map((file) => `/${file}`)];

// The service worker precaches the shell and names its cache after the build, so any change replaces it.
await viteBuild({
	configFile: false,
	define: {
		BUILD_ID: JSON.stringify(buildId),
		SHELL: JSON.stringify(shell),
	},
	build: {
		outDir: out,
		emptyOutDir: false,
		target: ["safari16", "chrome110"],
		minify: true,
		rollupOptions: {
			input: join(root, "src", "sw", "sw.ts"),
			output: { format: "iife", entryFileNames: "sw.js" },
		},
	},
	logLevel: "warn",
});

process.stdout.write(`Built the app into ${out} (build ${buildId}).\n`);

// ---- The sandbox launcher for agent commands. On non-Linux the app still builds and pigui falls back to a launcher
// on PATH (the Docker image and the installer install one there).

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
