// Fake mode's model: pi-ai's faux provider, scripted as a function of each request's messages, so it plays the whole
// zero-shot flow (explore, questions, plan, edits, commits, progress, report) the same way in every conversation at
// once. The step a request is at is read from the ID of the newest scripted tool call, which survives compaction because
// the scripted summarizer always keeps it. Directives in the task, such as [no-report], steer the scenario for tests.
// With long-term memory on, every report states its memory part; [memory] also searches memory after exploring. In
// a local session, which works in place with nothing to deliver, it lists what it wrote where it would commit.
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
import { CHECKPOINT_HEADER } from "../agent/checkpoint.ts";
import { HANDOFF_REQUEST, WRITE_HANDOFF } from "../agent/handoff.ts";
import { SUBMIT_PLAN, UPDATE_PROGRESS } from "../agent/plan.ts";
import { LOCAL_RULES } from "../agent/prompt.ts";
import { ASK_MULTIPLE, ASK_SINGLE } from "../agent/questions.ts";
import { RECALL } from "../agent/recall.ts";
import { FILE_REPORT } from "../agent/report.ts";
import { SUMMARIZER_PROMPT } from "../agent/summarizer.ts";
import { SURFACE_MEMORIES } from "../memory/directives.ts";
import { SPEECH_PROMPT } from "../speech/script.ts";

const FAKE_PROVIDER = "picloud-fake";
const FAKE_MODEL = "scripted";

type Step =
	| "explore"
	| "surface"
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
	| "handoff"
	| "spin"
	| "build-1"
	| "build-2"
	| "build-3"
	| "probe";

const STEPS = new Set<string>([
	"explore", "surface", "ask", "checklist", "plan", "write-src", "progress-1", "write-test", "progress-2", "commit", "progress-3",
	"report", "fix-commit", "follow-edit", "follow-commit", "follow-report", "recall", "handoff", "spin", "build-1", "build-2", "build-3",
	"probe",
]);

/** Steps that do not move the scenario on: looking up history, and the handoff note picloud asks for. */
const ASIDES = new Set<string>(["recall", "handoff"]);

/** In [long] scenarios, verbose build output fills the context so compaction happens mid-implementation. */
const BULK = "seq 100000 102500";
/** In [backstop] scenarios, one build prints the most bash keeps (50 KB), so a single round passes Durable's thresholds. */
const FLOOD = 'seq -f "%032g" 1 2000';

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

/** The newest result of a scripted step, skipping the asides. */
function lastStep(messages: readonly Message[]): StepResult | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "toolResult") continue;
		const step = message.toolCallId.split(":")[0] ?? "";
		if (!STEPS.has(step) || ASIDES.has(step)) continue;
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
	const system = systemText(messages);
	const kind: RequestKind = system.includes(SUMMARIZER_PROMPT.slice(0, 60)) ? "summary" : system.includes(SPEECH_PROMPT.slice(0, 60)) ? "speech" : "agent";
	const lastUser = messages.findLast((message) => message.role === "user");
	onRequest?.(kind, lastUser === undefined ? "" : textOf(lastUser));
	if (kind === "summary") return summarize(messages);
	if (kind === "speech") return speechScript(lastUser === undefined ? "" : textOf(lastUser));
	if (system.includes("context summarization assistant")) return builtInSummary(messages, options);
	const people = messages.filter((message) => message.role === "user").map(textOf);
	const directives = people.join("\n");
	const previous = lastStep(messages);
	const after = previous === undefined ? messages : messages.slice(previous.index + 1);
	const newest = [...after].reverse().find((message) => message.role === "user");
	const nudged = after.some((message) => message.role === "user" && textOf(message).startsWith("[Automatic continuation"));

	if (newest !== undefined && textOf(newest) === HANDOFF_REQUEST && !directives.includes("[ignore-handoff]")) {
		const where = previous === undefined ? "starting out" : `just finished the ${previous.step} step`;
		return tools(call("handoff", WRITE_HANDOFF, { text: `I have ${where} of the approved plan. Next I continue with the step after it, then mark progress. Nothing is blocking me.` }));
	}

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
		if (directives.includes("[probe]")) return probe(directives, messages);
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
	const recalled = messages.some((message) => message.role === "toolResult" && message.toolCallId.startsWith("recall:"));
	if (directives.includes("[recall]") && people.some((text) => text.includes(CHECKPOINT_HEADER)) && !recalled) {
		return tools(call("recall", RECALL, { query: "build id" }));
	}
	// A condensed result says where the full one is; [condense] follows the pointer once, as an agent needing it would.
	const pointer = messages.flatMap((message) => (message.role === "toolResult" ? [/^\[Condensed at compaction:[\s\S]*The full result is entry (\d+)/.exec(textOf(message))?.[1]] : [])).find((id) => id !== undefined);
	if (directives.includes("[condense]") && pointer !== undefined && !recalled) {
		return tools(call("recall", RECALL, { entry: Number(pointer) }));
	}
	return next(previous, messages, directives, nudged, memoryOffered(system), system.includes(LOCAL_RULES));
}

/** Whether the request offers surface_memories, and so whether a report must state its memory part. */
function memoryOffered(system: string): boolean {
	return system.includes(`"name":"${SURFACE_MEMORIES}"`);
}

/** The [memory] scenario's search: a distill naming the fixture's machinery, as the prompt asks. */
const MEMORY_QUERY =
	"Add shout() to demo/greeter, built on greet() in src/greet.ts, with a test. The surrounding work: src/greet.ts and test/greet.test.ts, run by the node:test suite with `node --test test/*.test.ts` through Node's type stripping.";

/** What a [memory] report records when its search found nothing: one row, written to the create rules. */
export const SCRIPTED_MEMORY =
	"`node --test test/*.test.ts` in demo/greeter runs src/greet.ts and test/greet.test.ts through Node's type stripping with no build or install step, so an import without its `.ts` extension fails with ERR_MODULE_NOT_FOUND. Verify stale by: running the node:test suite after removing the `.ts` extension from the import in test/greet.test.ts.";

/**
 * A report's memory part: empty, or for [memory] the surfaced ids rated helpful and, when nothing was found, one new
 * memory. [unrated] leaves the ratings out until a report has been refused for it.
 */
function memoryPart(messages: readonly Message[], directives: string) {
	const empty = { create: [] as string[], helpful: [] as { id: string; helpful: boolean }[], edit: [], delete: [] };
	if (!directives.includes("[memory]")) return empty;
	const surfaced = messages.find((message) => message.role === "toolResult" && message.toolCallId.startsWith("surface:"));
	const ids = surfaced === undefined ? [] : [...textOf(surfaced).matchAll(/^\[\d+\] id: ([0-9a-f]+)/gm)].map((match) => match[1]!);
	const refused = messages.some((message) => message.role === "toolResult" && message.toolName === FILE_REPORT && message.isError);
	const rated = directives.includes("[unrated]") && !refused ? [] : ids.map((id) => ({ id, helpful: true }));
	return { ...empty, create: ids.length === 0 ? [SCRIPTED_MEMORY] : [], helpful: rated };
}

function spin(turn: number): AssistantMessage {
	return tools(call("spin", "bash", { command: `echo turn ${turn}` }));
}

/**
 * [probe] runs the task's `$ command`, `read PATH` and `write PATH` lines with bash, read and write, one call at a time
 * so each sees what the one before did, then replies. Tests read the tool results.
 */
function probe(directives: string, messages: readonly Message[]): AssistantMessage {
	const calls = directives.split("\n").flatMap((line): [string, Parameters<typeof fauxToolCall>[1]][] => {
		if (line.startsWith("$ ")) return [["bash", { command: line.slice(2) }]];
		if (line.startsWith("read ")) return [["read", { path: line.slice(5) }]];
		if (line.startsWith("write ")) return [["write", { path: line.slice(6), content: "probe\n" }]];
		return [];
	});
	const done = messages.filter((message) => message.role === "toolResult" && message.toolCallId.startsWith("probe:")).length;
	const next = calls[done];
	return next === undefined ? fauxAssistantMessage("Probed.") : tools(call("probe", ...next));
}

function next(previous: StepResult, messages: readonly Message[], directives: string, nudged: boolean, memory: boolean, local: boolean): AssistantMessage {
	const long = directives.includes("[long]");
	const build = (step: "build-1" | "build-2" | "build-3") => {
		const bulk = step === "build-2" && directives.includes("[backstop]") ? FLOOD : BULK;
		return tools(call(step, "bash", { command: `node --test test/*.test.ts --test-reporter=spec 2>&1 | tail -3; ${bulk}` }));
	};
	switch (previous.step) {
		case "build-1":
			return tools(call("progress-1", UPDATE_PROGRESS, { completed: [1], note: "Added shout()" }));
		case "build-2":
			return tools(call("progress-2", UPDATE_PROGRESS, { completed: [2] }));
		case "build-3":
			return tools(call("progress-3", UPDATE_PROGRESS, { completed: [3] }));
		case "spin":
			return spin(messages.length);
		case "probe":
			return probe(directives, messages);
		case "explore":
			if (memory && directives.includes("[memory]")) return tools(call("surface", SURFACE_MEMORIES, { query: MEMORY_QUERY }));
			return questions();
		case "surface":
			return questions();
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
			if (local) return tools(call("commit", "bash", { command: "pwd && ls src test" }));
			if (directives.includes("[dirty-report]")) return tools(call("commit", "bash", { command: "node --test test/*.test.ts" }));
			return tools(call("commit", "bash", { command: 'node --test test/*.test.ts && git add -A && git commit -q -m "Add shout()" && git log --oneline -1' }));
		case "commit":
			if (long) return build("build-3");
			return tools(call("progress-3", UPDATE_PROGRESS, { completed: [3] }));
		case "progress-3":
			if (directives.includes("[never-report]") || (directives.includes("[no-report]") && !nudged)) {
				return fauxAssistantMessage("All steps are done.");
			}
			return report(messages, directives, memory);
		case "report":
			return tools(call("fix-commit", "bash", { command: 'git add -A && git commit -q -m "Add shout()" && git status --short' }));
		case "fix-commit":
			return report(messages, directives, memory);
		case "follow-edit":
			if (local) return tools(call("follow-commit", "bash", { command: "ls docs" }));
			return tools(call("follow-commit", "bash", { command: 'git add -A && git commit -q -m "Follow-up" && git log --oneline -1' }));
		case "follow-commit":
			return tools(
				call("follow-report", FILE_REPORT, {
					headline: "Made the follow-up change.",
					summary: "",
					outcome: "complete",
					endState: [],
					changes: [{ change: "Added a follow-up note under docs/", files: [] }],
					checks: [{ command: "git log --oneline -1", result: "passed", detail: "Committed; no code changed." }],
					deviations: [],
					notes: [],
					learned: "Run the tests with `node --test test/*.test.ts`.",
					...(memory ? { memory: memoryPart(messages, directives) } : {}),
				}),
			);
		case "recall":
		case "handoff":
		case "follow-report":
			return fauxAssistantMessage("Done.");
	}
}

function questions(): AssistantMessage {
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
}

function plan(feedback: string | undefined): AssistantMessage {
	const revised = feedback !== undefined;
	const quoted = feedback?.match(/"""\n([\s\S]*?)\n"""/)?.[1];
	return tools(
		call("plan", SUBMIT_PLAN, {
			title: revised ? "Add shout() (revised)" : "Add shout()",
			goal: revised
				? `Add a shout() greeting, revised for: ${quoted ?? "the feedback"}`
				: "Add a `shout()` function that greets in capitals, built on `greet()`, with a test.",
			endState: ['`shout("Ada")` returns `"HELLO, ADA!"`', "`greet()` behaves exactly as before", "`node --test test/*.test.ts` passes"],
			decisions: [
				{ choice: "Put it in its own file, `src/shout.ts`", reason: "Keeps `src/greet.ts` to one function, as the repository does" },
				{ choice: "Build on `greet()` rather than repeat its template", reason: "One place decides the greeting's wording" },
			],
			steps: [
				{ text: "Add `shout(name)`", files: ["src/shout.ts"] },
				{ text: "Add a test for it", files: ["test/shout.test.ts"] },
				{ text: "Run the tests and commit", files: [] },
			],
			verification: ["node --test test/*.test.ts"],
			outOfScope: ["Changing `greet()` or its test"],
			risks: [],
			citations: [
				{ ref: "src/greet.ts:1-3", note: "`greet()` builds the greeting that `shout()` will capitalise" },
				{ ref: "test/greet.test.ts", note: "The test style to follow: `node:test` with strict assertions" },
			],
		}),
	);
}

function report(messages: readonly Message[], directives: string, memory: boolean): AssistantMessage {
	const recalled = messages.find((message) => message.role === "toolResult" && message.toolCallId.startsWith("recall:"));
	const id = recalled === undefined ? undefined : textOf(recalled).match(/build id: (\d+)/)?.[1];
	return tools(
		call("report", FILE_REPORT, {
			headline: "Added shout(), a capitalised greeting, with a test.",
			summary: "",
			outcome: "complete",
			endState: [
				{ criterion: '`shout("Ada")` returns `"HELLO, ADA!"`', met: true, evidence: "Asserted in `test/shout.test.ts`, which passes" },
				{ criterion: "`greet()` behaves exactly as before", met: true, evidence: "`src/greet.ts` is unchanged and its test passes" },
				{ criterion: "`node --test test/*.test.ts` passes", met: true, evidence: "2 tests, 0 failures" },
			],
			changes: [
				{ change: "Added `shout(name)`, built on `greet()`", files: ["src/shout.ts"] },
				{ change: "Added a test for it", files: ["test/shout.test.ts"] },
			],
			checks: [{ command: "node --test test/*.test.ts", result: "passed", detail: "2 tests, 0 failures" }],
			deviations: [],
			notes: id === undefined ? [] : [`The build id from the start of the session was ${id}.`],
			learned: "Run the tests with `node --test test/*.test.ts`; no install step is needed.",
			...(memory ? { memory: memoryPart(messages, directives) } : {}),
		}),
	);
}

/**
 * The scripted speech rewrite, mechanical so tests know what they will hear: a code block becomes one sentence, a link
 * its text, each list item and heading a sentence, and Markdown's markers go. [speech-fails] fails it.
 */
function speechScript(markdown: string): AssistantMessage {
	if (markdown.includes("[speech-fails]")) return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Scripted speech failure" });
	const paragraphs = markdown
		.replace(/```[\s\S]*?(?:```|$)/g, "\n\nA code block.\n\n")
		.split(/\n\s*\n/)
		.map((block) =>
			block
				.split("\n")
				.map((line) =>
					line
						.replace(/^\s*(?:#+|[-*+]|\d+\.|>)\s+/, "")
						.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
						.replace(/[*_`#]/g, "")
						.trim(),
				)
				.filter((line) => line !== "")
				.map((line) => (/[.!?:]$/.test(line) ? line : `${line}.`))
				.join(" "),
		)
		.filter((paragraph) => paragraph !== "");
	return fauxAssistantMessage(paragraphs.join("\n\n"));
}

/** Durable's own summarizer, which runs only when picloud's backstop hook fails; [compaction-fails] fails it once. */
function builtInSummary(messages: readonly Message[], options: SimpleStreamOptions | undefined): AssistantMessage {
	const request = messages.filter((message) => message.role === "user").map(textOf).join("\n");
	const key = `builtin:${options?.sessionId ?? "none"}`;
	if (request.includes("[compaction-fails]") && (faults.get(key) ?? 0) < 1) {
		faults.set(key, 1);
		return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Scripted compaction failure" });
	}
	return fauxAssistantMessage("Summary: the plan is being implemented.");
}

type PromptEntry = { id: number; role: string; valid: boolean; text: string };

function promptEntries(section: string): PromptEntry[] {
	return [...section.matchAll(/<entry id="(\d+)" kind="[^"]*" role="([^"]*)"(?: valid_cutpoint="(true|false)")?>\n([\s\S]*?)\n<\/entry>/g)].map((match) => ({
		id: Number(match[1]),
		role: match[2] ?? "",
		valid: match[3] === "true",
		text: match[4] ?? "",
	}));
}

function section(text: string, tag: string): string | undefined {
	return new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text)?.[1];
}

/**
 * The scripted summarizer. By default it keeps the runway from the newest scripted call, which the scripted agent reads
 * its step from, and evolves the previous checkpoint: its verified list gains one line per compaction. Directives: an
 * invalid cut ([cut-invalid]), the earliest cut with every long result condensed ([condense]), an error
 * ([summarizer-fails]) and a reply with no checkpoint in it ([summarizer-garbage]).
 */
function summarize(messages: readonly Message[]): AssistantMessage {
	const request = messages.filter((message) => message.role === "user").map(textOf).join("\n");
	if (request.includes("[summarizer-fails]")) return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Scripted summarizer failure" });
	if (request.includes("[summarizer-garbage]")) return fauxAssistantMessage("Sure! Here is a quick summary: the agent did some work.");
	const history = promptEntries(section(request, "new_history_to_compact") ?? "");
	const kept = promptEntries(section(request, "kept_recent_context") ?? "");
	const valid = kept.filter((entry) => entry.valid);
	const scripted = valid.filter((entry) => entry.role === "assistant" && /\[call (?!write_handoff)/.test(entry.text));
	const condense = request.includes("[condense]");
	const cut = request.includes("[cut-invalid]")
		? (kept.find((entry) => entry.role === "toolResult")?.id ?? 999_999)
		: condense
			? valid[0]?.id
			: (scripted.at(-1) ?? valid.at(-1))?.id;
	const condensed = condense
		? kept.filter((entry) => entry.role === "toolResult" && entry.text.includes("characters left out") && !entry.text.startsWith(`[result of ${WRITE_HANDOFF}]`))
		: [];
	const verified = [...(section(request, "previous_checkpoint") ?? "").matchAll(/^ {2}- Compaction \d+:.*$/gm)].map((match) => match[0]);
	const latest = [...history.map((entry) => entry.text).join("\n").matchAll(/\[result of (\w+)\]/g)].at(-1)?.[1] ?? "nothing";
	verified.push(`  - Compaction ${verified.length + 1}: compacted ${history.length} entries; the newest compacted result was from ${latest}.`);
	const handoff = section(request, "agent_handoff");
	const decision = [
		"<cutpoint_decision>",
		`<recommended_cut_before_entry_id>${cut ?? ""}</recommended_cut_before_entry_id>`,
		"<cutpoint_reasoning>The newest scripted call and its result are the runway to the next step.</cutpoint_reasoning>",
		"</cutpoint_decision>",
		...(condensed.length === 0
			? []
			: ["<condense>", ...condensed.map((entry) => `<tool_result entry_id="${entry.id}">Printed a long build log; the build finished.</tool_result>`), "</condense>"]),
	];
	const body = [
		"STATE AT COMPACTION BOUNDARY:",
		"- Active task: Working through the approved plan.",
		"- Most recent request from the person: as in their words.",
		`- Current implementation state: the newest compacted result was from ${latest}.`,
		`- Context needed to continue: ${handoff === undefined ? "the kept entries." : "the agent's handoff note, kept after this checkpoint."}`,
		"",
		"EVIDENCE TIERS:",
		"- Verified from session and tool history:",
		...verified,
		"- Requirements the person stated: as in their words.",
		"- Inferences: none.",
		"",
		"CODE REFERENCES:",
		"- Files and paths: src/shout.ts, test/shout.test.ts",
		"",
		"DECISIONS AND RATIONALE:",
		"- Decisions made: follow the approved plan.",
		"",
		"COMMANDS, TESTS, AND FAILURES:",
		"- Tests run: node --test test/*.test.ts",
		"",
		"WORK QUEUE:",
		"- Next exact steps: Continue with the first plan step that is not done.",
		"",
		"OPEN THREADS:",
		"- Open questions: none.",
		"",
		"COMPACTED HISTORY SYNOPSIS:",
		"The agent explored the repository, asked its questions, planned, and is implementing the plan.",
	];
	return fauxAssistantMessage([...decision, "", ...body].join("\n"));
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

/** What a request to the scripted model is for: the agent's turn, a compaction checkpoint or a speakable script. */
export type RequestKind = "agent" | "summary" | "speech";

export type ScriptedModelOptions = {
	/** Small windows force compaction in tests. */
	contextWindow?: number;
	/** Streaming pace, so a phone sees text arrive; unset streams at once. */
	tokensPerSecond?: number;
	/** Told of every request and the text of its last user message, so tests can see what the model was asked. */
	onRequest?: (kind: RequestKind, text: string) => void;
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
