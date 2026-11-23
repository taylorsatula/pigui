// Agent definitions: one Markdown file per agent, in pi-subagents' format, so the same file works in the Pi CLI and
// here. They are read when used, never cached, so an edit applies on the next request. A field that would make the
// agent behave otherwise than written refuses it, with a reason the person can act on; a tool pigui does not have is
// left out and named, since the rest of the agent still works as written.
//
// Four roots, lowest precedence first: the app's bundled definitions, the person's own (the Pi CLI's `agents/`
// directory, shared with it), the session's `.agents/agents`, the session's `.pi/agents`. A name defined at a higher
// level shadows the lower one; a definition refused at any level removes the name, so a broken override never falls
// back to a lower root silently. The person's `.disabled` file, one name per line in their `agents/` directory,
// hides a name from every root.
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ModelRef } from "@earendil-works/pi-durable";

export type Definition = {
	/** The agent's type: what `Agent`'s `subagent_type` names. */
	name: string;
	/** The file's name, for logs. */
	file: string;
	/** The file's full path, for messages the person acts on. */
	path: string;
	description: string;
	/** The tools it gets: those it names that pigui has, or without a `tools` field the coding tools. */
	tools: string[];
	/** The tools it names that no extension here provides. */
	missing: string[];
	/** Whether its prompt lists Pi's skills. */
	skills: boolean;
	/** Absent: the session's. */
	model?: ModelRef;
	thinking?: ModelThinkingLevel;
	maxTurns?: number;
	/** The body: the agent's whole prompt. */
	prompt: string;
};

type Refusal = { name: string; file: string; path: string; reason: string };

/** Where definitions are read from, lowest precedence first. `workspace` and `project` are the session's directories. */
export type Roots = {
	/** The app's bundled definitions; replaced on update, never written by the person. */
	bundled: string;
	/** The person's definitions, the Pi CLI's `agents/` directory; overrides bundled. */
	user: string;
	/** The session's `.agents/agents`; overrides the person's. */
	workspace?: string;
	/** The session's `.pi/agents`; overrides everything. */
	project?: string;
};

type Definitions = { agents: Definition[]; refused: Refusal[] };

/** What a definition is checked against: the tools an agent may be given, the coding tools, and the models Pi runs. */
export type Catalog = {
	tools: ReadonlySet<string>;
	/** What an agent without a `tools` field gets: every tool of the installed coding tools. */
	coding: readonly string[];
	runs(model: ModelRef): Promise<boolean>;
};

/**
 * The fields of pi-subagents' format whose meaning pigui gives, or which the CLI's own decoration only uses
 * (`color`, `display_name`). `prompt_mode`, `extensions` and `skills` are accepted only with the values pigui
 * honours; every other field of the format changes what an agent does in a way pigui does not.
 */
const FIELDS = new Set(["name", "description", "tools", "model", "thinking", "max_turns", "prompt_mode", "extensions", "skills", "color", "display_name"]);
const THINKING: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** The names the person's `.disabled` file hides, one per line; blank lines and `#` comments are ignored. */
async function readDisabled(user: string): Promise<Set<string>> {
	const text = await readFile(join(user, ".disabled"), "utf8").catch(() => undefined);
	if (text === undefined) return new Set();
	return new Set(text.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#")));
}

/**
 * Every definition across the roots, lowest precedence first. A name defined at a higher root shadows the lower one;
 * a definition refused at any root removes the name, so a broken override never falls back to a lower root silently.
 * A second file of the same name within one root is refused, the first kept.
 */
export async function readDefinitions(roots: Roots, catalog: Catalog): Promise<Definitions> {
	const disabled = await readDisabled(roots.user);
	const order = [roots.bundled, roots.user, roots.workspace, roots.project].filter((dir): dir is string => dir !== undefined);
	const byName = new Map<string, Definition>();
	const refused: Refusal[] = [];
	for (const dir of order) {
		const files = (await readdir(dir).catch(() => [])).filter((file) => file.endsWith(".md")).sort();
		const seen = new Set<string>();
		for (const file of files) {
			const checked = await check(join(dir, file), catalog);
			if ("reason" in checked) {
				refused.push(checked);
				byName.delete(checked.name);
				continue;
			}
			if (seen.has(checked.name)) {
				refused.push({ name: checked.name, file: checked.file, path: checked.path, reason: `another file already defines ${checked.name}` });
				continue;
			}
			seen.add(checked.name);
			byName.set(checked.name, checked);
		}
	}
	for (const name of disabled) byName.delete(name);
	return { agents: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), refused };
}

/** The one definition `name` names: the agent, its refusal, or neither when no file defines it. */
export async function readDefinition(roots: Roots, name: string, catalog: Catalog): Promise<{ found: Definition | Refusal | undefined; available: string[] }> {
	const { agents, refused } = await readDefinitions(roots, catalog);
	return { found: agents.find((agent) => agent.name === name) ?? refused.find((refusal) => refusal.name === name), available: agents.map((agent) => agent.name) };
}

/**
 * Move the definitions an earlier pigui seeded into the data directory to the person's agent directory, and delete
 * the ones it left unchanged, so updates to the bundled definitions reach the person again. Runs at startup and is a
 * no-op once the seeded folder is gone. A seeded file that differs from the bundled one is the person's edit and
 * moves; one whose destination already exists is left in place with a warning rather than overwritten.
 */
export async function migrateSeededAgents(dataDir: string, agentDir: string, bundled: string, log: { info(event: string, fields?: Record<string, string | undefined>): void; warn(event: string, fields?: Record<string, string | undefined>): void }): Promise<void> {
	const seeded = join(dataDir, "agents");
	const files = await readdir(seeded).catch(() => undefined);
	if (files === undefined) return;
	const user = join(agentDir, "agents");
	for (const file of files.filter((name) => name.endsWith(".md")).sort()) {
		const from = join(seeded, file);
		const [source, reference] = await Promise.all([readFile(from), readFile(join(bundled, file)).catch(() => undefined)]);
		if (reference !== undefined && source.equals(reference)) {
			await rm(from);
			log.info("subagents.seed_removed", { file });
			continue;
		}
		const to = join(user, file);
		if ((await stat(to).catch(() => undefined)) !== undefined) {
			log.warn("subagents.seed_kept", { file, reason: `${to} already exists; leaving ${from} in place` });
			continue;
		}
		await mkdir(user, { recursive: true });
		try {
			await rename(from, to);
		} catch (error) {
			// The data directory and the agent directory may be different filesystems (two volumes in the container).
			if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
			await writeFile(to, source);
			await rm(from);
		}
		log.info("subagents.seed_moved", { file });
	}
	const left = await readdir(seeded).catch(() => []);
	if (left.length === 0) await rmdir(seeded).catch(() => undefined);
}

async function check(path: string, catalog: Catalog): Promise<Definition | Refusal> {
	const file = basename(path);
	const fallback = file.slice(0, -".md".length);
	const refuse = (reason: string, name = fallback): Refusal => ({ name, file, path, reason });
	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = parseFrontmatter(await readFile(path, "utf8"));
	} catch (error) {
		return refuse(`its frontmatter is not valid YAML: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
	}
	const fields = parsed.frontmatter;
	const name = fields.name ?? fallback;
	if (typeof name !== "string" || name.trim() === "") return refuse("name must be text");
	const unsupported = Object.keys(fields).filter((field) => !FIELDS.has(field));
	if (unsupported.length > 0) {
		return refuse(`${unsupported.map((field) => `"${field}"`).join(", ")} ${unsupported.length === 1 ? "is a field" : "are fields"} pigui does not support, so the agent would not behave as written`, name);
	}
	if (typeof fields.description !== "string" || fields.description.trim() === "") return refuse("description is required", name);
	if (fields.prompt_mode !== undefined && fields.prompt_mode !== "replace") {
		return refuse(`prompt_mode ${JSON.stringify(fields.prompt_mode)} is not supported: pigui gives an agent its body as its whole prompt, as "replace" does`, name);
	}
	if (fields.extensions !== undefined && fields.extensions !== false) {
		return refuse("extensions must be false or left out: an agent's tools come from its tools field", name);
	}
	if (fields.skills !== undefined && typeof fields.skills !== "boolean") return refuse("skills must be true or false: preloading a list of skills is not supported", name);
	const named = fields.tools === undefined || fields.tools === null ? [...catalog.coding] : toolList(fields.tools);
	if (named === undefined || named.length === 0) return refuse("tools must be a comma-separated list or a YAML list of tool names, or left out for the coding tools", name);
	const tools = named.filter((tool) => catalog.tools.has(tool));
	const missing = named.filter((tool) => !catalog.tools.has(tool));
	if (tools.length === 0) return refuse(`none of its tools is available here (${missing.join(", ")}); pigui has ${[...catalog.tools].join(", ")}`, name);
	if (parsed.body.trim() === "") return refuse("the body, the agent's prompt, is empty", name);
	const definition: Definition = { name, file, path, description: fields.description.trim(), tools, missing, skills: fields.skills !== false, prompt: parsed.body.trim() };
	if (fields.model !== undefined) {
		const model = typeof fields.model === "string" ? modelRef(fields.model) : undefined;
		if (model === undefined) return refuse("model must be provider/modelId", name);
		if (!(await catalog.runs(model))) return refuse(`model ${fields.model} is not one of Pi's configured models`, name);
		definition.model = model;
	}
	if (fields.thinking !== undefined) {
		const thinking = THINKING.find((level) => level === fields.thinking);
		if (thinking === undefined) return refuse(`thinking must be one of ${THINKING.join(", ")}`, name);
		definition.thinking = thinking;
	}
	if (fields.max_turns !== undefined) {
		if (typeof fields.max_turns !== "number" || !Number.isInteger(fields.max_turns) || fields.max_turns < 1) return refuse("max_turns must be a whole number of 1 or more", name);
		definition.maxTurns = fields.max_turns;
	}
	return definition;
}

function toolList(value: unknown): string[] | undefined {
	const items = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : undefined;
	if (items === undefined || !items.every((item) => typeof item === "string")) return undefined;
	return [...new Set(items.map((item) => item.trim()).filter((item) => item !== ""))];
}

function modelRef(text: string): ModelRef | undefined {
	const slash = text.indexOf("/");
	if (slash <= 0 || slash === text.length - 1) return undefined;
	return { provider: text.slice(0, slash).trim(), modelId: text.slice(slash + 1).trim() };
}
