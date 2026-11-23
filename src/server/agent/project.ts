// What agents working in a session's directory get, the session's own and those it starts alike, as two small
// extensions. `pigui-project`: the project's instructions, rendered for the session's working directory at each
// request, and the spend cap, which counts the whole session and stops all of it; every agent selects it.
// `pigui-skills`: Pi's skills list, which an agent whose definition says `skills: false` does not select.
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, type Extension, type PromptInput, section } from "@earendil-works/pi-durable";
import type { SessionDoc } from "../../shared/session.ts";
import { sessionFor } from "../docs.ts";
import { budget } from "./budget.ts";
import { projectContext, renderProjectContext, renderSkills, skillsAt } from "./resources.ts";
import type { AgentServices } from "./services.ts";

/** The session a request works for, once its directory is ready to be read. */
async function ready(input: PromptInput, context: Context): Promise<Readonly<SessionDoc> | undefined> {
	const doc = await sessionFor(input.read, input.conversationId, context);
	return doc?.setup.status === "ready" ? doc : undefined;
}

export function projectExtension(services: AgentServices): Extension {
	const cap = budget(services);
	return defineExtension({
		name: "pigui-project",
		sections: [
			section("project_context", async (input, context) => {
				const doc = await ready(input, context);
				return doc === undefined ? undefined : renderProjectContext(projectContext(services.workingDir(doc), services.agentDir));
			}),
		],
		hooks: [cap.hook],
		tasks: [cap.task],
	});
}

export function skillsExtension(services: AgentServices): Extension {
	return defineExtension({
		name: "pigui-skills",
		sections: [
			section("skills", async (input, context) => {
				const doc = await ready(input, context);
				return doc === undefined ? undefined : renderSkills(skillsAt(services.workingDir(doc), services.agentDir));
			}),
		],
	});
}
