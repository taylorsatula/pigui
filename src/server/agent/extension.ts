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

/**
 * What pigui adds to Pi for a session's own agent: its tools, prompt sections, the compaction cycle and long-term
 * memory. What the agents it starts see as well (the project's instructions, skills and the spend cap) is in project.ts.
 */
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
