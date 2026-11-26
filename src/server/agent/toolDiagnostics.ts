// Where tool diagnostics go: the journal, never the screen. The session view shows only one-line human notes; the
// structured diagnostics the harness commits on the tool-result entry (entry.data.diagnostics, which already includes
// the truncation diagnostics added after the afterTool chain) are logged here, one line each, as tool.diagnostics.
// pi-ai validation messages embed the whole arguments payload after "Received arguments:", so the logged message is cut
// before it and capped; the journal never carries a tool's arguments.
import { defineExtension, GenerationTask, hook, ToolResultEntry, type EntryId, type HookApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import type { AgentServices } from "./services.ts";

const RECEIVED = /\n\s*Received arguments:/;
const MESSAGE_MAX = 500;

/** Cut pi-ai's arguments payload tail, and cap what is logged. */
function boundMessage(message: string): string {
	const cut = RECEIVED.exec(message);
	const kept = (cut === null ? message : message.slice(0, cut.index)).trim();
	return kept.length <= MESSAGE_MAX ? kept : `${kept.slice(0, MESSAGE_MAX).trimEnd()}…`;
}

async function logResults(services: AgentServices, results: readonly EntryId[], api: HookApi, context: Context): Promise<void> {
	for (const id of results) {
		const entry = await api.entry(ToolResultEntry, id, context);
		const message = entry?.model?.[0];
		const tool = message?.role === "toolResult" ? message.toolName : undefined;
		for (const diagnostic of entry?.data?.diagnostics ?? []) {
			const level = diagnostic.severity === "error" ? "error" : diagnostic.severity === "warn" ? "warn" : "info";
			services.log[level]("tool.diagnostics", {
				tool: tool ?? "unknown",
				code: diagnostic.code ?? "unknown",
				message: boundMessage(diagnostic.message),
			});
		}
	}
}

export function toolDiagnostics(services: AgentServices) {
	const hooks = hook(GenerationTask, {
		// Logging must never fail the round, so every failure is swallowed into a line of its own.
		afterTools: async (_assistant, results, api, context) => {
			try {
				await logResults(services, results, api, context);
			} catch (error) {
				services.log.warn("tool.diagnostics.failed", { error: error instanceof Error ? error.name : "unknown" });
			}
			return undefined;
		},
	});
	return defineExtension({ name: "pigui-diagnostics", hooks: [hooks] });
}
