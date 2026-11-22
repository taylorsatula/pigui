// The report tool: the end of a piece of work. It checks the workspace itself instead of trusting the model, refusing
// uncommitted changes and a branch behind its base, then files the report, updates repo memory and notifies.
import { defineTool, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { arr, obj, str } from "@earendil-works/pi-schema";
import type { Report } from "../../shared/session.ts";
import { editSession, RepoMemoryToken } from "../docs.ts";
import { fetchBranch, head, isAncestor, refExists, uncommitted } from "../git.ts";
import { sessionOf } from "./cards.ts";
import type { AgentServices } from "./services.ts";

export const FILE_REPORT = "file_report";

const ReportParameters = obj({
	summary: str({
		minLength: 1,
		maxLength: 4000,
		description:
			"The outcome in a few sentences, read first. Its first line is the notification and the pull request title, so make it one short line saying what changed. Anything unfinished or failing belongs here, not only in notes.",
	}),
	changes: arr(str({ maxLength: 1000 }), { maxItems: 50, description: "The changes, one line each" }),
	verification: str({ maxLength: 4000, description: "The commands you ran and what they showed, and anything you could not verify" }),
	notes: str({
		maxLength: 4000,
		description: "What you could not do, what you are unsure about, decisions the plan did not cover, and problems you noticed but left alone; empty if none",
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
			"File a report after any change to the repository: when the work is done, or when you cannot go further. It ends your turn, and it becomes the pull request's description if the person opens one. Refused while there are uncommitted changes or the branch is behind its base.",
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
			const notes = fetchError === undefined ? args.notes : `${args.notes}${args.notes === "" ? "" : "\n\n"}Could not fetch origin/${session.base} to check the branch is up to date.`;
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
					await services.notifications.enqueue(tx, doc, { key: `report:${api.callId}`, title: "Report ready", body: args.summary.split("\n")[0] ?? "" });
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
