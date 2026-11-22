// Daily upkeep, as one Durable task that sleeps a day between rounds: back up the database, remove workspaces of old
// archived sessions, and drop stale uploads. A sleeping task holds no process and survives restarts, so there is no
// timer or scheduler of picloud's own.
import { DatabaseSync, backup } from "node:sqlite";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { type ConversationId, defineTask, type Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { editSession, SessionDocToken, SessionIndexToken } from "./docs.ts";
import { isAncestor, isRepository, refExists, uncommitted, unpushedCount } from "./git.ts";
import { errorKind, type Logger } from "./log.ts";

const DAY = 24 * 60 * 60 * 1000;
/** Archived sessions untouched this long lose their workspace, if nothing in it is unpushed. */
export const CLEANUP_AFTER_MS = 7 * DAY;
const BACKUPS_KEPT = 14;
const UPLOADS_KEPT_MS = DAY;

export type MaintenanceDeps = {
	harness: () => Harness;
	log: Logger;
	now: () => number;
	databaseFile: string;
	backupDir: string;
	uploadsDir: string;
	workspace: (id: number) => string;
	/** A session's scratch directory (its commands' home and tmp), removed with its workspace. */
	scratch: (id: number) => string;
};

export type SweepResult = { backup?: string; cleaned: number[]; kept: number[] };

export class Maintenance {
	readonly #deps: MaintenanceDeps;
	readonly task;

	constructor(deps: MaintenanceDeps) {
		this.#deps = deps;
		this.task = defineTask<null, { phase: "sweep" }, null, object>({
			name: "picloud.maintenance",
			version: 1,
			initial: () => ({ phase: "sweep" }),
			phases: {
				sweep: async (_task, runtime, context) => {
					await this.sweep(context);
					await runtime.sleepUntil(this.#deps.now() + DAY, { phase: "sweep" }, context);
				},
			},
			abort: async (_task, runtime, context) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
			},
		});
	}

	/** Make sure exactly one maintenance task is alive, in the root conversation, which no session uses. */
	async ensureScheduled(context: Context): Promise<void> {
		const harness = this.#deps.harness();
		await harness.root(context);
		await harness.commit(async (tx) => {
			const live = await tx.scanTasks({ conversationId: ROOT_CONVERSATION_ID, kind: this.task.definition.name }, 10);
			if (live.items.some((task) => task.state.status !== "terminal")) return;
			await tx.createTask(this.task, null, { ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID, background: true });
		}, context);
	}

	async sweep(context: Context): Promise<SweepResult> {
		const result: SweepResult = { cleaned: [], kept: [] };
		try {
			result.backup = await this.backup();
		} catch (error) {
			this.#deps.log.error("maintenance.backup_failed", { error: errorKind(error) });
		}
		await this.#pruneUploads();
		const index = await this.#deps.harness().snapshot(SessionIndexToken, context);
		for (const row of Object.values(index?.rows ?? {})) {
			if (!row.archived || this.#deps.now() - row.updatedAt < CLEANUP_AFTER_MS) continue;
			const doc = await this.#deps.harness().snapshot(SessionDocToken, row.id as ConversationId, context);
			if (doc === undefined || doc.cleanedAt !== undefined) continue;
			if (await this.#clean(row.id, doc.branch, doc.base, context)) result.cleaned.push(row.id);
			else result.kept.push(row.id);
		}
		this.#deps.log.info("maintenance.swept", { cleaned: result.cleaned.length, kept: result.kept.length });
		return result;
	}

	/**
	 * Remove a workspace only when git shows nothing in it that GitHub does not have: no uncommitted changes, HEAD on
	 * the session's branch at origin (or already in its base, for a session that changed nothing), and no other local
	 * branch with commits origin lacks.
	 */
	async #clean(id: number, branch: string, base: string, context: Context): Promise<boolean> {
		const workspace = this.#deps.workspace(id);
		if (await isRepository(workspace)) {
			try {
				if ((await uncommitted(workspace)).length > 0 || (await unpushedCount(workspace)) > 0) return false;
				const delivered = await this.#contains(workspace, `refs/remotes/origin/${branch}`);
				if (!delivered && !(await this.#contains(workspace, `refs/remotes/origin/${base}`))) return false;
			} catch (error) {
				this.#deps.log.warn("maintenance.check_failed", { session: id, error: errorKind(error) });
				return false;
			}
		} else if ((await stat(workspace).catch(() => undefined)) !== undefined) {
			// A directory that is not a repository cannot be checked, so it is never removed.
			return false;
		}
		await rm(workspace, { recursive: true, force: true });
		await rm(this.#deps.scratch(id), { recursive: true, force: true });
		await this.#deps.harness().commit(async (tx) => {
			await editSession(tx, id, this.#deps.now(), (doc) => {
				doc.cleanedAt = this.#deps.now();
			});
		}, context);
		return true;
	}

	async #contains(workspace: string, ref: string): Promise<boolean> {
		return (await refExists(workspace, ref)) && (await isAncestor(workspace, "HEAD", ref));
	}

	/** A consistent copy of the database through SQLite's online backup, beside the last few. */
	async backup(): Promise<string> {
		await mkdir(this.#deps.backupDir, { recursive: true });
		const name = `picloud-${new Date(this.#deps.now()).toISOString().slice(0, 10)}.sqlite`;
		const target = join(this.#deps.backupDir, name);
		const source = new DatabaseSync(this.#deps.databaseFile, { readOnly: true });
		try {
			await backup(source, target);
		} finally {
			source.close();
		}
		const backups = (await readdir(this.#deps.backupDir)).filter((file) => /^picloud-\d{4}-\d{2}-\d{2}\.sqlite$/.test(file)).sort();
		for (const old of backups.slice(0, Math.max(0, backups.length - BACKUPS_KEPT))) await rm(join(this.#deps.backupDir, old), { force: true });
		return target;
	}

	async #pruneUploads(): Promise<void> {
		const files = await readdir(this.#deps.uploadsDir).catch(() => [] as string[]);
		for (const file of files) {
			const path = join(this.#deps.uploadsDir, file);
			const info = await stat(path).catch(() => undefined);
			if (info !== undefined && this.#deps.now() - info.mtimeMs > UPLOADS_KEPT_MS) await rm(path, { force: true });
		}
	}
}
