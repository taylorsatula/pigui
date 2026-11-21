// The plan tool (submit a plan, wait for approval or revision feedback) and the progress tool (mark steps done).
import type { JsonValue } from "@earendil-works/chord/json";
import { defineTool, type ToolExecutionResult, type ToolPark } from "@earendil-works/pi-durable";
import { arr, int, obj, opt, str } from "@earendil-works/pi-schema";
import type { Plan, PlanCard, PlanState } from "../../shared/session.ts";
import { editSession } from "../docs.ts";
import { awaitCard, isPark, sessionOf } from "./cards.ts";
import type { AgentServices } from "./services.ts";

export const SUBMIT_PLAN = "submit_plan";
export const UPDATE_PROGRESS = "update_progress";

const PlanParameters = obj({
	title: str({ minLength: 1, maxLength: 200, description: "The change in a few words" }),
	summary: str({ maxLength: 4000, description: "What will change and why, in a short paragraph the person reads on a phone" }),
	steps: arr(str({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 20, description: "Concrete steps in order, each checkable" }),
});

const ProgressParameters = obj({
	completed: arr(int({ minimum: 1 }), { minItems: 1, description: "Numbers of the plan steps now complete (1 is the first step)" }),
	note: opt(str({ maxLength: 1000, description: "One line on what was just finished" })),
});

export function describePlan(plan: Pick<PlanState, "steps" | "done">): string {
	return plan.steps.map((step, index) => `${index + 1}. [${plan.done.includes(step.id) ? "x" : " "}] ${step.text}`).join("\n");
}

export function planTools(services: AgentServices) {
	const submitPlan = defineTool({
		name: SUBMIT_PLAN,
		description:
			"Propose a plan for substantial work and wait for the person to approve it or ask for changes. Submit it after exploring and after your questions are answered. Approval is your go-ahead to implement the whole plan without further permission.",
		parameters: PlanParameters,
		replay: "safe",
		async execute(args, api, context): Promise<ToolExecutionResult | ToolPark> {
			const session = await sessionOf(api, context);
			const plan: Plan = {
				title: args.title,
				summary: args.summary,
				steps: args.steps.map((text, index) => ({ id: String(index + 1), text })),
			};
			// Memoized, so a rerun or the run after the answer sees the card exactly as it was shown.
			const revision = await api.memo("revision", (session.plan?.revision ?? 0) + 1, context);
			const createdAt = await api.memo("createdAt", services.now(), context);
			const card: PlanCard = { kind: "plan", id: api.callId, taskId: api.taskId, plan, revision, createdAt };
			const outcome = await awaitCard(api, context, services, card, { title: "Plan ready", body: plan.title }, (doc) => {
				// A plan waiting for approval is not approved work, so a new plan also ends any implementation underway.
				doc.plan = { ...plan, revision, approved: false, done: [] };
				doc.workflow = "open";
			});
			if (isPark(outcome)) return outcome;
			const details = { card, answer: outcome } as unknown as JsonValue;
			if (outcome.kind === "approve") {
				return {
					output: [
						{
							type: "text",
							text: `The person approved the plan (revision ${revision}). Implement all of it now, without asking for permission. Mark steps complete with ${UPDATE_PROGRESS}, commit as you go, verify, bring the branch up to date with its base, and finish with file_report.`,
						},
					],
					details,
				};
			}
			const feedback = outcome.kind === "revise" ? outcome.feedback : outcome.kind === "text" ? outcome.text : "";
			return {
				output: [
					{
						type: "text",
						text: `The person did not approve the plan yet. Their feedback, verbatim:\n"""\n${feedback}\n"""\nRevise the plan to address it and submit it again with ${SUBMIT_PLAN}. Ask with a question tool first only if the feedback leaves something you cannot decide.`,
					},
				],
				details,
			};
		},
	});

	const updateProgress = defineTool({
		name: UPDATE_PROGRESS,
		description: "Mark steps of the approved plan as complete, as you finish them, so the person sees progress at a glance.",
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
