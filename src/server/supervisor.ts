// What happens when a run ends. Durable settles the submission that started a run when the run ends; the supervisor
// sees that commit, and in one commit of its own decides what follows: following the next run Durable already
// started, an automatic continuation, or telling the person. Clearing `activeRun` in that same commit makes the
// decision exactly once, and a restart re-checks every session, so a run that ended while nothing was watching is
// still handled.
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Draft } from "@earendil-works/chord/delta";
import {
	type Conversation,
	type ConversationId,
	type Harness,
	LiveDoc,
	type SubmissionDraft,
	type SubmissionId,
	type SubmissionRecord,
	type Tx,
} from "@earendil-works/pi-durable";
import { NUDGE_ENTRY, type NudgeEntryData, runFailureText, type SessionDoc } from "../shared/session.ts";
import { FILE_REPORT } from "./agent/report.ts";
import { editSession, readSession, SessionIndexToken } from "./docs.ts";
import { errorKind, type Logger } from "./log.ts";
import type { Notifications } from "./notify.ts";

/** Automatic continuations of an approved plan that stopped without a report, before the person is asked. */
export const MAX_CONTINUATIONS = 3;

export type SupervisorDeps = {
	harness: () => Harness;
	notifications: Notifications;
	log: Logger;
	now: () => number;
};

function nudgeText(attempt: number, limit: number): string {
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
		// A message sent while the run wrote its answer is queued, and Durable starts the next run with it as this one
		// ends. That run is the one under way: it is followed, and its end is told, rather than this one's.
		const next = (await tx.doc(LiveDoc, conversation.id)).run?.inputs[0];
		let continuation: SubmissionDraft | undefined;
		let notice: { key: string; title: string; body: string } | undefined;
		let outcome: SessionDoc["outcome"];
		const runKey = `run:${record.id}`;

		if (next !== undefined) {
			// Nothing to decide for this run: the person is waiting on the next.
		} else if (doc.outcome?.kind === "budget" && since(doc.outcome.at)) {
			// The spend cap ended the run; its task already told the person.
		} else if (doc.outcome?.kind === "reported" && since(doc.outcome.at)) {
			// The report ended the run and notified.
		} else if (record.status === "done") {
			if (doc.workflow === "implementing" && doc.continuations < MAX_CONTINUATIONS) {
				const attempt = doc.continuations + 1;
				const data: NudgeEntryData = { attempt, limit: MAX_CONTINUATIONS };
				continuation = { type: "input", content: nudgeText(attempt, MAX_CONTINUATIONS), entry: { kind: NUDGE_ENTRY, data }, requestId: `continuation:${record.id}` };
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
			// Not retried here. Durable retries model requests, its own summarizer's included, under its retry settings,
			// and picloud's checkpoint carries the previous state forward when its summarizer fails; what still ends a
			// run would only fail again. The person sees it, with a Continue button.
			const reason = record.reason ?? "unknown";
			const detail = typeof record.detail === "string" ? record.detail : undefined;
			outcome = detail === undefined ? { kind: "failed", reason, at: now } : { kind: "failed", reason, detail, at: now };
			notice = { key: runKey, title: "Run failed", body: `${runFailureText(reason)}.` };
		}

		// The submission comes before any table write in this commit, as Durable requires.
		const submission = continuation === undefined ? undefined : await conversation.submit(tx, continuation);
		await editSession(tx, doc.id, now, async (draft) => {
			delete draft.activeRun;
			// A card belongs to a parked tool of the run, which has ended with it.
			delete draft.card;
			const following = next ?? submission;
			if (following !== undefined) draft.activeRun = { submission: following, startedAt: now };
			if (next !== undefined) delete draft.outcome;
			if (submission !== undefined) draft.continuations += 1;
			if (outcome !== undefined) {
				draft.outcome = outcome;
				if (outcome.kind !== "stopped") draft.attentionAt = now;
			}
			if (notice !== undefined) await notifications.enqueue(tx, draft, notice);
		});
	}
}
