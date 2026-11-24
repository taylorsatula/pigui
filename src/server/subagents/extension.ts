// pigui's subagents, as one Durable extension: the `Agent` and `steer_subagent` tools, the list of agents the parent
// can start, and the agent task. It takes a small interface from pigui and imports nothing else of pigui's
// server; pigui's side calls it through the functions exported here.
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	defineExtension,
	type DocumentReader,
	type Extension,
	type Harness,
	type RegistryReader,
	type ToolRegistration,
	type Tx,
} from "@earendil-works/pi-durable";
import type { AgentRow } from "../../shared/session.ts";
import type { Catalog, Roots } from "./definitions.ts";
import { type AgentFaults, AgentDocToken, agentTask, liveAgentTasks, type SessionEffect } from "./task.ts";
import { agentsSection, subagentTools } from "./tools.ts";

export { migrateSeededAgents } from "./definitions.ts";
export { seedSettings } from "./settings.ts";
export { agentSession, liveAgentTasks, type AgentFaults } from "./task.ts";

const SUBAGENTS = "pigui-subagents";

/** What the extension needs from pigui. */
export type SubagentHost = {
	/** Where the setting (`subagent-settings.json`) lives. */
	dataDir: string;
	/** The definition roots that do not depend on the session: the app's bundled and the person's. */
	agents: { bundled: string; user: string };
	/** The session's working directory, when it is ready to be read; the project and workspace roots hang off it. */
	dir(session: ConversationId, read: DocumentReader, context: Context): Promise<string | undefined>;
	now(): number;
	log: { warn(event: string, fields: Record<string, string | undefined>): void };
	registry: RegistryReader;
	models(): Models;
	/** The extensions an agent never gets besides this one: pigui's session extension. */
	exclude: readonly Extension[];
	/** The coding tools, which an agent without a `tools` field gets all of. */
	coding: Extension;
	/** The skills list's extension: every agent selects it, unless its definition says `skills: false`. */
	skills: Extension;
	/** Where the session works, which its agents share: the directory, and its branch when it is a git repository. */
	place(session: ConversationId, read: DocumentReader, context: Context): Promise<{ dir: string; branch?: string }>;
	/** Whether the session's run under way has filed its report: an agent started after it would answer a finished run. */
	reported(session: ConversationId, read: DocumentReader, context: Context): Promise<boolean>;
	/** Change an agent's row in its session's document, in the commit that changes the agent, with what else it does. */
	row(tx: Tx, session: ConversationId, agent: number, change: (row: AgentRow | undefined) => AgentRow, effect?: SessionEffect): Promise<void>;
	faults: AgentFaults;
};

export function subagentsExtension(host: SubagentHost): Extension {
	// What was last logged about each file, so a problem is logged once for each change of it.
	const logged = new Map<string, string>();
	const warn = (event: string, file: string, text: string | undefined) => {
		const key = `${event} ${file}`;
		if (text === undefined) {
			logged.delete(key);
			return;
		}
		if (logged.get(key) === text) return;
		logged.set(key, text);
		host.log.warn(event, { file, reason: text });
	};
	const excluded = (): readonly Extension[] => [...host.exclude, extension];
	const allowed = (snapshot: { tools(): readonly { extension: Extension; tool: ToolRegistration }[] }) => {
		const names = new Set(excluded().map((ext) => ext.name));
		return snapshot.tools().filter(({ extension: ext }) => !names.has(ext.name));
	};
	const catalog = async (): Promise<Catalog> => ({
		tools: new Set(allowed(host.registry.snapshot()).map(({ tool }) => tool.name)),
		coding: host.registry
			.snapshot()
			.tools()
			.filter(({ extension: ext }) => ext.name === host.coding.name)
			.map(({ tool }) => tool.name),
		runs: async (ref) => {
			const models = host.models();
			return models.getModel(ref.provider, ref.modelId) !== undefined && (await models.checkAuth(ref.provider).catch(() => undefined)) !== undefined;
		},
	});
	const roots = async (session: ConversationId, read: DocumentReader, context: Context): Promise<Roots> => {
		const dir = await host.dir(session, read, context);
		return { ...host.agents, ...(dir === undefined ? {} : { workspace: join(dir, ".agents", "agents"), project: join(dir, ".pi", "agents") }) };
	};
	const taskHost = { dataDir: host.dataDir, now: host.now, row: host.row, warn, faults: host.faults };
	const task = agentTask(taskHost);
	const { tools } = subagentTools(
		{
			...taskHost,
			roots,
			catalog,
			tools: (api, names) => {
				const found = new Map<string, ToolRegistration>();
				for (const { tool } of allowed(api.registry)) if (names.includes(tool.name) && !found.has(tool.name)) found.set(tool.name, tool);
				return names.flatMap((name) => found.get(name) ?? []);
			},
			excluded,
			skills: host.skills,
			place: host.place,
			reported: host.reported,
		},
		task,
	);
	const extension: Extension = defineExtension({
		name: SUBAGENTS,
		tools,
		sections: [agentsSection({ roots, catalog, warn })],
		tasks: [task],
	});
	return extension;
}

/** Stop every agent of the session, queued or running; each one's own abort handler records it and tells the parent. */
export async function stopAgents(harness: Harness, session: ConversationId, context: Context): Promise<void> {
	const live = await harness.commit((tx) => liveAgentTasks(tx, session), context);
	for (const task of live) await harness.abortTask(task.id, context);
}

/** Stop one agent of the session, queued or running; false when the session has no such agent. */
export async function stopAgent(harness: Harness, session: ConversationId, agent: number, context: Context): Promise<boolean> {
	const doc = await harness.snapshot(AgentDocToken, agent as ConversationId, context);
	if (doc === undefined || doc.session !== session) return false;
	await harness.abortTask(doc.task as Parameters<Harness["abortTask"]>[0], context);
	return true;
}
