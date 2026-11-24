// Reading a reply aloud, as the phone asks for it after a tap: the session's model writes the speakable script, whose
// cost counts toward the session as the summarizer's does, and the synthesizer reads each segment of it.
import type { Context } from "@earendil-works/chord/context";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import type { ScriptLine } from "../../shared/api.ts";
import { countSpend } from "../agent/budget.ts";
import type { AgentServices } from "../agent/services.ts";
import { SessionDocToken } from "../documents.ts";
import { HttpError, notFound } from "../errors.ts";
import { errorKind, type Logger } from "../log.ts";
import type { Synthesizer } from "./kokoro.ts";
import { writeScript } from "./script.ts";

export type SpeechDeps = {
	harness: () => Harness;
	agent: Pick<AgentServices, "models" | "model">;
	synthesizer: Synthesizer;
	log: Logger;
	now: () => number;
};

export class Speech {
	readonly #deps: SpeechDeps;

	constructor(deps: SpeechDeps) {
		this.#deps = deps;
	}

	/** The model a session runs with, which writes its scripts; refused before any of the response is sent. */
	async modelOf(id: number, context: Context): Promise<Model<Api>> {
		const harness = this.#deps.harness();
		const doc = await harness.snapshot(SessionDocToken, id as ConversationId, context);
		const conversation = doc?.id === undefined ? undefined : await harness.conversation(id as ConversationId, context);
		const ref = (await conversation?.agent(context))?.model;
		if (ref === undefined) throw notFound("The session");
		const model = this.#deps.agent.model(ref.provider, ref.modelId);
		if (model === undefined) {
			throw new HttpError(409, `This session's model, ${ref.provider}/${ref.modelId}, is not available on the server.`, "Check Pi's models and sign-in on the server.");
		}
		return model;
	}

	/** Write the speakable script of `markdown`, sending each segment as it is ready, then `done` or what went wrong. */
	async script(id: number, model: Model<Api>, markdown: string, send: (line: ScriptLine) => void, signal: AbortSignal, context: Context): Promise<void> {
		const started = Date.now();
		let count = 0;
		// How long the model took to its first sentence: the part of the wait before the first words that is not synthesis.
		let firstMs: number | undefined;
		const result = await writeScript(this.#deps.agent.models(), model, markdown, {
			now: this.#deps.now(),
			signal,
			segment: (text) => {
				count++;
				firstMs ??= Date.now() - started;
				send({ t: "segment", text });
			},
		});
		const spend = result.spend;
		if (spend !== undefined) await this.#deps.harness().commit((tx) => countSpend(tx, id as ConversationId, spend), context);
		this.#deps.log.info("speech.script", { session: id, segments: count, firstMs, ms: Date.now() - started, failed: result.problem !== undefined });
		if (result.problem === undefined) send({ t: "done" });
		else send({ t: "error", error: `The model could not prepare the reply for reading: ${result.problem}`, hint: "Tap the speaker to try again." });
	}

	/** One segment read aloud, as a WAV file. */
	async audio(text: string, signal: AbortSignal): Promise<Uint8Array> {
		const started = Date.now();
		try {
			const wav = await this.#deps.synthesizer.synthesize(text, signal);
			this.#deps.log.info("speech.audio", { chars: text.length, ms: Date.now() - started });
			return wav;
		} catch (error) {
			signal.throwIfAborted();
			this.#deps.log.error("speech.failed", { error: errorKind(error) });
			throw new HttpError(500, "The server could not read this aloud.", "Try again; if it keeps failing, check the server's journal.");
		}
	}
}
