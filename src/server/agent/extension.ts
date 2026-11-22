import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import { budget } from "./budget.ts";
import { compactionCycle } from "./compaction.ts";
import { handoffTool } from "./handoff.ts";
import { surfaceTool } from "./memory.ts";
import { planTools } from "./plan.ts";
import { promptSections } from "./prompt.ts";
import { questionTools } from "./questions.ts";
import { recallTool } from "./recall.ts";
import { reportTool } from "./report.ts";
import type { AgentServices } from "./services.ts";

/** Everything picloud adds to Pi: its tools, prompt sections, the spend cap, the compaction cycle and long-term memory. */
export function picloudAgent(services: AgentServices): Extension {
	const cap = budget(services);
	const compaction = compactionCycle(services);
	const memory = services.memory === undefined ? [] : [surfaceTool(services, services.memory)];
	return defineExtension({
		name: "picloud",
		tools: [...questionTools(services), ...planTools(services), reportTool(services), ...memory, recallTool(), handoffTool()],
		sections: promptSections(services),
		hooks: [cap.hook, ...compaction.hooks],
		tasks: [cap.task, ...compaction.tasks],
	});
}
