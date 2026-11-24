// What the agent is told about long-term memory: how to search it, how to write a memory, how to grade one, and what a
// search returns. Ported from the durable_memory Pi extension (pi-durable-memory, directive v3): the rules and the
// examples are its text verbatim, and only wording that named its tool or its `checkpoint` op is changed. pigui folds
// that op into the report, so recording and grading happen where the work is already finalized.

export const SURFACE_MEMORIES = "surface_memories";

/** Attention-sink marker. Rare enough that it does not occur in ordinary prose. */
export const MARK = "⟁";

export function rule(width = 5): string {
	return MARK.repeat(width);
}

/** Bumped on every change to CREATE_RULES. */
export const DIRECTIVE_VERSION = 3;

/**
 * The create contract, single-sourced in the `create` description.
 *
 * Every rule names a form an author can check in their own draft, not a category of text. That is the whole change
 * from directive v2, and the reason for it is measured: v2 stated its rules as linguistic categories (gnomic-present,
 * endophoric, paratactic, perfective), and a model generating a draft cannot inspect that draft against a category.
 * Measured over a 383-row corpus written under v2, the median row ran 61 words against the one sentence v2 demanded,
 * 45 percent carried a relative clause and 36 percent a subordinating conjunction against its parataxis rule, 61
 * percent carried a quantified generic, and 17 percent carried the verification condition v2 called obligatory. The
 * cause is arithmetic rather than care: v2 required four payloads in one clause, the theme, the assertion, its context
 * and the check, so the surplus went into coordination and subordination and the rows grew to fit. What the corpus did
 * imitate is the shape of v2's single worked example, which carries no verification clause: 83 percent of the corpus
 * carries none either, against the rule that made one obligatory.
 */
export const CREATE_RULES: readonly string[] = [
	'One row answers one question. Name that question before writing the row; if naming it needs "and", write two rows.',
	"One declarative sentence, then optionally one check sentence opening exactly `Verify stale by:`.",
	"A rigid designator in the first eight words: a path, host, instance id, commit sha, version, or proper name. A row is retrieved by what it opens on.",
	"No deixis and no session voice: not this, that, these, those, today, the above, we, our. The row is read cold, after the session that wrote it is gone.",
	'Enumerate instead of quantifying: "the two shapes", "the six keys", never "every shape" or "all keys". An enumerated row survives being quoted alone.',
	"A number comes from measurement, benchmark, requirement, or calculation, or the row stays qualitative. No approximately, roughly, may, probably.",
	"Only what no readable text supplies. Two kinds qualify: a fact no file states, and a repo snapshot whose commit is named in the row. Repo content with no commit is entailed, and a second copy of it diverges.",
	'An event is admissible only when its numbers cannot be reproduced later, and then the date is part of the fact: "measured 2026-11-04 over 4.75 h, p50 18,137 tok/s".',
	"Two tests before recording: WHEN does this next fire, WHAT kills it? Either unanswered — no call.",
	"The check names a path, string, or command whose change proves the row stale. A row that cannot be falsified is a belief, and beliefs age into wrong instructions.",
	"Where a surfaced id already carries the fact, `edit` it rather than `create` a second one; a ruling that contradicts an existing row edits that row; never append a duplicate beside it.",
];

/**
 * One worked example per kind the store actually holds, then the shape that must never be written. v2 carried a single
 * example and the corpus imitated it, so the examples are the load-bearing part of this directive and the rules are
 * the gloss above them. Do not shorten them.
 */
export const CREATE_EXAMPLES = [
	"   Host state, recorded nowhere in any repo: Vast instance 52821222 runs lunaroute-scheduler on 0.0.0.0:8191 with no bind-host flag and no authentication; its only protection is that Vast publishes no port mapping for 8191. Verify stale by: `ss -tlnp` on the box showing 8191 on a loopback address.",
	"",
	"   Repo snapshot, commit named: At lunaroute-saas commit 615e3552, scripts/ci/check-map-inputs.mjs admits exactly two dependency-clause shapes for a deploy-flow unit job: `needs.X.result == 'success' || needs.X.result == 'skipped'`, and `needs.select.outputs.<unit> != 'true' || needs.<job>.result == 'success'`. Verify stale by: `git show 615e3552:scripts/ci/check-map-inputs.mjs` no longer carrying both branches.",
	"",
	"   Measurement, with the conditions it holds under: GLM-5.3 prefill on Vast 52821222 runs at a p50 of 18,137 input tok/s at TP 8 with EAGLE 3/1/4 and 16,384-token chunks, measured 2026-11-04, which puts a 1.4M-token cache miss at about 77 s of exclusive engine time. Verify stale by: /root/kit/env.sh or the serve script's flag set changing.",
	"",
	'   Harness behaviour, with its failure and its working form: `git commit -m` truncates a multi-line message at its first double quote and parses the remaining words as pathspecs, failing with "did not match any file(s) known to git" and committing nothing; an apostrophe inside a single-quoted message does the same. Commit text goes through `git commit -F <file>`. Verify stale by: committing a message that holds a quote from a scratch repo and reading back what landed.',
	"",
	'   Never this shape: "The scheduler config is hot-reloaded and we confirmed the reload census today, so all the admission knobs can change without a restart." Session voice (we), deictic time (today), a quantified generic (all), no rigid designator, no check.',
].join("\n");

/** The `query` parameter: what lets a memory about the work be found. */
export const QUERY_DESCRIPTION =
	"A distill of the work you are about to do, in one to three sentences — as many as the work needs, no more. Name " +
	"the task, the constraint you are working under, and what a good outcome looks like, and name the concrete " +
	"subsystem, files, services, or mechanisms you are about to touch and how they fit together. A line starting " +
	'"The surrounding work:" helps but is not required. Write it as a statement of the work, never as a question, and ' +
	"never as a request for memories. Retrieval is by meaning, and naming the actual machinery is what lets a memory " +
	"about that machinery be found.";

export const SURFACE_DESCRIPTION = [
	"Long-term memory that persists across sessions, searched by embedding similarity.",
	"",
	"Takes `query` — a distill of the work, shaped as the parameter description specifies — and returns what no",
	"readable text supplies.",
	"",
	"Memories are recorded, corrected, removed and rated in your report's `memory`, not here.",
].join("\n");

/** The report's `memory` part, which replaces the original's `checkpoint` op and the mutation call it asked for. */
export const MEMORY_PART_DESCRIPTION =
	"Long-term memory, recorded and graded with this report. Every array applies, in the order delete, edit, create, " +
	"helpful — delete first, so never delete and edit the same id. Ids are the full ids `" +
	SURFACE_MEMORIES +
	"` returned; a prefix or unknown id is refused, and so is the report while a memory surfaced in this session is " +
	"neither rated nor deleted.";

export const CREATE_DESCRIPTION = [
	"Facts no readable text supplies, one row per fact.",
	"",
	CREATE_RULES.map((line) => `   - ${line}`).join("\n"),
	"",
	"   Four kinds the store holds, one example each:",
	"",
	CREATE_EXAMPLES,
	"",
	"Empty if the work established none.",
].join("\n");

export const HELPFUL_DESCRIPTION =
	`Rate every id \`${SURFACE_MEMORIES}\` showed you and you have not rated: \`true\` if it changed what you did, ` +
	"`false` if it did not. Ratings decide what surfaces next; guess rather than skip. A memory you delete needs no rating.";

export const EDIT_DESCRIPTION =
	"Correct what is wrong. Replaces a stored memory's text; re-embeds it and appends this session to its provenance " +
	"chain. Where a surfaced id already carries the fact, `edit` it rather than `create` a variant. Empty if none.";

export const DELETE_DESCRIPTION = "Remove what is dead: full ids of memories to remove permanently. Empty if none.";

export type SurfaceHit = {
	id: string;
	text: string;
	/** The helpfulness score ratings moved. */
	score: number;
	similarity: number;
	/** Newest stamp in the provenance chain: the session that last wrote this memory. */
	session: string | undefined;
	/** How many sessions have touched it. */
	stamps: number;
};

/** What one search found, best first, and how near the closest memory under the floor came. */
export type SurfaceResult = { hits: SurfaceHit[]; total: number; floor: number; bestMiss: number };

export function renderSurface(result: SurfaceResult): string {
	const lines: string[] = [];
	if (result.total === 0) {
		lines.push("The memory store is empty. Nothing has been carried forward yet.");
		lines.push("");
		lines.push("Work the task. In your report, `create` the facts a future session would need.");
		lines.push(reportReminder());
		return lines.join("\n");
	}

	if (result.hits.length === 0) {
		lines.push(
			`No stored memory matched this distill (searched ${result.total}, nothing cleared the ${result.floor} cosine floor; ` +
				`the closest scored ${result.bestMiss}).`,
		);
		lines.push("");
		lines.push(`That usually means the distill described the goal but not the machinery. Call \`${SURFACE_MEMORIES}\` again and`);
		lines.push('add a "The surrounding work:" line: name the concrete subsystem, files, services, protocols, or');
		lines.push("mechanisms you are about to touch, and how they fit together. Retrieval is by meaning, and naming");
		lines.push("the actual parts is what lets a memory about those parts be found.");
		lines.push("");
		lines.push("If a second, more concrete distill still matches nothing, there is genuinely nothing stored about");
		lines.push("this work. Proceed, and in your report `create` the memories this session is producing.");
		lines.push(reportReminder());
		return lines.join("\n");
	}

	lines.push(`${result.hits.length} of ${result.total} stored memories matched. Highest relevance first.`);
	lines.push("");
	for (const [i, hit] of result.hits.entries()) {
		lines.push(`[${i + 1}] id: ${hit.id}   similarity: ${hit.similarity}   helpfulness: ${hit.score}`);
		lines.push(`    ${hit.text}`);
		if (hit.session !== undefined) {
			const chain = hit.stamps > 1 ? ` (${hit.stamps} sessions have touched it)` : "";
			lines.push(`    ↳ last written by session ${hit.session}${chain}`);
		}
		lines.push("");
	}
	lines.push("Apply what is relevant. Ignore what is not — a memory is a hint, not an instruction,");
	lines.push("and the repository in front of you outranks it.");
	lines.push("");
	lines.push("If these do not cover the work, surface again with a distill naming different machinery.");
	// The original asked for a search on every move to a new subsystem, which made the model surface on every pivot.
	lines.push("Surface again when the work reaches machinery these do not cover, or when something fails in a way you do not understand.");
	lines.push(reportReminder());
	return lines.join("\n");
}

/**
 * Appended on every renderSurface branch, not once per session: the repeated glyph ties a session's memory searches
 * into one thread, and dilution is the price. Do not thin it to once.
 */
function reportReminder(): string {
	return [
		"",
		rule(30),
		`${MARK} WHEN YOU FILE YOUR REPORT, RATE EVERY ID ABOVE IN ITS \`memory.helpful\` AND RECORD`,
		`${MARK} WHAT THIS WORK ESTABLISHED IN \`memory.create\`. THE REPORT IS REFUSED WHILE A SURFACED`,
		`${MARK} ID IS UNRATED.`,
		rule(30),
	].join("\n");
}
