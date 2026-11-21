// Turning what the person sent into what the agent receives: `@file` contents, `#skill` invocations, attachments saved
// into the workspace and images fitted for the model. The text itself is kept exactly as typed for the transcript.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import type { ImageContent, TextContent, UserMessage } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { fitImage } from "@earendil-works/pi-durable/images/fit";
import { type ImageProcessor, imageLimits } from "@earendil-works/pi-durable/tools";
import type { UploadedAttachment } from "../shared/api.ts";
import { findReferences } from "../shared/references.ts";
import type { MessageEntryData } from "../shared/session.ts";
import { ATTACHMENTS_DIR } from "./agent/prompt.ts";
import { skillBlock } from "./agent/resources.ts";

/** Larger files are pointed to instead of included; the agent reads them with its tools. */
export const MAX_INCLUDED_FILE_BYTES = 64 * 1024;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export type PreparedInput = {
	content: UserMessage["content"];
	data: MessageEntryData;
};

/** Uploaded files waiting to be sent with a message. They are removed once the message is placed. */
export class Uploads {
	readonly #dir: string;

	constructor(dir: string) {
		this.#dir = dir;
	}

	async save(bytes: Uint8Array, name: string, mimeType: string): Promise<UploadedAttachment> {
		await mkdir(this.#dir, { recursive: true });
		const id = randomBytes(16).toString("hex");
		const meta: UploadedAttachment = { id, name: safeName(name), mimeType, size: bytes.byteLength };
		await writeFile(join(this.#dir, id), bytes);
		await writeFile(join(this.#dir, `${id}.json`), JSON.stringify(meta));
		return meta;
	}

	async read(id: string): Promise<{ meta: UploadedAttachment; bytes: Uint8Array } | undefined> {
		if (!/^[a-f0-9]{32}$/.test(id)) return undefined;
		try {
			const meta = JSON.parse(await readFile(join(this.#dir, `${id}.json`), "utf8")) as UploadedAttachment;
			return { meta, bytes: await readFile(join(this.#dir, id)) };
		} catch {
			return undefined;
		}
	}

	async remove(ids: readonly string[]): Promise<void> {
		for (const id of ids) {
			if (!/^[a-f0-9]{32}$/.test(id)) continue;
			await rm(join(this.#dir, id), { force: true });
			await rm(join(this.#dir, `${id}.json`), { force: true });
		}
	}
}

function safeName(name: string): string {
	const cleaned = basename(name).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "");
	return cleaned === "" ? "attachment" : cleaned.slice(0, 120);
}

/** A path inside the workspace, or undefined when the reference would leave it or reach into `.git`. */
function insideWorkspace(workspace: string, path: string): string | undefined {
	const target = resolve(workspace, path);
	const rel = relative(workspace, target);
	if (rel === "" || rel.startsWith("..") || rel.split(sep)[0] === ".git") return undefined;
	return target;
}

function looksBinary(bytes: Uint8Array): boolean {
	const sample = bytes.subarray(0, 8000);
	return sample.includes(0);
}

type Expansion = { blocks: string[]; references: MessageEntryData["references"] };

/**
 * The context `@` and `#` references add. A file brings its contents, or a pointer when it is too large or binary; a
 * skill brings its body as the Pi CLI invokes it. A reference to nothing known stays plain text.
 */
export async function expandReferences(text: string, workspace: string, skills: readonly Skill[]): Promise<Expansion> {
	const blocks: string[] = [];
	const references: Expansion["references"] = [];
	const seen = new Set<string>();
	for (const reference of findReferences(text)) {
		const key = `${reference.kind}:${reference.value}`;
		if (seen.has(key)) continue;
		seen.add(key);
		if (reference.kind === "skill") {
			const skill = skills.find((candidate) => candidate.name === reference.value);
			if (skill === undefined) continue;
			blocks.push(skillBlock(skill));
			references.push({ kind: "skill", value: skill.name, status: "skill" });
			continue;
		}
		const path = insideWorkspace(workspace, reference.value);
		if (path === undefined) continue;
		const info = await stat(path).catch(() => undefined);
		if (info === undefined) continue;
		if (info.isDirectory()) {
			blocks.push(`<directory path="${reference.value}">A directory; list it with your tools.</directory>`);
			references.push({ kind: "file", value: reference.value, status: "pointer", note: "directory" });
			continue;
		}
		if (info.size > MAX_INCLUDED_FILE_BYTES) {
			blocks.push(`<file path="${reference.value}" size="${info.size}">Too large to include here (${Math.round(info.size / 1024)} KB); read the parts you need with the read tool.</file>`);
			references.push({ kind: "file", value: reference.value, status: "pointer", note: `${Math.round(info.size / 1024)} KB` });
			continue;
		}
		const bytes = await readFile(path);
		if (looksBinary(bytes)) {
			blocks.push(`<file path="${reference.value}" size="${info.size}">A binary file; not included.</file>`);
			references.push({ kind: "file", value: reference.value, status: "pointer", note: "binary" });
			continue;
		}
		blocks.push(`<file path="${reference.value}">\n${bytes.toString("utf8")}\n</file>`);
		references.push({ kind: "file", value: reference.value, status: "included" });
	}
	return { blocks, references };
}

/**
 * Save attachments under the workspace's attachments directory (which git ignores) and fit images for `model`.
 * Rerunning with the same uploads writes the same files, so a setup rerun after a crash attaches them once.
 */
export async function attach(
	ids: readonly string[],
	uploads: Uploads,
	workspace: string,
	model: Model<Api> | undefined,
	images: ImageProcessor,
): Promise<{ notes: string[]; images: ImageContent[]; attachments: MessageEntryData["attachments"] }> {
	const notes: string[] = [];
	const fitted: ImageContent[] = [];
	const attachments: MessageEntryData["attachments"] = [];
	const dir = join(workspace, ATTACHMENTS_DIR);
	for (const id of ids) {
		const upload = await uploads.read(id);
		if (upload === undefined) continue;
		await mkdir(dir, { recursive: true });
		// The upload ID in the name keeps two photos both called image.jpg apart.
		const stem = basename(upload.meta.name, extname(upload.meta.name));
		const file = `${stem}-${createHash("sha256").update(id).digest("hex").slice(0, 6)}${extname(upload.meta.name)}`;
		const path = `${ATTACHMENTS_DIR}/${file}`;
		await writeFile(join(dir, file), upload.bytes);
		const image = IMAGE_TYPES.has(upload.meta.mimeType);
		attachments.push({ name: upload.meta.name, mimeType: upload.meta.mimeType, size: upload.meta.size, path, image });
		if (image && model?.input.includes("image") === true) {
			const result = await fitImage(upload.bytes, upload.meta.mimeType, imageLimits(model), images);
			if (result.kind === "fitted") {
				fitted.push(result.image);
				notes.push(`Attached image ${path}${result.notes.length > 0 ? ` (${result.notes.join("; ")})` : ""}.`);
			} else {
				notes.push(`Attached image ${path}: ${result.note}`);
			}
		} else {
			notes.push(`Attached file ${path} (${upload.meta.mimeType}, ${upload.meta.size} bytes).`);
		}
	}
	return { notes, images: fitted, attachments };
}

/** The user message content: added context first, as the Pi CLI places a skill before its arguments, then the text. */
export function composeContent(text: string, expansion: Expansion, notes: readonly string[], images: readonly ImageContent[]): UserMessage["content"] {
	const parts = [...expansion.blocks, ...(notes.length > 0 ? [notes.join("\n")] : []), text].filter((part) => part !== "");
	const body = parts.join("\n\n");
	if (images.length === 0) return body;
	const content: (TextContent | ImageContent)[] = [{ type: "text", text: body }, ...images];
	return content;
}
