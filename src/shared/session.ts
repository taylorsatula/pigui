// The shapes of pigui's own Durable documents. The server writes them in commits; the phone receives them through
// watches and applies Chord operations to them, so both sides read exactly these types.
//
// The shapes are split into sections: where the session works, how far its setup is, the plan-first workflow's cards,
// the report, the agents it started, what the person said, the transcript entries pigui places, and finally the
// session document itself and its drawer projection.

/** How a session's working branch was chosen. */
export type SessionStart =
	/** A new branch cut from `base`. */
	| { kind: "new"; base: string }
	/** An existing branch; pushes update it and any pull request open for it. */
	| { kind: "continue"; branch: string };

export type SetupStep = "clone" | "branch" | "start";

export type SetupState =
	| { status: "preparing"; step: SetupStep }
	| { status: "ready" }
	| { status: "failed"; step: SetupStep; error: string };

/**
 * Where the session is in the plan-first workflow. `open` is ordinary interaction (questions, answers, small requests,
 * planning); `implementing` starts when a plan is approved and ends when a report is filed.
 */
export type Workflow = "open" | "implementing" | "reported";

// --- Cards: questions and plans -----------------------------------------------------------------------------------

export type ChoiceOption = {
	id: string;
	label: string;
	description?: string;
};

export type Question = {
	id: string;
	prompt: string;
	options: ChoiceOption[];
	/** Single-choice questions only: the option Pi recommends. */
	recommended?: string;
	multiple: boolean;
};

export type QuestionCard = {
	kind: "questions";
	/** The tool call ID; stable across reruns of the call, so it also keys the card's notification. */
	id: string;
	/** The parked tool task the answer is signalled to. */
	taskId: number;
	questions: Question[];
	createdAt: number;
};

/** A choice the agent made instead of asking. Approving the plan approves it. */
export type PlanDecision = { choice: string; reason: string };

/** What a plan rests on: a repository path (`path`, `path:line` or `path:start-end`) or a URL, and what it shows. */
export type Citation = { ref: string; note: string };

export type PlanStep = {
	id: string;
	text: string;
	/** The repository paths the step creates or changes. */
	files: string[];
};

/**
 * A plan, as the agent submits it with submit_plan. Every part is required, and lists may be empty only where the
 * tool's description allows, so each part of a good plan is stated out loud. A new part goes here, in the tool's
 * parameters, in the card, and in what the agent is told while implementing.
 */
export type Plan = {
	title: string;
	/** What changes and why, in one to three sentences. */
	goal: string;
	/** Done when: conditions a reviewer could check. */
	endState: string[];
	decisions: PlanDecision[];
	steps: PlanStep[];
	/** How the work will be proved: the commands and tests to run. */
	verification: string[];
	outOfScope: string[];
	risks: string[];
	citations: Citation[];
};

/** A plan filed before plans were structured: a summary paragraph and steps without files. */
export type LegacyPlan = { title: string; summary: string; steps: { id: string; text: string }[] };

/** A plan as stored: sessions from before plans were structured may hold the older shape. */
export type StoredPlan = Plan | LegacyPlan;

/** Any stored plan in the current shape, the older one read as a goal and steps with nothing else stated. */
export function planOf(plan: StoredPlan): Plan {
	if ("goal" in plan) return plan;
	return {
		title: plan.title,
		goal: plan.summary,
		endState: [],
		decisions: [],
		steps: plan.steps.map((step) => ({ ...step, files: [] })),
		verification: [],
		outOfScope: [],
		risks: [],
		citations: [],
	};
}

export type PlanCard = {
	kind: "plan";
	id: string;
	taskId: number;
	plan: StoredPlan;
	/** 1 for the first proposal, then one more per revision. */
	revision: number;
	createdAt: number;
};

export type PendingCard = QuestionCard | PlanCard;

export type QuestionAnswer = {
	questionId: string;
	/** Option IDs. */
	selected: string[];
	/** Free text instead of, or in addition to, the options. */
	text?: string;
};

/** What the person gave a card; signalled to the parked tool and kept verbatim for compaction checkpoints. */
export type CardAnswer =
	| { kind: "questions"; answers: QuestionAnswer[] }
	/** Typed into the composer while a card waits: one reply for the whole card. */
	| { kind: "text"; text: string }
	| { kind: "approve" }
	| { kind: "revise"; feedback: string };

export type PlanState = StoredPlan & {
	revision: number;
	approved: boolean;
	/** Step IDs Pi marked complete. */
	done: string[];
};

// --- Reports -------------------------------------------------------------------------------------------------------

/** How far the work got against what was asked: all of it, some of it, or none for a reason the person must clear. */
export type ReportOutcome = "complete" | "partial" | "blocked";

/** One condition of the plan's end state, restated, with whether it now holds and what shows it. */
export type EndStateCheck = { criterion: string; met: boolean; evidence: string };

export type ReportChange = { change: string; files: string[] };

/** A check the agent ran, as the exact command, and what it showed. */
export type ReportCheck = { command: string; result: "passed" | "failed" | "not run"; detail: string };

/** A memory as the report recorded it: its id in long-term memory and its text. */
export type RememberedMemory = { id: string; text: string };

/** What a report did to long-term memory: the memories it recorded and corrected, those it removed, and its ratings. */
export type ReportMemory = {
	created: RememberedMemory[];
	edited: RememberedMemory[];
	deleted: string[];
	/** Surfaced memories rated as having changed what the agent did, and as not. */
	helpful: number;
	unhelpful: number;
};

/**
 * A report, as the agent files it with file_report, set against the plan: each end-state condition with its evidence,
 * the changes by file, the checks run, and where the work departed from the plan. A new part goes here, in the tool's
 * parameters, in the card and in the pull request's description.
 */
export type Report = {
	/** One line: the notification and the pull request's title. */
	headline: string;
	summary: string;
	outcome: ReportOutcome;
	endState: EndStateCheck[];
	changes: ReportChange[];
	checks: ReportCheck[];
	/** Where the work departed from the plan, and decisions the plan left open. */
	deviations: string[];
	/** What the agent is unsure of, could not do, or noticed and left alone. */
	notes: string[];
	learned: string;
	/** Absent when long-term memory was off, or the report changed and rated nothing in it. */
	memory?: ReportMemory;
	/** HEAD when the report was filed; absent in a local session, whose directory need not be a repository. */
	commit?: string;
	filedAt: number;
};

/** A report filed before reports were structured: prose fields and changes as plain lines. */
export type LegacyReport = {
	summary: string;
	changes: string[];
	verification: string;
	notes: string;
	learned: string;
	commit: string;
	filedAt: number;
};

/** A report as stored: sessions from before reports were structured may hold the older shape. */
export type StoredReport = Report | LegacyReport;

/**
 * Any stored report in the current shape. The older one's verification prose has no commands to show, so it reads as
 * a note; its first line becomes the headline because it is all it had one for.
 */
export function reportOf(report: StoredReport): Report {
	if ("headline" in report) return report;
	const [headline = "", ...rest] = report.summary.split("\n");
	return {
		headline,
		summary: rest.join("\n").trim(),
		outcome: "complete",
		endState: [],
		changes: report.changes.map((change) => ({ change, files: [] })),
		checks: [],
		deviations: [],
		notes: [report.verification, report.notes].map((text) => text.trim()).filter((text) => text !== ""),
		learned: report.learned,
		commit: report.commit,
		filedAt: report.filedAt,
	};
}

export type PullRequestRef = {
	number: number;
	url: string;
};

export type Delivery = {
	pushed?: { commit: string; at: number };
	pr?: PullRequestRef;
	error?: { message: string; at: number };
};

/** How the last run ended, as the person needs to know it. */
export type Outcome =
	| { kind: "replied"; at: number }
	| { kind: "reported"; at: number }
	| { kind: "stopped"; at: number }
	| { kind: "failed"; reason: string; detail?: string; at: number }
	| { kind: "budget"; at: number }
	| { kind: "no-report"; at: number }
	/** The run ended while agents it started in the background still work; their answers start the next one. */
	| { kind: "waiting-agents"; at: number };

/** Where an agent's current run is: waiting its turn, running, or ended one of three ways. */
export type AgentStatus = "queued" | "running" | "done" | "failed" | "stopped";

/**
 * One agent of a session, written by its run's task in the same commit as each change of the run's own state, since the
 * phone cannot read Durable's task records. A view: nothing decides from it, beyond finding an agent's conversation and
 * its current run.
 */
export type AgentRow = {
	/** The agent's conversation, which is its id across every run. */
	id: number;
	/** Its current run's task. */
	task: number;
	/** The definition's name. */
	type: string;
	description: string;
	background: boolean;
	status: AgentStatus;
	/** Why it failed, in Durable's words. */
	reason?: string;
	/** 1, then one more per resume. */
	runs: number;
	createdAt: number;
	startedAt?: number;
	endedAt?: number;
};

/** Whether an agent is still under way: waiting its turn or running. */
export function agentLive(row: Pick<AgentRow, "status">): boolean {
	return row.status === "queued" || row.status === "running";
}

/**
 * What each reason Durable gives for a failed run means, in the sidebar's banner and in the notification alike. Every
 * new reason must be added here once, so the banner and the notification never drift apart.
 */
export const RUN_FAILURES: Record<string, string> = {
	model_error: "The model returned an error",
	no_model: "No model is available: check Pi's sign-in on the server",
	interrupted: "The server kept stopping while the model answered",
	restart_limit: "The run kept crashing the server",
	turn_limit: "The run reached its turn limit",
	nothing_to_answer: "There was nothing to continue: Pi had already answered",
	faulted: "The run hit an internal error",
	orphaned: "The run could not resume after an upgrade",
	reset: "The conversation was reset",
	run_failed: "An earlier run failed",
};

/** One sentence, without its full stop, for why a run failed. */
export function runFailureText(reason: string): string {
	return RUN_FAILURES[reason] ?? `The run ended: ${reason}`;
}

// --- The person's words and pigui's transcript entries --------------------------------------------------------------

export type PersonWordKind = "task" | "message" | "answer" | "approval" | "feedback";

/** Something the person said, verbatim. Compaction checkpoints carry these unchanged. */
export type PersonWord = {
	at: number;
	kind: PersonWordKind;
	text: string;
};

/** Entry kinds pigui places in the transcript, beside Durable's own `pi.*` kinds. */
export const MESSAGE_ENTRY = "pigui.message";
export const NUDGE_ENTRY = "pigui.nudge";
/** pigui's compaction checkpoint: a head marker that starts the context at the cut its summarizer chose. */
export const CHECKPOINT_ENTRY = "pigui.compaction";
/** What pigui says to the agent around a compaction it runs; the model sees it as a user message. */
export const COMPACTION_NOTE_ENTRY = "pigui.compaction-note";
/** A background agent's answer, sent to its parent as a message, which starts the parent's next run. */
export const AGENT_RESULT_ENTRY = "pigui.agent-result";
/** A background agent stopped before it answered: a note the parent reads at its next boundary. */
export const AGENT_STOPPED_ENTRY = "pigui.agent-stopped";

export type AgentResultData = {
	agent: number;
	type: string;
	description: string;
	status: "done" | "failed";
	/** The agent's full answer, or why it failed. */
	text: string;
};

export type AgentStoppedData = { agent: number; type: string; description: string };

/** How a reference behind a message turned out; the transcript shows it as a compact chip (see references.ts). */
export type ReferenceStatus = "included" | "pointer" | "skill";

/** What the transcript shows for a message: the person's text as typed, and compact notes on what was added to it. */
export type MessageEntryData = {
	text: string;
	references: { kind: "file" | "skill"; value: string; status: ReferenceStatus; note?: string }[];
	attachments: { name: string; mimeType: string; size: number; path: string; image: boolean }[];
};

/** An automatic continuation, shown as such rather than as something the person said. */
export type NudgeEntryData = {
	attempt: number;
	limit: number;
};

export type CheckpointEntryData = {
	/** The compaction task that wrote it: pigui's own, or Durable's when pigui's backstop hook answered it. */
	task: number;
	/**
	 * For a Durable compaction, the entry its own summary heads: that summary carries the same checkpoint text, and the
	 * phone shows the two as one row.
	 */
	durableCut?: number;
	/** Whose cut it is: the summarizer's, the nearest within the cap, or the fallback. */
	selection: "model" | "capped" | "fallback";
	/** Model messages kept verbatim after the checkpoint. */
	retained: number;
	/** Kept tool results replaced by a one-line note in what the model sees. */
	condensed: number;
};

/** Before compacting, pigui asks the agent for a handoff note; after, it tells the agent to resume. */
export type CompactionNoteData = { note: "handoff-request" | "resume" };

// --- Where a session works ------------------------------------------------------------------------------------------

/** A clone of a GitHub repository on a branch of its own, which pigui pushes when the person taps. */
export type RepoPlace = {
	place: "repo";
	repo: string;
	start: SessionStart;
	/** The session's working branch. */
	branch: string;
	/** The branch the work is compared with and merged into. */
	base: string;
	/** HEAD once the workspace was ready. */
	startCommit?: string;
	delivery: Delivery;
};

/**
 * A directory on the person's own computer (pigui OnPrem), worked in place: nothing is cloned, pushed or diffed, and
 * nothing pigui does ever removes or rewrites anything in it.
 */
export type LocalPlace = {
	place: "local";
	/** The absolute directory the agent starts in, as chosen when the session was created; not a boundary. */
	dir: string;
};

/** Where a session works. Sessions stored before local sessions existed are repository sessions (see app.ts). */
export type SessionPlace = RepoPlace | LocalPlace;

export type SessionDoc = SessionCommon & SessionPlace;
export type RepoSessionDoc = SessionCommon & RepoPlace;

/** What every session holds, wherever it works. */
export type SessionCommon = {
	id: number;
	title: string;
	setup: SetupState;
	workflow: Workflow;
	plan?: PlanState;
	card?: PendingCard;
	report?: StoredReport;
	/** Spend cap in US dollars; absent means no cap. */
	cap?: number;
	/**
	 * The run under way, by the submission whose settlement ends it, so the supervisor decides each run's end once, and
	 * the sidebar, which reads this document alone, can show it. The open session reads Durable's `pi.live` as well.
	 */
	activeRun?: { submission: number; startedAt: number };
	outcome?: Outcome;
	/** Automatic continuations since the plan was approved or the person last spoke. */
	continuations: number;
	/**
	 * The person's words, verbatim, oldest first. Deliberately unbounded: compaction carries them into every
	 * checkpoint and never sheds them, so a very long session's checkpoint can exceed its size budget. `recall_history`
	 * and the transcript are the recovery paths; the words are the record.
	 */
	words: PersonWord[];
	/** Keys of notifications already enqueued, so each wait notifies once. */
	notified: string[];
	/** Recently handled request IDs and what they answered, so a retried send never acts twice. */
	requests: { id: string; at: number; result: string }[];
	/**
	 * What the next compaction needs. Documents from before checkpoints also hold `notes`, which nothing reads and the
	 * next compaction drops.
	 */
	handoff?: {
		/** The summarizer's latest working state, which the next one evolves; absent until one was written. */
		body?: string;
		/** Checkpoints written. */
		compactions: number;
		/** The compaction task that wrote the latest, so a rerun after a restart counts it once. */
		lastTask: number;
		/** When pigui asked the agent for a handoff note; cleared by the compaction that follows. */
		requestedAt?: number;
	};
	/**
	 * Long-term memories surface_memories showed since the last report, which the next report must rate or delete. Kept
	 * here rather than read from the transcript, so a compaction cannot hide one.
	 */
	memoryShown?: string[];
	/** The first message, kept until setup submits it, so a failed setup can be retried. */
	pendingTask?: { text: string; attachments: string[] };
	/** The agents its agent started, oldest first; absent until the first. */
	agents?: AgentRow[];
	archived: boolean;
	/**
	 * When maintenance removed pigui's own directories of this archived session: a repository session's clone, after
	 * checking nothing in it was unpushed; a local session's attachments, never its directory.
	 */
	cleanedAt?: number;
	createdAt: number;
	updatedAt: number;
	/** When the person last looked at the session. */
	seenAt: number;
	/** When the session last started needing the person. */
	attentionAt?: number;
};

// --- The drawer index and its rows ----------------------------------------------------------------------------------

export type SessionGroup = "attention" | "working" | "done";

/**
 * What a session's status means, and so its colour wherever the status shows: the agent at work, the person's turn, a
 * warning, an error, done, or nothing in particular.
 */
export type StatusTone = "working" | "attention" | "warn" | "error" | "done" | "idle";

/** Where a drawer row's session works: the repository and branch, or the directory on this computer. */
export type RowPlace = Pick<RepoPlace, "place" | "repo" | "branch"> | LocalPlace;

/** One drawer row: a projection of a SessionDoc, recomputed whenever the document changes and when pigui starts. */
export type SessionRow = RowPlace & {
	id: number;
	title: string;
	group: SessionGroup;
	label: string;
	tone: StatusTone;
	progress?: { done: number; total: number };
	updatedAt: number;
	attentionAt?: number;
	seenAt: number;
	archived: boolean;
};

export type SessionIndex = {
	rows: Record<string, SessionRow>;
	/** The repository of the newest session, the default for the next one. */
	lastRepo?: string;
	/**
	 * pigui OnPrem: the directories the person starred, absolute, offered above the recent ones when a session starts.
	 * Kept here rather than in the browser, so a star made at the computer is there on the phone.
	 */
	starred?: string[];
	/**
	 * The repositories the person starred, `owner/name`, favourites on the New session page. Kept here rather than in
	 * the browser, like the directories, so a star made on one device is there on the other.
	 */
	starredRepos?: string[];
	/** Session-creation request IDs, so a retried create never makes two sessions. */
	created: { id: string; at: number; session: number }[];
};

/** Derive the drawer row of a session. The one place that decides how a session is grouped and labelled. */
export function sessionRow(doc: SessionDoc): SessionRow {
	const { group, label, tone } = describeRow(doc);
	const row: SessionRow = {
		id: doc.id,
		// The plan's title once there is one: a few words, where the session's own title is the first line of its task.
		title: doc.plan === undefined ? doc.title : doc.plan.title,
		...(doc.place === "local" ? { place: "local", dir: doc.dir } : { place: "repo", repo: doc.repo, branch: doc.branch }),
		group,
		label,
		tone,
		updatedAt: doc.updatedAt,
		seenAt: doc.seenAt,
		archived: doc.archived,
	};
	if (doc.plan?.approved === true) row.progress = { done: doc.plan.done.length, total: doc.plan.steps.length };
	if (doc.attentionAt !== undefined) row.attentionAt = doc.attentionAt;
	return row;
}

function describeRow(doc: SessionDoc): { group: SessionGroup; label: string; tone: StatusTone } {
	if (doc.setup.status === "preparing") return { group: "working", label: "Setting up", tone: "working" };
	if (doc.setup.status === "failed") return { group: "attention", label: "Setup failed", tone: "error" };
	if (doc.card?.kind === "questions") return { group: "attention", label: "Question waiting", tone: "attention" };
	if (doc.card?.kind === "plan") return { group: "attention", label: "Plan ready", tone: "attention" };
	if (doc.activeRun !== undefined) {
		const progress = doc.plan?.approved === true ? ` · ${doc.plan.done.length}/${doc.plan.steps.length}` : "";
		return { group: "working", label: `Working${progress}`, tone: "working" };
	}
	const delivery = doc.place === "repo" ? doc.delivery : undefined;
	const delivered = delivery?.pr !== undefined ? "PR open" : delivery?.pushed !== undefined ? "Pushed" : undefined;
	switch (doc.outcome?.kind) {
		case "failed":
			return { group: "attention", label: "Run failed", tone: "error" };
		case "budget":
			return { group: "attention", label: "Budget reached", tone: "warn" };
		case "no-report":
			return { group: "attention", label: "Stopped without a report", tone: "warn" };
		case "stopped":
			// The person stopped it: their turn, but nothing went wrong.
			return { group: "attention", label: "Stopped", tone: "idle" };
		case "replied":
			return { group: "attention", label: "Replied", tone: "attention" };
		case "waiting-agents":
			return { group: "working", label: "Waiting on agents", tone: "working" };
		case "reported":
		case undefined:
			break;
	}
	if (doc.report !== undefined && delivered === undefined) return { group: "attention", label: "Report ready", tone: "attention" };
	if (delivered !== undefined || doc.report !== undefined) return { group: "done", label: delivered ?? "Reported", tone: "done" };
	return { group: "done", label: "Idle", tone: "idle" };
}

/** Whether a row asks for the person's attention and they have not looked since. */
export function needsAttention(row: SessionRow): boolean {
	return !row.archived && row.group === "attention" && (row.attentionAt ?? 0) > row.seenAt;
}
