// Project instructions and skills, through Pi's own loaders, so a repository behaves here as it does in the Pi CLI.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatSkillsForPrompt, loadProjectContextFiles, loadSkills, type Skill, stripFrontmatter } from "@earendil-works/pi-coding-agent";

export function projectContext(cwd: string, agentDir: string): { path: string; content: string }[] {
	return loadProjectContextFiles({ cwd, agentDir });
}

/** Pi's rendering of project instructions (its `project_context` prompt section). */
export function renderProjectContext(files: readonly { path: string; content: string }[]): string | undefined {
	if (files.length === 0) return undefined;
	return [
		"Project-specific instructions and guidelines:",
		...files.map(({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`),
	].join("\n\n");
}

/**
 * The skills pigui ships, in Pi's layout (`<name>/SKILL.md`): offered in every session beside the project's and Pi's
 * own, which win a name they share.
 */
export const BUNDLED_SKILLS = join(import.meta.dirname, "..", "..", "..", "skills");

export function skillsAt(cwd: string, agentDir: string): Skill[] {
	return loadSkills({ cwd, agentDir, skillPaths: [BUNDLED_SKILLS], includeDefaults: true }).skills;
}

export function renderSkills(skills: Skill[]): string | undefined {
	const text = formatSkillsForPrompt(skills, "read").trim();
	return text === "" ? undefined : text;
}

/** A skill invoked the way the Pi CLI's `/skill:name` does: its body without frontmatter, in a `<skill>` block. */
export function skillBlock(skill: Skill): string {
	const body = stripFrontmatter(readFileSync(skill.filePath, "utf8")).trim();
	return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
}
