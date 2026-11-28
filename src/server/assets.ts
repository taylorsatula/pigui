// Generates the four PWA PNG icons and copies the three self-hosted Fontsource woff2 families into dist/assets, plus
// builds the runtime service worker script with an accurate BUILD_ID and precache SHELL list. Zero bundler required.
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const SHARED_BROWSER_MODULES = ["references", "wav"] as const;

const FONTS = [
	{ dir: "@fontsource-variable/source-serif-4", files: ["source-serif-4-latin-opsz-normal.woff2"], licence: "LICENSE-source-serif-4.txt" },
	{ dir: "@fontsource-variable/ibm-plex-sans", files: ["ibm-plex-sans-latin-wght-normal.woff2", "ibm-plex-sans-latin-wght-italic.woff2"], licence: "LICENSE-ibm-plex-sans.txt" },
	{ dir: "@fontsource/ibm-plex-mono", files: ["ibm-plex-mono-latin-400-normal.woff2"], licence: "LICENSE-ibm-plex-mono.txt" },
] as const;

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
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", new Uint8Array())]);
}

function insidePi(u: number, v: number): boolean {
	const bar = v > 0.28 && v < 0.38 && u > 0.2 && u < 0.82;
	const leftLeg = u > 0.34 && u < 0.44 && v >= 0.33 && v < 0.74 - (0.44 - u) * 0.4;
	const rightLeg = u > 0.58 && u < 0.68 && v >= 0.33 && v < 0.72;
	const rightFoot = v > 0.64 && v < 0.74 && u > 0.6 && u < 0.78;
	return bar || leftLeg || rightLeg || rightFoot;
}

function drawIcon(size: number, inset: number): Buffer {
	const paper: [number, number, number] = [255, 212, 0];
	const ink: [number, number, number] = [27, 25, 21];
	return png(size, (x, y) => {
		const u = (x / size - inset) / (1 - 2 * inset);
		const v = (y / size - inset) / (1 - 2 * inset);
		return insidePi(u, v) ? ink : paper;
	});
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function emitSharedModules(root: string, assetsDir: string, force: boolean): Promise<void> {
	const outDir = join(assetsDir, "shared");
	await mkdir(outDir, { recursive: true });
	for (const name of SHARED_BROWSER_MODULES) {
		const srcPath = join(root, "src", "shared", `${name}.ts`);
		const dstPath = join(outDir, `${name}.js`);
		if (!force) {
			const [srcStat, dstStat] = await Promise.all([stat(srcPath), stat(dstPath).catch(() => undefined)]);
			if (dstStat !== undefined && dstStat.mtimeMs >= srcStat.mtimeMs) continue;
		}
		const source = await readFile(srcPath, "utf8");
		await writeFile(dstPath, stripTypeScriptTypes(source, { mode: "strip" }));
	}
}

/** Generate icons and copy fonts + static vendor/shared ESM modules into `assetsDir`. Fast (~20 ms) and safe to call on startup or from scripts/build.ts. */
export async function generateAssets(root: string, assetsDir: string, force = false): Promise<void> {
	await emitSharedModules(root, assetsDir, force);

	const marker = join(assetsDir, "icons", "icon-maskable-512.png");
	const fontMarker = join(assetsDir, "fonts", "ibm-plex-mono-latin-400-normal.woff2");
	const vendorMarker = join(assetsDir, "vendor", "idiomorph.esm.js");
	if (!force && (await exists(marker)) && (await exists(fontMarker)) && (await exists(vendorMarker))) return;

	await mkdir(join(assetsDir, "icons"), { recursive: true });
	await mkdir(join(assetsDir, "fonts"), { recursive: true });
	await mkdir(join(assetsDir, "vendor"), { recursive: true });

	for (const font of FONTS) {
		const dir = join(root, "node_modules", font.dir);
		for (const file of font.files) await copyFile(join(dir, "files", file), join(assetsDir, "fonts", file));
		await copyFile(join(dir, "LICENSE"), join(assetsDir, "fonts", font.licence));
	}

	await copyFile(join(root, "node_modules", "idiomorph", "dist", "idiomorph.esm.js"), join(assetsDir, "vendor", "idiomorph.esm.js"));

	await writeFile(join(assetsDir, "icons", "icon-192.png"), drawIcon(192, 0));
	await writeFile(join(assetsDir, "icons", "icon-512.png"), drawIcon(512, 0));
	await writeFile(join(assetsDir, "icons", "apple-touch-icon.png"), drawIcon(180, 0));
	await writeFile(join(assetsDir, "icons", "icon-maskable-512.png"), drawIcon(512, 0.12));
}

async function walk(dir: string, prefix = ""): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	const out: string[] = [];
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walk(full, `${prefix}${entry.name}/`)));
		else out.push(`${prefix}${entry.name}`);
	}
	return out.sort();
}

/** Compose /sw.js dynamically with a content hash BUILD_ID and precache SHELL over publicDir and assetsDir. */
export async function renderServiceWorker(publicDir: string, assetsDir: string): Promise<string> {
	const publicFiles = (await walk(publicDir)).filter((file) => file !== "sw.js" && !file.endsWith(".map"));
	const assetFiles = (await walk(assetsDir)).filter((file) => !file.endsWith(".map"));
	const hash = createHash("sha256");
	for (const file of publicFiles) {
		hash.update(file);
		hash.update(await readFile(join(publicDir, file)));
	}
	for (const file of assetFiles) {
		hash.update(file);
		hash.update(await readFile(join(assetsDir, file)));
	}
	const source = await readFile(join(publicDir, "sw.js"), "utf8");
	hash.update("sw.js");
	hash.update(source);
	const buildId = hash.digest("hex").slice(0, 12);
	const shell = ["/", ...publicFiles.map((file) => `/${file}`), ...assetFiles.map((file) => `/${file}`)];
	return `const BUILD_ID = ${JSON.stringify(buildId)};\nconst SHELL = ${JSON.stringify(shell)};\n${source}`;
}
