// The spend cap. After every tool round the run's spend is checked; over the cap, a task ends the run before the next
// model request, records why, and tells the person. Raising the cap and continuing starts from those tool results.
import type { Context } from "@earendil-works/chord/context";
import { copyJson, type JsonRepresentation } from "@earendil-works/chord/json";
import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import { type AfterToolsDecision, type ConversationId, defineTask, GenerationTask, hook, type HookApi, hookTask, type Tx, UsageDoc } from "@earendil-works/pi-durable";
import { formatDollars, spentOf } from "../../shared/spend.ts";
import { editSession, SessionDocToken } from "../docs.ts";
import type { AgentServices } from "./services.ts";

/**
 * What one of picloud's own model calls used, beside the agent's: a compaction checkpoint, a speakable script. As
 * JSON, since the checkpoint's is memoized; providers may leave optional counters undefined, which JSON cannot hold.
 */
export type ModelSpend = { key: string; usage: JsonRepresentation<Usage> };

export function modelSpend(model: Model<Api>, reply: AssistantMessage): ModelSpend {
	return { key: `${model.provider}/${model.id}`, usage: copyJson(reply.usage, { omitUndefinedProperties: true }) as JsonRepresentation<Usage> };
}

/**
 * Count `spend` in the session's `pi.usage` as Durable counts its own requests and summaries, so the spend cap and the
 * ledger see it. Durable does not export its `recordUsage`, so this follows it counter for counter: a model's first
 * call is copied whole, and later ones add every counter, the optional ones once either side reports them.
 */
export async function countSpend(tx: Tx, conversationId: ConversationId, spend: ModelSpend): Promise<void> {
	const { models } = await tx.doc(UsageDoc, conversationId);
	const { usage } = spend;
	const total = Object.hasOwn(models, spend.key) ? models[spend.key] : undefined;
	if (total === undefined) {
		models[spend.key] = copyJson(usage) as JsonRepresentation<Usage>;
		return;
	}
	total.input += usage.input;
	total.output += usage.output;
	total.cacheRead += usage.cacheRead;
	total.cacheWrite += usage.cacheWrite;
	total.totalTokens += usage.totalTokens;
	if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
	if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
	total.cost.input += usage.cost.input;
	total.cost.output += usage.cost.output;
	total.cost.cacheRead += usage.cost.cacheRead;
	total.cost.cacheWrite += usage.cost.cacheWrite;
	total.cost.total += usage.cost.total;
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
