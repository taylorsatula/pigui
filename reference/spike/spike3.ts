import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { obj, str } from "@earendil-works/pi-schema";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
const echo = defineTool({ name: "step", description: "s", parameters: obj({ n: str() }), async execute(a) { return { output: [{ type: "text", text: `did ${a.n}` }] }; } });
// Scenario decided from the conversation's own last message: concurrency-safe.
const scenario: FauxResponseFactory = (context) => {
	const last: any = context.messages[context.messages.length - 1];
	const call = (n: string) => fauxAssistantMessage(fauxToolCall("step", { n }), { stopReason: "toolUse" });
	if (last.role === "user") return call("1");
	if (last.role === "toolResult" && JSON.stringify(last.content).includes("did 1")) return call("2");
	return fauxAssistantMessage("finished");
};
const faux = fauxProvider();
const topUp = () => { while (faux.getPendingResponseCount() < 8) faux.appendResponses([scenario]); };
const wrapped: FauxResponseFactory = (...args) => { topUp(); return scenario(...args); };
faux.setResponses(Array(8).fill(wrapped));
const models = createModels(); models.setProvider(faux.provider);
const registry = createRegistry(); registry.install(defineExtension({ name: "x", tools: [echo] }));
const h = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
const mk = () => h.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } }, ctx);
const [a, b, c] = await Promise.all([mk(), mk(), mk()]);
const res = await Promise.all([a, b, c].map(async (conv) => (await conv.submit({ type: "input", content: "go" }, ctx)).wait(ctx)));
for (const conv of [a, b, c]) {
	const p = await conv.entries({ order: "ascending" }, 50, undefined, ctx);
	console.log(conv.id, p.items.map((e) => e.kind.replace("pi.", "")).join(" "));
}
console.log("statuses:", res.map((r) => r.status).join(","), "| calls:", faux.state.callCount);
await h.close(ctx);
