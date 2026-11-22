// Fake mode's model: pi-ai's faux provider, scripted as a function of each request's messages, so it plays the whole
// zero-shot flow (explore, questions, plan, edits, commits, progress, report) the same way in every conversation at
// once. The step a request is at is read from the ID of the newest tool call, which survives compaction because the
// kept tail always ends with it. Directives in the task, such as [no-report], steer the scenario for tests.
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	calculateCost,
	createAssistantMessageEventStream,
	createFauxCore,
	createModels,
	createProvider,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type Message,
	type Model,
	type Models,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import { SUMMARIZER_PROMPT } from "../agent/handoff.ts";
import { SUBMIT_PLAN, UPDATE_PROGRESS } from "../agent/plan.ts";
import { ASK_MULTIPLE, ASK_SINGLE } from "../agent/questions.ts";
import { RECALL } from "../agent/recall.ts";
import { FILE_REPORT } from "../agent/report.ts";

const FAKE_PROVIDER = "picloud-fake";
const FAKE_MODEL = "scripted";

type Step =
	| "explore"
	| "ask"
	| "checklist"
	| "plan"
	| "write-src"
	| "progress-1"
	| "write-test"
	| "progress-2"
	| "commit"
	| "progress-3"
	| "report"
	| "fix-commit"
	| "follow-edit"
	| "follow-commit"
	| "follow-report"
	| "recall"
	| "spin"
	| "build-1"
	| "build-2"
	| "build-3";

const STEPS = new Set<string>([
	"explore", "ask", "checklist", "plan", "write-src", "progress-1", "write-test", "progress-2", "commit", "progress-3",
	"report", "fix-commit", "follow-edit", "follow-commit", "follow-report", "recall", "spin", "build-1", "build-2", "build-3",
]);

/** In [long] scenarios, verbose build output fills the context so compaction happens mid-implementation. */
const BULK = "seq 100000 102500";

let callIds = 0;
const call = (step: Step, name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxToolCall(name, args, { id: `${step}:${++callIds}` });
const tools = (...blocks: Parameters<typeof fauxAssistantMessage>[0][]) =>
	fauxAssistantMessage(blocks.flat() as Parameters<typeof fauxAssistantMessage>[0], { stopReason: "toolUse" });

function textOf(message: Message): string {
	if (message.role === "system") return "";
	if (message.role === "assistant") return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	const content = message.content;
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function systemText(messages: readonly Message[]): string {
	return messages
		.filter((message) => message.role === "system")
		.map((message) => JSON.stringify(message))
		.join("\n");
}

type StepResult = { step: Step; index: number; text: string; isError: boolean };

/** The newest result of a scripted step, skipping recall lookups, which do not move the scenario on. */
function lastStep(messages: readonly Message[]): StepResult | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "toolResult") continue;
		const step = message.toolCallId.split(":")[0] ?? "";
		if (!STEPS.has(step) || step === "recall") continue;
		return { step: step as Step, index, text: textOf(message), isError: message.isError };
	}
	return undefined;
}

/** Questions ending in "?" and requests marked [chat] are answered in prose, without touching the code. */
function isChat(text: string): boolean {
	const message = stripContext(text).trim();
	return message.endsWith("?") || message.includes("[chat]");
}

/** The person's text without the context picloud adds before it (file and skill blocks, attachment notes). */
function stripContext(text: string): string {
	const parts = text.split("\n\n");
	return parts.at(-1) ?? text;
}

/** A small per-conversation counter for injected faults, keyed by Durable's session identity. */
const faults = new Map<string, number>();

function chatReply(text: string): AssistantMessage {
	const question = stripContext(text).replace(/\[chat\]/g, "").trim();
	return fauxAssistantMessage([
		fauxThinking("The person asked a question; answer it directly without changing code."),
		fauxText(`Short answer: **yes**, that works.\n\nYou asked: _${question.slice(0, 200)}_\n\n- \`greet(name)\` lives in \`src/greet.ts\`\n- The tests run with \`node --test test/*.test.ts\``),
	]);
}

function style(messages: readonly Message[]): string {
	const answer = messages.find((message) => message.role === "toolResult" && message.toolCallId.startsWith("ask:"));
	return answer !== undefined && textOf(answer).includes("Three !!!") ? "!!!" : "!";
}

function respond(context: TranscriptContext, options: SimpleStreamOptions | undefined, onRequest?: ScriptedModelOptions["onRequest"]): AssistantMessage {
	const messages = context.messages;
	const summary = systemText(messages).includes(SUMMARIZER_PROMPT.slice(0, 60));
	onRequest?.(summary ? "summary" : "agent");
	if (summary) return summarize(messages);
	if (systemText(messages).includes("context summarization assistant")) return builtInSummary(messages, options);
	const people = messages.filter((message) => message.role === "user").map(textOf);
	const directives = people.join("\n");
	const previous = lastStep(messages);
	const after = previous === undefined ? messages : messages.slice(previous.index + 1);
	const newest = [...after].reverse().find((message) => message.role === "user");
	const nudged = after.some((message) => message.role === "user" && textOf(message).startsWith("[Automatic continuation"));

	if (directives.includes("[model-error]") && previous?.step === "progress-1") {
		const key = options?.sessionId ?? "none";
		// Once per conversation: an error pi-ai does not classify as transient fails the run without a retry.
		const count = faults.get(key) ?? 0;
		if (count < 1) {
			faults.set(key, count + 1);
			return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Scripted model failure" });
		}
	}

	if (previous === undefined) {
		const task = newest === undefined ? "" : textOf(newest);
		if (isChat(task)) return chatReply(task);
		if (directives.includes("[spin]")) return spin(0);
		return tools(
			fauxThinking("Look at the project layout and its instructions before asking anything."),
			fauxText("Let me look around the repository first."),
			call("explore", "bash", {
				// The build id is printed last, so it stays in the output the bash tool keeps.
				command: `ls -R | head -40; cat AGENTS.md 2>/dev/null; ${directives.includes("[long]") ? `${BULK} && ` : ""}echo "build id: $((4000+817))"`,
			}),
		);
	}
	if ((previous.step === "report" && !previous.isError) || previous.step === "follow-report") {
		const request = newest === undefined ? "" : textOf(newest);
		if (isChat(request)) return chatReply(request);
		return tools(call("follow-edit", "write", { path: `docs/follow-up-${messages.length}.md`, content: `# Follow-up\n\n${stripContext(request)}\n` }));
	}
	if (previous.step === "spin" && newest !== undefined) {
		// A steer reached the spinning run: it stops and says what it heard.
		return fauxAssistantMessage(`Stopping, as you said: ${stripContext(textOf(newest))}`);
	}
	if (directives.includes("[recall]") && people.some((text) => text.includes("<summary>")) && !messages.some((message) => message.role === "toolResult" && message.toolCallId.startsWith("recall:"))) {
		return tools(call("recall", RECALL, { query: "build id" }));
	}
	return next(previous, messages, directives, nudged);
}

function spin(turn: number): AssistantMessage {
	return tools(call("spin", "bash", { command: `echo turn ${turn}` }));
}

function next(previous: StepResult, messages: readonly Message[], directives: string, nudged: boolean): AssistantMessage {
	const long = directives.includes("[long]");
	const build = (step: "build-1" | "build-2" | "build-3") => tools(call(step, "bash", { command: `node --test test/*.test.ts --test-reporter=spec 2>&1 | tail -3; ${BULK}` }));
	switch (previous.step) {
		case "build-1":
			return tools(call("progress-1", UPDATE_PROGRESS, { completed: [1], note: "Added shout()" }));
		case "build-2":
			return tools(call("progress-2", UPDATE_PROGRESS, { completed: [2] }));
		case "build-3":
			return tools(call("progress-3", UPDATE_PROGRESS, { completed: [3] }));
		case "spin":
			return spin(messages.length);
		case "explore":
			return tools(
				fauxText("I have two questions before I plan."),
				call("ask", ASK_SINGLE, {
					questions: [
						{
							question: "How should the new shout() function end its greeting?",
							options: [
								{ label: "One !", description: "HELLO, ADA!" },
								{ label: "Three !!!", description: "HELLO, ADA!!!" },
							],
							recommended: "One !",
						},
						{
							question: "Where should it live?",
							options: [{ label: "src/shout.ts" }, { label: "src/greet.ts" }],
							recommended: "src/shout.ts",
						},
					],
				}),
			);
		case "ask":
			if (directives.includes("[checklist]")) {
				return tools(
					call("checklist", ASK_MULTIPLE, {
						questions: [{ question: "What else should come with it?", options: [{ label: "A test" }, { label: "Docs" }, { label: "A changelog line" }] }],
					}),
				);
			}
			return plan(undefined);
		case "checklist":
			return plan(undefined);
		case "plan":
			if (previous.text.includes("approved the plan")) {
				const ending = style(messages);
				return tools(
					call("write-src", "write", {
						path: "src/shout.ts",
						content: `import { greet } from "./greet.ts";\n\nexport function shout(name: string): string {\n\treturn greet(name).toUpperCase().replace(/!$/, "${ending}");\n}\n`,
					}),
				);
			}
			return plan(previous.text);
		case "write-src":
			if (long) return build("build-1");
			return tools(call("progress-1", UPDATE_PROGRESS, { completed: [1], note: "Added shout()" }));
		case "progress-1":
			return tools(
				call("write-test", "write", {
					path: "test/shout.test.ts",
					content: `import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { shout } from "../src/shout.ts";\n\ntest("shouts", () => {\n\tassert.match(shout("Ada"), /^HELLO, ADA!/);\n});\n`,
				}),
			);
		case "write-test":
			if (long) return build("build-2");
			return tools(call("progress-2", UPDATE_PROGRESS, { completed: [2] }));
		case "progress-2":
			if (directives.includes("[dirty-report]")) return tools(call("commit", "bash", { command: "node --test test/*.test.ts" }));
			return tools(call("commit", "bash", { command: 'node --test test/*.test.ts && git add -A && git commit -q -m "Add shout()" && git log --oneline -1' }));
		case "commit":
			if (long) return build("build-3");
			return tools(call("progress-3", UPDATE_PROGRESS, { completed: [3] }));
		case "progress-3":
			if (directives.includes("[never-report]") || (directives.includes("[no-report]") && !nudged)) {
				return fauxAssistantMessage("All steps are done.");
			}
			return report(messages);
		case "report":
			return tools(call("fix-commit", "bash", { command: 'git add -A && git commit -q -m "Add shout()" && git status --short' }));
		case "fix-commit":
			return report(messages);
		case "follow-edit":
			return tools(call("follow-commit", "bash", { command: 'git add -A && git commit -q -m "Follow-up" && git log --oneline -1' }));
		case "follow-commit":
			return tools(
				call("follow-report", FILE_REPORT, {
					summary: "Made the follow-up change.",
					changes: ["Added a follow-up note"],
					verification: "Committed; no code changed.",
					notes: "",
					learned: "Run the tests with `node --test test/*.test.ts`.",
				}),
			);
		case "recall":
		case "follow-report":
			return fauxAssistantMessage("Done.");
	}
}

function plan(feedback: string | undefined): AssistantMessage {
	const revised = feedback !== undefined;
	const quoted = feedback?.match(/"""\n([\s\S]*?)\n"""/)?.[1];
	return tools(
		call("plan", SUBMIT_PLAN, {
			title: revised ? "Add shout() (revised)" : "Add shout()",
			summary: revised ? `Add a shout() greeting, revised for: ${quoted ?? "the feedback"}` : "Add a shout() function that greets in capitals, with a test.",
			steps: ["Add src/shout.ts", "Add a test", "Run the tests and commit"],
		}),
	);
}

function report(messages: readonly Message[]): AssistantMessage {
	const recalled = messages.find((message) => message.role === "toolResult" && message.toolCallId.startsWith("recall:"));
	const id = recalled === undefined ? undefined : textOf(recalled).match(/build id: (\d+)/)?.[1];
	return tools(
		call("report", FILE_REPORT, {
			summary: "Added shout(), a capitalised greeting, with a test.",
			changes: ["src/shout.ts: shout(name)", "test/shout.test.ts: covers it"],
			verification: "node --test test/*.test.ts passes.",
			notes: id === undefined ? "" : `The build id from the start of the session was ${id}.`,
			learned: "Run the tests with `node --test test/*.test.ts`; no install step is needed.",
		}),
	);
}

/** Durable's own summarizer, which runs only when picloud's handoff hook fails; [compaction-fails] fails it once. */
function builtInSummary(messages: readonly Message[], options: SimpleStreamOptions | undefined): AssistantMessage {
	const request = messages.filter((message) => message.role === "user").map(textOf).join("\n");
	const key = `builtin:${options?.sessionId ?? "none"}`;
	if (request.includes("[compaction-fails]") && (faults.get(key) ?? 0) < 1) {
		faults.set(key, 1);
		return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Scripted compaction failure" });
	}
	return fauxAssistantMessage("Summary: the plan is being implemented.");
}

/** The scripted summarizer: an update built from the transcript it is given, or a failure when asked for one. */
function summarize(messages: readonly Message[]): AssistantMessage {
	const request = messages.filter((message) => message.role === "user").map(textOf).join("\n");
	if (request.includes("[summarizer-fails]")) return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Scripted summarizer failure" });
	const results = [...request.matchAll(/\[result of (\w+)\]/g)].map((match) => match[1]);
	const latest = results.at(-1) ?? "nothing";
	return fauxAssistantMessage(
		JSON.stringify({
			resume: {
				inProgress: "Working through the approved plan.",
				latestResult: `The last tool to finish was ${latest}.`,
				nextAction: "Continue with the first plan step that is not done.",
			},
			addFindings: [`Compacted ${results.length} tool results.`],
			addFailed: [],
			addOpen: [],
			resolve: [],
		}),
	);
}

/**
 * Durable's faux core reports zero cost; fake mode prices its tokens like a mid-range model, so the spend cap can be
 * exercised without credentials.
 */
function priced(inner: AssistantMessageEventStream, model: Model<string>): AssistantMessageEventStream {
	const outer = createAssistantMessageEventStream();
	void (async () => {
		for await (const event of inner) {
			if (event.type === "done") event.message.usage.cost = calculateCost(model, event.message.usage);
			if (event.type === "error") event.error.usage.cost = calculateCost(model, event.error.usage);
			outer.push(event);
		}
		outer.end();
	})();
	return outer;
}

export type ScriptedModelOptions = {
	/** Small windows force compaction in tests. */
	contextWindow?: number;
	/** Streaming pace, so a phone sees text arrive; unset streams at once. */
	tokensPerSecond?: number;
	/** Told of every request, so tests can count what the model was asked. */
	onRequest?: (kind: "agent" | "summary") => void;
};

export function scriptedModels(options: ScriptedModelOptions = {}): { models: Models; model: ModelRef } {
	const core = createFauxCore({
		api: "picloud-faux",
		provider: FAKE_PROVIDER,
		models: [
			{
				id: FAKE_MODEL,
				name: "Scripted model",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: options.contextWindow ?? 128_000,
				maxTokens: 4096,
			},
		],
		...(options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond }),
	});
	// One scripted response per request: queue it as the request arrives, so the supply never runs out.
	const stream = (model: Model<string>, context: TranscriptContext, streamOptions?: SimpleStreamOptions) => {
		core.appendResponses([(transcript, given) => respond(transcript, given, options.onRequest)]);
		return priced(core.stream(model, context, streamOptions), model);
	};
	const provider = createProvider({
		id: FAKE_PROVIDER,
		name: "picloud fake mode",
		auth: { apiKey: { name: "None", resolve: async () => ({ auth: {} }) } },
		models: core.models,
		api: { stream, streamSimple: stream },
	});
	const models = createModels();
	models.setProvider(provider);
	return { models, model: { provider: FAKE_PROVIDER, modelId: FAKE_MODEL } };
}
