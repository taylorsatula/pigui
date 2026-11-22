import type { Context } from "@earendil-works/chord/context";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { Harness, ModelRef } from "@earendil-works/pi-durable";
import type { Logger } from "../log.ts";
import type { Memory } from "../memory/store.ts";
import type { Notifications } from "../notify.ts";

/** Test seams: points where a test can hold the code still to simulate a crash at an exact moment. */
export type Faults = {
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
	/** The summarizer's model when it is not the session's (`PICLOUD_COMPACTION_MODEL`); used only while Pi can sign in to it. */
	compactionModel: ModelRef | undefined;
	/** Pi's configuration directory, read by Pi's loaders for global context files and skills. */
	agentDir: string;
	workspace(session: number): string;
	/** Long-term memory; undefined when it is off, and then no tool, report part or prompt text mentions it. */
	memory: Memory | undefined;
	faults: Faults;
};
