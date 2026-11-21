import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import { budget } from "./budget.ts";
import { handoff } from "./handoff.ts";
import { planTools } from "./plan.ts";
import { promptSections } from "./prompt.ts";
import { questionTools } from "./questions.ts";
import { recallTool } from "./recall.ts";
import { reportTool } from "./report.ts";
import type { AgentServices } from "./services.ts";

/** Everything picloud adds to Pi: its tools, prompt sections, the spend cap and the compaction handoff. */
export function picloudAgent(services: AgentServices): Extension {
	const cap = budget(services);
	return defineExtension({
		name: "picloud",
		tools: [...questionTools(services), ...planTools(services), reportTool(services), recallTool()],
		sections: promptSections(services),
		hooks: [cap.hook, handoff(services)],
		tasks: [cap.task],
	});
}
