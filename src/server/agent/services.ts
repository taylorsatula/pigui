import type { Context } from "@earendil-works/chord/context";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { Harness, ModelRef } from "@earendil-works/pi-durable";
import type { SessionDoc } from "../../shared/session.ts";
import type { Logger } from "../log.ts";
import type { Memory } from "../memory/store.ts";
import type { Notifications } from "../notify.ts";
import type { AgentFaults } from "../subagents/extension.ts";

/** Test seams: points where a test can hold the code still to simulate a crash at an exact moment. */
export type Faults = AgentFaults & {
	/** After a card's commit, before its tool parks. */
	afterCard?: (context: Context) => Promise<void>;
	/** At the start of the backstop's compaction hook; throwing leaves the compaction to Durable's built-in summarizer. */
	beforeBackstop?: (context: Context) => Promise<void>;
	/** After the summarizer's reply is memoized, before the checkpoint is placed. */
	afterSummarizer?: (context: Context) => Promise<void>;
};

/** What the agent extension needs from the server around it. */
export type AgentServices = {
	now(): number;
	log: Logger;
	notifications: Notifications;
	/** Set once the Harness is open; tools and hooks only run after that. */
	harness(): Harness;
	models(): Models;
	/** A conversation's model, resolved against the catalog. */
	model(provider: string, modelId: string): Model<Api> | undefined;
	/** The summarizer's model when it is not the session's (`PIGUI_COMPACTION_MODEL`); used only while Pi can sign in to it. */
	compactionModel: ModelRef | undefined;
	/** Pi's configuration directory, read by Pi's loaders for global context files and skills. */
	agentDir: string;
	/** pigui's own directory for a session: a repository session's clone, and every session's attachments. */
	workspace(session: number): string;
	/**
	 * Where the agent works: its clone for a repository session, the chosen directory for a local one. Everything the
	 * agent is shown or resolves against (its cwd, the prompt, project context, skills, references) goes through here.
	 */
	workingDir(doc: Readonly<SessionDoc>): string;
	/** Runs on the person's own computer (pigui OnPrem), whose commands run as them, with their credentials. */
	onPrem: boolean;
	/** Agent commands and file tools run in the Landlock sandbox. */
	sandboxed: boolean;
	/** Long-term memory; undefined when it is off, and then no tool, report part or prompt text mentions it. */
	memory: Memory | undefined;
	faults: Faults;
};
