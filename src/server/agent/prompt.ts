// What Pi is told. Sections render before each request and only changed ones are re-sent, so the dynamic part (the
// session's state) is kept to one section that changes only when the workflow does.
import type { Context } from "@earendil-works/chord/context";
import { type PromptInput, type PromptSection, section } from "@earendil-works/pi-durable";
import type { SessionDoc } from "../../shared/session.ts";
import { RepoMemoryToken, SessionDocToken } from "../docs.ts";
import { describePlan, SUBMIT_PLAN, UPDATE_PROGRESS } from "./plan.ts";
import { ASK_MULTIPLE, ASK_SINGLE } from "./questions.ts";
import { RECALL } from "./recall.ts";
import { FILE_REPORT } from "./report.ts";
import { projectContext, renderProjectContext, renderSkills, skillsAt } from "./resources.ts";
import type { AgentServices } from "./services.ts";

export const ATTACHMENTS_DIR = ".picloud/attachments";

export const PREAMBLE = `You are Pi, a coding agent running on its owner's server through picloud. The person drives you from a phone and is usually away: they read what you write later, in short glances, and answer by tapping. Nobody is at a keyboard while you work, so never wait for input except through the question and plan tools.

How to work:
- Answer simple questions directly, and just do small, clear requests (a typo, a one-line change, a quick lookup). No plan is needed for those.
- For substantial work, explore the code first. Then ask everything you need to know at once with ${ASK_SINGLE} or ${ASK_MULTIPLE}, putting all your questions on one card. Then propose a plan with ${SUBMIT_PLAN} and wait for approval.
- Once the plan is approved, work to completion without asking for permission or checking in. Mark steps done with ${UPDATE_PROGRESS} as you finish them. If something comes up that the plan did not decide, choose the sensible option and say so in the report; ask only when you truly cannot continue.
- Verify before you report: run the tests, the build, or whatever proves the change works, and read the output.
- Commit your work with clear messages as you go. Never push, never open pull requests, and never switch to or create other branches: picloud delivers your branch when the person taps.
- Before reporting, bring the branch up to date with its base: fetch it, merge it, resolve conflicts, run the tests again and commit.
- Finish substantial work with ${FILE_REPORT}. Report honestly, including what you could not do or are unsure of. A report that names a failure is worth more than one that hides it.
- Writing a reply without a tool call ends your turn. While implementing an approved plan, keep going with tools until the report is filed.
- Files the person attaches are saved under ${ATTACHMENTS_DIR}/, which git ignores. Never commit them.
- Your history is never lost: if you need something from earlier that is no longer in view, use ${RECALL}.
- Keep messages short and plain; they are read on a small screen.`;

function startLine(doc: SessionDoc): string {
	if (doc.start.kind === "new") return `a new branch cut from ${doc.start.base}`;
	return `the existing branch ${doc.start.branch}; pushing updates it and any pull request open for it`;
}

function workflowLines(doc: SessionDoc): string[] {
	switch (doc.workflow) {
		case "open":
			return doc.plan !== undefined && !doc.plan.approved
				? [`A plan (revision ${doc.plan.revision}) is waiting for the person's approval.`]
				: ["No plan is approved. Interact as the request needs."];
		case "implementing": {
			const plan = doc.plan;
			if (plan === undefined) return ["Implementing."];
			return [
				`Plan approved (revision ${plan.revision}): "${plan.title}". Implement it to completion and file the report.`,
				`Progress, ${plan.done.length} of ${plan.steps.length} steps done:`,
				describePlan(plan),
			];
		}
		case "reported":
			return ["The report was filed. If the person asks for more, do it, commit, and file a new report when it is substantial."];
	}
}

export function renderSession(doc: SessionDoc, workspace: string): string {
	return [
		`Repository: ${doc.repo}, cloned at ${workspace} (your working directory).`,
		`Branch: ${doc.branch}, which is yours. It started as ${startLine(doc)}.`,
		`Base branch: ${doc.base}. Compare with and merge from origin/${doc.base}.`,
		...workflowLines(doc),
	].join("\n");
}

export function promptSections(services: AgentServices): PromptSection[] {
	const session = (input: PromptInput, context: Context) => input.read.snapshot(SessionDocToken, input.conversationId, context);
	return [
		section("picloud", () => PREAMBLE, { tag: false }),
		section("session", async (input, context) => {
			const doc = await session(input, context);
			return doc?.id === undefined ? undefined : renderSession(doc, services.workspace(doc.id));
		}),
		section("project_context", async (input, context) => {
			const doc = await session(input, context);
			if (doc?.id === undefined || doc.setup.status !== "ready") return undefined;
			return renderProjectContext(projectContext(services.workspace(doc.id), services.agentDir));
		}),
		section("skills", async (input, context) => {
			const doc = await session(input, context);
			if (doc?.id === undefined || doc.setup.status !== "ready") return undefined;
			return renderSkills(skillsAt(services.workspace(doc.id), services.agentDir));
		}),
		section("repo_memory", async (input, context) => {
			const doc = await session(input, context);
			if (doc?.id === undefined) return undefined;
			const memory = await input.read.snapshot(RepoMemoryToken, doc.repo, context);
			if (memory === undefined || memory.notes === "") return undefined;
			return `What earlier sessions learned about building and testing ${doc.repo} on this machine (update it in your report's "learned" field):\n${memory.notes}`;
		}),
	];
}
