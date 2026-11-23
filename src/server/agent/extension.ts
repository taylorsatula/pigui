// The session's own extension: pigui's tools, prompt sections, the compaction cycle and long-term memory, for the
// agent that works the session. The parts agents it starts also see (project instructions, skills) live in project.ts.
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import { compactionCycle } from "./compaction.ts";
import { handoffTool } from "./handoff.ts";
import { surfaceTool } from "./memory.ts";
import { planTools } from "./plan.ts";
import { promptSections } from "./prompt.ts";
import { questionTools } from "./questions.ts";
import { recallTool } from "./recall.ts";
import { reportTool } from "./report.ts";
import type { AgentServices } from "./services.ts";

export function piguiAgent(services: AgentServices): Extension {
	const compaction = compactionCycle(services);
	const memory = services.memory === undefined ? [] : [surfaceTool(services, services.memory)];
	return defineExtension({
		name: "pigui",
		tools: [...questionTools(services), ...planTools(services), reportTool(services), ...memory, recallTool(), handoffTool()],
		sections: promptSections(services),
		hooks: compaction.hooks,
		tasks: compaction.tasks,
	});
}
