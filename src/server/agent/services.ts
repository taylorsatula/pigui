import type { Context } from "@earendil-works/chord/context";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { Harness } from "@earendil-works/pi-durable";
import type { Logger } from "../log.ts";
import type { Notifications } from "../notify.ts";

/** Test seams: points where a test can hold the code still to simulate a crash at an exact moment. */
export type Faults = {
	/** After a card's commit, before its tool parks. */
	afterCard?: (context: Context) => Promise<void>;
	/** At the start of the compaction hook; throwing leaves the compaction to Durable's built-in summarizer. */
	beforeHandoff?: (context: Context) => Promise<void>;
	/** After the handoff's model-written notes are memoized, before the compaction summary is returned. */
	afterHandoffNotes?: (context: Context) => Promise<void>;
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
	/** Pi's configuration directory, read by Pi's loaders for global context files and skills. */
	agentDir: string;
	workspace(session: number): string;
	faults: Faults;
};
