// file_report is the end of a piece of work. In a repository session the clone is checked rather than trusted:
// uncommitted changes and a branch behind its base are refused until fixed. A local session works in place, with
// nothing to deliver, so nothing is checked. On success the report is filed, repo memory is updated, the person is
// notified, and the run's agents are done being waited on. With long-term memory on, the memory part is recorded and
// rated in the same commit as the report.
import type { Draft } from "@earendil-works/chord/delta";
import { defineTool, type ToolExecutionResult, type Tx } from "@earendil-works/pi-durable";
import { arr, bool, obj, oneOf, type Static, str, unsafe } from "@earendil-works/pi-schema";
import { type Report, reportOf, type RepoSessionDoc, type SessionDoc } from "../../shared/session.ts";
import { editSession, MemoryToken, RepoMemoryToken, repoMemoryKey } from "../documents.ts";
import { fetchBranch, head, isAncestor, refExists, uncommitted } from "../git.ts";
import { applyChanges, type PreparedChanges } from "../memory/store.ts";
import { liveAgentTasks } from "../subagents/extension.ts";
import { sessionOf } from "./cards.ts";
import { MemoryPart, type MemoryOutcome, prepareMemory } from "./memory.ts";
import type { AgentServices } from "./services.ts";

export const FILE_REPORT = "file_report";

const line = (description: string) => str({ minLength: 1, maxLength: 300, description });

// Each part sits beside the plan on the card, so what was asked can be read next to what was done.
const reportParts = {
	headline: str({
		minLength: 1,
		maxLength: 100,
		description: "What changed, in one short line: the notification and the pull request's title. Say so if the work is unfinished.",
	}),
	summary: str({
		maxLength: 1500,
		description: "Anything the person must know first, in one to three sentences; empty if the headline says it all",
	}),
	outcome: oneOf(["complete", "partial", "blocked"], {
		description: "complete: everything asked is done and verified. partial: some of it. blocked: you could not go further without the person.",
	}),
	endState: arr(
		obj({
			criterion: line("One condition of the plan's end state, as the plan stated it"),
			met: bool({ description: "Whether it holds now" }),
			evidence: line("What shows it: a test, a command's output, a behaviour you saw; or why it does not hold"),
		}),
		{ maxItems: 8, description: "Each condition of the approved plan's end state, in order; empty only when there was no plan" },
	),
	changes: arr(
		obj({
			change: line("What changed, as a reviewer would say it"),
			files: arr(str({ minLength: 1, maxLength: 300 }), { maxItems: 30, description: "The repository paths it touched" }),
		}),
		{ maxItems: 30, description: "The changes, one per item, grouped as a reviewer would read them" },
	),
	checks: arr(
		obj({
			command: line("The exact command or check"),
			result: oneOf(["passed", "failed", "not run"]),
			detail: str({ maxLength: 300, description: "What it showed, briefly; for a failure, whether it failed before you started" }),
		}),
		{ maxItems: 15, description: "Every check you ran to verify the work, and any the plan named that you could not run" },
	),
	deviations: arr(line("One departure"), {
		maxItems: 10,
		description: "Where the work departed from the approved plan, and decisions it left open that you made; empty if none",
	}),
	notes: arr(line("One note"), {
		maxItems: 10,
		description: "What you are unsure about, could not do, or noticed and left alone; empty if none",
	}),
	learned: str({
		maxLength: 4000,
		description:
			"Everything a later session needs to build and test this repository on this machine (in a session on this computer, to work on it): commands, setup, pitfalls. Include what you were told under repo memory that is still true; this replaces it.",
	}),
};

const ReportParameters = obj(reportParts);
// The memory part exists only with long-term memory on, so its schema is chosen at registration.
const MemoryReportParameters = obj({ ...reportParts, memory: MemoryPart });

/** The arguments either schema gives: `memory` is present exactly when long-term memory is on. */
type ReportArgs = Static<typeof ReportParameters> & { memory?: Static<typeof MemoryPart> };

const refuse = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text }], isError: true });

/** What the agent is told when it tries to file while agents it started are still working. */
function agentsRefusal(waiting: number): string {
	if (waiting === 1) return "1 agent is still running or queued. Its answer arrives as a message; file the report after it has.";
	return `${waiting} agents are still running or queued. Their answers arrive as messages; file the report after they have.`;
}

export function reportTool(services: AgentServices) {
	return defineTool({
		name: FILE_REPORT,
		description:
			"File a report after any change you make: when the work is done, or when you cannot go further. The person reviews it beside the plan: each end-state condition with its evidence, the changes by file, the checks you ran, and where you departed from the plan. Write each item as one short line. It ends your turn, and it becomes the pull request's description if the person opens one. Refused while agents you started are still running or queued, and in a repository session while there are uncommitted changes or the branch is behind its base.",
		parameters: unsafe<ReportArgs>(services.memory === undefined ? ReportParameters : MemoryReportParameters),
		replay: "safe",
		// Its round runs in call order, so an Agent call before it in the round has dispatched its agent by the time the
		// check below reads the session's agents, and one after it finds the report filed and refuses.
		executionMode: "sequential",
		async execute(args, api, context): Promise<ToolExecutionResult> {
			const session = await sessionOf(api, context);
			// Keyed by the call's task rather than the provider's call ID, which can repeat: a later report must not read as this one.
			const key = `report:${api.taskId}`;
			// This exact call already filed its report before a crash: hand back what was filed, checks and all, unchanged.
			const already = session.notified.includes(key) && session.report !== undefined ? filed(reportOf(session.report)) : undefined;
			if (already !== undefined) return already;
			// These agents may have answers to give; the report waits for them, read from Durable's own task records.
			const waiting = (await api.commit((tx) => liveAgentTasks(tx, api.conversationId), context)).length;
			if (waiting > 0) return refuse(agentsRefusal(waiting));
			const checked = session.place === "repo" ? await checkRepository(services.workspace(session.id), session) : { notes: [] };
			if ("refused" in checked) return refuse(checked.refused);
			const { memory: memoryPart, ...parts } = args;
			const notes = [...parts.notes, ...checked.notes];
			const shown = session.memoryShown ?? [];
			let remembering: MemoryOutcome | undefined;
			if (services.memory !== undefined) {
				remembering = await prepareMemory(services.memory, memoryPart ?? { create: [], helpful: [], edit: [], delete: [] }, shown, context);
				if (remembering.kind === "refused") return refuse(remembering.text);
				if (remembering.kind === "unavailable") {
					// Better a report without memory than no report: the work matters more.
					notes.push(`Memory was not recorded: ${remembering.reason}`);
				}
			}
			const report: Report = { ...parts, notes, ...("commit" in checked ? { commit: checked.commit } : {}), filedAt: services.now() };
			let missing: string[] = [];
			await api.commit(async (tx) => {
				await editSession(tx, api.conversationId, services.now(), async (doc) => {
					// This exact call already filed before a crash.
					if (doc.notified.includes(key)) return;
					if (remembering?.kind === "apply") missing = await applyRemembering(tx, doc, remembering.changes, shown, report);
					doc.report = report;
					doc.workflow = "reported";
					doc.outcome = { kind: "reported", at: report.filedAt };
					doc.attentionAt = report.filedAt;
					if (args.learned.trim() !== "") {
						const memory = await tx.doc(RepoMemoryToken, repoMemoryKey(doc), null);
						memory.notes = args.learned.trim();
						memory.updatedAt = report.filedAt;
					}
					await services.notifications.enqueue(tx, doc, { key, title: "Report ready", body: args.headline });
				});
			}, context);
			return filed(report, missing);
		},
	});
}

/**
 * Apply the report's memory part inside its commit, and settle what this session was shown: memories the report
 * answered for are answered for. Memories a failed embedding left behind stay to be rated, as would any a same-round
 * search showed after this call read the session. Answers with the ids that matched nothing and were not rated.
 */
async function applyRemembering(tx: Tx, doc: Draft<SessionDoc>, changes: PreparedChanges, shown: readonly string[], report: Report): Promise<string[]> {
	const applied = applyChanges(await tx.doc(MemoryToken), changes, String(doc.id), report.filedAt);
	if (applied.done !== undefined) report.memory = applied.done;
	const remaining = (doc.memoryShown ?? []).filter((id) => !shown.includes(id));
	if (remaining.length > 0) doc.memoryShown = remaining;
	else delete doc.memoryShown;
	return applied.missing;
}

/**
 * What a repository's clone must show before its report is filed: everything committed, and the branch not behind its
 * base. Answers with its HEAD, and a note when the base could not be fetched to check.
 */
async function checkRepository(workspace: string, session: Readonly<RepoSessionDoc>): Promise<{ refused: string } | { commit: string; notes: string[] }> {
	const dirty = await uncommitted(workspace);
	if (dirty.length > 0) {
		const listed = dirty.slice(0, 20).map((path) => `- ${path}`).join("\n");
		const changes = dirty.length === 1 ? "1 uncommitted change" : `${dirty.length} uncommitted changes`;
		return { refused: `Report refused: ${changes}:\n${listed}\nCommit what belongs in the work, remove what does not, then file the report again.` };
	}
	const fetchError = await fetchBranch(workspace, session.base);
	const baseRef = `refs/remotes/origin/${session.base}`;
	if ((await refExists(workspace, baseRef)) && !(await isAncestor(workspace, baseRef, "HEAD"))) {
		return {
			refused: `Report refused: ${session.branch} is behind origin/${session.base}. Merge it (git merge origin/${session.base}), resolve any conflicts, run the tests again, commit, then file the report.`,
		};
	}
	return { commit: await head(workspace), notes: fetchError === undefined ? [] : [`Could not fetch origin/${session.base} to check the branch is up to date.`] };
}

function filed(report: Report, missing: string[] = []): ToolExecutionResult {
	const lines = ["Report filed. The person will review it and choose to push the branch, open a pull request, or ask for more."];
	if (missing.length > 0) {
		lines.push(`These memory ids matched nothing and were not rated: ${missing.join(", ")}.`);
		lines.push("They may have been from an earlier session and since deleted. Nothing else failed.");
	}
	const text = lines.join("\n");
	return {
		output: [{ type: "text", text }],
		details: { report },
		control: { terminate: true },
	};
}
