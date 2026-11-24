// The spend cap. After each tool round, in the session and in every agent of it, spend is checked against the
// session's cap; once it is reached the person is told, every agent of the session is stopped, and the run ends
// before its next model request. Raising the cap and continuing resumes from the round's tool results.
import type { Context } from "@earendil-works/chord/context";
import { copyJson, type JsonRepresentation } from "@earendil-works/chord/json";
import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import { type AfterToolsDecision, type ConversationId, defineTask, GenerationTask, hook, type HookApi, hookTask, type Tx, UsageDoc, type UsageState } from "@earendil-works/pi-durable";
import type { SessionDoc } from "../../shared/session.ts";
import { formatDollars, sessionSpent } from "../../shared/spend.ts";
import { editSession, sessionFor } from "../documents.ts";
import { agentSession, stopAgents } from "../subagents/extension.ts";
import type { AgentServices } from "./services.ts";

/** One of pigui's own model calls, beside the agent's: a compaction checkpoint, a speakable script. JSON, since the checkpoint memoizes it. */
export type ModelSpend = { key: string; usage: JsonRepresentation<Usage> };

/** Capture what a call spent, under the model's key, dropping the counters JSON cannot hold. */
export function modelSpend(model: Model<Api>, reply: AssistantMessage): ModelSpend {
	const key = `${model.provider}/${model.id}`;
	return { key, usage: copyJson(reply.usage, { omitUndefinedProperties: true }) as JsonRepresentation<Usage> };
}

/**
 * Fold `spend` into the session's `pi.usage` document, the way Durable counts its own requests and summaries, so the
 * cap and the ledger agree. Durable keeps `recordUsage` to itself, so the counters are followed one for one: a first
 * call for a model is stored as it arrived, later calls add every counter, and the optional ones once either side reports them.
 */
export async function countSpend(tx: Tx, conversationId: ConversationId, spend: ModelSpend): Promise<void> {
	const { models } = await tx.doc(UsageDoc, conversationId);
	const { usage } = spend;
	const known = Object.hasOwn(models, spend.key) ? models[spend.key] : undefined;
	if (known === undefined) {
		models[spend.key] = copyJson(usage) as JsonRepresentation<Usage>;
		return;
	}
	for (const counter of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
		known[counter] += usage[counter];
	}
	// Optional counters count once either side reports them; a side that never does leaves the other's reading alone.
	for (const counter of ["cacheWrite1h", "reasoning"] as const) {
		const reported = usage[counter];
		if (reported !== undefined) known[counter] = (known[counter] ?? 0) + reported;
	}
	for (const counter of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
		known.cost[counter] += usage.cost[counter];
	}
}

/** What a session has spent, its own conversation plus every agent's, each read as Durable reads it. */
export async function sessionSpend(doc: Readonly<SessionDoc>, usage: (conversation: ConversationId) => Promise<Readonly<UsageState> | undefined>): Promise<number> {
	const agents = await Promise.all((doc.agents ?? []).map((agent) => usage(agent.id as ConversationId)));
	return sessionSpent(await usage(doc.id as ConversationId), agents);
}

/**
 * The spend and cap of the session behind `api`, once spend has reached the cap; undefined below it or with no cap
 * set. An agent's conversation answers with its whole session's numbers.
 */
export async function overCap(api: Pick<HookApi, "conversationId" | "snapshot">, context: Context): Promise<{ spent: number; cap: number } | undefined> {
	const session = await sessionFor(api, api.conversationId, context);
	if (session?.cap === undefined) return undefined;
	const spent = await sessionSpend(session, (id) => api.snapshot(UsageDoc, id, context));
	return spent < session.cap ? undefined : { spent, cap: session.cap };
}

export function budget(services: AgentServices) {
	const BudgetStop = defineTask<{ spent: number; cap: number }, { phase: "stop" }, AfterToolsDecision, object>({
		name: "pigui.budget-stop",
		version: 1,
		initial: () => ({ phase: "stop" }),
		phases: {
			// The person is told before anything else happens: when this runs inside an agent's round, stopping the
			// session's agents may stop this task along with them, and a commit after that fails. The abort handler ends it.
			stop: async (task, runtime, context) => {
				const { spent, cap } = task.input;
				const session = (await agentSession(runtime, runtime.conversationId, context)) ?? runtime.conversationId;
				await runtime.commit(async (tx) => {
					await editSession(tx, session, services.now(), async (doc) => {
						doc.outcome = { kind: "budget", at: services.now() };
						doc.attentionAt = services.now();
						// Keyed by the cap, so the session and its agents reaching it together notify only once.
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
