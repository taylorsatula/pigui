// pigui's compaction cycle. After each tool round, an `afterTools` hook measures the context. Past the trigger it asks
// the agent, in a steer, for a handoff note; the round after it compacts: the summarizer writes a checkpoint, a marker
// starts the context at the cut it chose (keeping the note's call and result), and a resume turn follows. Durable's own
// compaction stays on as a backstop for what this cycle does not catch, such as one round's output jumping past
// Durable's thresholds; pigui's `beforeCompact` hook writes that checkpoint the same way, within Durable's cut.
import type { Context } from "@earendil-works/chord/context";
import { calculateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
	type AfterToolsDecision,
	AgentDoc,
	CompactionTask,
	type ConversationHandle,
	defineTask,
	type EntryId,
	GenerationTask,
	hook,
	type HookApi,
	hookTask,
	LiveDoc,
	type TaskRuntime,
} from "@earendil-works/pi-durable";
import { CHECKPOINT_ENTRY, type CheckpointEntryData, COMPACTION_NOTE_ENTRY, type CompactionNoteData } from "../../shared/session.ts";
import { editSession, SessionDocToken } from "../documents.ts";
import { overCap } from "./budget.ts";
import { type Limits, saveCheckpoint, type Written, writeCheckpoint } from "./checkpoint.ts";
import { cappedBounds, durableBounds, type Span, spansOf } from "./cut.ts";
import { HANDOFF_REQUEST, RESUME, WRITE_HANDOFF } from "./handoff.ts";
import type { AgentServices } from "./services.ts";

/** Compaction thresholds for a model, as proportions of its context window. */
export function compactionFor(contextWindow: number) {
	return {
		enabled: true,
		reserveTokens: Math.round(contextWindow * 0.15),
		keepRecentTokens: Math.round(contextWindow * 0.25),
		backgroundTokens: Math.round(contextWindow * 0.1),
	};
}

/**
 * Where pigui asks for a handoff note, as a share of the context window. Durable starts its own compaction at 75%
 * with the thresholds above; the 15% between leaves room for one round of large tool output (a bash result is capped at
 * 50 KB, about 12k tokens) and the handoff round itself, so on a large window pigui's cycle nearly always runs first.
 */
export const HANDOFF_TRIGGER = 0.6;

const DEFAULT_WINDOW = 128_000;

type CompactInput = { handoff: number | null };
type CompactState = { phase: "checkpoint" } | { phase: "resume" };

const markerRequest = (taskId: number) => `pigui-compaction:${taskId}`;

async function limitsOf(services: AgentServices, api: Pick<HookApi, "conversationId" | "snapshot">, context: Context): Promise<Limits & { background: number }> {
	const agent = await api.snapshot(AgentDoc, api.conversationId, context);
	const model = agent?.model === undefined ? undefined : services.model(agent.model.provider, agent.model.modelId);
	const window = model?.contextWindow ?? DEFAULT_WINDOW;
	const defaults = compactionFor(window);
	const policy = agent?.compaction;
	const reserve = policy?.reserveTokens ?? defaults.reserveTokens;
	const background = policy?.backgroundTokens ?? defaults.backgroundTokens;
	return { model, window, cap: policy?.keepRecentTokens ?? defaults.keepRecentTokens, background: window - reserve - background };
}

/**
 * The context's size after a round, measured as Durable measures it: the usage of the request that made the round's
 * calls, plus estimates of the results it returned. Without usage, every message of the context is estimated.
 */
async function contextTokens(services: AgentServices, api: HookApi, assistant: EntryId, results: readonly EntryId[], context: Context): Promise<number> {
	const message = (await api.entry(assistant, context))?.model?.[0];
	const measured = message?.role === "assistant" ? calculateContextTokens(message.usage) : 0;
	if (measured === 0) {
		const view = await (await services.harness().conversation(api.conversationId, context))?.context(context);
		return (view?.messages ?? []).reduce((total, each) => total + estimateMessageTokens(each), 0);
	}
	let tokens = measured;
	for (const id of results) for (const each of (await api.entry(id, context))?.model ?? []) tokens += estimateMessageTokens(each);
	return tokens;
}

/** Whether a round's results include a saved handoff note. */
async function wroteHandoff(api: HookApi, results: readonly EntryId[], context: Context): Promise<boolean> {
	for (const id of results) {
		const message = (await api.entry(id, context))?.model?.[0];
		if (message?.role === "toolResult" && message.toolName === WRITE_HANDOFF && !message.isError) return true;
	}
	return false;
}

function handoffText(spans: readonly Span[], assistant: number): string | undefined {
	const message = spans.find((span) => span.entry.id === assistant)?.messages[0];
	if (message?.role !== "assistant") return undefined;
	const call = message.content.find((block) => block.type === "toolCall" && block.name === WRITE_HANDOFF);
	return call?.type === "toolCall" && typeof call.arguments.text === "string" ? call.arguments.text : undefined;
}

async function handleOf(runtime: Pick<TaskRuntime<unknown, { phase: string }, unknown, object>, "conversation" | "conversationId">, context: Context): Promise<ConversationHandle> {
	const handle = await runtime.conversation(runtime.conversationId, context);
	if (handle === undefined) throw new Error("The session's conversation is missing.");
	return handle;
}

/** pigui's steer to the agent, placed as its own kind so the phone shows it as a note and not as the person's words. */
function noteInput(note: CompactionNoteData["note"], taskId: number) {
	return {
		type: "input" as const,
		content: note === "resume" ? RESUME : HANDOFF_REQUEST,
		whenBusy: "steer" as const,
		requestId: `pigui-${note}:${taskId}`,
		entry: { kind: COMPACTION_NOTE_ENTRY, data: { note } satisfies CompactionNoteData },
	};
}

export function compactionCycle(services: AgentServices) {
	/** Ask for the handoff note, and mark the cycle as waiting for it in the same commit. */
	const request = defineTask<null, { phase: "ask" }, AfterToolsDecision, object>({
		name: "pigui.handoff-request",
		version: 1,
		initial: () => ({ phase: "ask" }),
		phases: {
			ask: async (_task, runtime, context) => {
				const handle = await handleOf(runtime, context);
				await runtime.commit(async (tx) => {
					await handle.submit(tx, noteInput("handoff-request", runtime.taskId));
					await editSession(tx, runtime.conversationId, services.now(), (doc) => {
						if (doc.handoff === undefined) doc.handoff = { compactions: 0, lastTask: 0, requestedAt: services.now() };
						else doc.handoff.requestedAt = services.now();
					});
					return { status: "terminal", outcome: { status: "completed", result: {} } };
				}, context);
			},
		},
		abort: async (_task, runtime, context) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
		},
	});

	/**
	 * pigui's compaction, as a child of the generation before the round ends, so the marker and the resume turn are
	 * placed at this round's boundary: the marker first, as writes are, then the resume turn. One admission per commit:
	 * the marker with the checkpoint's other writes, the resume turn in the terminal commit; both have fixed request IDs.
	 */
	const compact = defineTask<CompactInput, CompactState, AfterToolsDecision, object>({
		name: "pigui.compact",
		version: 1,
		initial: () => ({ phase: "checkpoint" }),
		phases: {
			checkpoint: async (task, runtime, context) => {
				const doc = await runtime.snapshot(SessionDocToken, runtime.conversationId, context);
				const view = await runtime.context(runtime.conversationId, context);
				const spans = spansOf(view);
				const limits = await limitsOf(services, runtime, context);
				const keep = task.input.handoff ?? undefined;
				const bounds = doc?.id === undefined ? undefined : cappedBounds(spans, limits.cap, view.head !== undefined, keep);
				let written: Written | undefined;
				if (doc?.id !== undefined && bounds !== undefined) {
					const handoff = keep === undefined ? undefined : handoffText(spans, keep);
					written = await writeCheckpoint(services, runtime, { doc, view, spans, bounds, limits, ...(handoff === undefined ? {} : { handoff }), signal: runtime.signal }, context);
				}
				const handle = await handleOf(runtime, context);
				await runtime.commit(async (tx) => {
					if (written === undefined) {
						// Nothing to compact after all: the cycle ends without a checkpoint.
						await editSession(tx, runtime.conversationId, services.now(), (draft) => {
							if (draft.handoff !== undefined) delete draft.handoff.requestedAt;
						});
						return { status: "terminal", outcome: { status: "completed", result: {} } };
					}
					if (written.marker !== undefined) await handle.submit(tx, { type: "write", requestId: markerRequest(runtime.taskId), entry: written.marker });
					await saveCheckpoint(tx, services, runtime, written);
					return { status: "running", checkpoint: { phase: "resume" } };
				}, context);
			},
			resume: async (_task, runtime, context) => {
				const handle = await handleOf(runtime, context);
				await runtime.commit(async (tx) => {
					await handle.submit(tx, noteInput("resume", runtime.taskId));
					return { status: "terminal", outcome: { status: "completed", result: {} } };
				}, context);
			},
		},
		abort: async (_task, runtime, context) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
		},
	});

	const trigger = hook(GenerationTask, {
		afterTools: async (assistant, results, api, context) => {
			const doc = await api.snapshot(SessionDocToken, api.conversationId, context);
			if (doc?.id === undefined) return undefined;
			// A round the spend cap ends: a steer queued now would start a run of its own.
			if ((await overCap(api, context)) !== undefined) return undefined;
			if (doc.handoff?.requestedAt !== undefined) {
				// The round after the request: compact, with the note when the agent wrote one.
				return { tasks: [hookTask(compact, { handoff: (await wroteHandoff(api, results, context)) ? assistant : null } satisfies CompactInput)] };
			}
			const limits = await limitsOf(services, api, context);
			const tokens = await contextTokens(services, api, assistant, results, context);
			// Past Durable's background threshold, Durable compacts before the agent could answer: leave it to the backstop.
			if (tokens < limits.window * HANDOFF_TRIGGER || tokens >= limits.background) return undefined;
			const live = await api.snapshot(LiveDoc, api.conversationId, context);
			if ((live?.compactions?.length ?? 0) > 0) return undefined;
			return { tasks: [hookTask(request, null)] };
		},
	});

	const backstop = hook(CompactionTask, {
		beforeCompact: async (compaction, api, context) => {
			await services.faults.beforeBackstop?.(context);
			const doc = await api.snapshot(SessionDocToken, api.conversationId, context);
			const conversation = await services.harness().conversation(api.conversationId, context);
			if (doc?.id === undefined || conversation === undefined) return undefined;
			const view = await conversation.context(context);
			// A rerun after a restart whose marker already landed (an idle conversation places it at once): it is done.
			if (view.head?.kind === CHECKPOINT_ENTRY && (view.head.data as CheckpointEntryData).task === api.taskId) return { decline: true };
			const spans = spansOf(view);
			const bounds = durableBounds(spans, compaction.firstKept);
			// A newer compaction already moved the context past this one's cut, so its summary could only be stale.
			if (bounds === undefined) return { decline: true };
			const limits = await limitsOf(services, api, context);
			const written = await writeCheckpoint(services, api, { doc, view, spans, bounds, limits, durableCut: compaction.firstKept, signal: context.abortSignal }, context);
			// Durable places this summary at its own cut; the marker, placed after it, moves the context to the
			// summarizer's. A blocking compaction's generation continues at once, so there the marker applies from the
			// next turn. A marker whose head another compaction has passed by then settles stale and is never placed.
			await services.harness().commit(async (tx) => {
				if (written.marker !== undefined) await conversation.submit(tx, { type: "write", requestId: markerRequest(api.taskId), entry: written.marker });
				await saveCheckpoint(tx, services, api, written);
			}, context);
			return { summary: written.text };
		},
	});

	return { hooks: [trigger, backstop], tasks: [request, compact] };
}
