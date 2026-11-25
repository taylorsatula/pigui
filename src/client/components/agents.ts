// The plain-TS parts of the agents feature: the tone and label maps, the counts and the lines under each agent, and the
// Stop action. No markup; the button, the panel, and the viewer are AgentsButton.svelte, AgentsPanel.svelte, and AgentView.svelte.
import type { LiveState, UsageState } from "@earendil-works/pi-durable";
import { runFailureText, type AgentRow, type AgentStatus, type StatusTone } from "../../shared/session.ts";
import type { AgentDocs } from "../../shared/stream.ts";
import { api, describeFailure } from "../api.ts";
import { firstLine } from "../format.ts";
import { showToast } from "../store.svelte.ts";

export const TONES: Record<AgentStatus, StatusTone> = { queued: "idle", running: "working", done: "done", failed: "error", stopped: "idle" };
export const LABELS: Record<AgentStatus, string> = { queued: "Queued", running: "Working", done: "Done", failed: "Failed", stopped: "Stopped" };

/** How many of the session's agents are at work: running, and waiting their turn. */
export function counts(rows: readonly AgentRow[]): { running: number; queued: number } {
	return { running: rows.filter((row) => row.status === "running").length, queued: rows.filter((row) => row.status === "queued").length };
}

export function countText({ running, queued }: { running: number; queued: number }): string {
	return [running > 0 ? `${running} running` : "", queued > 0 ? `${queued} queued` : ""].filter((part) => part !== "").join(", ");
}

export function elapsed(row: AgentRow, now: number): string {
	if (row.startedAt === undefined) return "—";
	const seconds = Math.max(0, Math.round(((row.endedAt ?? now) - row.startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export function tokens(usage: UsageState | undefined): string {
	const total = Object.values(usage?.models ?? {}).reduce((sum, entry) => sum + entry.totalTokens, 0);
	return total < 1000 ? `${total} tokens` : `${(total / 1000).toFixed(1)}k tokens`;
}

export function ordinal(n: number): string {
	const tens = n % 100;
	const suffix = tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
	return `${n}${suffix}`;
}

/**
 * What a running agent is doing now, as its live state says: the tool it runs, with the last line it printed, or
 * thinking or writing. A call's arguments are in its transcript entry, not in the live state, so they are not shown.
 */
export function doing(live: LiveState | undefined): string {
	const slot = live?.tools?.find((tool) => tool.status === "running");
	if (slot !== undefined) {
		const printed = slot.output?.trimEnd().split("\n").at(-1)?.trim() ?? "";
		return printed === "" ? slot.name : `${slot.name} · ${firstLine(printed, 48)}`;
	}
	const content = live?.generation?.message?.content;
	return content?.at(-1)?.type === "text" ? "writing" : "thinking";
}

/** The line under an agent: what it is doing while it runs, its place in line while it waits, how it ended after. */
export function detail(row: AgentRow, docs: Partial<AgentDocs> | undefined, place: number): string {
	const usage = tokens(docs?.["pi.usage"]);
	switch (row.status) {
		case "running": {
			const live = docs?.["pi.live"];
			const model = docs?.["pi.agent"]?.model;
			const turns = live?.run?.turns ?? 0;
			return [model === undefined ? "session model" : `${model.provider}/${model.modelId}`, doing(live), `${turns} turn${turns === 1 ? "" : "s"}`, usage].join(" · ");
		}
		case "queued":
			return place === 1 ? "queued, next in line" : `queued, ${ordinal(place)} in line`;
		case "done":
			return `done · ${usage}`;
		case "failed":
			return `failed · ${row.reason === "settings" ? "it could not start: subagent-settings.json is not valid" : runFailureText(row.reason ?? "unknown").toLowerCase()}`;
		case "stopped":
			return `stopped · ${usage}`;
	}
}

export async function stop(session: number, agent: AgentRow): Promise<void> {
	try {
		await api.stopAgent(session, agent.id);
	} catch (error) {
		showToast({ message: describeFailure(error).message });
	}
}
