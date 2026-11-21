// Spike 2: observeDoc, observeConversation (run-end detection), entries paging, UsageDoc, abort while parked.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { obj, str } from "@earendil-works/pi-schema";
import {
	createRegistry, defineDoc, defineExtension, defineSignal, defineTool, Harness, LiveDoc, UsageDoc,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const Sessions = defineDoc<{ items: Record<string, { state: string }> }>({
	kind: "picloud.sessions", version: 1, scope: "session", initial: () => ({ items: {} }), checkpointWhen: () => false,
});
const Reply = defineSignal({ name: "picloud.reply", version: 1, schema: obj({ text: str() }) });
const ask = defineTool({
	name: "ask_user", description: "ask", parameters: obj({ q: str() }), replay: "safe",
	async execute(_a, api, c) {
		const s = await api.readSignal(Reply, "reply", c);
		if (s !== undefined && "value" in s) return { output: [{ type: "text", text: s.value.text }] };
		return { sleep: { signals: [Reply.key("reply")] } };
	},
});
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const registry = createRegistry();
registry.install(defineExtension({ name: "x", tools: [ask] }));
const dir = await mkdtemp(join(tmpdir(), "picloud-spike2-"));
const h = await Harness.open(await openNodeSqliteStorage(join(dir, "d.sqlite")), { models, registry }, ctx);
await h.commit(async (tx) => { await tx.doc(Sessions); }, ctx);

// observeDoc on a session-scoped doc
const docOps: number[] = [];
const obs = await h.observeDoc(Sessions, { advance: (call) => { if (call.kind === "value") docOps.push(call.ops.length); }, end: () => {} }, ctx);
console.log("A. observeDoc returned:", obs === undefined ? "undefined" : "observation", "| initial:", JSON.stringify(obs?.value));
await h.commit(async (tx) => { (await tx.doc(Sessions)).items["x"] = { state: "planning" }; }, ctx);
await h.commit(async (tx) => { (await tx.doc(Sessions)).items["x"]!.state = "idle"; }, ctx);
console.log("   advances after 2 commits:", docOps.length, "ops:", JSON.stringify(docOps));

// observeConversation: detect run start/end; plain answer
faux.setResponses([fauxAssistantMessage("Hello there.")]);
const conv = await h.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } }, ctx);
const transitions: string[] = [];
let wasRunning = false;
const cobs = await h.observeConversation(conv.id, {
	advance: (call) => {
		if (call.kind !== "value") return;
		const live: any = call.value.docs["pi.live"];
		const running = live?.run !== undefined;
		if (running !== wasRunning) transitions.push(running ? "start" : `end(${live?.runFailure?.reason ?? "ok"})`);
		wasRunning = running;
	},
	end: () => {},
}, ctx);
await (await conv.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
await new Promise((r) => setTimeout(r, 20));
console.log("B. observeConversation transitions (plain answer):", transitions.join(" → "));

// abort while parked on ask_user: runFailure reason
transitions.length = 0;
faux.setResponses([fauxAssistantMessage(fauxToolCall("ask_user", { q: "?" }), { stopReason: "toolUse" })]);
const sub = await conv.submit({ type: "input", content: "ask me" }, ctx);
for (;;) { const s = (await h.snapshot(LiveDoc, conv.id, ctx))?.tools?.[0]; if (s?.status === "sleeping") break; await new Promise((r) => setTimeout(r, 5)); }
await conv.abort(ctx);
const settled = await sub.wait(ctx);
await new Promise((r) => setTimeout(r, 20));
console.log("C. abort while parked: submission", settled.status, "| transitions:", transitions.join(" → "));

// model error → runFailure
transitions.length = 0;
faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" })]);

const sub2 = await conv.submit({ type: "input", content: "fail please" }, ctx);
const s2 = await sub2.wait(ctx);
await new Promise((r) => setTimeout(r, 20));
const live2: any = await h.snapshot(LiveDoc, conv.id, ctx);
console.log("D. model error: submission", s2.status, "| runFailure:", JSON.stringify(live2?.runFailure)?.slice(0, 120), "| transitions:", transitions.join(" → "));

// entries paging: newest-first with maxEntryId
const all = await conv.entries({ order: "ascending" }, 100, undefined, ctx);
const ids = all.items.map((e) => e.id);
const before = ids[ids.length - 2]!;
const page = await conv.entries({ maxEntryId: before, order: "descending" }, 3, undefined, ctx);
console.log("E. entry ids:", JSON.stringify(ids), "| page maxEntryId", before, "desc limit 3 →", JSON.stringify(page.items.map((e) => e.id)), "| cursor:", page.cursor !== undefined);

// UsageDoc
const usage: any = await h.snapshot(UsageDoc, conv.id, ctx);
console.log("F. UsageDoc keys:", JSON.stringify(Object.keys(usage ?? {})), "| models:", JSON.stringify(Object.keys(usage?.models ?? {})), "| sample cost:", JSON.stringify(Object.values(usage?.models ?? {})[0]?.cost));
cobs?.detach(); obs?.detach();
await h.close(ctx);
