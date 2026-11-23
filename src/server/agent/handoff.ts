// The handoff note: before pigui compacts the context, it asks the agent, in a steer, for a short first-person note
// on where it stands, and the agent writes it with this tool. The call and its result stay in the context verbatim after
// the compaction, right before the resume turn, so the agent reads its own words first; the summarizer reads them too.
import { defineTool, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";

export const WRITE_HANDOFF = "write_handoff";

/** About 300 words. */
const MAX_HANDOFF_CHARS = 2000;

export const HANDOFF_REQUEST =
	"Your context window is about to be compacted. Call write_handoff now with a short first-person note on how you are doing right now: what you are doing and where you are, what you just learned or decided, your exact next step and why, and anything you are unsure of or watching for. Make no other tool call this turn.";

export const RESUME = "The context window has just been compacted. Please resume with what you were doing.";

export function handoffTool() {
	return defineTool({
		name: WRITE_HANDOFF,
		description:
			"Only when pigui asks for it, just before your context is compacted: save a short first-person note on how you are doing right now. It stays in your context after the compaction.",
		parameters: obj({
			text: str({
				minLength: 1,
				maxLength: MAX_HANDOFF_CHARS,
				description: "About 300 words at most: what you are doing and where you are, what you just learned or decided, your exact next step and why, and what you are unsure of or watching for",
			}),
		}),
		replay: "safe",
		execute: async (): Promise<ToolExecutionResult> => ({ output: [{ type: "text", text: "Saved" }] }),
	});
}
