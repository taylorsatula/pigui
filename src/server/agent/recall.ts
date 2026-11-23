// History recall: compaction drops old context from what the model sees, but every entry stays in storage. This tool
// searches and reads that full history, so a detail lost to a summary can be found again.
import type { Context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { type Cursor, defineTool, type EntryRecord, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { int, obj, opt, str } from "@earendil-works/pi-schema";

export const RECALL = "recall_history";

const MAX_MATCHES = 8;
const SNIPPET = 240;
const MAX_ENTRY_TEXT = 20_000;

/** The searchable text of one entry: what was said, the calls made with their arguments, and what tools returned. */
export function entryText(entry: EntryRecord): string {
	return messagesText(entry.model ?? []);
}

/** Messages as text, the way recall shows an entry; system messages are left out. */
export function messagesText(messages: readonly Message[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role === "system") continue;
		if (message.role === "toolResult") parts.push(`[result of ${message.toolName}]`);
		const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
		for (const block of content) {
			if (block.type === "text") parts.push(block.text);
			else if (block.type === "toolCall") parts.push(`[call ${block.name}] ${JSON.stringify(block.arguments)}`);
		}
	}
	return parts.join("\n");
}

async function scanHistory(api: ToolExecutionApi, context: Context, visit: (entry: EntryRecord) => boolean): Promise<void> {
	let cursor: Cursor | undefined;
	do {
		const page = await api.commit(
			(tx) => tx.scanEntries({ conversationId: api.conversationId, order: "descending" }, 200, cursor),
			context,
		);
		for (const entry of page.items) if (!visit(entry)) return;
		cursor = page.next;
	} while (cursor !== undefined);
}

export function recallTool() {
	return defineTool({
		name: RECALL,
		description:
			"Search or read this session's full history, including everything from before a compaction. Give `query` (words that must all appear, such as a file name, an error message or a number) to find entries, or `entry` (an entry number from a search or a compaction checkpoint) to read one in full.",
		parameters: obj({
			query: opt(str({ minLength: 1, maxLength: 500 })),
			entry: opt(int({ minimum: 1 })),
		}),
		replay: "safe",
		async execute(args, api, context): Promise<ToolExecutionResult> {
			if (args.entry !== undefined) {
				const wanted = args.entry;
				let found: EntryRecord | undefined;
				await scanHistory(api, context, (entry) => {
					if (entry.id === wanted) found = entry;
					return found === undefined && entry.id > wanted;
				});
				if (found === undefined) return { output: [{ type: "text", text: `No entry ${wanted} in this session.` }], isError: true };
				const text = entryText(found);
				const shown = text.length > MAX_ENTRY_TEXT ? `${text.slice(0, MAX_ENTRY_TEXT)}\n[… ${text.length - MAX_ENTRY_TEXT} more characters]` : text;
				return { output: [{ type: "text", text: `Entry ${found.id} (${found.kind}):\n${shown}` }] };
			}
			if (args.query === undefined) throw new Error("Give a query to search for, or an entry number to read.");
			const terms = args.query.toLowerCase().split(/\s+/).filter((term) => term !== "");
			const matches: string[] = [];
			await scanHistory(api, context, (entry) => {
				const text = entryText(entry);
				const lower = text.toLowerCase();
				if (terms.every((term) => lower.includes(term))) {
					const at = lower.indexOf(terms[0] ?? "");
					const start = Math.max(0, at - SNIPPET / 2);
					const snippet = text.slice(start, start + SNIPPET).replace(/\s+/g, " ");
					matches.push(`Entry ${entry.id} (${entry.kind}): …${snippet}…`);
				}
				return matches.length < MAX_MATCHES;
			});
			const text =
				matches.length === 0
					? `Nothing in this session's history contains all of: ${terms.join(", ")}.`
					: `Newest first. Read one in full with ${RECALL} and its entry number.\n${matches.join("\n")}`;
			return { output: [{ type: "text", text }] };
		},
	});
}
