// The wiring between pigui and Pi's own resource loaders, so a project set up for the Pi CLI also behaves
// here: project instruction files, and the skills the person, the project, Pi and pigui ship.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatSkillsForPrompt, loadProjectContextFiles, loadSkills, type Skill, stripFrontmatter } from "@earendil-works/pi-coding-agent";

/** The project instruction files Pi would find for `cwd`, loaded the way the Pi CLI loads them. */
export function projectContext(cwd: string, agentDir: string): { path: string; content: string }[] {
	return loadProjectContextFiles({ cwd, agentDir });
}

/** What Pi renders those files into (its `project_context` prompt section); nothing when there are none. */
export function renderProjectContext(files: readonly { path: string; content: string }[]): string | undefined {
	if (files.length === 0) return undefined;
	const sections = files.map(({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`);
	return ["Project-specific instructions and guidelines:", ...sections].join("\n\n");
}

/**
 * pigui's own skills, shipped in Pi's layout (`<name>/SKILL.md`). They join every session beside the project's
 * and Pi's own; anything sharing a name with one of those loses.
 */
export const BUNDLED_SKILLS = join(import.meta.dirname, "..", "..", "..", "skills");

/** pigui's own agent definitions, in pi-subagents' layout (`<name>.md`); the person's and the session's win a shared name. */
export const BUNDLED_AGENTS = join(import.meta.dirname, "..", "..", "..", "agents");

/**
 * Where a session's attachments are saved inside its workspace, relative to it. In a repository's clone the
 * directory is excluded from git (`/.pigui/` is in `.git/info/exclude`).
 */
export const ATTACHMENTS_DIR = ".pigui/attachments";

/**
 * The skills available in a session rooted at `cwd`: Pi's defaults, plus the project's and the person's
 * `.agents/skills` directories and pigui's bundled ones.
 */
export function skillsAt(cwd: string, agentDir: string): Skill[] {
	const skillPaths = [join(cwd, ".agents", "skills"), join(homedir(), ".agents", "skills"), BUNDLED_SKILLS];
	return loadSkills({ cwd, agentDir, skillPaths, includeDefaults: true }).skills;
}

/** Pi's prompt rendering of `skills`; nothing when the list renders to nothing. */
export function renderSkills(skills: Skill[]): string | undefined {
	const rendered = formatSkillsForPrompt(skills, "read").trim();
	return rendered === "" ? undefined : rendered;
}

/** The skill as Pi's `/skill:name` invocation sends it: the body without frontmatter, in a `<skill>` block. */
export function skillBlock(skill: Skill): string {
	const body = stripFrontmatter(readFileSync(skill.filePath, "utf8")).trim();
	return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
}
