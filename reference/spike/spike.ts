// Spike: verifies the picloud core mechanics against the published @earendil-works/*@1.6.0 packages.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { applyImmutable } from "@earendil-works/chord/delta";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { arr, bool, obj, opt, str } from "@earendil-works/pi-schema";
import {
	type Conversation,
	createRegistry,
	defineDoc,
	defineExtension,
	defineSignal,
	defineTool,
	GenerationTask,
	Harness,
	hook,
	LiveDoc,
	section,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

type SessionInfo = { state: string; title: string };
const Sessions = defineDoc<{ items: Record<string, SessionInfo> }>({
	kind: "picloud.sessions",
	version: 1,
	scope: "session",
	initial: () => ({ items: {} }),
	checkpointWhen: () => false,
});
const Reply = defineSignal({
	name: "picloud.reply",
	version: 1,
	schema: obj({ approved: opt(bool()), text: str() }),
});

const setState = (api: { conversationId: string; commit: Function }, state: string, title?: string) =>
	api.commit(async (tx: any) => {
		const doc = await tx.doc(Sessions);
		const prev = doc.items[api.conversationId] ?? { state, title: "" };
		doc.items[api.conversationId] = { ...prev, state, ...(title ? { title } : {}) };
	}, ctx);

const AskParams = obj({ questions: arr(obj({ header: str(), question: str(), options: arr(obj({ label: str() })) })) });
const askUser = defineTool({
	name: "ask_user",
	description: "Ask the person multiple-choice questions; waits for the answer.",
	parameters: AskParams,
	replay: "safe",
	async execute(_args, api, c) {
		const state = await api.readSignal(Reply, "reply", c);
		if (state !== undefined && "value" in state) {
			await setState(api as any, "planning");
			return { output: [{ type: "text", text: state.value.text }] };
		}
		await setState(api as any, "question");
		return { sleep: { signals: [Reply.key("reply")] } };
	},
});
const PlanParams = obj({ title: str(), steps: arr(str()) });
const submitPlan = defineTool({
	name: "submit_plan",
	description: "Submit the plan for approval; waits for the person.",
	parameters: PlanParams,
	replay: "safe",
	async execute(args, api, c) {
		const state = await api.readSignal(Reply, "reply", c);
		if (state !== undefined && "value" in state) {
			if (state.value.approved) {
				await setState(api as any, "implementing");
				return { output: [{ type: "text", text: "Approved. Implement it now without stopping." }] };
			}
			await setState(api as any, "planning");
			return { output: [{ type: "text", text: `Revise the plan: ${state.value.text}` }] };
		}
		await setState(api as any, "approval", args.title);
		return { sleep: { signals: [Reply.key("reply")] } };
	},
});
const finalReport = defineTool({
	name: "final_report",
	description: "File the final report.",
	parameters: obj({ summary: str() }),
	async execute(_args, api) {
		await setState(api as any, "reported");
		return { output: [{ type: "text", text: "Report filed." }] };
	},
});
const NUDGE = "You have not filed final_report yet. Continue the approved plan, then call final_report.";
const Picloud = defineExtension({
	name: "picloud",
	tools: [askUser, submitPlan, finalReport],
	sections: [section("picloud", () => "You run remotely. Plan, ask, submit_plan, implement, final_report.")],
	hooks: [
		hook(GenerationTask, {
			onYield: async (_answer, api, c) => {
				const doc = await api.snapshot(Sessions, c);
				if (doc?.items[api.conversationId]?.state !== "implementing") return undefined;
				// Count nudges since the plan was approved; stop at the first real user message.
				const page = await api.entries({ order: "descending" }, 100, undefined, c);
				let nudges = 0;
				for (const e of page.items) {
					const m: any = e.model?.[0];
					if (e.kind === "pi.tool-result" && m?.toolName === "submit_plan") break;
					if (e.kind === "pi.user") {
						if (m?.content === NUDGE) nudges++;
						else break;
					}
				}
				return nudges >= 3 ? undefined : { continue: NUDGE };
			},
		}),
	],
});

// Scripted model.
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const call = (name: string, args: any) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
faux.setResponses([
	call("ask_user", { questions: [{ header: "Scope", question: "Which?", options: [{ label: "A" }, { label: "B" }] }] }),
	call("submit_plan", { title: "Write hello", steps: ["write hello.txt"] }),
	call("write", { path: "hello.txt", content: "hi\n" }),
	fauxAssistantMessage("I think I'm done."), // no report: expect a nudge
	call("final_report", { summary: "Wrote hello.txt" }),
	fauxAssistantMessage("Done."),
]);

const registry = createRegistry();
registry.install(CodingTools);
registry.install(Picloud);
const dir = await mkdtemp(join(tmpdir(), "picloud-spike-"));
const workspace = await mkdtemp(join(tmpdir(), "picloud-ws-"));
const open = async () =>
	Harness.open(
		await openNodeSqliteStorage(join(dir, "durable.sqlite")),
		{ models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? workspace }) },
		ctx,
	);
const parked = async (h: Harness, conv: Conversation, name: string) => {
	for (;;) {
		const slot = (await h.snapshot(LiveDoc, conv.id, ctx))?.tools?.find((s) => s.name === name);
		if (slot?.status === "sleeping") return slot.taskId!;
		await new Promise((r) => setTimeout(r, 5));
	}
};

// Process 1: create the session, submit, park on ask_user, then "crash" (close).
const h1 = await open();
const conv1 = await h1.createConversation(
	{ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: workspace, maxTurns: 50 } },
	ctx,
);
await h1.commit(async (tx) => {
	(await tx.doc(Sessions)).items[conv1.id] = { state: "planning", title: "task" };
}, ctx);
const sub = await conv1.submit({ type: "input", content: "Write hello.txt", requestId: "req-1" }, ctx);
const askTask1 = await parked(h1, conv1, "ask_user");
console.log("1. parked on ask_user; sessions doc:", JSON.stringify(await h1.snapshot(Sessions, ctx)));
console.log("   wake while parked:", JSON.stringify(h1.wake()));
await h1.close(ctx);

// Process 2: reopen, attach a watch with a client-side mirror, answer, approve, run to the end.
const h2 = await open();
const conv2 = (await h2.conversation(conv1.id, ctx))!;
h2.resume();
const watch = await conv2.watch(ctx);
let mirror: any = structuredClone(watch.value);
let opsSeen = 0;
watch.start(async (callw) => {
	if (callw.kind !== "value") return;
	mirror = applyImmutable(mirror, callw.ops as any);
	opsSeen += callw.ops.length;
});
const askTask2 = await parked(h2, conv2, "ask_user");
console.log("2. after restart still parked, same task:", askTask1 === askTask2);
console.log("   signal:", JSON.stringify(await h2.signal(askTask2, Reply, "reply", { text: "Scope: A" }, ctx)));
const planTask = await parked(h2, conv2, "submit_plan");
console.log("3. parked on submit_plan; state:", (await h2.snapshot(Sessions, ctx))?.items[conv2.id]?.state);
await h2.signal(planTask, Reply, "reply", { approved: true, text: "" }, ctx);
const settled = await (await h2.submission(sub.id, ctx))!.wait(ctx);
console.log("4. submission:", settled.status, "| file:", JSON.stringify(await readFile(join(workspace, "hello.txt"), "utf8")));
console.log("   final state:", (await h2.snapshot(Sessions, ctx))?.items[conv2.id]?.state);
const page = await conv2.entries({}, 50, undefined, ctx);
const kinds = [...page.items].reverse().map((e) => e.kind);
console.log("   entries:", kinds.join(" "));
const nudged = page.items.some((e) => JSON.stringify(e.model ?? "").includes("not filed final_report"));
console.log("   nudge present:", nudged);
await new Promise((r) => setTimeout(r, 50));
console.log("5. ops applied:", opsSeen, "| mirror equals watch value:", JSON.stringify(mirror) === JSON.stringify(watch.value));
await watch.stop();

// Scenario B: the model never files a report; the nudge must stop after 3.
faux.setResponses([
	call("submit_plan", { title: "Loop", steps: ["x"] }),
	fauxAssistantMessage("stop 1"), fauxAssistantMessage("stop 2"), fauxAssistantMessage("stop 3"), fauxAssistantMessage("stop 4"),
	fauxAssistantMessage("stop 5"),
]);
const convB = await h2.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: workspace } }, ctx);
const subB = await convB.submit({ type: "input", content: "loop" }, ctx);
await h2.signal(await parked(h2, convB, "submit_plan"), Reply, "reply", { approved: true, text: "" }, ctx);
const settledB = await subB.wait(ctx);
const pageB = await convB.entries({}, 50, undefined, ctx);
const nudgesB = pageB.items.filter((e) => (e.model?.[0] as any)?.content === NUDGE).length;
console.log("6. never-reporting run:", settledB.status, "| nudges:", nudgesB, "| model calls left:", faux.getPendingResponseCount());
await h2.close(ctx);
