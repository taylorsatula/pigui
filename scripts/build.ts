// Builds the phone app into dist/public: esbuild bundles for the app, its theme boot script and the service worker,
// the static shell, the fonts (copied from their pinned packages), and the icons, drawn here so the repository holds no
// binary assets. Then the sandbox launcher into dist/bin.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { build } from "esbuild";

const root = join(import.meta.dirname, "..");
const out = join(root, "dist", "public");
const client = join(root, "src", "client");

await rm(out, { recursive: true, force: true });
await mkdir(join(out, "icons"), { recursive: true });
await mkdir(join(out, "fonts"), { recursive: true });

// The Latin files app.css's @font-face rules name, and each family's licence (the SIL Open Font License asks that it
// travel with the fonts).
const FONTS = [
	{ dir: "@fontsource-variable/source-serif-4", files: ["source-serif-4-latin-opsz-normal.woff2", "source-serif-4-latin-opsz-italic.woff2"], licence: "LICENSE-source-serif-4.txt" },
	{ dir: "@fontsource/ibm-plex-mono", files: ["ibm-plex-mono-latin-400-normal.woff2", "ibm-plex-mono-latin-500-normal.woff2"], licence: "LICENSE-ibm-plex-mono.txt" },
];
const fontBytes: Buffer[] = [];
for (const font of FONTS) {
	const dir = join(root, "node_modules", font.dir);
	for (const file of font.files) {
		await copyFile(join(dir, "files", file), join(out, "fonts", file));
		fontBytes.push(await readFile(join(dir, "files", file)));
	}
	await copyFile(join(dir, "LICENSE"), join(out, "fonts", font.licence));
}


const app = await build({
	entryPoints: [join(client, "main.tsx")],
	outfile: join(out, "app.js"),
	bundle: true,
	format: "esm",
	platform: "browser",
	target: ["safari16", "chrome110"],
	minify: true,
	sourcemap: true,
	jsx: "automatic",
	jsxImportSource: "preact",
	metafile: true,
	logLevel: "warning",
});
// A classic script, not a module, so it runs before the first paint (see src/client/boot.ts).
const boot = await build({
	entryPoints: [join(client, "boot.ts")],
	outfile: join(out, "boot.js"),
	bundle: true,
	format: "iife",
	platform: "browser",
	target: ["safari16", "chrome110"],
	minify: true,
	metafile: true,
	logLevel: "warning",
});
// The service worker's cache is named after everything in the shell, so any change to it replaces the cache.
const shell = await Promise.all(["index.html", "app.css", "manifest.webmanifest"].map((file) => readFile(join(client, file))));
const buildId = createHash("sha256")
	.update(JSON.stringify([app.metafile.outputs, boot.metafile.outputs]))
	.update(Buffer.concat(shell))
	.update(Buffer.concat(fontBytes))
	.digest("hex")
	.slice(0, 12);

await build({
	entryPoints: [join(root, "src", "sw", "sw.ts")],
	outfile: join(out, "sw.js"),
	bundle: true,
	format: "iife",
	platform: "browser",
	target: ["safari16", "chrome110"],
	minify: true,
	define: { BUILD_ID: JSON.stringify(buildId), FONT_FILES: JSON.stringify(FONTS.flatMap((font) => font.files.map((file) => `/fonts/${file}`))) },
	logLevel: "warning",
});

for (const file of ["index.html", "app.css", "manifest.webmanifest"]) await copyFile(join(client, file), join(out, file));

// ---- Icons: an ink π on the highlighter's yellow, as PNGs (the format iOS home screens need).

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
	const rows = Buffer.alloc(size * (size * 3 + 1));
	for (let y = 0; y < size; y++) {
		const offset = y * (size * 3 + 1);
		for (let x = 0; x < size; x++) rows.set(pixel(x, y), offset + 1 + x * 3);
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header.set([8, 2, 0, 0, 0], 8);
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", new Uint8Array())]);
}

/** π in unit coordinates: a bar across the top and two legs, the right one curling out at its foot. */
function inPi(u: number, v: number): boolean {
	const bar = v > 0.28 && v < 0.38 && u > 0.2 && u < 0.82;
	const left = u > 0.34 && u < 0.44 && v >= 0.33 && v < 0.74 - (0.44 - u) * 0.4;
	const right = u > 0.58 && u < 0.68 && v >= 0.33 && v < 0.72;
	const foot = v > 0.64 && v < 0.74 && u > 0.6 && u < 0.78;
	return bar || left || right || foot;
}

function icon(size: number, inset: number): Buffer {
	const mark: [number, number, number] = [242, 216, 92];
	const ink: [number, number, number] = [27, 25, 21];
	return png(size, (x, y) => {
		const u = (x / size - inset) / (1 - 2 * inset);
		const v = (y / size - inset) / (1 - 2 * inset);
		return inPi(u, v) ? ink : mark;
	});
}

await writeFile(join(out, "icons", "icon-192.png"), icon(192, 0));
await writeFile(join(out, "icons", "icon-512.png"), icon(512, 0));
await writeFile(join(out, "icons", "apple-touch-icon.png"), icon(180, 0));
// Maskable icons keep their glyph inside the central safe zone.
await writeFile(join(out, "icons", "icon-maskable-512.png"), icon(512, 0.12));

process.stdout.write(`Built the app into ${out} (build ${buildId}).\n`);

// ---- The agent sandbox's launcher. Without a C compiler the app still builds, and picloud looks for the launcher on
// PATH instead, where the Docker image installs it.

const launcher = join(root, "dist", "bin", "picloud-sandbox");
if (process.platform !== "linux") {
	process.stdout.write("Skipped the sandbox launcher: Landlock is Linux's.\n");
} else {
	await mkdir(dirname(launcher), { recursive: true });
	const compiled = spawnSync("cc", ["-O2", "-Wall", "-o", launcher, join(root, "src", "sandbox", "picloud-sandbox.c")], { stdio: "inherit" });
	if (compiled.error !== undefined) process.stdout.write("Skipped the sandbox launcher: no C compiler (cc) here.\n");
	else if (compiled.status !== 0) throw new Error("Compiling src/sandbox/picloud-sandbox.c failed.");
	else process.stdout.write(`Built the sandbox launcher into ${launcher}.\n`);
}
