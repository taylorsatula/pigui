// The plan tools: submitting a plan for the person's approval (and waiting), and checking steps off as the work
// lands, so the person watching the session sees the shape of the thing getting done.
import type { JsonValue } from "@earendil-works/chord/json";
import { defineTool, type ToolExecutionResult, type ToolPark } from "@earendil-works/pi-durable";
import { arr, int, obj, opt, str } from "@earendil-works/pi-schema";
import { type Plan, type PlanCard, type PlanState, planOf } from "../../shared/session.ts";
import { editSession } from "../documents.ts";
import { awaitCard, isPark, sessionOf } from "./cards.ts";
import { FILE_REPORT } from "./report.ts";
import type { AgentServices } from "./services.ts";

export const SUBMIT_PLAN = "submit_plan";
export const UPDATE_PROGRESS = "update_progress";

/** Repository paths, as they will appear under a step or a change: the person reads them to know where to look. */
const filePaths = (description: string) => arr(str({ minLength: 1, maxLength: 300 }), { maxItems: 30, description });

// Every part of a plan is required, so the person reviews each in turn; a list may be empty only where its description says so.
const PlanParameters = obj({
	title: str({ minLength: 1, maxLength: 120, description: "The change in a few words" }),
	goal: str({ minLength: 1, maxLength: 1000, description: "What will change and why, in one to three sentences" }),
	endState: arr(str({ minLength: 1, maxLength: 300 }), {
		minItems: 1,
		maxItems: 8,
		description:
			"Done when: each a condition the person could check once the work is finished (a behaviour, an output, a passing test), not an activity. Your report restates each one with evidence.",
	}),
	decisions: arr(
		obj({
			choice: str({ minLength: 1, maxLength: 300, description: "What you decided" }),
			reason: str({ minLength: 1, maxLength: 300, description: "Why, in a line" }),
		}),
		{
			maxItems: 10,
			description:
				"Every choice you made instead of asking: approach, names, public interfaces, data shapes, dependencies, behaviour users will see. Approving the plan approves them. Empty only if there was nothing to decide.",
		},
	),
	steps: arr(
		obj({
			text: str({ minLength: 1, maxLength: 300, description: "A result you can verify and mark done, not a single command or a vague phase" }),
			files: filePaths("The repository paths the step creates or changes; empty if none"),
		}),
		{ minItems: 1, maxItems: 20, description: "Usually 3 to 8 steps in order, including the tests you will add" },
	),
	verification: arr(str({ minLength: 1, maxLength: 300 }), {
		minItems: 1,
		maxItems: 10,
		description: "How you will prove it: each the exact command or check you will run (tests, typecheck, build, lint, a manual check)",
	}),
	outOfScope: arr(str({ minLength: 1, maxLength: 300 }), {
		maxItems: 10,
		description: "What you will deliberately not do that the person might expect; empty if nothing",
	}),
	risks: arr(str({ minLength: 1, maxLength: 300 }), {
		maxItems: 10,
		description: "What could go wrong or is uncertain, each with what you will do about it; empty if none",
	}),
	citations: arr(
		obj({
			ref: str({ minLength: 1, maxLength: 300, description: "A repository path (path, path:line or path:start-end) or a URL" }),
			note: str({ minLength: 1, maxLength: 300, description: "What it shows that the plan relies on" }),
		}),
		{
			maxItems: 20,
			description: "The code, tests and docs the plan rests on, so the person can check your reasoning: cite what you read. Empty only for a change that needed no reading.",
		},
	),
});

const ProgressParameters = obj({
	completed: arr(int({ minimum: 1 }), { minItems: 1, description: "Numbers of the plan steps now complete (1 is the first step)" }),
	note: opt(str({ maxLength: 1000, description: "One line on what was just finished" })),
});

/** The plan as checkboxes, for the prompt, checkpoints and this file's tools. */
export function describePlan(plan: Pick<PlanState, "steps" | "done">): string {
	return plan.steps.map((step, index) => `${index + 1}. [${plan.done.includes(step.id) ? "x" : " "}] ${step.text}`).join("\n");
}

/** The plan's end state as bullet lines, for the agent while it works: what its report must show. */
export function describeEndState(plan: PlanState): string {
	const endState = planOf(plan).endState;
	if (endState.length === 0) return "";
	return ["Done when:", ...endState.map((condition) => `- ${condition}`)].join("\n");
}

/** What approval tells the agent: the plan is the go-ahead, and the report ends the work. */
function approvalText(revision: number): string {
	return `The person approved the plan (revision ${revision}). Implement all of it now, without asking for permission. Mark steps complete with ${UPDATE_PROGRESS}, commit as you go, verify, bring the branch up to date with its base, and finish with ${FILE_REPORT}.`;
}

/** What a non-approval tells the agent: the feedback is the person's own words, and the plan goes again. */
function revisionText(feedback: string): string {
	return `The person did not approve the plan yet. Their feedback, verbatim:\n"""\n${feedback}\n"""\nRevise the plan to address it and submit it again with ${SUBMIT_PLAN}. Ask with a question tool first only if the feedback leaves something you cannot decide.`;
}

export function planTools(services: AgentServices) {
	const submitPlan = defineTool({
		name: SUBMIT_PLAN,
		description:
			"Propose a plan and wait until the person approves it or asks for changes. They review it on a phone, part by part: the goal, the end state that defines done, your decisions, the steps with their files, how you will verify, what you leave out, the risks, and the code you read. Approval is the go-ahead to carry out all of it unattended, so the plan holds every decision they would want to veto. Write each item as one short line. A new plan replaces the approved one and stops work until it is approved: submit one mid-run only when the approved plan can no longer work.",
		parameters: PlanParameters,
		replay: "safe",
		async execute(args, api, context): Promise<ToolExecutionResult | ToolPark> {
			const session = await sessionOf(api, context);
			const plan: Plan = { ...args, steps: args.steps.map((step, index) => ({ id: String(index + 1), text: step.text, files: step.files })) };
			// Memoized so a rerun, or the resolution run after the person answers, sees the card as it was shown.
			const revision = await api.memo("revision", (session.plan?.revision ?? 0) + 1, context);
			const createdAt = await api.memo("createdAt", services.now(), context);
			const card: PlanCard = { kind: "plan", id: api.callId, taskId: api.taskId, plan, revision, createdAt };
			const outcome = await awaitCard(api, context, services, card, { title: "Plan ready", body: plan.title }, (doc) => {
				// A plan awaiting approval is not approved work, so offering one also stands down any implementation underway.
				doc.plan = { ...plan, revision, approved: false, done: [] };
				doc.workflow = "open";
			});
			if (isPark(outcome)) return outcome;
			const details = { card, answer: outcome } as unknown as JsonValue;
			if (outcome.kind === "approve") {
				// Approval turns the session to implementation. The flip is idempotent: a crash before or after it, or an answer
				// path that sets it too, all land on the same state.
				await api.commit(async (tx) => {
					await editSession(tx, api.conversationId, services.now(), (doc) => {
						doc.workflow = "implementing";
						doc.continuations = 0;
						delete doc.report;
						if (doc.plan !== undefined) doc.plan.approved = true;
					});
				}, context);
				return { output: [{ type: "text", text: approvalText(revision) }], details };
			}
			const feedback = outcome.kind === "revise" ? outcome.feedback : outcome.kind === "text" ? outcome.text : "";
			return { output: [{ type: "text", text: revisionText(feedback) }], details };
		},
	});

	const updateProgress = defineTool({
		name: UPDATE_PROGRESS,
		description: "Mark steps of the approved plan complete once each is done and verified, so the person sees progress at a glance.",
		parameters: ProgressParameters,
		replay: "safe",
		async execute(args, api, context): Promise<ToolExecutionResult> {
			const plan = await api.commit(async (tx) =>
				editSession(tx, api.conversationId, services.now(), (doc) => {
					if (doc.plan === undefined || !doc.plan.approved) return undefined;
					for (const number of args.completed) {
						const step = doc.plan.steps[number - 1];
						if (step !== undefined && !doc.plan.done.includes(step.id)) doc.plan.done.push(step.id);
					}
					// Hand back plain copies: the caller reads this outside the commit.
					return { steps: doc.plan.steps.map((step) => ({ ...step })), done: [...doc.plan.done] };
				}),
			context);
			if (plan === undefined) throw new Error("There is no approved plan to record progress against.");
			const unknown = args.completed.filter((number) => number > plan.steps.length);
			const remaining = plan.steps.length - plan.done.length;
			const text = [
				`Progress: ${plan.done.length} of ${plan.steps.length} steps complete.`,
				unknown.length > 0 ? `The plan has no step ${unknown.join(", ")}.` : "",
				describePlan(plan),
				remaining === 0 ? "Every step is done: verify, bring the branch up to date with its base, commit, and file the report." : "",
			].filter((line) => line !== "");
			return { output: [{ type: "text", text: text.join("\n") }], details: { done: plan.done.length, total: plan.steps.length } };
		},
	});

	return [submitPlan, updateProgress];
}
