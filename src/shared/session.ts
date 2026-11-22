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

export type PlanStep = {
	id: string;
	text: string;
};

export type Plan = {
	title: string;
	summary: string;
	steps: PlanStep[];
};

export type PlanCard = {
	kind: "plan";
	id: string;
	taskId: number;
	plan: Plan;
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

export type PlanState = Plan & {
	revision: number;
	approved: boolean;
	/** Step IDs Pi marked complete. */
	done: string[];
};

export type Report = {
	summary: string;
	changes: string[];
	verification: string;
	notes: string;
	learned: string;
	/** HEAD when the report was filed. */
	commit: string;
	filedAt: number;
};

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
	cause: "continuation" | "resume";
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

/** Why the current run was started; decides how its end is handled. */
export type RunCause = "person" | "continuation" | "resume" | "continue";

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
	report?: Report;
	delivery: Delivery;
	/** Spend cap in US dollars; absent means no cap. */
	cap?: number;
	activeRun?: { submission: number; cause: RunCause; startedAt: number };
	outcome?: Outcome;
	/** Automatic continuations since the plan was approved or the person last spoke. */
	continuations: number;
	/** Automatic resumptions after a failed compaction since the person last spoke. */
	resumes: number;
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

/** One drawer row: a projection of a SessionDoc, recomputed whenever the document changes. */
export type SessionRow = {
	id: number;
	title: string;
	repo: string;
	branch: string;
	group: SessionGroup;
	label: string;
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
	const { group, label } = describe(doc);
	const row: SessionRow = {
		id: doc.id,
		title: doc.title,
		repo: doc.repo,
		branch: doc.branch,
		group,
		label,
		updatedAt: doc.updatedAt,
		seenAt: doc.seenAt,
		archived: doc.archived,
	};
	if (doc.plan?.approved === true) row.progress = { done: doc.plan.done.length, total: doc.plan.steps.length };
	if (doc.attentionAt !== undefined) row.attentionAt = doc.attentionAt;
	return row;
}

function describe(doc: SessionDoc): { group: SessionGroup; label: string } {
	if (doc.setup.status === "preparing") return { group: "working", label: "Setting up" };
	if (doc.setup.status === "failed") return { group: "attention", label: "Setup failed" };
	if (doc.card?.kind === "questions") return { group: "attention", label: "Question waiting" };
	if (doc.card?.kind === "plan") return { group: "attention", label: "Plan ready" };
	if (doc.activeRun !== undefined) {
		const progress = doc.plan?.approved === true ? ` · ${doc.plan.done.length}/${doc.plan.steps.length}` : "";
		return { group: "working", label: `Working${progress}` };
	}
	const delivered = doc.delivery.pr !== undefined ? "PR open" : doc.delivery.pushed !== undefined ? "Pushed" : undefined;
	switch (doc.outcome?.kind) {
		case "failed":
			return { group: "attention", label: "Run failed" };
		case "budget":
			return { group: "attention", label: "Budget reached" };
		case "no-report":
			return { group: "attention", label: "Stopped without a report" };
		case "stopped":
			return { group: "attention", label: "Stopped" };
		case "replied":
			return { group: "attention", label: "Replied" };
		case "reported":
		case undefined:
			break;
	}
	if (doc.report !== undefined && delivered === undefined) return { group: "attention", label: "Report ready" };
	return { group: "done", label: delivered ?? (doc.report !== undefined ? "Reported" : "Idle") };
}

/** Whether a row asks for the person's attention and they have not looked since. */
export function needsAttention(row: SessionRow): boolean {
	return !row.archived && row.group === "attention" && (row.attentionAt ?? 0) > row.seenAt;
}
