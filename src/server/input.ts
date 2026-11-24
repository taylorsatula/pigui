// What leaves the composer and reaches the agent: the message text, the contents or pointers for what it
// `@`-mentions, the bodies of what it `#`-invokes, and any attachments saved into the session's own workspace.
// The person's text is kept exactly as typed for the transcript; everything added for the model goes ahead of it.
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
import { ATTACHMENTS_DIR, skillBlock } from "./agent/resources.ts";
import { expandHome } from "./local.ts";

/** Larger files are pointed to instead of included; the agent reads them with its tools. */
export const MAX_INCLUDED_FILE_BYTES = 64 * 1024;
/** The HTTP boundary refuses uploads past this size. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export type PreparedInput = {
	content: UserMessage["content"];
	data: MessageEntryData;
};

const UPLOAD_ID = /^[a-f0-9]{32}$/;

/** Uploaded files waiting to travel with a message; removed once the message is placed. */
export class Uploads {
	readonly #directory: string;

	constructor(directory: string) {
		this.#directory = directory;
	}

	async save(bytes: Uint8Array, name: string, mimeType: string): Promise<UploadedAttachment> {
		await mkdir(this.#directory, { recursive: true });
		const id = randomBytes(16).toString("hex");
		const meta: UploadedAttachment = { id, name: attachmentFileName(name), mimeType, size: bytes.byteLength };
		await writeFile(join(this.#directory, id), bytes);
		await writeFile(join(this.#directory, `${id}.json`), JSON.stringify(meta));
		return meta;
	}

	async read(id: string): Promise<{ meta: UploadedAttachment; bytes: Uint8Array } | undefined> {
		if (!UPLOAD_ID.test(id)) return undefined;
		try {
			const meta = JSON.parse(await readFile(join(this.#directory, `${id}.json`), "utf8")) as UploadedAttachment;
			return { meta, bytes: await readFile(join(this.#directory, id)) };
		} catch {
			return undefined;
		}
	}

	async remove(ids: readonly string[]): Promise<void> {
		for (const id of ids) {
			if (!UPLOAD_ID.test(id)) continue;
			await rm(join(this.#directory, id), { force: true });
			await rm(join(this.#directory, `${id}.json`), { force: true });
		}
	}
}

/** What an upload is called, safely: a plain file name no traversal can escape, capped at 120 characters. */
function attachmentFileName(name: string): string {
	const cleaned = basename(name).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "");
	return cleaned === "" ? "attachment" : cleaned.slice(0, 120);
}

/**
 * What an `@path` may open. A repository session stays inside its clone and out of `.git`; a local session
 * roams the person's computer, as absolute, `~/` or clone-relative paths, since nothing confines it there.
 */
export type ReferenceRoot = { place: "repo"; dir: string } | { place: "local"; dir: string; home: string };

/** The file a reference names; undefined when a repository session's reference would step outside its clone. */
function resolveReference(root: ReferenceRoot, path: string): string | undefined {
	if (root.place === "local") return resolve(root.dir, expandHome(path, root.home));
	const target = resolve(root.dir, path);
	const rel = relative(root.dir, target);
	if (rel === "" || rel.startsWith("..") || rel.split(sep)[0] === ".git") return undefined;
	return target;
}

/** A NUL byte in the first bytes is how text files are told from binary ones. */
function looksLikeBinary(bytes: Uint8Array): boolean {
	return bytes.subarray(0, 8000).includes(0);
}

type Expansion = { blocks: string[]; references: MessageEntryData["references"] };
type ReferenceOutcome = { block: string; reference: MessageEntryData["references"][number] };

/** The `<file>` outcome for a reference that names a file inside a repository session's clone. */
async function expandFileReference(reference: { value: string }, root: ReferenceRoot): Promise<ReferenceOutcome | undefined> {
	const path = resolveReference(root, reference.value);
	if (path === undefined) return undefined;
	const info = await stat(path).catch(() => undefined);
	if (info === undefined) return undefined;
	const shown = reference.value;
	if (info.isDirectory()) {
		return {
			block: `<directory path="${shown}">A directory; list it with your tools.</directory>`,
			reference: { kind: "file", value: shown, status: "pointer", note: "directory" },
		};
	}
	if (info.size > MAX_INCLUDED_FILE_BYTES) {
		const kilobytes = Math.round(info.size / 1024);
		return {
			block: `<file path="${shown}" size="${info.size}">Too large to include here (${kilobytes} KB); read the parts you need with the read tool.</file>`,
			reference: { kind: "file", value: shown, status: "pointer", note: `${kilobytes} KB` },
		};
	}
	const bytes = await readFile(path);
	if (looksLikeBinary(bytes)) {
		return {
			block: `<file path="${shown}" size="${info.size}">A binary file; not included.</file>`,
			reference: { kind: "file", value: shown, status: "pointer", note: "binary" },
		};
	}
	return {
		block: `<file path="${shown}">\n${bytes.toString("utf8")}\n</file>`,
		reference: { kind: "file", value: shown, status: "included" },
	};
}

/** The `<skill>` outcome for a `#name` reference, the way the Pi CLI's `/skill:name` invocation delivers it. */
function expandSkillReference(reference: { value: string }, skills: readonly Skill[]): ReferenceOutcome | undefined {
	const skill = skills.find((candidate) => candidate.name === reference.value);
	if (skill === undefined) return undefined;
	return { block: skillBlock(skill), reference: { kind: "skill", value: skill.name, status: "skill" } };
}

/**
 * The context `@` and `#` references add. A file brings its contents, or a pointer when it is too large or
 * binary; a skill brings its body. A reference to nothing known stays plain text, and each reference is
 * expanded once however often it appears.
 */
export async function expandReferences(text: string, root: ReferenceRoot, skills: readonly Skill[]): Promise<Expansion> {
	const blocks: string[] = [];
	const references: Expansion["references"] = [];
	const seen = new Set<string>();
	for (const reference of findReferences(text)) {
		const key = `${reference.kind}:${reference.value}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const outcome = reference.kind === "skill" ? expandSkillReference(reference, skills) : await expandFileReference(reference, root);
		if (outcome === undefined) continue;
		blocks.push(outcome.block);
		references.push(outcome.reference);
	}
	return { blocks, references };
}

/** One place attachments may differ in a name: the stem keeps the human's file name, the hash keeps it unique. */
function savedName(meta: UploadedAttachment, id: string): string {
	const stem = basename(meta.name, extname(meta.name));
	return `${stem}-${createHash("sha256").update(id).digest("hex").slice(0, 6)}${extname(meta.name)}`;
}

/**
 * Save attachments under the session's attachments directory inside its workspace (which git ignores in a
 * repository's clone), and fit images for `model`. The agent learns each file's path as `shown` makes it:
 * relative to a clone, which is its working directory, or absolute for a local session, which works elsewhere.
 * Rerunning with the same uploads rewrites the same files, so a setup rerun after a crash attaches them once.
 */
export async function attach(
	ids: readonly string[],
	uploads: Uploads,
	workspace: string,
	shown: "relative" | "absolute",
	model: Model<Api> | undefined,
	images: ImageProcessor,
): Promise<{ notes: string[]; images: ImageContent[]; attachments: MessageEntryData["attachments"] }> {
	const notes: string[] = [];
	const fitted: ImageContent[] = [];
	const attachments: MessageEntryData["attachments"] = [];
	const directory = join(workspace, ATTACHMENTS_DIR);
	for (const id of ids) {
		const upload = await uploads.read(id);
		if (upload === undefined) continue;
		await mkdir(directory, { recursive: true });
		// The upload ID in the name keeps two photos both called image.jpg apart.
		const file = savedName(upload.meta, id);
		const path = shown === "relative" ? `${ATTACHMENTS_DIR}/${file}` : join(directory, file);
		await writeFile(join(directory, file), upload.bytes);
		const isImage = IMAGE_MIME_TYPES.has(upload.meta.mimeType);
		attachments.push({ name: upload.meta.name, mimeType: upload.meta.mimeType, size: upload.meta.size, path, image: isImage });
		if (isImage && model?.input.includes("image") === true) {
			const result = await fitImage(upload.bytes, upload.meta.mimeType, imageLimits(model), images);
			fitted.push(...(result.kind === "fitted" ? [result.image] : []));
			notes.push(result.kind === "fitted"
				? `Attached image ${path}${result.notes.length > 0 ? ` (${result.notes.join("; ")})` : ""}.`
				: `Attached image ${path}: ${result.note}`);
		} else {
			notes.push(`Attached file ${path} (${upload.meta.mimeType}, ${upload.meta.size} bytes).`);
		}
	}
	return { notes, images: fitted, attachments };
}

/** The user message content: added context first, then the text as the Pi CLI places a skill before its arguments. */
export function composeContent(text: string, expansion: Expansion, notes: readonly string[], images: readonly ImageContent[]): UserMessage["content"] {
	const parts = [...expansion.blocks, ...(notes.length > 0 ? [notes.join("\n")] : []), text].filter((part) => part !== "");
	const body = parts.join("\n\n");
	if (images.length === 0) return body;
	const content: (TextContent | ImageContent)[] = [{ type: "text", text: body }, ...images];
	return content;
}
