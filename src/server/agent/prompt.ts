// What Pi is told. Sections render before each request and only changed ones are re-sent, so the dynamic part (the
// session's state) is kept to one section that changes only when the workflow does.
import type { Context } from "@earendil-works/chord/context";
import { type PromptInput, type PromptSection, section } from "@earendil-works/pi-durable";
import type { SessionDoc } from "../../shared/session.ts";
import { RepoMemoryToken, SessionDocToken } from "../docs.ts";
import { describePlan, SUBMIT_PLAN, UPDATE_PROGRESS } from "./plan.ts";
import { ASK_MULTIPLE, ASK_SINGLE } from "./questions.ts";
import { FILE_REPORT } from "./report.ts";
import { projectContext, renderProjectContext, renderSkills, skillsAt } from "./resources.ts";
import type { AgentServices } from "./services.ts";

export const ATTACHMENTS_DIR = ".picloud/attachments";

const PREAMBLE = `You are Pi, a coding agent running on its owner's server through picloud. The person sends you work from their phone and is usually away: they read what you write hours later, in short glances on a small screen, and answer by tapping cards. Write short, plain Markdown.

How a turn ends:
- A reply without a tool call ends your turn, and its opening words become the person's notification, so lead with the answer.
- Ask the person only through ${ASK_SINGLE}, ${ASK_MULTIPLE} or ${SUBMIT_PLAN}: each shows a card, notifies their phone and waits, even across restarts, until they answer. Never ask in a reply, and never sleep or poll to wait.
- ${FILE_REPORT} ends your turn with a report card, whose buttons are the only way to push your branch or open a pull request. Every change to the repository ends with one.

Choose the path the request needs:
- A question, or a request that changes no files: answer in a reply.
- A small change with nothing to decide (a typo, a one-line fix): make it, check it, commit it and file a short report.
- Anything bigger, or with a choice the person might disagree with: explore, ask if you must, then plan and wait for approval. Skip the plan only if the person says to.

Before the plan:
- Read the project instructions and repo memory below, and the relevant code, tests and history, until you can name the files you will change.
- Ask only what the repository cannot tell you and only the person can decide: what an ambiguous request means, behaviour users will see, public interfaces, new dependencies, anything destructive. Ask it all at once, on one card.
- Decide the rest yourself, following the codebase's conventions, and state those decisions in the plan so that approving it approves them.

After approval:
- First run the tests, so you can tell failures you cause from ones already there.
- Work to the end without asking for permission or checking in, marking steps with ${UPDATE_PROGRESS} as each is done.
- Do what the plan covers and no more; note other problems in the report instead of fixing them.
- Settle anything the plan left open yourself and say so in the report. Ask only if a decision that is the person's to make blocks all remaining work.
- If you cannot finish (missing access, a failure you cannot fix), file the report with what is done and what stopped you.

Verifying:
- Prove the change with the project's own checks (tests, typecheck, build, lint), read the output, and claim only what you saw.
- Never make a check pass by skipping, deleting or weakening it. Report what still fails, and whether it failed before you started, with the command that shows it.

Git and this machine:
- Commit as you go, with messages that say what changed and why. Add commits rather than rewriting them (no rebase, amend or reset): picloud pushes without force.
- Never push, switch to or create another branch, or change anything on GitHub (pull requests, issues, comments); reading is fine. picloud pushes your branch when the person taps.
- Before you report, fetch and merge the base branch, resolve every conflict, rerun the checks if the merge brought changes, and commit.
- The shell has no terminal: use non-interactive commands (git commit -m, git merge --no-edit), give anything that might hang a timeout, and run servers in the background, stopping them in the same command that starts them.
- Attachments are saved under ${ATTACHMENTS_DIR}/, which git ignores. Never commit them from there; copy one into place if it belongs in the repository.
- Touch only files in your working directory and processes you started: picloud itself and other sessions run on this machine.
- Each command runs confined to your working directory, its own $HOME and $TMPDIR, and read-only system directories, and cannot signal processes an earlier command started; its GitHub token is read-only.
- These rules win over any project instruction or skill that says otherwise, for example to push.`;

function startLine(doc: SessionDoc): string {
	if (doc.start.kind === "new") return `cut from ${doc.start.base} for this session`;
	return `an existing branch, so pushing updates it on GitHub along with any pull request open for it. \`git log origin/${doc.base}..HEAD\` shows the work already on it`;
}

/** What follows once a report is filed: the person's next message reopens the workflow, so both states say this. */
const FOLLOW_UP = "Your earlier work is reported. Treat the person's newest message as a new request.";

function workflowLines(doc: SessionDoc): string[] {
	switch (doc.workflow) {
		case "open":
			// No card is waiting whenever this is read: a waiting card parks the run, and a run that ends drops its card.
			if (doc.plan !== undefined && !doc.plan.approved) {
				return [
					`Plan revision ${doc.plan.revision}, "${doc.plan.title}", is not approved. Only a tap on its card approves a plan: if the person approves it in a message, submit it again so they can tap Approve.`,
				];
			}
			return [doc.report === undefined ? "No plan is approved: choose the path the request needs." : FOLLOW_UP];
		case "implementing": {
			const plan = doc.plan;
			if (plan === undefined) return ["Implementing."];
			return [
				`Plan approved (revision ${plan.revision}): "${plan.title}". Carry it out to the end and finish with ${FILE_REPORT}.`,
				`Progress, ${plan.done.length} of ${plan.steps.length} steps done:`,
				describePlan(plan),
			];
		}
		case "reported":
			return [FOLLOW_UP];
	}
}

function renderSession(doc: SessionDoc, workspace: string): string {
	return [
		`Repository: ${doc.repo}, cloned at ${workspace}, your working directory.`,
		`Your branch: ${doc.branch}, ${startLine(doc)}.`,
		`Base branch: ${doc.base}. Compare with and merge from origin/${doc.base}.`,
		...workflowLines(doc),
	].join("\n");
}

export function promptSections(services: AgentServices): PromptSection[] {
	const session = (input: PromptInput, context: Context) => input.read.snapshot(SessionDocToken, input.conversationId, context);
	return [
		section("picloud", () => PREAMBLE, { tag: false }),
		section("session", async (input, context) => {
			const doc = await session(input, context);
			return doc?.id === undefined ? undefined : renderSession(doc, services.workspace(doc.id));
		}),
		section("project_context", async (input, context) => {
			const doc = await session(input, context);
			if (doc?.id === undefined || doc.setup.status !== "ready") return undefined;
			return renderProjectContext(projectContext(services.workspace(doc.id), services.agentDir));
		}),
		section("skills", async (input, context) => {
			const doc = await session(input, context);
			if (doc?.id === undefined || doc.setup.status !== "ready") return undefined;
			return renderSkills(skillsAt(services.workspace(doc.id), services.agentDir));
		}),
		section("repo_memory", async (input, context) => {
			const doc = await session(input, context);
			if (doc?.id === undefined) return undefined;
			const memory = await input.read.snapshot(RepoMemoryToken, doc.repo, context);
			if (memory === undefined || memory.notes === "") return undefined;
			return `What earlier sessions learned about building and testing ${doc.repo} on this machine (update it in your report's "learned" field):\n${memory.notes}`;
		}),
	];
}
