// What picloud's agent gets: `Agent` starts or resumes an agent, `steer_subagent` sends one a message while it runs,
// and a prompt section lists the agents it can start, read from their files at every request.
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import {
	type AgentChange,
	configure,
	type ConversationId,
	ConversationIdle,
	defineTool,
	type DocumentReader,
	type Extension,
	type PromptSection,
	section,
	type TaskId,
	type ToolExecutionApi,
	type ToolExecutionResult,
	type ToolRegistration,
	type Tx,
} from "@earendil-works/pi-durable";
import { bool, int, obj, opt, str } from "@earendil-works/pi-schema";
import type { AgentRow } from "../../shared/session.ts";
import { type Catalog, type Definition, readDefinition, readDefinitions } from "./definitions.ts";
import { readSettings } from "./settings.ts";
import { AGENT_TASK, AgentDocToken, type AgentEnd, type AgentInput, type AgentTask, endMessage, queued, stopMessage, type TaskHost } from "./task.ts";

export const AGENT = "Agent";
export const STEER = "steer_subagent";
/** The first line of every agent's instructions; fake mode's scripted model reads it to tell an agent's request. */
export const ENVIRONMENT = "# Environment";

/** What the tools need beyond the agent task's host. */
export type ToolsHost = TaskHost & {
	/** The tools an agent may name, and the models it may run: what definitions are checked against. */
	catalog(): Promise<Catalog>;
	/** The tools behind a definition's names, from the registry as this call sees it. */
	tools(api: ToolExecutionApi, names: readonly string[]): ToolRegistration[];
	/** The extensions an agent never gets: picloud's session extension, and this one, so agents start no agents. */
	excluded(): readonly Extension[];
	/** The extension of the skills list, which an agent whose definition says `skills: false` does not select. */
	skills: Extension;
	/** Where the session works, which its agents share. */
	place(session: ConversationId, read: DocumentReader, context: Context): Promise<{ dir: string; branch?: string }>;
};

/** What a call dispatched: its run's task and its agent, memoized so a rerun after a crash finds them. */
type Made = { task: number; agent: number; type: string };

const refuse = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text }], isError: true });
const said = (text: string, isError = false): ToolExecutionResult => ({ output: [{ type: "text", text }], ...(isError ? { isError } : {}) });

const AgentParameters = obj({
	subagent_type: opt(str({ minLength: 1, maxLength: 100, description: "The agent to start, by name, as listed under <subagents>. With resume it may be left out; given, it must be that agent's type." })),
	description: str({ minLength: 1, maxLength: 80, description: "Three to five words on what the agent will do, shown to the person" }),
	prompt: str({ minLength: 1, maxLength: 100_000, description: "The task, self-contained; with resume, the next message to the agent" }),
	run_in_background: opt(bool({ description: "Default false: the call waits and returns the agent's answer. true: it returns at once, and the full answer arrives later as a message." })),
	resume: opt(int({ minimum: 1, description: "The id of an agent whose run has ended (done, failed or stopped): its conversation goes on with prompt, after waiting its turn like a new agent" })),
});

const AGENT_DESCRIPTION = `Start an agent: a separate Pi, defined by the person with its own prompt, tools and model, that works on one task in a conversation of its own and answers when it is done. The agents you can start are listed under <subagents>. Use one when a task matches an agent's description, to run independent work in parallel, or to keep a long exploration out of your own context; for a known file or a single command, use your own tools.
- The agent has not seen this conversation. Brief it like a colleague who just walked in: what you are trying to do and why, what you have learned or ruled out, the files and lines involved, whether it should change anything or only look, and how long its answer should be.
- In the foreground (the default) the call waits and returns the agent's full answer. Use it when your next step depends on that answer.
- With run_in_background the call returns at once with the agent's id, and its full answer arrives later as a message. Never sleep, poll or guess at its result meanwhile: go on with other work, or end your turn if there is none. Your report waits until every agent has answered.
- Several Agent calls in one round run at once; beyond the session's limit they wait their turn, oldest first.
- An answer says what the agent meant to do: check changes it says it made before you rely on them. The person does not see it, so say what matters in your own words.
- resume continues an agent whose run has ended: its conversation, and all it learned, carry forward. To reach one while it runs, use ${STEER}.`;

const SteerParameters = obj({
	agent_id: int({ minimum: 1, description: "The agent's id, as Agent gave it" }),
	message: str({ minLength: 1, maxLength: 100_000, description: "What the agent should know or do next" }),
});

const STEER_DESCRIPTION = `Send a message to a running agent. It reads the message after its current tool round and goes on with it, keeping everything it has done, so use it to correct its course or give it what it lacks. An agent still waiting its turn has not started and cannot be steered; one whose run has ended is continued with ${AGENT} and resume instead.`;

/** The environment block that heads an agent's instructions: where it works, as pi-subagents tells its agents. */
function environment(place: { dir: string; branch?: string }): string {
	return [
		ENVIRONMENT,
		`Working directory: ${place.dir}`,
		place.branch === undefined ? "Not a git repository" : `Git repository: yes\nBranch: ${place.branch}`,
		`Platform: ${process.platform}`,
	].join("\n");
}

/** The ids the call `call` dispatched, should a crash have cut it off between that commit and its memo. */
async function dispatched(tx: Tx, session: ConversationId, call: string): Promise<Made | undefined> {
	let cursor;
	do {
		const page = await tx.scanTasks({ conversationId: session, kind: AGENT_TASK, order: "descending" }, 100, cursor);
		const found = page.items.find((task) => (task.input as AgentInput).call === call);
		if (found !== undefined) {
			const input = found.input as AgentInput;
			const agent = input.agent ?? (await tx.scanConversations({ ownerTaskId: found.id }, 1)).items[0]?.id;
			if (agent !== undefined) return { task: found.id, agent, type: input.type };
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return undefined;
}

export function subagentTools(host: ToolsHost, task: AgentTask) {
	/** A new agent: its conversation, configured once from its definition, owned by its first run. */
	const start = async (tx: Tx, api: ToolExecutionApi, input: AgentInput, definition: Definition, place: { dir: string; branch?: string }): Promise<Made> => {
		const session = api.conversationId;
		const ownership = input.background ? ({ ownership: { kind: "conversation" }, background: true } as const) : ({ ownership: { kind: "task", taskId: api.taskId } } as const);
		const run = await tx.createTask(task, input, ownership);
		const conversation = await tx.createConversation({ ownership: { kind: "task", taskId: run } });
		const change: AgentChange = {
			tools: host.tools(api, definition.tools),
			extensions: { remove: definition.skills ? host.excluded() : [...host.excluded(), host.skills] },
			instructions: `${environment(place)}\n\n${definition.prompt}`,
			cwd: place.dir,
			maxTurns: definition.maxTurns ?? null,
			...(definition.model === undefined ? {} : { model: definition.model }),
			...(definition.thinking === undefined ? {} : { thinkingLevel: definition.thinking }),
			// The session's compaction thresholds are sized for its own model's window; on another model they could
			// compact at every turn, so an agent on its own model uses Durable's.
			...(definition.model === undefined ? {} : { compaction: null }),
		};
		await configure(tx, conversation.id, change);
		Object.assign(await tx.doc(AgentDocToken, conversation.id), { session, task: run });
		const now = host.now();
		const row: AgentRow = { id: conversation.id, task: run, type: input.type, description: input.description, background: input.background, status: "queued", runs: 1, createdAt: now };
		await host.row(tx, session, conversation.id, () => row);
		return { task: run, agent: conversation.id, type: input.type };
	};

	/** A new run of an agent whose last one ended, on the conversation it already has. */
	const resume = async (tx: Tx, api: ToolExecutionApi, agent: number, args: { subagent_type?: string; description: string; prompt: string; background: boolean }): Promise<Made> => {
		const session = api.conversationId;
		const doc = await tx.doc(AgentDocToken, agent as ConversationId);
		const last = await tx.task(doc.task as TaskId);
		if (last === undefined) throw new Error(`Agent ${agent} has no run to resume.`);
		if (last.state.status !== "terminal") {
			throw new Error(`Agent ${agent} is ${queued(last) ? "queued" : "running"}, so it cannot be resumed. Use ${STEER} to send it a message.`);
		}
		const previous = last.input as AgentInput;
		if (args.subagent_type !== undefined && args.subagent_type !== previous.type) {
			throw new Error(`Agent ${agent} is a ${previous.type}, not a ${args.subagent_type}. Leave subagent_type out to resume it.`);
		}
		const input: AgentInput = { call: api.callId, type: previous.type, description: args.description, prompt: args.prompt, background: args.background, agent };
		const ownership = args.background ? ({ ownership: { kind: "conversation" }, background: true } as const) : ({ ownership: { kind: "task", taskId: api.taskId } } as const);
		const run = await tx.createTask(task, input, ownership);
		doc.task = run;
		await host.row(tx, session, agent, (row) => {
			if (row === undefined) throw new Error(`Agent ${agent} has no row in its session.`);
			const { reason: _reason, startedAt: _started, endedAt: _ended, ...kept } = row;
			return { ...kept, task: run, description: args.description, background: args.background, status: "queued", runs: row.runs + 1 };
		});
		return { task: run, agent, type: previous.type };
	};

	type Args = { subagent_type?: string | undefined; description: string; prompt: string; resume?: number | undefined };

	/** What the call asks for, checked before anything is created: the commit that dispatches it, or why it cannot. */
	const prepare = async (api: ToolExecutionApi, args: Args, background: boolean, context: Context): Promise<{ refused: string } | { run: (tx: Tx) => Promise<Made> }> => {
		if (args.resume !== undefined) {
			const id = args.resume;
			const doc = await api.snapshot(AgentDocToken, id as ConversationId, context);
			if (doc === undefined || doc.session !== api.conversationId) return { refused: `There is no agent ${id} in this session.` };
			const resumed = { description: args.description, prompt: args.prompt, background, ...(args.subagent_type === undefined ? {} : { subagent_type: args.subagent_type }) };
			return { run: (tx) => resume(tx, api, id, resumed) };
		}
		if (args.subagent_type === undefined) return { refused: "Name the agent to start in subagent_type, or an agent to continue in resume." };
		const { found, available } = await readDefinition(host.dataDir, args.subagent_type, await host.catalog());
		if (found === undefined) return { refused: `There is no agent type ${args.subagent_type}. Available: ${available.join(", ") || "none"}.` };
		if ("reason" in found) {
			host.warn("subagents.definition_refused", found.file, found.reason);
			return { refused: `The agent ${found.name} cannot run: ${found.reason}. Its file is agents/${found.file}, which only the person can change.` };
		}
		const place = await host.place(api.conversationId, api, context);
		const input: AgentInput = { call: api.callId, type: found.name, description: args.description, prompt: args.prompt, background };
		return { run: (tx) => start(tx, api, input, found, place) };
	};

	/** What a foreground call returns once its agent's run ends. */
	const answer = async (api: ToolExecutionApi, made: Made, context: Context): Promise<ToolExecutionResult> => {
		const record = await api.getTask(made.task as TaskId<AgentEnd>, context);
		if (record === undefined || record.state.status !== "terminal") return refuse(`Agent ${made.agent}'s run is missing.`);
		const input = record.input as AgentInput;
		const outcome = record.state.outcome;
		if (outcome.status === "completed") return said(endMessage(input, outcome.result), outcome.result.status === "failed");
		if (outcome.status === "aborted") return said(stopMessage(made.agent, input));
		return refuse(`Agent ${made.agent}'s run broke down: ${outcome.status === "orphaned" ? outcome.reason : outcome.error.message}. Resume it with Agent and resume: ${made.agent}.`);
	};

	const agentTool = defineTool<typeof AgentParameters, JsonValue, Made>({
		name: AGENT,
		description: AGENT_DESCRIPTION,
		parameters: AgentParameters,
		replay: "safe",
		async execute(args, api, context) {
			if (api.wake !== undefined && api.checkpoint !== undefined) return answer(api, api.checkpoint, context);
			const background = args.run_in_background === true;
			let made = await api.memo<Made>("agent", context);
			if (made === undefined) {
				const settings = await readSettings(host.dataDir);
				host.warn("subagents.settings_invalid", "subagent-settings.json", "error" in settings ? settings.error : undefined);
				if ("error" in settings) {
					return refuse(`No agent can start: ${settings.error}. Only the person can fix the file.`);
				}
				const dispatch = await prepare(api, args, background, context);
				if ("refused" in dispatch) return refuse(dispatch.refused);
				// The memo is written after the commit, so a rerun cut off between the two finds its agent by its call.
				made = await api.commit(async (tx) => (await dispatched(tx, api.conversationId, api.callId)) ?? (await dispatch.run(tx)), context);
				made = await api.memo("agent", made, context);
			}
			if (!background) return { wait: { on: [made.task as TaskId], policy: "allSettled", checkpoint: made } };
			const run = await api.getTask(made.task as TaskId, context);
			const state = run !== undefined && !queued(run) ? "running" : "queued, waiting its turn";
			return said(`Agent ${made.agent} (${made.type}) is ${state}. Its full answer will arrive as a message; until then, go on with other work or end your turn.`);
		},
	});

	const steerTool = defineTool({
		name: STEER,
		description: STEER_DESCRIPTION,
		parameters: SteerParameters,
		replay: "safe",
		async execute(args, api, context) {
			const id = args.agent_id;
			const doc = await api.snapshot(AgentDocToken, id as ConversationId, context);
			if (doc === undefined || doc.session !== api.conversationId) return refuse(`There is no agent ${id} in this session.`);
			const run = await api.getTask(doc.task as TaskId, context);
			const ended = `Agent ${id}'s run has ended, so it cannot be steered. Continue it with ${AGENT} and resume: ${id}.`;
			if (run === undefined || run.state.status === "terminal" || run.state.status === "completing") return refuse(ended);
			if (queued(run)) return refuse(`Agent ${id} is queued and has not started, so there is nothing to steer yet. Its prompt reaches it when it starts.`);
			const child = await api.conversation(id as ConversationId, context);
			try {
				// By this call's ID, so a rerun after a crash steers once.
				await child?.submit({ type: "input", content: args.message, whenBusy: "steer", whenIdle: "reject", requestId: `${STEER}:${api.callId}` }, context);
			} catch (error) {
				if (error instanceof ConversationIdle) return refuse(ended);
				throw error;
			}
			return said(`Agent ${id} gets the message after its current tool round.`);
		},
	});

	return { tools: [agentTool, steerTool] };
}

/**
 * The agents the parent can start, read from their files at each request: a refused one is logged and left out, and
 * one naming tools picloud does not have says so, since its prompt may count on them.
 */
export function agentsSection(host: Pick<ToolsHost, "dataDir" | "catalog" | "warn">): PromptSection {
	return section("subagents", async () => {
		const { agents, refused } = await readDefinitions(host.dataDir, await host.catalog());
		for (const refusal of refused) host.warn("subagents.definition_refused", refusal.file, refusal.reason);
		for (const agent of agents) {
			host.warn("subagents.definition_refused", agent.file, undefined);
			host.warn("subagents.tools_missing", agent.file, agent.missing.length === 0 ? undefined : `no installed extension provides ${agent.missing.join(", ")}`);
		}
		if (agents.length === 0) return undefined;
		return [`Agents you can start with ${AGENT}, by subagent_type:`, ...agents.map(entry)].join("\n");
	});
}

function entry(agent: Definition): string {
	const line = `- ${agent.name}: ${agent.description}`;
	if (agent.missing.length === 0) return line;
	const missing = agent.missing.length === 1 ? `${agent.missing[0]} is` : `${agent.missing.slice(0, -1).join(", ")} and ${agent.missing.at(-1)} are`;
	return `${line} Here it has ${agent.tools.join(", ")}; ${missing} not available in picloud.`;
}
