// One run of an agent: a Durable task in its session's conversation. It waits its turn among the session's agents,
// submits its prompt to the agent's own conversation and sleeps until that settles, then ends with the answer; a run
// in the background also sends the answer to the parent, as a message, in the commit that ends it. Stopping it
// aborts the agent's run. The queue is the session's agent tasks themselves, as Durable records them.
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

export const AGENT_TASK = "picloud.agent";

/** On every agent's conversation: the session it works for, and its current run. */
type AgentDocState = { session: number; task: number };

export const AgentDocToken = defineDoc<AgentDocState>({
	kind: "picloud.agent",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	// Written in full in the commit that creates the agent's conversation; never read before that.
	initial: () => ({ session: 0, task: 0 }),
	checkpointWhen: () => true,
});

export type AgentInput = {
	/**
	 * The task of the Agent call that dispatched this run, so a rerun of that call finds it rather than dispatching
	 * again. Not the provider's call id, which a provider may repeat (pi-ai's OpenAI-compatible one writes "" for a
	 * call that came without one); Durable's task id is unique, and the same in a rerun.
	 */
	call: string;
	type: string;
	description: string;
	prompt: string;
	background: boolean;
	/** A resume: the agent's conversation, which an earlier run created. Absent: the one this task owns. */
	agent?: number;
};

type Checkpoint = { phase: "queue"; agent?: number } | { phase: "run"; agent: number };

/** How a run ended, with its full answer or Durable's reason; a stop ends the task `aborted` instead. */
export type AgentEnd = { agent: number; status: "done" | "failed"; text: string; reason?: string };

/** What a change to an agent also does to its session, beyond its row. */
export type SessionEffect =
	/** This commit sent a background answer that starts the session's next run. */
	| { kind: "run"; submission: number }
	/** This commit stopped the session's last agent while nothing else runs, so nothing is under way any more. */
	| { kind: "quiet" };

/** What the agent task needs from picloud. */
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

const SETTLED = "settled";
const LIVE = ["pending", "running", "waiting", "sleeping", "completing"] as const;

/** The session's agent runs that have not ended, oldest first. The queue, the report rule and Stop read these. */
export async function liveAgentTasks(tx: Tx, session: ConversationId): Promise<TaskRecord<JsonValue, JsonValue, JsonValue>[]> {
	const found: TaskRecord<JsonValue, JsonValue, JsonValue>[] = [];
	for (const status of LIVE) {
		let cursor;
		do {
			const page = await tx.scanTasks({ conversationId: session, kind: AGENT_TASK, status }, 100, cursor);
			found.push(...page.items);
			cursor = page.next;
		} while (cursor !== undefined);
	}
	return found.sort((a, b) => a.id - b.id);
}

/** Whether a run is still waiting its turn: past the queue it holds one of the session's places. */
export function queued(task: Pick<TaskRecord<JsonValue, JsonValue, unknown>, "state">): boolean {
	const state = task.state as TaskState<Checkpoint, unknown>;
	return state.status !== "completing" && state.status !== "terminal" && state.checkpoint.phase === "queue";
}

/** The session an agent's conversation works for; undefined for any other conversation. */
export async function agentSession(read: Pick<DocumentReader, "snapshot">, conversationId: ConversationId, context: Context): Promise<ConversationId | undefined> {
	const doc = await read.snapshot(AgentDocToken, conversationId, context);
	return doc === undefined || doc.session === 0 ? undefined : (doc.session as ConversationId);
}

/**
 * Whether this run may start: the free places go to the oldest runs waiting, so a run started in the same round as an
 * older one, which has not looked yet, still takes its own place. Otherwise it waits for one of the runs ahead of it
 * to end: those running, and the older ones the free places are for. A settings file that cannot be read starts
 * nothing; with nothing running there is nothing to wait for, and the run ends with the file's error.
 */
function turn(self: TaskId, live: readonly TaskRecord<JsonValue, JsonValue, JsonValue>[], settings: Settings | { error: string }): { start: true } | { wait: TaskId[] } | { fail: string } {
	const running = live.filter((task) => !queued(task));
	if ("error" in settings) return running.length === 0 ? { fail: settings.error } : { wait: running.map((task) => task.id) };
	const admitted = live.filter(queued).slice(0, Math.max(0, settings.maxInFlight - running.length));
	if (admitted.some((task) => task.id === self)) return { start: true };
	return { wait: [...running, ...admitted].map((task) => task.id) };
}

function answerText(message: AssistantMessage | undefined): string {
	if (message === undefined) return "";
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n\n").trim();
}

/** The settled prompt as the run's end: the answer's text, or Durable's reason the run ended without one. */
async function ending(tx: Tx, agent: number, settled: SettledSubmissionRecord): Promise<AgentEnd> {
	if (settled.status === "done" && settled.answer !== undefined) {
		const message = (await tx.entry(settled.answer))?.model?.[0];
		return { agent, status: "done", text: answerText(message?.role === "assistant" ? message : undefined) || "(The agent ended without writing an answer.)" };
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

type Runtime = TaskRuntime<AgentInput, Checkpoint, AgentEnd, object>;

/** The conversation a first run created for its agent, which it owns. */
async function ownConversation(runtime: Runtime, context: Context): Promise<number> {
	let agent: number | undefined;
	await runtime.commit(async (tx) => {
		agent = (await tx.scanConversations({ ownerTaskId: runtime.taskId }, 1)).items[0]?.id;
		return undefined;
	}, context);
	if (agent === undefined) throw new Error("The agent's conversation is missing.");
	return agent;
}

async function agentOf(runtime: Runtime, task: { input: AgentInput; state: { checkpoint: Checkpoint } }, context: Context): Promise<number> {
	return task.state.checkpoint.agent ?? task.input.agent ?? (await ownConversation(runtime, context));
}

export function agentTask(host: TaskHost) {
	/** End the run with `end`, and in the background send it to the parent: once, by its request ID, and kept through a stop of the parent's run. */
	const finish = async (tx: Tx, task: { id: TaskId; input: AgentInput }, session: ConversationId, parent: ConversationHandle | undefined, end: AgentEnd): Promise<NextTaskState<Checkpoint, AgentEnd>> => {
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
		await host.row(
			tx,
			session,
			end.agent,
			(row) => {
				const next = { ...current(row, end.agent), status: end.status, endedAt: host.now() };
				if (end.reason === undefined) delete next.reason;
				else next.reason = end.reason;
				return next;
			},
			effect,
		);
		return { status: "terminal", outcome: { status: "completed", result: end } };
	};

	return defineTask<AgentInput, Checkpoint, AgentEnd, object>({
		name: AGENT_TASK,
		version: 1,
		initial: (input) => (input.agent === undefined ? { phase: "queue" } : { phase: "queue", agent: input.agent }),
		phases: {
			queue: async (task, runtime, context) => {
				const session = runtime.conversationId;
				const agent = await agentOf(runtime, task, context);
				const settings = await readSettings(host.dataDir);
				host.warn("subagents.settings_invalid", "subagent-settings.json", "error" in settings ? settings.error : undefined);
				const child = await runtime.conversation(agent as ConversationId, context);
				if (child === undefined) throw new Error("The agent's conversation is missing.");
				const parent = task.input.background ? await runtime.conversation(session, context) : undefined;
				await runtime.commit(async (tx) => {
					const place = turn(task.id, await liveAgentTasks(tx, session), settings);
					if ("wait" in place) return { status: "waiting", on: place.wait, policy: "any", checkpoint: { phase: "queue", agent } };
					if ("fail" in place) return finish(tx, task, session, parent, { agent, status: "failed", reason: "settings", text: `It could not start: ${place.fail}` });
					// The prompt's request ID keeps a rerun of this phase from sending it twice.
					await child.submit(tx, { type: "input", content: task.input.prompt, requestId: `${AGENT_TASK}:${task.id}`, notify: { taskId: task.id, key: SETTLED } });
					await host.row(tx, session, agent, (row) => ({ ...current(row, agent), status: "running", startedAt: host.now() }));
					return { status: "sleeping", signals: [SubmissionSettled.key(SETTLED)], checkpoint: { phase: "run", agent } };
				}, context);
			},
			run: async (task, runtime, context) => {
				const state = await runtime.readSignal(SubmissionSettled, SETTLED, context);
				if (state === undefined || !("value" in state)) throw new Error("The agent's run woke without its answer.");
				await host.faults.beforeAgentResult?.(context);
				const session = runtime.conversationId;
				const parent = task.input.background ? await runtime.conversation(session, context) : undefined;
				await runtime.commit(async (tx) => finish(tx, task, session, parent, await ending(tx, task.state.checkpoint.agent, state.value)), context);
			},
		},
		abort: async (task, runtime, context) => {
			const session = runtime.conversationId;
			const agent = await agentOf(runtime, task, context);
			// A first run owns its agent's conversation, so the abort already stopped the agent's work; a resumed run does
			// not, since the conversation belongs to the run that created it.
			if (task.state.checkpoint.phase === "run") await (await runtime.conversation(agent as ConversationId, context))?.abort(context);
			const parent = task.input.background ? await runtime.conversation(session, context) : undefined;
			await runtime.commit(async (tx) => {
				let effect: SessionEffect | undefined;
				if (parent !== undefined) {
					const others = (await liveAgentTasks(tx, session)).some((other) => other.id !== task.id);
					const idle = (await tx.doc(LiveDoc, session)).run === undefined;
					const data: AgentStoppedData = { agent, type: task.input.type, description: task.input.description };
					// A note the parent's model reads at its next boundary, which starts no run of its own.
					await parent.submit(tx, {
						type: "write",
						entry: { kind: AGENT_STOPPED_ENTRY, data, model: [{ role: "user", content: stopMessage(agent, task.input), timestamp: host.now() }] },
					});
					if (!others && idle) effect = { kind: "quiet" };
				}
				await host.row(tx, session, agent, (row) => ({ ...current(row, agent), status: "stopped", endedAt: host.now() }), effect);
				return { status: "terminal", outcome: { status: "aborted", reason: "stopped" } };
			}, context);
		},
	});
}

/** The row as it is; an agent's row is written when it is dispatched, so it is always there for its run to change. */
function current(row: AgentRow | undefined, agent: number): AgentRow {
	if (row === undefined) throw new Error(`Agent ${agent} has no row in its session.`);
	return row;
}

export type AgentTask = ReturnType<typeof agentTask>;
