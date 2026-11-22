// The spend cap. After every tool round the run's spend is checked; over the cap, a task ends the run before the next
// model request, records why, and tells the person. Raising the cap and continuing starts from those tool results.
import type { Context } from "@earendil-works/chord/context";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { type AfterToolsDecision, type ConversationId, defineTask, GenerationTask, hook, type HookApi, hookTask, type Tx, UsageDoc } from "@earendil-works/pi-durable";
import { formatDollars, spentOf } from "../../shared/spend.ts";
import { editSession, SessionDocToken } from "../docs.ts";
import type { AgentServices } from "./services.ts";

/** What one of picloud's own model calls cost, beside the agent's: a compaction checkpoint, a speakable script. */
export type ModelSpend = { key: string; cost: number; input: number; output: number };

export function modelSpend(model: Model<Api>, reply: AssistantMessage): ModelSpend {
	return { key: `${model.provider}/${model.id}`, cost: reply.usage.cost.total, input: reply.usage.input, output: reply.usage.output };
}

/** Count `spend` in the session's `pi.usage` the way Durable counts its own summaries, so the spend cap sees it. */
export async function countSpend(tx: Tx, conversationId: ConversationId, spend: ModelSpend): Promise<void> {
	const usage = await tx.doc(UsageDoc, conversationId);
	const bucket = (usage.models[spend.key] ??= {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});
	bucket.input += spend.input;
	bucket.output += spend.output;
	bucket.totalTokens += spend.input + spend.output;
	bucket.cost.total += spend.cost;
}

/** The session's spend and its cap once the spend has reached it; undefined below the cap or without one. */
export async function overCap(api: Pick<HookApi, "conversationId" | "snapshot">, context: Context): Promise<{ spent: number; cap: number } | undefined> {
	const session = await api.snapshot(SessionDocToken, api.conversationId, context);
	if (session?.cap === undefined) return undefined;
	const spent = spentOf(await api.snapshot(UsageDoc, api.conversationId, context));
	return spent < session.cap ? undefined : { spent, cap: session.cap };
}

export function budget(services: AgentServices) {
	const BudgetStop = defineTask<{ spent: number; cap: number }, { phase: "stop" }, AfterToolsDecision, object>({
		name: "picloud.budget-stop",
		version: 1,
		initial: () => ({ phase: "stop" }),
		phases: {
			stop: async (task, runtime, context) => {
				await runtime.commit(async (tx) => {
					await editSession(tx, runtime.conversationId, services.now(), async (doc) => {
						doc.outcome = { kind: "budget", at: services.now() };
						doc.attentionAt = services.now();
						await services.notifications.enqueue(tx, doc, {
							key: `budget:${task.id}`,
							title: "Budget reached",
							body: `${formatDollars(task.input.spent)} spent of a ${formatDollars(task.input.cap)} cap. Raise it to continue.`,
						});
					});
					return { status: "terminal", outcome: { status: "completed", result: { terminate: true } } };
				}, context);
			},
		},
		abort: async (_task, runtime, context) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
		},
	});

	const check = hook(GenerationTask, {
		afterTools: async (_assistant, _results, api, context) => {
			const over = await overCap(api, context);
			return over === undefined ? undefined : { tasks: [hookTask(BudgetStop, over)] };
		},
	});

	return { task: BudgetStop, hook: check };
}
