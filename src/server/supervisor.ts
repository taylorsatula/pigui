// What happens when a run ends. Durable settles the submission that started a run when the run ends; the supervisor
// sees that commit, and in one commit of its own decides what follows: an automatic continuation, a resumption after a
// failed compaction, or telling the person. Clearing `activeRun` in that same commit makes the decision exactly once,
// and a restart re-checks every session, so a run that ended while nothing was watching is still handled.
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Draft } from "@earendil-works/chord/delta";
import {
	type Conversation,
	type ConversationId,
	type Harness,
	type SubmissionDraft,
	type SubmissionId,
	type SubmissionRecord,
	type Tx,
} from "@earendil-works/pi-durable";
import { NUDGE_ENTRY, type NudgeEntryData, type SessionDoc } from "../shared/session.ts";
import { FILE_REPORT } from "./agent/report.ts";
import { editSession, readSession, SessionIndexToken } from "./docs.ts";
import { errorKind, type Logger } from "./log.ts";
import type { Notifications } from "./notify.ts";

/** Automatic continuations of an approved plan that stopped without a report, before the person is asked. */
export const MAX_CONTINUATIONS = 3;
/** Automatic resumptions after a failed compaction, before the person is asked. */
export const MAX_RESUMES = 3;

export type SupervisorDeps = {
	harness: () => Harness;
	notifications: Notifications;
	log: Logger;
	now: () => number;
};

const FAILURE_TEXT: Record<string, string> = {
	model_error: "The model returned an error.",
	no_model: "No model is available. Check Pi's sign-in on the server.",
	interrupted: "The server kept stopping while the model answered.",
	restart_limit: "The run kept crashing the server.",
	turn_limit: "The run reached its turn limit.",
	nothing_to_answer: "There was nothing to continue: Pi had already answered.",
	faulted: "The run hit an internal error.",
	orphaned: "The run could not resume after an upgrade.",
	reset: "The conversation was reset.",
	run_failed: "An earlier run failed.",
};

export function nudgeText(attempt: number, limit: number): string {
	return `[Automatic continuation ${attempt} of ${limit}] Your turn ended, but the approved plan is not finished: no report has been filed. The person is away. Continue with the next step. If you are blocked or cannot finish, say so in ${FILE_REPORT} rather than stopping.`;
}

export class Supervisor {
	readonly #deps: SupervisorDeps;
	readonly #queues = new Map<number, Promise<void>>();
	#detach: (() => void) | undefined;

	constructor(deps: SupervisorDeps) {
		this.#deps = deps;
	}

	/** Watch commits for settled submissions, and handle any run that ended while nothing watched. */
	async start(context: Context): Promise<void> {
		const observation = this.#deps.harness().observeCommits({
			advance: (publication) => {
				for (const change of publication.changes) {
					if (change.type === "submission" && (change.value.status === "done" || change.value.status === "unanswered")) {
						this.schedule(change.value.conversationId);
					}
				}
			},
			end: () => {},
		});
		this.#detach = () => observation.detach();
		const index = await this.#deps.harness().snapshot(SessionIndexToken, context);
		for (const key of Object.keys(index?.rows ?? {})) this.schedule(Number(key));
	}

	stop(): void {
		this.#detach?.();
	}

	/** Reconcile a session after whatever is queued for it; settles once that is done. */
	schedule(id: number): Promise<void> {
		const previous = this.#queues.get(id) ?? Promise.resolve();
		const next = previous.then(() => this.#reconcile(id)).catch((error: unknown) => {
			this.#deps.log.error("supervisor.failed", { session: id, error: errorKind(error) });
		});
		this.#queues.set(id, next);
		void next.then(() => {
			if (this.#queues.get(id) === next) this.#queues.delete(id);
		});
		return next;
	}

	/** Settles once every scheduled reconcile has run; tests wait on it. */
	async idle(): Promise<void> {
		while (this.#queues.size > 0) await Promise.all([...this.#queues.values()]);
	}

	async #reconcile(id: number): Promise<void> {
		const harness = this.#deps.harness();
		const conversation = await harness.conversation(id as ConversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) return;
		await harness.commit(async (tx) => {
			const doc = await readSession(tx, id);
			const active = doc?.activeRun;
			if (doc === undefined || active === undefined) return;
			const record = await tx.submission(active.submission as SubmissionId);
			if (record === undefined || record.status === "queued" || record.status === "placed") return;
			const answer = record.status === "done" && record.answer !== undefined ? await tx.entry(record.answer) : undefined;
			const reply = answer?.model?.[0];
			const replyText = reply?.role === "assistant" ? reply.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ") : "";
			await this.#runEnded(tx, conversation, doc, record, replyText);
		}, BACKGROUND_CONTEXT);
	}

	async #runEnded(tx: Tx, conversation: Conversation, doc: Draft<SessionDoc>, record: SubmissionRecord, replyText: string): Promise<void> {
		const { notifications } = this.#deps;
		const now = this.#deps.now();
		const startedAt = doc.activeRun?.startedAt ?? 0;
		const since = (at: number | undefined) => at !== undefined && at >= startedAt;
		let follow: { draft: SubmissionDraft; cause: "continuation" | "resume" } | undefined;
		let notice: { key: string; title: string; body: string } | undefined;
		let outcome: SessionDoc["outcome"];
		const runKey = `run:${record.id}`;

		if (doc.outcome?.kind === "budget" && since(doc.outcome.at)) {
			// The spend cap ended the run; its task already told the person.
		} else if (doc.outcome?.kind === "reported" && since(doc.outcome.at)) {
			// The report ended the run and notified.
		} else if (record.status === "done") {
			if (doc.workflow === "implementing" && doc.continuations < MAX_CONTINUATIONS) {
				const attempt = doc.continuations + 1;
				const data: NudgeEntryData = { cause: "continuation", attempt, limit: MAX_CONTINUATIONS };
				follow = {
					cause: "continuation",
					draft: { type: "input", content: nudgeText(attempt, MAX_CONTINUATIONS), entry: { kind: NUDGE_ENTRY, data }, requestId: `continuation:${record.id}` },
				};
			} else if (doc.workflow === "implementing") {
				outcome = { kind: "no-report", at: now };
				notice = { key: runKey, title: "Stopped without a report", body: replyText.slice(0, 200) || "Pi stopped before finishing the plan." };
			} else {
				outcome = { kind: "replied", at: now };
				notice = { key: runKey, title: "Pi replied", body: replyText.slice(0, 200) || "Pi answered." };
			}
		} else if (record.reason === "aborted") {
			outcome = { kind: "stopped", at: now };
		} else {
			const reason = record.reason ?? "unknown";
			const detail = typeof record.detail === "string" ? record.detail : undefined;
			const compaction = reason === "model_error" && detail?.startsWith("Compaction failed") === true;
			if (compaction && doc.resumes < MAX_RESUMES) {
				follow = { cause: "resume", draft: { type: "continue" } };
			} else {
				outcome = detail === undefined ? { kind: "failed", reason, at: now } : { kind: "failed", reason, detail, at: now };
				notice = { key: runKey, title: "Run failed", body: FAILURE_TEXT[reason] ?? `The run ended: ${reason}.` };
			}
		}

		// The submission comes before any table write in this commit, as Durable requires.
		const submission = follow === undefined ? undefined : await conversation.submit(tx, follow.draft);
		await editSession(tx, doc.id, now, async (draft) => {
			delete draft.activeRun;
			// A card belongs to a parked tool of the run, which has ended with it.
			delete draft.card;
			if (follow !== undefined && submission !== undefined) {
				draft.activeRun = { submission, cause: follow.cause, startedAt: now };
				if (follow.cause === "continuation") draft.continuations += 1;
				else draft.resumes += 1;
			}
			if (outcome !== undefined) {
				draft.outcome = outcome;
				if (outcome.kind !== "stopped") draft.attentionAt = now;
			}
			if (notice !== undefined) await notifications.enqueue(tx, draft, notice);
		});
	}
}
