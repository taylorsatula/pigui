// The shapes of picloud's own Durable documents. The server writes them in commits; the phone receives them through
// watches and applies Chord operations to them, so both sides read exactly these types.

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
	/** HEAD when the report was filed. */
	commit: string;
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

/** Any stored report in the current shape. The older one's verification prose has no commands to show, so it reads as a note. */
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
	| { kind: "no-report"; at: number };

/** What each reason Durable gives for a failed run means, in the sidebar's banner and in the notification alike. */
const RUN_FAILURES: Record<string, string> = {
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

export type PersonWordKind = "task" | "message" | "answer" | "approval" | "feedback";

/** Something the person said, verbatim. Compaction checkpoints carry these unchanged. */
export type PersonWord = {
	at: number;
	kind: PersonWordKind;
	text: string;
};

/** Entry kinds picloud places in the transcript, beside Durable's own `pi.*` kinds. */
export const MESSAGE_ENTRY = "picloud.message";
export const NUDGE_ENTRY = "picloud.nudge";
/** picloud's compaction checkpoint: a head marker that starts the context at the cut its summarizer chose. */
export const CHECKPOINT_ENTRY = "picloud.compaction";
/** What picloud says to the agent around a compaction it runs; the model sees it as a user message. */
export const COMPACTION_NOTE_ENTRY = "picloud.compaction-note";

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
	/** The compaction task that wrote it: picloud's own, or Durable's when picloud's backstop hook answered it. */
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

/** Before compacting, picloud asks the agent for a handoff note; after, it tells the agent to resume. */
export type CompactionNoteData = { note: "handoff-request" | "resume" };

export type SessionDoc = {
	id: number;
	title: string;
	repo: string;
	start: SessionStart;
	/** The session's working branch. */
	branch: string;
	/** The branch the work is compared with and merged into. */
	base: string;
	/** HEAD once the workspace was ready. */
	startCommit?: string;
	setup: SetupState;
	workflow: Workflow;
	plan?: PlanState;
	card?: PendingCard;
	report?: StoredReport;
	delivery: Delivery;
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
		/** When picloud asked the agent for a handoff note; cleared by the compaction that follows. */
		requestedAt?: number;
	};
	/**
	 * Long-term memories surface_memories showed since the last report, which the next report must rate or delete. Kept
	 * here rather than read from the transcript, so a compaction cannot hide one.
	 */
	memoryShown?: string[];
	/** The first message, kept until setup submits it, so a failed setup can be retried. */
	pendingTask?: { text: string; attachments: string[] };
	archived: boolean;
	/** When maintenance removed the workspace of this archived session, after checking nothing in it was unpushed. */
	cleanedAt?: number;
	createdAt: number;
	updatedAt: number;
	/** When the person last looked at the session. */
	seenAt: number;
	/** When the session last started needing the person. */
	attentionAt?: number;
};

export type SessionGroup = "attention" | "working" | "done";

/**
 * What a session's status means, and so its colour wherever the status shows: the agent at work, the person's turn, a
 * warning, an error, done, or nothing in particular.
 */
export type StatusTone = "working" | "attention" | "warn" | "error" | "done" | "idle";

/** One drawer row: a projection of a SessionDoc, recomputed whenever the document changes and when picloud starts. */
export type SessionRow = {
	id: number;
	title: string;
	repo: string;
	branch: string;
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
	/** Session-creation request IDs, so a retried create never makes two sessions. */
	created: { id: string; at: number; session: number }[];
};

/** Derive the drawer row of a session. The one place that decides how a session is grouped and labelled. */
export function sessionRow(doc: SessionDoc): SessionRow {
	const { group, label, tone } = describe(doc);
	const row: SessionRow = {
		id: doc.id,
		// The plan's title once there is one: a few words, where the session's own title is the first line of its task.
		title: doc.plan === undefined ? doc.title : doc.plan.title,
		repo: doc.repo,
		branch: doc.branch,
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

function describe(doc: SessionDoc): { group: SessionGroup; label: string; tone: StatusTone } {
	if (doc.setup.status === "preparing") return { group: "working", label: "Setting up", tone: "working" };
	if (doc.setup.status === "failed") return { group: "attention", label: "Setup failed", tone: "error" };
	if (doc.card?.kind === "questions") return { group: "attention", label: "Question waiting", tone: "attention" };
	if (doc.card?.kind === "plan") return { group: "attention", label: "Plan ready", tone: "attention" };
	if (doc.activeRun !== undefined) {
		const progress = doc.plan?.approved === true ? ` · ${doc.plan.done.length}/${doc.plan.steps.length}` : "";
		return { group: "working", label: `Working${progress}`, tone: "working" };
	}
	const delivered = doc.delivery.pr !== undefined ? "PR open" : doc.delivery.pushed !== undefined ? "Pushed" : undefined;
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
