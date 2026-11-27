// A session's life: creating it, preparing its workspace in a Durable task, and every way the person acts on it. Each
// action is one commit that checks the current state and changes it, so a retried request or a crash midway never
// acts twice. A repository session clones into its workspace; a local session (pigui OnPrem) works in a directory of
// the person's in place, and its workspace holds only pigui's own files for it.
import type { Context } from "@earendil-works/chord/context";
import type { Draft } from "@earendil-works/chord/delta";
import {
	configure,
	type ConversationId,
	ConversationBusy,
	ConversationIdle,
	defineTask,
	type Harness,
	InboxDoc,
	type ModelRef,
	type SubmissionDraft,
	type SubmissionId,
	type TaskId,
	type TaskRuntime,
	type Tx,
	UsageDoc,
} from "@earendil-works/pi-durable";
import type { ImageProcessor } from "@earendil-works/pi-durable/tools";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AnswerCardBody, CanceledQueued, CreateSessionBody, MessageRoute, SendMessageBody } from "../shared/api.ts";
import { type CardAnswer, MESSAGE_ENTRY, type PendingCard, type SessionDoc, type SessionPlace, type SessionStart, type SetupStep } from "../shared/session.ts";
import { formatDollars } from "../shared/spend.ts";
import { sessionSpend } from "./agent/budget.ts";
import { compactionFor } from "./agent/compaction.ts";
import { ANSWER_KEY, CardAnswerSignal } from "./agent/cards.ts";
import { describeAnswer } from "./agent/questions.ts";
import { ATTACHMENTS_DIR, skillsAt } from "./agent/resources.ts";
import type { AgentServices } from "./agent/services.ts";
import type { OnPrem } from "./config.ts";
import { editSession, handledRequest, readSession, rememberRequest, SessionDocToken, SessionIndexToken } from "./documents.ts";
import { HttpError, notFound } from "./errors.ts";
import { branchExists, cloneInto, currentBranch, git, head, isRepository } from "./git.ts";
import type { RepoHost } from "./host.ts";
import { attach, composeContent, expandReferences, type PreparedInput, type ReferenceRoot, type Uploads } from "./input.ts";
import { localDirectory } from "./local.ts";
import { errorKind, type Logger } from "./log.ts";
import { stopAgent, stopAgents } from "./subagents/extension.ts";

export type SessionsDeps = {
	harness: () => Harness;
	host: RepoHost;
	uploads: Uploads;
	images: ImageProcessor;
	agent: AgentServices;
	log: Logger;
	now: () => number;
	/** Pi's default model. Carried for the app's wiring, which configures each conversation's model; this file sets no model. */
	defaultModel: () => ModelRef;
	spendCap: number | undefined;
	/** pigui OnPrem: local sessions may be created, and `~` is this home. */
	onPrem: OnPrem | undefined;
};

type SetupCheckpoint = { phase: SetupStep };

const CREATED_MEMORY = 200;

function titleOf(text: string): string {
	const line = text.trim().split("\n")[0]?.trim() ?? "";
	return line.length > 72 ? `${line.slice(0, 71)}…` : line || "Untitled session";
}

function branchFor(title: string, id: number): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
	return `pi/${slug === "" ? "session" : slug}-${id}`;
}

export class Sessions {
	readonly #deps: SessionsDeps;
	readonly setupTask;

	constructor(deps: SessionsDeps) {
		this.#deps = deps;
		const step = (name: SetupStep, run: (task: SetupRuntime, context: Context) => Promise<void>) =>
			async (_task: unknown, runtime: SetupRuntime, context: Context): Promise<void> => {
				try {
					await run(runtime, context);
				} catch (error) {
					await this.#setupFailed(runtime, name, error, context);
				}
			};
		this.setupTask = defineTask<null, SetupCheckpoint, null, object>({
			name: "pigui.setup",
			version: 1,
			initial: () => ({ phase: "clone" }),
			phases: {
				clone: step("clone", (runtime, context) => this.#clone(runtime, context)),
				branch: step("branch", (runtime, context) => this.#branch(runtime, context)),
				start: step("start", (runtime, context) => this.#start(runtime, context)),
			},
			abort: async (_task, runtime, context) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
			},
		});
	}

	#workspace(id: number): string {
		return this.#deps.agent.workspace(id);
	}

	async #session(runtime: SetupRuntime, context: Context): Promise<Readonly<SessionDoc>> {
		const doc = await runtime.snapshot(SessionDocToken, runtime.conversationId, context);
		if (doc?.id === undefined) throw new Error("The session record is missing.");
		return doc;
	}

	async #advance(runtime: SetupRuntime, next: SetupStep, context: Context, change?: (doc: Draft<SessionDoc>) => void): Promise<void> {
		await runtime.commit(async (tx) => {
			await editSession(tx, runtime.conversationId, this.#deps.now(), (doc) => {
				doc.setup = { status: "preparing", step: next };
				change?.(doc);
			});
			return { status: "running", checkpoint: { phase: next } };
		}, context);
	}

	async #clone(runtime: SetupRuntime, context: Context): Promise<void> {
		const doc = await this.#session(runtime, context);
		const workspace = this.#workspace(doc.id);
		if (doc.place === "local") {
			// Nothing to clone or branch: the agent works in the person's directory. Only pigui's own directory is made.
			await mkdir(join(workspace, ATTACHMENTS_DIR), { recursive: true });
			await this.#advance(runtime, "start", context);
			return;
		}
		if (!(await isRepository(workspace))) {
			await mkdir(join(workspace, ".."), { recursive: true });
			const ref = doc.start.kind === "new" ? doc.start.base : doc.start.branch;
			await cloneInto(this.#deps.host.remoteUrl(doc.repo), ref, workspace);
		}
		await this.#advance(runtime, "branch", context);
	}

	async #branch(runtime: SetupRuntime, context: Context): Promise<void> {
		const doc = await this.#session(runtime, context);
		if (doc.place === "local") throw new Error("A local session has no branch.");
		const workspace = this.#workspace(doc.id);
		if ((await currentBranch(workspace)) !== doc.branch) {
			if (await branchExists(workspace, doc.branch)) await git(workspace, ["switch", "--quiet", doc.branch]);
			else await git(workspace, ["switch", "--quiet", "-c", doc.branch]);
		}
		// A repository carries pigui's own identity for its commits, and pigui's files stay out of its index.
		await git(workspace, ["config", "user.name", "Pi"]);
		await git(workspace, ["config", "user.email", "pi@pigui.invalid"]);
		const exclude = join(workspace, ".git", "info", "exclude");
		const excluded = await readFile(exclude, "utf8").catch(() => "");
		if (!excluded.split("\n").includes("/.pigui/")) {
			await mkdir(join(workspace, ".git", "info"), { recursive: true });
			await writeFile(exclude, `${excluded}${excluded === "" || excluded.endsWith("\n") ? "" : "\n"}/.pigui/\n`);
		}
		await mkdir(join(workspace, ATTACHMENTS_DIR), { recursive: true });
		const startCommit = await head(workspace);
		// The commit that moves the step to `start` carries the commit the session's work began at.
		await this.#advance(runtime, "start", context, (draft) => {
			if (draft.place === "repo") draft.startCommit = startCommit;
		});
	}

	async #start(runtime: SetupRuntime, context: Context): Promise<void> {
		const doc = await this.#session(runtime, context);
		const pending = doc.pendingTask;
		if (pending === undefined) throw new Error("The first message is missing.");
		const input = await this.prepare(doc, pending.text, pending.attachments, context);
		const handle = await runtime.conversation(runtime.conversationId, context);
		if (handle === undefined) throw new Error("The session's conversation is missing.");
		await runtime.commit(async (tx) => {
			const submission = await handle.submit(tx, {
				type: "input",
				content: input.content,
				requestId: "pigui:task",
				entry: { kind: MESSAGE_ENTRY, data: input.data },
			});
			const now = this.#deps.now();
			await editSession(tx, runtime.conversationId, now, (draft) => {
				draft.setup = { status: "ready" };
				draft.activeRun = { submission, startedAt: now };
				draft.words.push({ at: now, kind: "task", text: pending.text });
				delete draft.pendingTask;
			});
			return { status: "terminal", outcome: { status: "completed", result: null } };
		}, context);
		await this.#deps.uploads.remove(pending.attachments);
	}

	async #setupFailed(runtime: SetupRuntime, step: SetupStep, error: unknown, context: Context): Promise<void> {
		// Shutting down is not a failure: the step reruns when the server is back.
		if (runtime.signal.aborted) throw error;
		this.#deps.log.warn("setup.failed", { session: runtime.conversationId, step, error: errorKind(error) });
		const message = error instanceof Error ? error.message : String(error);
		await runtime.commit(async (tx) => {
			await editSession(tx, runtime.conversationId, this.#deps.now(), (doc) => {
				doc.setup = { status: "failed", step, error: message };
				doc.attentionAt = this.#deps.now();
			});
			return { status: "terminal", outcome: { status: "failed", error: { message } } };
		}, context);
	}

	/**
	 * The message the agent receives for `text` and `attachments`: references read where the agent works, attachments
	 * saved in pigui's workspace of the session.
	 */
	async prepare(doc: Readonly<SessionDoc>, text: string, attachments: readonly string[], context: Context): Promise<PreparedInput> {
		const dir = this.#deps.agent.workingDir(doc);
		const agent = await this.#deps.harness().conversation(doc.id as ConversationId, context);
		const ref = (await agent?.agent(context))?.model;
		const model = ref === undefined ? undefined : this.#deps.agent.model(ref.provider, ref.modelId);
		const root: ReferenceRoot = doc.place === "local" ? { place: "local", dir, home: this.#home() } : { place: "repo", dir };
		const expansion = await expandReferences(text, root, skillsAt(dir, this.#deps.agent.agentDir));
		const shown = doc.place === "local" ? "absolute" : "relative";
		const attached = await attach(attachments, this.#deps.uploads, this.#workspace(doc.id), shown, model, this.#deps.images);
		return {
			content: composeContent(text, expansion, attached.notes, attached.images),
			data: { text, references: expansion.references, attachments: attached.attachments },
		};
	}

	/** The home a local session's `~` means; only OnPrem has local sessions. */
	#home(): string {
		if (this.#deps.onPrem === undefined) throw new Error("Local sessions exist only in pigui OnPrem.");
		return this.#deps.onPrem.home;
	}

	/** Where a new session works, checked before anything is created: its repository and branches, or its directory. */
	async #placeFor(body: CreateSessionBody): Promise<(id: number, title: string) => SessionPlace> {
		if (body.place === "local") {
			if (this.#deps.onPrem === undefined) {
				throw new HttpError(
					403,
					"Sessions in a directory on this computer are for pigui OnPrem, where the agent has your full access.",
					"This server confines every session to a clone of a repository: choose a repository instead.",
				);
			}
			const dir = await localDirectory(body.dir, this.#deps.onPrem.home);
			return () => ({ place: "local", dir });
		}
		const start: SessionStart = body.start;
		const { base, pr } = await this.#baseFor(body.repo, start);
		return (id, title) => ({
			place: "repo",
			repo: body.repo,
			start,
			branch: start.kind === "new" ? branchFor(title, id) : start.branch,
			base,
			delivery: pr === undefined ? {} : { pr },
		});
	}

	async create(body: CreateSessionBody, context: Context): Promise<number> {
		const harness = this.#deps.harness();
		const prior = (await harness.snapshot(SessionIndexToken, context))?.created.find((entry) => entry.id === body.requestId);
		if (prior !== undefined) return prior.session;
		const place = await this.#placeFor(body);
		const title = titleOf(body.text);
		const now = this.#deps.now();
		return harness.commit(async (tx) => {
			const index = await tx.doc(SessionIndexToken);
			const again = index.created.find((entry) => entry.id === body.requestId);
			if (again !== undefined) return again.session;
			const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
			const id = conversation.id;
			const fresh: SessionDoc = {
				id,
				title,
				...place(id, title),
				setup: { status: "preparing", step: body.place === "local" ? "start" : "clone" },
				workflow: "open",
				continuations: 0,
				words: [],
				notified: [],
				requests: [],
				archived: false,
				createdAt: now,
				updatedAt: now,
				seenAt: now,
				pendingTask: { text: body.text, attachments: [...body.attachments] },
			};
			if (this.#deps.spendCap !== undefined) fresh.cap = this.#deps.spendCap;
			const model = this.#deps.defaultModel();
			const window = this.#deps.agent.model(model.provider, model.modelId)?.contextWindow ?? 128_000;
			await configure(tx, id, {
				model,
				cwd: this.#deps.agent.workingDir(fresh),
				// The maintenance sweep adopts sessions later; their turn limit was removed at startup. This one never had one:
				// a run takes as many tool rounds as its work needs.
				maxTurns: null,
				compaction: compactionFor(window),
			});
			await editSession(tx, id, now, (doc) => {
				Object.assign(doc, fresh);
			});
			if (body.place === "repo") index.lastRepo = body.repo;
			index.created.push({ id: body.requestId, at: now, session: id });
			if (index.created.length > CREATED_MEMORY) index.created.splice(0, index.created.length - CREATED_MEMORY);
			await tx.createTask(this.setupTask, null, { ownership: { kind: "conversation" }, conversationId: id, background: true });
			return id as number;
		}, context);
	}

	/** The branch to compare with: the chosen base, or for a continued branch its open PR's base or the default branch. */
	async #baseFor(repo: string, start: SessionStart): Promise<{ base: string; pr?: { number: number; url: string } }> {
		if (start.kind === "new") return { base: start.base };
		const pr = await this.#deps.host.findPullRequest(repo, start.branch);
		if (pr !== undefined) return { base: pr.base, pr: { number: pr.number, url: pr.url } };
		return { base: (await this.#deps.host.branches(repo)).defaultBranch };
	}

	async retrySetup(id: number, context: Context): Promise<void> {
		await this.#deps.harness().commit(async (tx) => {
			const doc = await readSession(tx, id);
			if (doc === undefined) throw notFound("The session");
			if (doc.setup.status !== "failed") return;
			const step = doc.setup.step;
			await editSession(tx, id, this.#deps.now(), (draft) => {
				draft.setup = { status: "preparing", step };
			});
			await tx.createTask(this.setupTask, null, { ownership: { kind: "conversation" }, conversationId: id as ConversationId, background: true });
		}, context);
	}

	async #ready(id: number, context: Context): Promise<Readonly<SessionDoc>> {
		const doc = await this.#deps.harness().snapshot(SessionDocToken, id as ConversationId, context);
		if (doc?.id === undefined) throw notFound("The session");
		if (doc.setup.status === "preparing") throw new HttpError(409, "The session is still being set up.", "Wait a moment and send again.");
		if (doc.setup.status === "failed") throw new HttpError(409, "The session's setup failed.", "Tap Retry setup.");
		if (doc.place === "local" && this.#deps.onPrem === undefined) {
			throw new HttpError(409, "This session works in a directory on this computer, which only pigui OnPrem runs.", "Turn PIGUI_ONPREM back on to continue it.");
		}
		if (doc.cleanedAt !== undefined) {
			throw new HttpError(
				409,
				"This session's workspace was cleaned up after it was archived.",
				doc.place === "local" ? "Start a new session in the same directory to go on." : "Start a new session to continue its branch.",
			);
		}
		return doc;
	}

	/**
	 * Route a message by the session's state: a waiting card takes it as its answer, a running run takes it as a steer,
	 * and otherwise it starts a new run.
	 */
	async send(id: number, body: SendMessageBody, context: Context): Promise<MessageRoute> {
		const doc = await this.#ready(id, context);
		const handled = handledRequest(doc as Draft<SessionDoc>, body.requestId);
		if (handled !== undefined) return handled as MessageRoute;
		if (doc.card !== undefined) {
			const note = body.attachments.length > 0 ? await this.#attachmentNote(doc, body.attachments, context) : "";
			const text = note === "" ? body.text : `${body.text}\n\n${note}`;
			await this.answer(id, { requestId: body.requestId, cardId: doc.card.id, answer: { kind: "text", text } }, context);
			return "card";
		}
		if (body.text.trim() === "" && body.attachments.length === 0) throw new HttpError(400, "The message is empty.");
		const input = await this.prepare(doc, body.text, body.attachments, context);
		const conversation = await this.#deps.harness().conversation(id as ConversationId, context);
		if (conversation === undefined) throw notFound("The session");
		const route = await this.#deps.harness().commit(async (tx) => {
			const draft = await tx.doc(SessionDocToken, id as ConversationId);
			const again = handledRequest(draft, body.requestId);
			if (again !== undefined) return again as MessageRoute;
			const message: SubmissionDraft = { type: "input", content: input.content, requestId: body.requestId, entry: { kind: MESSAGE_ENTRY, data: input.data } };
			let route: MessageRoute = "steer";
			let submission: number;
			try {
				submission = await conversation.submit(tx, { ...message, whenBusy: "steer", whenIdle: "reject" });
			} catch (error) {
				if (!(error instanceof ConversationIdle)) throw error;
				await this.#checkBudget(tx, draft);
				submission = await conversation.submit(tx, message);
				route = "run";
			}
			const now = this.#deps.now();
			await editSession(tx, id, now, (doc) => {
				doc.words.push({ at: now, kind: "message", text: body.text });
				if (route === "run") {
					doc.activeRun = { submission, startedAt: now };
					delete doc.outcome;
					if (doc.workflow === "reported") doc.workflow = "open";
				}
				doc.continuations = 0;
				rememberRequest(doc, body.requestId, route, now);
			});
			return route;
		}, context);
		await this.#deps.uploads.remove(body.attachments);
		return route;
	}

	/**
	 * Cancel a queued steering message the person sent. Only the person's own queued messages (a steer whose entry is a
	 * pigui.message) can be withdrawn here; pigui's own steers and an agent's queued answers are not theirs to cancel.
	 * Idempotent: a message that already reached the conversation, or nothing of theirs queued, is a settled no-op.
	 */
	async cancelQueued(id: number, submission: number, context: Context): Promise<CanceledQueued> {
		await this.#ready(id, context);
		const harness = this.#deps.harness();
		const conversationId = id as ConversationId;
		const inbox = await harness.snapshot(InboxDoc, conversationId, context);
		const wanted = submission as SubmissionId;
		const item = inbox?.items.find((each) => each.id === wanted);
		// The inbox is the boundary Durable places at; anything not in it is either just placed or already settled.
		// Reporting it as settled keeps a double tap — and a tap that races the boundary — from erroring.
		if (item === undefined) return { result: "settled" };
		const entryKind = (item.mode === "steer" ? (item.entry as { kind?: string } | undefined) : undefined)?.kind;
		if (entryKind !== MESSAGE_ENTRY) {
			throw new HttpError(409, "Only your own queued messages can be canceled.", "Wait for Pi to finish its current step, or stop the run.");
		}
		const result = await harness.abortSubmission(wanted, context, conversationId);
		if (result === "not_found") throw notFound("The queued message");
		return { result };
	}

	async #attachmentNote(doc: Readonly<SessionDoc>, attachments: readonly string[], context: Context): Promise<string> {
		const input = await this.prepare(doc, "", attachments, context);
		await this.#deps.uploads.remove(attachments);
		return input.data.attachments.map((item) => `(Attached ${item.path})`).join("\n");
	}

	async #checkBudget(tx: Tx, doc: Draft<SessionDoc>): Promise<void> {
		if (doc.cap === undefined) return;
		const spent = await sessionSpend(doc, (conversation) => tx.doc(UsageDoc, conversation));
		if (spent >= doc.cap) {
			throw new HttpError(409, `The session has spent ${formatDollars(spent)} of its ${formatDollars(doc.cap)} cap.`, "Raise the budget to continue.");
		}
	}

	/** Answer the waiting card: signal its parked tool and record the person's words, in one commit. */
	async answer(id: number, body: AnswerCardBody, context: Context): Promise<void> {
		const doc = await this.#ready(id, context);
		if (handledRequest(doc as Draft<SessionDoc>, body.requestId) !== undefined) return;
		const card = doc.card;
		if (card === undefined || card.id !== body.cardId) {
			throw new HttpError(409, "That card is no longer waiting for an answer.", "Scroll to the newest message.");
		}
		const answer = body.answer as CardAnswer;
		checkAnswer(card, answer);
		const result = await this.#deps.harness().commit(async (tx) => {
			const result = await tx.signal(card.taskId as TaskId, CardAnswerSignal, ANSWER_KEY, answer);
			const now = this.#deps.now();
			await editSession(tx, id, now, (draft) => {
				if (handledRequest(draft, body.requestId) !== undefined) return;
				rememberRequest(draft, body.requestId, "card", now);
				if (draft.card?.id === card.id) delete draft.card;
				if (result !== "delivered") return;
				draft.continuations = 0;
				if (card.kind === "questions") {
					draft.words.push({ at: now, kind: "answer", text: describeAnswer(card.questions, answer) });
				} else if (answer.kind === "approve") {
					draft.words.push({ at: now, kind: "approval", text: `Approved the plan "${card.plan.title}" (revision ${card.revision}).` });
					if (draft.plan !== undefined) draft.plan.approved = true;
					draft.workflow = "implementing";
					delete draft.report;
				} else {
					draft.words.push({ at: now, kind: "feedback", text: answer.kind === "revise" ? answer.feedback : answer.kind === "text" ? answer.text : "" });
				}
			});
			return result;
		}, context);
		// The card's tool already ended (a stop, a failed run): the stale card is gone now, and the answer went nowhere.
		if (result === "closed" || result === "not_found") {
			throw new HttpError(409, "That card is no longer waiting for an answer.", "Send your answer as a message instead.");
		}
	}

	/** Stop the session's run and every agent it started, queued or running. */
	async stop(id: number, context: Context): Promise<void> {
		await this.#ready(id, context);
		// The agents first: once a run is marked stopped Durable refuses its commits, so a background answer cannot land
		// after the session's run is stopped and start another.
		await stopAgents(this.#deps.harness(), id as ConversationId, context);
		const conversation = await this.#deps.harness().conversation(id as ConversationId, context);
		await conversation?.abort(context);
	}

	/** Stop one agent of the session, queued or running; its run records the stop and tells the session's agent. */
	async stopAgent(id: number, agent: number, context: Context): Promise<void> {
		if (!(await stopAgent(this.#deps.harness(), id as ConversationId, agent, context))) throw notFound("The agent");
	}

	/** Start a run on the context as it is: after a failure, a stop, or a raised budget. */
	async continue(id: number, context: Context): Promise<void> {
		await this.#ready(id, context);
		const conversation = await this.#deps.harness().conversation(id as ConversationId, context);
		if (conversation === undefined) throw notFound("The session");
		await this.#deps.harness().commit(async (tx) => {
			const doc = await tx.doc(SessionDocToken, id as ConversationId);
			await this.#checkBudget(tx, doc);
			let submission: number;
			try {
				submission = await conversation.submit(tx, { type: "continue" });
			} catch (error) {
				if (error instanceof ConversationBusy) throw new HttpError(409, "Pi is already working.");
				throw error;
			}
			const now = this.#deps.now();
			await editSession(tx, id, now, (draft) => {
				draft.activeRun = { submission, startedAt: now };
				delete draft.outcome;
			});
		}, context);
	}

	async raiseBudget(id: number, cap: number, context: Context): Promise<void> {
		const doc = await this.#ready(id, context);
		const spent = await sessionSpend(doc, (conversation) => this.#deps.harness().snapshot(UsageDoc, conversation, context));
		if (cap <= spent) throw new HttpError(400, `The new cap must be more than the ${formatDollars(spent)} already spent.`);
		await this.#deps.harness().commit(async (tx) => {
			await editSession(tx, id, this.#deps.now(), (draft) => {
				draft.cap = cap;
			});
		}, context);
		if (doc.outcome?.kind === "budget") await this.continue(id, context);
	}

	async archive(id: number, archived: boolean, context: Context): Promise<void> {
		// An archived session is put away: its agents stop first, so none goes on working, or spending, out of sight.
		if (archived) await stopAgents(this.#deps.harness(), id as ConversationId, context);
		await this.#deps.harness().commit(async (tx) => {
			if ((await readSession(tx, id)) === undefined) throw notFound("The session");
			await editSession(tx, id, this.#deps.now(), (doc) => {
				doc.archived = archived;
			});
		}, context);
	}

	async seen(id: number, context: Context): Promise<void> {
		await this.#deps.harness().commit(async (tx) => {
			if ((await readSession(tx, id)) === undefined) throw notFound("The session");
			const now = this.#deps.now();
			await editSession(
				tx,
				id,
				now,
				(doc) => {
					doc.seenAt = now;
				},
				{ touch: false },
			);
		}, context);
	}
}

type SetupRuntime = TaskRuntime<null, SetupCheckpoint, null, object>;

/** Reject an answer that does not fit its card, at the boundary, so the tool never receives one it cannot read. */
function checkAnswer(card: PendingCard, answer: CardAnswer): void {
	if (answer.kind === "text") return;
	if (card.kind === "plan") {
		if (answer.kind !== "approve" && answer.kind !== "revise") throw new HttpError(400, "A plan is approved or revised.");
		return;
	}
	if (answer.kind !== "questions") throw new HttpError(400, "Questions are answered with choices or text.");
	for (const given of answer.answers) {
		const question = card.questions.find((candidate) => candidate.id === given.questionId);
		if (question === undefined) throw new HttpError(400, `There is no question ${given.questionId}.`);
		if (given.selected.some((option) => !question.options.some((candidate) => candidate.id === option))) {
			throw new HttpError(400, `An option chosen for "${question.prompt}" does not exist.`);
		}
		if (!question.multiple && given.selected.length > 1) throw new HttpError(400, `"${question.prompt}" takes one choice.`);
	}
}
