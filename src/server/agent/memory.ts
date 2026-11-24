// Long-term memory as the agent uses it: surface_memories searches it while the work goes on, and the report's
// `memory` part records, corrects, removes and rates memories, applied in the report's own commit.
import type { Context } from "@earendil-works/chord/context";
import { defineTool, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { arr, bool, obj, str } from "@earendil-works/pi-schema";
import { editSession } from "../documents.ts";
import {
	CREATE_DESCRIPTION,
	DELETE_DESCRIPTION,
	EDIT_DESCRIPTION,
	HELPFUL_DESCRIPTION,
	MEMORY_PART_DESCRIPTION,
	QUERY_DESCRIPTION,
	renderSurface,
	SURFACE_DESCRIPTION,
	SURFACE_MEMORIES,
} from "../memory/directives.ts";
import type { Memory, MemoryChanges, PreparedChanges } from "../memory/store.ts";
import { sessionOf } from "./cards.ts";
import type { AgentServices } from "./services.ts";

const memoryText = (description?: string) => str({ minLength: 1, maxLength: 1000, ...(description === undefined ? {} : { description }) });
const memoryId = str({ minLength: 1, maxLength: 64, description: `A full id, as ${SURFACE_MEMORIES} returned it` });

/** Four arrays, each required and each allowed to be empty, so the report states every one out loud. */
export const MemoryPart = obj(
	{
		create: arr(memoryText(), { maxItems: 20, description: CREATE_DESCRIPTION }),
		helpful: arr(obj({ id: memoryId, helpful: bool() }), { maxItems: 200, description: HELPFUL_DESCRIPTION }),
		edit: arr(obj({ id: memoryId, text: memoryText("The corrected text, under the same rules as `create`") }), { maxItems: 20, description: EDIT_DESCRIPTION }),
		delete: arr(memoryId, { maxItems: 50, description: DELETE_DESCRIPTION }),
	},
	{ description: MEMORY_PART_DESCRIPTION },
);

export function surfaceTool(services: AgentServices, memory: Memory) {
	return defineTool({
		name: SURFACE_MEMORIES,
		description: SURFACE_DESCRIPTION,
		parameters: obj({ query: str({ minLength: 1, maxLength: 2000, description: QUERY_DESCRIPTION }) }),
		replay: "safe",
		async execute(args, api, context): Promise<ToolExecutionResult> {
			const session = await sessionOf(api, context);
			const result = await memory.search(args.query, context);
			// Recorded on the session rather than read back from the transcript, so a compaction cannot hide one from the report.
			const shown = result.hits.map((hit) => hit.id).filter((id) => !(session.memoryShown ?? []).includes(id));
			if (shown.length > 0) {
				await api.commit(
					(tx) =>
						editSession(tx, api.conversationId, services.now(), (doc) => {
							const known = doc.memoryShown ?? [];
							doc.memoryShown = [...known, ...shown.filter((id) => !known.includes(id))];
						}),
					context,
				);
			}
			return { output: [{ type: "text", text: renderSurface(result) }] };
		},
	});
}

/**
 * What the report does with its memory part: refuse the report, apply the part in its commit, or record it unavailable.
 * A memory the agent asked for is better than a missing note; when embedding fails the report still files, with a
 * note saying so, because the work matters more than the memory.
 */
export type MemoryOutcome = { kind: "refused"; text: string } | { kind: "apply"; changes: PreparedChanges } | { kind: "unavailable"; reason: string };

/**
 * Check a report's memory part against the store and the memories this session was shown, then embed what it writes.
 * An unknown id, or a surfaced memory left unrated, refuses the report. An embedding failure returns `unavailable`,
 * so the caller files the report with a note instead: the work matters more than the memory.
 */
export async function prepareMemory(memory: Memory, changes: MemoryChanges, shown: readonly string[], context: Context): Promise<MemoryOutcome> {
	const rows = await memory.rows(context);
	const problems: string[] = [];
	for (const [field, ids] of [
		["memory.delete", changes.delete],
		["memory.edit", changes.edit.map((item) => item.id)],
	] as const) {
		const unknown = ids.filter((id) => rows[id] === undefined);
		if (unknown.length > 0) problems.push(`${field} names no stored memory: ${unknown.map((id) => `"${id}"`).join(", ")}. Use the full ids ${SURFACE_MEMORIES} returned.`);
	}
	const both = changes.edit.filter((item) => changes.delete.includes(item.id)).map((item) => `"${item.id}"`);
	if (both.length > 0) problems.push(`${both.join(", ")} ${both.length === 1 ? "is" : "are"} in both memory.delete and memory.edit. Delete applies first, so never delete and edit the same id.`);
	if (changes.edit.some((item) => item.text.trim() === "")) problems.push("A memory.edit item has empty text. Give the corrected text, or delete the memory instead.");
	const settled = new Set([...changes.helpful.map((vote) => vote.id), ...changes.delete]);
	// A memory another session removed since it was shown cannot be rated, and needs no rating.
	const unrated = shown.filter((id) => !settled.has(id) && rows[id] !== undefined);
	if (unrated.length > 0) {
		problems.push(
			[
				`${unrated.length === 1 ? "1 memory" : `${unrated.length} memories`} surfaced in this session ${unrated.length === 1 ? "is" : "are"} not rated. Rate each in memory.helpful (true if it changed what you did, false if it did not), or remove it with memory.delete:`,
				...unrated.map((id) => `- ${id}: ${rows[id]!.text}`),
			].join("\n"),
		);
	}
	if (problems.length > 0) return { kind: "refused", text: `Report refused:\n${problems.join("\n")}\nThen file the report again.` };
	try {
		return { kind: "apply", changes: await memory.prepare(changes, context.abortSignal) };
	} catch (error) {
		return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
	}
}
