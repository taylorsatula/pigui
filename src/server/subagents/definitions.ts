// Agent definitions: one Markdown file per agent in the data directory's `agents/`, written by the person over SSH in
// pi-subagents' format, so the same file works in the Pi CLI and here. They are read when used, never cached, so an
// edit applies on the next request. A field that would make the agent behave otherwise than written refuses it, with
// a reason the person can act on; a tool picloud does not have is left out and named, since the rest of the agent
// still works as written.
import { cp, readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ModelRef } from "@earendil-works/pi-durable";

export type Definition = {
	/** The agent's type: what `Agent`'s `subagent_type` names. */
	name: string;
	file: string;
	description: string;
	/** The tools it gets: those it names that picloud has, or without a `tools` field the coding tools. */
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

type Refusal = { name: string; file: string; reason: string };

type Definitions = { agents: Definition[]; refused: Refusal[] };

/** What a definition is checked against: the tools an agent may be given, the coding tools, and the models Pi runs. */
export type Catalog = {
	tools: ReadonlySet<string>;
	/** What an agent without a `tools` field gets: every tool of the installed coding tools. */
	coding: readonly string[];
	runs(model: ModelRef): Promise<boolean>;
};

/**
 * The fields of pi-subagents' format whose meaning picloud gives, or which the CLI's own decoration only uses
 * (`color`, `display_name`). `prompt_mode`, `extensions` and `skills` are accepted only with the values picloud
 * honours; every other field of the format changes what an agent does in a way picloud does not.
 */
const FIELDS = new Set(["name", "description", "tools", "model", "thinking", "max_turns", "prompt_mode", "extensions", "skills", "color", "display_name"]);
const THINKING: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function agentsDir(dataDir: string): string {
	return join(dataDir, "agents");
}

/**
 * Give a data directory without an agents folder the bundled definitions. Once the folder exists it is the person's:
 * nothing here adds, changes or removes a file in it, so an update never undoes their edits.
 */
export async function seedAgents(dataDir: string, bundled: string): Promise<void> {
	const dir = agentsDir(dataDir);
	if ((await stat(dir).catch(() => undefined)) !== undefined) return;
	await cp(bundled, dir, { recursive: true });
}

/** Every definition in the folder, in file order; a second file of the same name is refused, the first kept. */
export async function readDefinitions(dataDir: string, catalog: Catalog): Promise<Definitions> {
	const dir = agentsDir(dataDir);
	const files = (await readdir(dir).catch(() => [])).filter((file) => file.endsWith(".md")).sort();
	const agents: Definition[] = [];
	const refused: Refusal[] = [];
	for (const file of files) {
		const checked = await check(join(dir, file), catalog);
		if ("reason" in checked) refused.push(checked);
		else if (agents.some((agent) => agent.name === checked.name)) refused.push({ name: checked.name, file: checked.file, reason: `another file already defines ${checked.name}` });
		else agents.push(checked);
	}
	return { agents, refused };
}

/** The one definition `name` names: the agent, its refusal, or neither when no file defines it. */
export async function readDefinition(dataDir: string, name: string, catalog: Catalog): Promise<{ found: Definition | Refusal | undefined; available: string[] }> {
	const { agents, refused } = await readDefinitions(dataDir, catalog);
	return { found: agents.find((agent) => agent.name === name) ?? refused.find((refusal) => refusal.name === name), available: agents.map((agent) => agent.name) };
}

async function check(path: string, catalog: Catalog): Promise<Definition | Refusal> {
	const file = basename(path);
	const fallback = file.slice(0, -".md".length);
	const refuse = (reason: string, name = fallback): Refusal => ({ name, file, reason });
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
		return refuse(`${unsupported.map((field) => `"${field}"`).join(", ")} ${unsupported.length === 1 ? "is a field" : "are fields"} picloud does not support, so the agent would not behave as written`, name);
	}
	if (typeof fields.description !== "string" || fields.description.trim() === "") return refuse("description is required", name);
	if (fields.prompt_mode !== undefined && fields.prompt_mode !== "replace") {
		return refuse(`prompt_mode ${JSON.stringify(fields.prompt_mode)} is not supported: picloud gives an agent its body as its whole prompt, as "replace" does`, name);
	}
	if (fields.extensions !== undefined && fields.extensions !== false) {
		return refuse("extensions must be false or left out: an agent's tools come from its tools field", name);
	}
	if (fields.skills !== undefined && typeof fields.skills !== "boolean") return refuse("skills must be true or false: preloading a list of skills is not supported", name);
	const named = fields.tools === undefined || fields.tools === null ? [...catalog.coding] : toolList(fields.tools);
	if (named === undefined || named.length === 0) return refuse("tools must be a comma-separated list or a YAML list of tool names, or left out for the coding tools", name);
	const tools = named.filter((tool) => catalog.tools.has(tool));
	const missing = named.filter((tool) => !catalog.tools.has(tool));
	if (tools.length === 0) return refuse(`none of its tools is available here (${missing.join(", ")}); picloud has ${[...catalog.tools].join(", ")}`, name);
	if (parsed.body.trim() === "") return refuse("the body, the agent's prompt, is empty", name);
	const definition: Definition = { name, file, description: fields.description.trim(), tools, missing, skills: fields.skills !== false, prompt: parsed.body.trim() };
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
