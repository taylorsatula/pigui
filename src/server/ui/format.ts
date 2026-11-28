// Pure formatting and presentation helpers shared across SSR pages, fragments, and SSE updates.
import type { AgentState, LiveState, UsageState } from "@earendil-works/pi-durable";
import {
	planOf,
	runFailureText,
	type AgentRow,
	type AgentStatus,
	type QuestionCard,
	type Report,
	type ReportMemory,
	type SessionDoc,
	type SessionRow,
	type StatusTone,
	type StoredPlan,
} from "../../shared/session.ts";
import type { IconName } from "./icons.ts";

export type AgentDocs = { "pi.live": LiveState; "pi.usage": UsageState; "pi.agent": AgentState };
export type AgentDocKind = keyof AgentDocs;

export function firstLine(text: unknown, max = 60): string {
	const line = String(text ?? "").split("\n")[0]?.trim() ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function describeCall(name: string, args: Record<string, unknown>): string {
	switch (name) {
		case "bash":
			return `Ran ${firstLine(args.command)}`;
		case "read":
			return `Read ${String(args.path ?? "a file")}`;
		case "write":
			return `Wrote ${String(args.path ?? "a file")}`;
		case "edit":
			return `Edited ${String(args.path ?? "a file")}`;
		case "update_progress": {
			const steps = Array.isArray(args.completed) ? args.completed.join(", ") : "";
			return `Marked step${steps.includes(",") ? "s" : ""} ${steps} done`;
		}
		case "write_handoff":
			return "Wrote a handoff note";
		case "recall_history":
			return args.entry !== undefined ? `Looked up history entry ${String(args.entry)}` : `Searched history for “${firstLine(args.query, 40)}”`;
		case "surface_memories":
			return `Searched memory: “${firstLine(args.query, 40)}”`;
		case "Agent":
			return args.resume === undefined
				? `Agent ${String(args.subagent_type ?? "")}: ${firstLine(args.description, 50)}`
				: `Resumed agent ${String(args.resume)}: ${firstLine(args.description, 50)}`;
		case "steer_subagent":
			return `Steered agent ${String(args.agent_id ?? "")}`;
		default:
			return name.replace(/_/g, " ");
	}
}

const NOUNS: Record<string, [string, string, string]> = {
	bash: ["Ran", "command", "commands"],
	read: ["Read", "file", "files"],
	write: ["Wrote", "file", "files"],
	edit: ["Edited", "file", "files"],
	update_progress: ["Updated", "progress", "progress"],
	recall_history: ["Searched", "history", "history"],
	surface_memories: ["Searched", "memory", "memory"],
	write_handoff: ["Wrote", "handoff note", "handoff notes"],
	Agent: ["Started", "agent", "agents"],
	steer_subagent: ["Steered", "agent", "agents"],
};

export function describeGroup(names: readonly string[]): string {
	const counts = new Map<string, number>();
	for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
	const parts = [...counts].map(([name, count]) => {
		const noun = NOUNS[name];
		if (noun === undefined) return `${name.replace(/_/g, " ")}${count > 1 ? ` ×${count}` : ""}`;
		if (noun[1] === noun[2]) return `${noun[0]} ${noun[1]}`;
		return `${noun[0]} ${count} ${count === 1 ? noun[1] : noun[2]}`;
	});
	const sentence = parts.join(", ").toLowerCase();
	return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

export function timeAgo(at: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.round((now - at) / 1000));
	if (seconds < 60) return "now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

export function dayHeading(at: number): string {
	return new Date(at).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

export function sameDay(a: number, b: number): boolean {
	return new Date(a).toDateString() === new Date(b).toDateString();
}

export function listingDate(at: number, now = Date.now()): string {
	const date = new Date(at);
	const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
	if (sameDay(at, now)) return `Today at ${time}`;
	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	if (sameDay(at, yesterday.getTime())) return `Yesterday at ${time}`;
	if (date.getFullYear() !== new Date(now).getFullYear()) return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
	return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })} at ${time}`;
}

export function shortDir(dir: string, home: string | undefined): string {
	if (home === undefined || home === "/") return dir;
	if (dir === home) return "~";
	return dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir;
}

export function whereOfRow(row: SessionRow, home: string | undefined): string {
	return row.place === "local" ? shortDir(row.dir, home) : row.repo;
}

export function whereOfFavorite(row: SessionRow, home: string | undefined): string {
	return row.place === "local" ? shortDir(row.dir, home) : `${row.repo} · ${row.branch}`;
}

export function placeholderFor(doc: SessionDoc, running: boolean): string {
	if (doc.setup.status === "preparing") return "Setting up the workspace…";
	if (doc.card?.kind === "questions") return "Answer in your own words…";
	if (doc.card?.kind === "plan") return "Ask for changes to the plan…";
	if (running) return "Steer Pi while it works…";
	if (doc.outcome?.kind === "budget") return "Raise the budget to continue…";
	if (doc.report !== undefined && doc.workflow === "reported") return "Ask for more changes…";
	return "Write to Pi…";
}

export function spendTone(spent: number, cap: number | undefined): string {
	if (cap === undefined || cap <= 0) return "";
	return spent >= cap ? "over" : spent >= cap * 0.8 ? "near" : "";
}

export function initialSelection(card: QuestionCard): Record<string, string[]> {
	return Object.fromEntries(card.questions.map((question) => [question.id, question.recommended === undefined ? [] : [question.recommended]]));
}

export function reportProse(report: Report): string {
	return [
		report.headline,
		report.summary,
		...(report.deviations.length === 0 ? [] : ["## Changed from the plan", report.deviations.map((line) => `- ${line}`).join("\n")]),
		...(report.notes.length === 0 ? [] : ["## Notes", report.notes.map((line) => `- ${line}`).join("\n")]),
	]
		.filter((part) => part !== "")
		.join("\n\n");
}

export function planProse(plan: StoredPlan): string {
	const current = planOf(plan);
	const list = (items: readonly string[]) => items.map((item) => `- ${item}`).join("\n");
	return [
		`# ${current.title}`,
		current.goal,
		...(current.endState.length === 0 ? [] : [`## Done when\n${list(current.endState)}`]),
		...(current.decisions.length === 0
			? []
			: [`## Decided for you\n${current.decisions.map((decision) => `- ${decision.choice}. ${decision.reason}`).join("\n")}`]),
		`## Steps\n${current.steps.map((step, index) => `${index + 1}. ${step.text}${step.files.length === 0 ? "" : ` Files: ${step.files.join(", ")}`}`).join("\n")}`,
		...(current.verification.length === 0 ? [] : [`## Verified by\n${list(current.verification)}`]),
		...(current.outOfScope.length === 0 ? [] : [`## Not doing\n${list(current.outOfScope)}`]),
		...(current.risks.length === 0 ? [] : [`## Risks\n${list(current.risks)}`]),
		...(current.citations.length === 0 ? [] : [`## Sources\n${current.citations.map((citation) => `- ${citation.ref}: ${citation.note}`).join("\n")}`]),
	].join("\n\n");
}

export function grading(memory: ReportMemory): string {
	const rated = memory.helpful + memory.unhelpful;
	return [
		rated === 0 ? "" : `Rated ${rated === 1 ? "1 memory" : `${rated} memories`}: ${memory.helpful} helpful, ${memory.unhelpful} not.`,
		memory.deleted.length === 0 ? "" : `Removed ${memory.deleted.length}.`,
	]
		.filter((part) => part !== "")
		.join(" ");
}

export const OUTCOME: Record<Report["outcome"], { label: string; tone: string }> = {
	complete: { label: "Complete", tone: "good" },
	partial: { label: "Partly done", tone: "warn" },
	blocked: { label: "Blocked", tone: "bad" },
};

export const CHECK_ICON: Record<"passed" | "failed" | "not run", IconName> = {
	passed: "check",
	failed: "close",
	"not run": "minus",
};

export const AGENT_TONES: Record<AgentStatus, StatusTone> = {
	queued: "idle",
	running: "working",
	done: "done",
	failed: "error",
	stopped: "idle",
};

export const AGENT_LABELS: Record<AgentStatus, string> = {
	queued: "Queued",
	running: "Working",
	done: "Done",
	failed: "Failed",
	stopped: "Stopped",
};

export function agentCounts(rows: readonly AgentRow[]): { running: number; queued: number } {
	return {
		running: rows.filter((row) => row.status === "running").length,
		queued: rows.filter((row) => row.status === "queued").length,
	};
}

export function agentCountText({ running, queued }: { running: number; queued: number }): string {
	return [running > 0 ? `${running} running` : "", queued > 0 ? `${queued} queued` : ""].filter((part) => part !== "").join(", ");
}

export function agentElapsed(row: AgentRow, now: number): string {
	if (row.startedAt === undefined) return "—";
	const seconds = Math.max(0, Math.round(((row.endedAt ?? now) - row.startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export function agentTokens(usage: UsageState | undefined): string {
	const total = Object.values(usage?.models ?? {}).reduce((sum, entry) => sum + entry.totalTokens, 0);
	return total < 1000 ? `${total} tokens` : `${(total / 1000).toFixed(1)}k tokens`;
}

function ordinal(n: number): string {
	const tens = n % 100;
	const suffix = tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
	return `${n}${suffix}`;
}

export function agentDoing(live: LiveState | undefined): string {
	const slot = live?.tools?.find((tool) => tool.status === "running");
	if (slot !== undefined) {
		const printed = slot.output?.trimEnd().split("\n").at(-1)?.trim() ?? "";
		return printed === "" ? slot.name : `${slot.name} · ${firstLine(printed, 48)}`;
	}
	const content = live?.generation?.message?.content;
	return content?.at(-1)?.type === "text" ? "writing" : "thinking";
}

export function agentDetail(row: AgentRow, docs: Partial<AgentDocs> | undefined, place: number): string {
	const usage = agentTokens(docs?.["pi.usage"]);
	switch (row.status) {
		case "running": {
			const live = docs?.["pi.live"];
			const model = docs?.["pi.agent"]?.model;
			const turns = live?.run?.turns ?? 0;
			return [model === undefined ? "session model" : `${model.provider}/${model.modelId}`, agentDoing(live), `${turns} turn${turns === 1 ? "" : "s"}`, usage].join(" · ");
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
