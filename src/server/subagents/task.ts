// One agent's run, modelled as a Durable task inside the session's conversation. The task queues itself against the
// session's other agent runs, hands its prompt to the agent's own conversation, and sleeps until the run settles; a
// background run additionally relays the answer to its parent in the commit that ends it. `abortTask()` stops the
// agent's model run and records the stop. The session's agent runs queue themselves by reading one another's task
// records: there is no separate queue.
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type ConversationHandle,
	type ConversationId,
	defineDoc,
	defineTask,
	type DocumentReader,
	LiveDoc,
	type NextTaskState,
	type SettledSubmissionRecord,
	SubmissionSettled,
	type TaskId,
	type TaskRecord,
	type TaskRuntime,
	type TaskState,
	type Tx,
} from "@earendil-works/pi-durable";
import { AGENT_RESULT_ENTRY, AGENT_STOPPED_ENTRY, type AgentResultData, type AgentRow, type AgentStoppedData, runFailureText } from "../../shared/session.ts";
import { readSettings, type Settings } from "./settings.ts";

export const AGENT_TASK = "pigui.agent";

/** What the agent's own conversation keeps about the run: its session, and the run to fall back to on a restart. */
type AgentDocState = { session: number; task: number };

export const AgentDocToken = defineDoc<AgentDocState>({
	kind: AGENT_TASK,
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	// The agent's conversation is created before this doc is read; the zero placeholders are never observed as real.
	initial: () => ({ session: 0, task: 0 }),
	checkpointWhen: () => true,
});

export type AgentInput = {
	/**
	 * The task id of the dispatching Agent call, not the provider's call id: providers may repeat those (an
	 * OpenAI-compatible one without a call id writes ""), while a Durable task id is unique and survives a rerun.
	 */
	call: string;
	type: string;
	description: string;
	prompt: string;
	background: boolean;
	/** A resume: the agent's conversation, which an earlier run created. Absent: the one this task owns. */
	agent?: number;
};

type AgentCheckpoint = { phase: "queue"; agent?: number } | { phase: "run"; agent: number };

/** How a run ended, with its full answer or Durable's reason; a stop ends the task `aborted` instead. */
export type AgentEnd = { agent: number; status: "done" | "failed"; text: string; reason?: string };

/** What a change to an agent also does to its session, beyond its row. */
export type SessionEffect =
	/** This commit sent a background answer that starts the session's next run. */
	| { kind: "run"; submission: number }
	/** This commit stopped the session's last agent while nothing else runs, so nothing is under way any more. */
	| { kind: "quiet" };

/** What the agent task needs from pigui. */
export type TaskHost = {
	dataDir: string;
	now(): number;
	/** Change an agent's row in its session's document, in the commit that changes the agent. */
	row(tx: Tx, session: ConversationId, agent: number, change: (row: AgentRow | undefined) => AgentRow, effect?: SessionEffect): Promise<void>;
	/**
	 * Log what is wrong with one of the person's files, once for each change of it; `undefined` says the file is fine
	 * again.
	 */
	warn(event: string, file: string, text: string | undefined): void;
	faults: AgentFaults;
};

/** Test seams: points where a test holds an agent still, to cut it off there as a crash would. */
export type AgentFaults = {
	/** After the agent's answer is in, before the commit that ends its run and sends the answer on. */
	beforeAgentResult?: (context: Context) => Promise<void>;
};

/** The key the run's submission settles under; the sleep in `run` waits on it. */
const SETTLED = "settled";
/** Task statuses short of terminal; `completing` is included so a run ending counts as in flight until it settles. */
const LIVE = ["pending", "running", "waiting", "sleeping", "completing"] as const;

async function scanLive(tx: Tx, session: ConversationId, status: (typeof LIVE)[number]): Promise<TaskRecord<JsonValue, JsonValue, JsonValue>[]> {
	const found: TaskRecord<JsonValue, JsonValue, JsonValue>[] = [];
	let cursor;
	do {
		const page = await tx.scanTasks({ conversationId: session, kind: AGENT_TASK, status }, 100, cursor);
		found.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	return found;
}

/** Every agent task of the session short of settled, oldest first. The queue, the report rule and Stop read these. */
export async function liveAgentTasks(tx: Tx, session: ConversationId): Promise<TaskRecord<JsonValue, JsonValue, JsonValue>[]> {
	const live: TaskRecord<JsonValue, JsonValue, JsonValue>[] = [];
	for (const status of LIVE) live.push(...(await scanLive(tx, session, status)));
	return live.sort((a, b) => a.id - b.id);
}

/** Whether a run is still waiting its turn: past the queue it holds one of the session's places. */
export function queued(task: Pick<TaskRecord<JsonValue, JsonValue, unknown>, "state">): boolean {
	const state = task.state as TaskState<AgentCheckpoint, unknown>;
	return state.status !== "completing" && state.status !== "terminal" && state.checkpoint.phase === "queue";
}

/** The session an agent's conversation works for; undefined for any other conversation. */
export async function agentSession(read: Pick<DocumentReader, "snapshot">, conversationId: ConversationId, context: Context): Promise<ConversationId | undefined> {
	const doc = await read.snapshot(AgentDocToken, conversationId, context);
	return doc === undefined || doc.session === 0 ? undefined : (doc.session as ConversationId);
}

type Admission = { verdict: "start" } | { verdict: "wait"; on: TaskId[] } | { verdict: "fail"; reason: string };

/**
 * Decide whether this run may start. Free places go to the oldest waiting runs, so a run admitted in the same round as
 * an older one that has not looked yet still holds its own place. A run that does not start waits for the runs ahead
 * of it to end. Without settings there is nothing to admit against: with nothing in flight the run fails with the
 * file's error, and the person can fix the file and resume it; with something in flight it waits, so the wake after
 * that something ends reads the file again.
 */
function admission(self: TaskId, live: readonly TaskRecord<JsonValue, JsonValue, JsonValue>[], settings: Settings | { error: string }): Admission {
	const running = live.filter((task) => !queued(task));
	if ("error" in settings) {
		return running.length === 0 ? { verdict: "fail", reason: settings.error } : { verdict: "wait", on: running.map((task) => task.id) };
	}
	const free = Math.max(0, settings.maxInFlight - running.length);
	const admitted = live.filter(queued).slice(0, free);
	if (admitted.some((task) => task.id === self)) return { verdict: "start" };
	return { verdict: "wait", on: [...running, ...admitted].map((task) => task.id) };
}

function assistantText(message: AssistantMessage | undefined): string {
	if (message === undefined) return "";
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n\n").trim();
}

/** The settled prompt as the run's end: the answer's text, or Durable's reason the run ended without one. */
async function runEnd(tx: Tx, agent: number, settled: SettledSubmissionRecord): Promise<AgentEnd> {
	if (settled.status === "done" && settled.answer !== undefined) {
		const message = (await tx.entry(settled.answer))?.model?.[0];
		const text = message?.role === "assistant" ? assistantText(message) : "";
		return { agent, status: "done", text: text || "(The agent ended without writing an answer.)" };
	}
	const reason = settled.reason ?? "unknown";
	const detail = typeof settled.detail === "string" ? `: ${settled.detail}` : "";
	return { agent, status: "failed", reason, text: `${runFailureText(reason)}${detail}.` };
}

/** How the parent is told an agent ended: headed by its id, type and how it ended, so it can resume it later. */
export function endMessage(input: Pick<AgentInput, "type" | "description">, end: AgentEnd): string {
	const head = `Agent ${end.agent} (${input.type}, "${input.description}")`;
	return end.status === "done" ? `${head} finished. Its answer:\n\n${end.text}` : `${head} failed: ${end.text}`;
}

export function stopMessage(agent: number, input: Pick<AgentInput, "type" | "description">): string {
	return `Agent ${agent} (${input.type}, "${input.description}") was stopped by the person before it finished. Resume it with Agent and resume: ${agent} if its work is still needed.`;
}

type AgentRun = TaskRuntime<AgentInput, AgentCheckpoint, AgentEnd, object>;

/** The conversation a first run created for its agent, found by the ownership the create committed. */
async function ownedConversation(runtime: AgentRun, context: Context): Promise<number> {
	let agent: number | undefined;
	await runtime.commit(async (tx) => {
		agent = (await tx.scanConversations({ ownerTaskId: runtime.taskId }, 1)).items[0]?.id;
		return undefined;
	}, context);
	if (agent === undefined) throw new Error("The agent's conversation is missing.");
	return agent;
}

/** Which conversation this run works on: the checkpoint's, an input's (a resume), or the one the first run created. */
async function agentConversation(runtime: AgentRun, task: { input: AgentInput; state: { checkpoint: AgentCheckpoint } }, context: Context): Promise<number> {
	return task.state.checkpoint.agent ?? task.input.agent ?? (await ownedConversation(runtime, context));
}

/** The row as it is; an agent's row is written when it is dispatched, so it is always there for its run to change. */
function existingRow(row: AgentRow | undefined, agent: number): AgentRow {
	if (row === undefined) throw new Error(`Agent ${agent} has no row in its session.`);
	return row;
}

/** The row of an agent whose run ended with `end`: the outcome, when it ended, and a failure's reason cleared or kept. */
function endedRow(row: AgentRow | undefined, end: AgentEnd, at: number): AgentRow {
	const next = { ...existingRow(row, end.agent), status: end.status, endedAt: at };
	if (end.reason === undefined) delete next.reason;
	else next.reason = end.reason;
	return next;
}

export function agentTask(host: TaskHost) {
	/**
	 * End the run with `end`. A background run also relays the answer to the parent in the same commit, once: the
	 * request ID keys the send to this run, and the answer survives a stop of the parent's run.
	 */
	const finish = async (tx: Tx, task: { id: TaskId; input: AgentInput }, session: ConversationId, parent: ConversationHandle | undefined, end: AgentEnd): Promise<NextTaskState<AgentCheckpoint, AgentEnd>> => {
		let effect: SessionEffect | undefined;
		if (parent !== undefined) {
			const idle = (await tx.doc(LiveDoc, session)).run === undefined;
			const data: AgentResultData = { agent: end.agent, type: task.input.type, description: task.input.description, status: end.status, text: end.text };
			const submission = await parent.submit(tx, {
				type: "input",
				content: endMessage(task.input, end),
				requestId: `${AGENT_RESULT_ENTRY}:${task.id}`,
				entry: { kind: AGENT_RESULT_ENTRY, data },
				onAbort: "keep",
			});
			if (idle) effect = { kind: "run", submission };
		}
		await host.row(tx, session, end.agent, (row) => endedRow(row, end, host.now()), effect);
		return { status: "terminal", outcome: { status: "completed", result: end } };
	};

	return defineTask<AgentInput, AgentCheckpoint, AgentEnd, object>({
		name: AGENT_TASK,
		version: 1,
		initial: (input) => (input.agent === undefined ? { phase: "queue" } : { phase: "queue", agent: input.agent }),
		phases: {
			queue: async (task, runtime, context) => {
				const session = runtime.conversationId;
				const agent = await agentConversation(runtime, task, context);
				const settings = await readSettings(host.dataDir);
				host.warn("subagents.settings_invalid", "subagent-settings.json", "error" in settings ? settings.error : undefined);
				const child = await runtime.conversation(agent as ConversationId, context);
				if (child === undefined) throw new Error("The agent's conversation is missing.");
				const parent = task.input.background ? await runtime.conversation(session, context) : undefined;
				await runtime.commit(async (tx) => {
					const place = admission(task.id, await liveAgentTasks(tx, session), settings);
					if (place.verdict === "wait") {
						return { status: "waiting", on: place.on, policy: "any", checkpoint: { phase: "queue", agent } };
					}
					if (place.verdict === "fail") {
						return finish(tx, task, session, parent, { agent, status: "failed", reason: "settings", text: `It could not start: ${place.reason}` });
					}
					// The prompt's request ID keeps a rerun of this phase from sending it twice.
					await child.submit(tx, { type: "input", content: task.input.prompt, requestId: `${AGENT_TASK}:${task.id}`, notify: { taskId: task.id, key: SETTLED } });
					await host.row(tx, session, agent, (row) => ({ ...existingRow(row, agent), status: "running", startedAt: host.now() }));
					return { status: "sleeping", signals: [SubmissionSettled.key(SETTLED)], checkpoint: { phase: "run", agent } };
				}, context);
			},
			run: async (task, runtime, context) => {
				const settled = await runtime.readSignal(SubmissionSettled, SETTLED, context);
				if (settled === undefined || !("value" in settled)) throw new Error("The agent's run woke without its answer.");
				await host.faults.beforeAgentResult?.(context);
				const session = runtime.conversationId;
				const parent = task.input.background ? await runtime.conversation(session, context) : undefined;
				await runtime.commit(async (tx) => finish(tx, task, session, parent, await runEnd(tx, task.state.checkpoint.agent, settled.value)), context);
			},
		},
		abort: async (task, runtime, context) => {
			const session = runtime.conversationId;
			const agent = await agentConversation(runtime, task, context);
			// Only a run that reached its agent's conversation has work there to stop; a queued run does not.
			if (task.state.checkpoint.phase === "run") await (await runtime.conversation(agent as ConversationId, context))?.abort(context);
			const parent = task.input.background ? await runtime.conversation(session, context) : undefined;
			await runtime.commit(async (tx) => {
				let effect: SessionEffect | undefined;
				if (parent !== undefined) {
					const others = (await liveAgentTasks(tx, session)).some((other) => other.id !== task.id);
					const idle = (await tx.doc(LiveDoc, session)).run === undefined;
					const data: AgentStoppedData = { agent, type: task.input.type, description: task.input.description };
					// A write, not an input: the parent reads it at its next boundary, and it starts no run of its own.
					await parent.submit(tx, {
						type: "write",
						entry: { kind: AGENT_STOPPED_ENTRY, data, model: [{ role: "user", content: stopMessage(agent, task.input), timestamp: host.now() }] },
					});
					if (!others && idle) effect = { kind: "quiet" };
				}
				await host.row(tx, session, agent, (row) => ({ ...existingRow(row, agent), status: "stopped", endedAt: host.now() }), effect);
				return { status: "terminal", outcome: { status: "aborted", reason: "stopped" } };
			}, context);
		},
	});
}

export type AgentTask = ReturnType<typeof agentTask>;
