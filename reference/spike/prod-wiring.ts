import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
const models = await ModelRuntime.create();
const settings = SettingsManager.create(process.cwd(), getAgentDir());
const model = { provider: settings.getDefaultProvider()!, modelId: settings.getDefaultModel()! };
const h = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, ctx);
const env = undefined as unknown as import("@earendil-works/pi-durable/env").ExecutionEnv;
const r = await env.exec(["git", "status", "--porcelain"], {}, ctx);
const code = r.ok ? r.value.exitCode : -1;
console.log(getAgentDir(), model, typeof h, code);
import { formatSkillsForPrompt, loadProjectContextFiles, loadSkills } from "@earendil-works/pi-coding-agent";
import { defineExtension, section } from "@earendil-works/pi-durable";
export const PiContext = defineExtension({
	name: "pi-context",
	sections: [
		section("project_context", (input) => {
			const cwd = input.env?.cwd; if (cwd === undefined) return undefined;
			const files = loadProjectContextFiles({ cwd, agentDir: getAgentDir() });
			return files.length === 0 ? undefined : files.map((f) => `## ${f.path}\n\n${f.content}`).join("\n\n");
		}),
		section("skills", (input) => {
			const cwd = input.env?.cwd; if (cwd === undefined) return undefined;
			const { skills } = loadSkills({ cwd, agentDir: getAgentDir(), skillPaths: [], includeDefaults: true });
			return skills.length === 0 ? undefined : formatSkillsForPrompt(skills, "read");
		}),
		section("cwd", (input) => input.env?.cwd),
	],
});
