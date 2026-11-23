// The spend cap. After every tool round, the session's agent's or one of its agents', the whole session's spend is
// checked; over the cap, a task records why, tells the person, stops every agent of the session and ends the round's
// run before its next model request. Raising the cap and continuing starts from those tool results.
import type { Context } from "@earendil-works/chord/context";
import { copyJson, type JsonRepresentation } from "@earendil-works/chord/json";
import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import { type AfterToolsDecision, type ConversationId, defineTask, GenerationTask, hook, type HookApi, hookTask, type Tx, UsageDoc, type UsageState } from "@earendil-works/pi-durable";
import type { SessionDoc } from "../../shared/session.ts";
import { formatDollars, sessionSpent } from "../../shared/spend.ts";
import { editSession, sessionFor } from "../docs.ts";
import { agentSession, stopAgents } from "../subagents/extension.ts";
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

/** What a session has spent, its own conversation and every agent's, as `usage` reads each one. */
export async function sessionSpend(doc: Readonly<SessionDoc>, usage: (conversation: ConversationId) => Promise<Readonly<UsageState> | undefined>): Promise<number> {
	const agents = await Promise.all((doc.agents ?? []).map((agent) => usage(agent.id as ConversationId)));
	return sessionSpent(await usage(doc.id as ConversationId), agents);
}

/**
 * The spend and cap of the session a conversation works for, once the spend has reached the cap; undefined below it or
 * without one. An agent's conversation counts its whole session.
 */
export async function overCap(api: Pick<HookApi, "conversationId" | "snapshot">, context: Context): Promise<{ spent: number; cap: number } | undefined> {
	const session = await sessionFor(api, api.conversationId, context);
	if (session?.cap === undefined) return undefined;
	const spent = await sessionSpend(session, (id) => api.snapshot(UsageDoc, id, context));
	return spent < session.cap ? undefined : { spent, cap: session.cap };
}

export function budget(services: AgentServices) {
	const BudgetStop = defineTask<{ spent: number; cap: number }, { phase: "stop" }, AfterToolsDecision, object>({
		name: "picloud.budget-stop",
		version: 1,
		initial: () => ({ phase: "stop" }),
		phases: {
			// The person is told first: stopping the session's agents may stop this task too, when it runs in an agent's
			// round, and it can commit nothing after that. Its last commit then fails, and its abort handler ends it.
			stop: async (task, runtime, context) => {
				const { spent, cap } = task.input;
				const session = (await agentSession(runtime, runtime.conversationId, context)) ?? runtime.conversationId;
				await runtime.commit(async (tx) => {
					await editSession(tx, session, services.now(), async (doc) => {
						doc.outcome = { kind: "budget", at: services.now() };
						doc.attentionAt = services.now();
						// Keyed by the cap, so the session and its agents reaching it together notify once.
						await services.notifications.enqueue(tx, doc, {
							key: `budget:${cap}`,
							title: "Budget reached",
							body: `${formatDollars(spent)} spent of a ${formatDollars(cap)} cap. Raise it to continue.`,
						});
					});
					return undefined;
				}, context);
				await stopAgents(services.harness(), session as ConversationId, context);
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { terminate: true } } }), context);
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
