// The report tool: the end of a piece of work. It checks the workspace itself instead of trusting the model, refusing
// uncommitted changes and a branch behind its base, then files the report, updates repo memory and notifies.
import { defineTool, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { arr, bool, obj, oneOf, str } from "@earendil-works/pi-schema";
import type { Report } from "../../shared/session.ts";
import { editSession, RepoMemoryToken } from "../docs.ts";
import { fetchBranch, head, isAncestor, refExists, uncommitted } from "../git.ts";
import { sessionOf } from "./cards.ts";
import type { AgentServices } from "./services.ts";

export const FILE_REPORT = "file_report";

const line = (description: string) => str({ minLength: 1, maxLength: 300, description });

// Set against the plan, part by part, so the card can show what was asked beside what was done.
const ReportParameters = obj({
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
			"Everything a later session needs to build and test this repository on this machine: commands, setup, pitfalls. Include what you were told under repo memory that is still true; this replaces it.",
	}),
});

const refuse = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text }], isError: true });

export function reportTool(services: AgentServices) {
	return defineTool({
		name: FILE_REPORT,
		description:
			"File a report after any change to the repository: when the work is done, or when you cannot go further. The person reviews it beside the plan: each end-state condition with its evidence, the changes by file, the checks you ran, and where you departed from the plan. Write each item as one short line. It ends your turn, and it becomes the pull request's description if the person opens one. Refused while there are uncommitted changes or the branch is behind its base.",
		parameters: ReportParameters,
		replay: "safe",
		async execute(args, api, context): Promise<ToolExecutionResult> {
			const session = await sessionOf(api, context);
			const workspace = services.workspace(session.id);
			const dirty = await uncommitted(workspace);
			if (dirty.length > 0) {
				const listed = dirty.slice(0, 20).map((path) => `- ${path}`).join("\n");
				return refuse(
					`Report refused: ${dirty.length} uncommitted change${dirty.length === 1 ? "" : "s"}:\n${listed}\nCommit what belongs in the work, remove what does not, then file the report again.`,
				);
			}
			const fetchError = await fetchBranch(workspace, session.base);
			const baseRef = `refs/remotes/origin/${session.base}`;
			if ((await refExists(workspace, baseRef)) && !(await isAncestor(workspace, baseRef, "HEAD"))) {
				return refuse(
					`Report refused: ${session.branch} is behind origin/${session.base}. Merge it (git merge origin/${session.base}), resolve any conflicts, run the tests again, commit, then file the report.`,
				);
			}
			const notes = fetchError === undefined ? args.notes : [...args.notes, `Could not fetch origin/${session.base} to check the branch is up to date.`];
			const commit = await head(workspace);
			const report: Report = { ...args, notes, commit, filedAt: services.now() };
			await api.commit(async (tx) => {
				await editSession(tx, api.conversationId, services.now(), async (doc) => {
					// A rerun of this call after a crash: the report is already filed.
					if (doc.notified.includes(`report:${api.callId}`)) return;
					doc.report = report;
					doc.workflow = "reported";
					doc.outcome = { kind: "reported", at: report.filedAt };
					doc.attentionAt = report.filedAt;
					if (args.learned.trim() !== "") {
						const memory = await tx.doc(RepoMemoryToken, doc.repo, null);
						memory.notes = args.learned.trim();
						memory.updatedAt = report.filedAt;
					}
					await services.notifications.enqueue(tx, doc, { key: `report:${api.callId}`, title: "Report ready", body: args.headline });
				});
			}, context);
			return {
				output: [{ type: "text", text: "Report filed. The person will review it and choose to push the branch, open a pull request, or ask for more." }],
				details: { report },
				control: { terminate: true },
			};
		},
	});
}
