// Delivery: the server, not the agent, pushes the session's branch and opens or reuses its pull request, and only when
// the person taps. Reviewing the diff lives here too, since it shows exactly what a delivery would send.
import type { Context } from "@earendil-works/chord/context";
import type { Draft } from "@earendil-works/chord/delta";
import { type ConversationId, type Harness, LiveDoc } from "@earendil-works/pi-durable";
import type { DeliveryResult, SessionDiff } from "../shared/api.ts";
import { type Report, reportOf, type RepoSessionDoc } from "../shared/session.ts";
import { editSession, SessionDocToken } from "./documents.ts";
import { HttpError, notFound } from "./errors.ts";
import { comparisonPoint, diffFiles, head, isRepository, push, PushRejected, uncommitted, unpushedCount } from "./git.ts";
import type { RepoHost } from "./host.ts";
import { errorKind, type Logger } from "./log.ts";

export type DeliveryDeps = {
	harness: () => Harness;
	host: RepoHost;
	/** A session's workspace: the clone its branch is pushed from. */
	workspace: (id: number) => string;
	now: () => number;
	log: Logger;
};

const OUTCOME: Record<Report["outcome"], string> = { complete: "Complete", partial: "Partly done", blocked: "Blocked" };

/** The report as a pull request's description: the same parts as its card, in GitHub's Markdown. */
function prBody(doc: Readonly<RepoSessionDoc>, report: Report | undefined): string {
	if (report === undefined) return `Work from the pigui session "${doc.title}".`;
	const files = (paths: string[]) => (paths.length === 0 ? "" : ` (${paths.map((path) => `\`${path}\``).join(", ")})`);
	const list = (title: string, lines: string[]) => (lines.length === 0 ? [] : [`## ${title}\n${lines.join("\n")}`]);
	return [
		`**${OUTCOME[report.outcome]}.** ${report.summary}`.trim(),
		...list(
			"Done when",
			report.endState.map((check) => `- [${check.met ? "x" : " "}] ${check.criterion}: ${check.evidence}`),
		),
		...list(
			"Changes",
			report.changes.map((change) => `- ${change.change}${files(change.files)}`),
		),
		...list(
			"Checks",
			report.checks.map((check) => `- ${check.result}: \`${check.command}\`${check.detail === "" ? "" : `: ${check.detail}`}`),
		),
		...list(
			"Changed from the plan",
			report.deviations.map((line) => `- ${line}`),
		),
		...list(
			"Notes",
			report.notes.map((line) => `- ${line}`),
		),
	].join("\n\n");
}

export class Delivery {
	readonly #deps: DeliveryDeps;
	/** One delivery per session at a time: two taps must not race two pushes. */
	readonly #busy = new Set<number>();

	constructor(deps: DeliveryDeps) {
		this.#deps = deps;
	}

	async #session(id: number, context: Context): Promise<Readonly<RepoSessionDoc>> {
		const doc = await this.#deps.harness().snapshot(SessionDocToken, id as ConversationId, context);
		if (doc?.id === undefined) throw notFound("The session");
		if (doc.place === "local") {
			throw new HttpError(
				409,
				"This session works in a directory on this computer, in place: there is no branch to push and no diff to show.",
				"Its changes are already where they belong. Ask Pi what it changed, or push from that directory yourself.",
			);
		}
		if (doc.setup.status !== "ready" || doc.startCommit === undefined) throw new HttpError(409, "The session has no workspace yet.");
		return doc;
	}

	async deliver(id: number, action: "push" | "pr", context: Context): Promise<DeliveryResult> {
		if (this.#busy.has(id)) throw new HttpError(409, "A delivery for this session is already running.");
		this.#busy.add(id);
		try {
			return await this.#deliver(id, action, context);
		} finally {
			this.#busy.delete(id);
		}
	}

	async #deliver(id: number, action: "push" | "pr", context: Context): Promise<DeliveryResult> {
		const doc = await this.#session(id, context);
		const live = await this.#deps.harness().snapshot(LiveDoc, id as ConversationId, context);
		if (live?.run !== undefined) {
			throw new HttpError(409, "Pi is still working, so there is nothing final to deliver yet.", "Wait for the report, or tap Stop first.");
		}
		const workspace = this.#deps.workspace(id);
		try {
			await push(workspace, doc.branch);
		} catch (error) {
			const message = await this.#failed(id, context, error);
			if (error instanceof PushRejected) {
				throw new HttpError(409, error.message, `Ask Pi to merge origin/${doc.branch} into the branch (for example "Merge the remote branch"), then push again.`);
			}
			throw new HttpError(502, `The push failed: ${message}`, "Check the server's GitHub access, then try again.");
		}
		const pushed = await head(workspace);
		let pr: DeliveryResult["pr"];
		if (action === "pr") {
			try {
				const existing = await this.#deps.host.findPullRequest(doc.repo, doc.branch);
				if (existing !== undefined) {
					pr = { number: existing.number, url: existing.url, created: false };
				} else {
					const report = doc.report === undefined ? undefined : reportOf(doc.report);
					const title = report?.headline.slice(0, 120) || doc.title;
					const created = await this.#deps.host.createPullRequest(doc.repo, { head: doc.branch, base: doc.base, title, body: prBody(doc, report) });
					pr = { ...created, created: true };
				}
			} catch (error) {
				const message = await this.#failed(id, context, error);
				throw new HttpError(502, `The pull request failed: ${message}`, "Check the server's GitHub access, then try again.");
			}
		}
		await this.#record(id, context, (draft) => {
			draft.delivery.pushed = { commit: pushed, at: this.#deps.now() };
			if (pr !== undefined) draft.delivery.pr = { number: pr.number, url: pr.url };
			delete draft.delivery.error;
		});
		return pr === undefined ? { pushed } : { pushed, pr };
	}

	/** Log and record a delivery failure, so the report card can say what happened; returns the message for the HTTP response. */
	async #failed(id: number, context: Context, error: unknown): Promise<string> {
		const message = error instanceof Error ? error.message : String(error);
		this.#deps.log.warn("deliver.failed", { session: id, error: errorKind(error) });
		await this.#record(id, context, (draft) => {
			draft.delivery.error = { message, at: this.#deps.now() };
		});
		return message;
	}

	async #record(id: number, context: Context, change: (doc: Draft<RepoSessionDoc>) => void): Promise<void> {
		await this.#deps.harness().commit(
			(tx) =>
				editSession(tx, id, this.#deps.now(), (doc) => {
					if (doc.place === "repo") change(doc);
				}),
			context,
		);
	}

	/** The session's committed changes, file by file, measured from where the session's own work began. */
	async diff(id: number, context: Context): Promise<SessionDiff> {
		const doc = await this.#session(id, context);
		const workspace = this.#deps.workspace(id);
		const from = await comparisonPoint(workspace, doc.startCommit ?? "HEAD", doc.base);
		return { base: doc.base, files: await diffFiles(workspace, from), uncommitted: (await uncommitted(workspace)).length };
	}

	/**
	 * How many commits of `branch` in a session's clone GitHub does not have yet, as last fetched; undefined when the
	 * clone is gone or has no such branch, which offering the branch for a new session can live without.
	 */
	async unpushed(id: number, branch: string): Promise<number | undefined> {
		const workspace = this.#deps.workspace(id);
		if (!(await isRepository(workspace))) return undefined;
		return unpushedCount(workspace, branch).catch(() => undefined);
	}
}
