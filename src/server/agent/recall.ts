// recall_history looks past compaction. Everything the model was shown stays in storage even after a summary
// replaces it, so a search over the entries can find a detail the summary dropped.
import type { Context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { type Cursor, defineTool, type EntryRecord, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { int, obj, opt, str } from "@earendil-works/pi-schema";

export const RECALL = "recall_history";

const MATCH_LIMIT = 8;
const SNIPPET_CHARS = 240;
const ENTRY_CHAR_LIMIT = 20_000;

/** The searchable text of one entry: what was said, the calls made with their arguments, and what tools returned. */
export function entryText(entry: EntryRecord): string {
	return messagesText(entry.model ?? []);
}

/** Messages flattened to text the way recall shows them; system messages carry nothing to search for. */
export function messagesText(messages: readonly Message[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role === "system") continue;
		if (message.role === "toolResult") parts.push(`[result of ${message.toolName}]`);
		const blocks = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
		for (const block of blocks) {
			if (block.type === "text") parts.push(block.text);
			else if (block.type === "toolCall") parts.push(`[call ${block.name}] ${JSON.stringify(block.arguments)}`);
		}
	}
	return parts.join("\n");
}

/** Walk the entry history newest-first in pages, stopping when `visit` says enough has been seen. */
async function walkEntries(api: ToolExecutionApi, context: Context, visit: (entry: EntryRecord) => boolean): Promise<void> {
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

/** Fetch one entry by number, or nothing when the session never held it. */
async function findEntry(api: ToolExecutionApi, context: Context, wanted: number): Promise<EntryRecord | undefined> {
	let found: EntryRecord | undefined;
	// Entries descend, so once the number passes the wanted one there is nothing more to look at.
	await walkEntries(api, context, (entry) => {
		if (entry.id === wanted) found = entry;
		return found === undefined && entry.id > wanted;
	});
	return found;
}

/** A window around the first place the leading term appears, flattened so it fits one line of a list. */
function snippetAround(text: string, lower: string, term: string): string {
	const at = lower.indexOf(term);
	const start = Math.max(0, at - SNIPPET_CHARS / 2);
	return text.slice(start, start + SNIPPET_CHARS).replace(/\s+/g, " ");
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
				const entry = await findEntry(api, context, args.entry);
				if (entry === undefined) return { output: [{ type: "text", text: `No entry ${args.entry} in this session.` }], isError: true };
				const text = entryText(entry);
				const shown =
					text.length > ENTRY_CHAR_LIMIT ? `${text.slice(0, ENTRY_CHAR_LIMIT)}\n[… ${text.length - ENTRY_CHAR_LIMIT} more characters]` : text;
				return { output: [{ type: "text", text: `Entry ${entry.id} (${entry.kind}):\n${shown}` }] };
			}
			if (args.query === undefined) throw new Error("Give a query to search for, or an entry number to read.");
			const terms = args.query.toLowerCase().split(/\s+/).filter((term) => term !== "");
			const [first = ""] = terms;
			const matches: string[] = [];
			await walkEntries(api, context, (entry) => {
				const text = entryText(entry);
				const lower = text.toLowerCase();
				if (terms.every((term) => lower.includes(term))) {
					matches.push(`Entry ${entry.id} (${entry.kind}): …${snippetAround(text, lower, first)}…`);
				}
				return matches.length < MATCH_LIMIT;
			});
			const text =
				matches.length === 0
					? `Nothing in this session's history contains all of: ${terms.join(", ")}.`
					: `Newest first. Read one in full with ${RECALL} and its entry number.\n${matches.join("\n")}`;
			return { output: [{ type: "text", text }] };
		},
	});
}
