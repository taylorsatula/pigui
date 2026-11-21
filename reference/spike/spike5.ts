import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage, UsageDoc } from "@earendil-works/pi-durable";
const faux = fauxProvider();
faux.setResponses([fauxAssistantMessage("x")]);
const models = createModels(); models.setProvider(faux.provider);
// Wrap Models: patch cost on every completed assistant message.
const wrapped: any = new Proxy(models, { get(t, p, r) {
  const v = Reflect.get(t, p, r);
  if (p !== "streamSimple" && p !== "stream") return typeof v === "function" ? v.bind(t) : v;
  return (...a: any[]) => { const s = v.apply(t, a); const orig = s.result.bind(s);
    s.result = async () => { const m = await orig(); m.usage.cost.total = 0.25; return m; };
    const it = s[Symbol.asyncIterator].bind(s);
    s[Symbol.asyncIterator] = async function* () { for await (const e of it()) { if (e.type === "done") e.message.usage.cost.total = 0.25; yield e; } };
    return s; };
}});
const h = await Harness.open(new MemoryStorage(), { models: wrapped, registry: createRegistry() }, ctx);
const c = await h.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } }, ctx);
await (await c.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
console.log("wrapped cost:", JSON.stringify((await h.snapshot(UsageDoc, c.id, ctx) as any)?.models));
try { await h.commit(async (tx) => { const u: any = await tx.doc(UsageDoc, c.id); u.models["test/x"] = { cost: { total: 9 } }; }, ctx); console.log("direct write ok:", JSON.stringify((await h.snapshot(UsageDoc, c.id, ctx) as any).models["test/x"])); } catch (e: any) { console.log("direct write refused:", e.message); }
await h.close(ctx);
