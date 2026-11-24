// The agents a session's agent started: a button in the session's bar that counts those at work, a panel over the page
// that lists them, newest first, with what each is doing now and a Stop for those under way, and a viewer of one
// agent's conversation, read-only, in the transcript's own layout.
import type { LiveState, UsageState } from "@earendil-works/pi-durable";
import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { agentLive, type AgentRow, type AgentStatus, runFailureText, type SessionDoc, type StatusTone } from "../../shared/session.ts";
import type { AgentDocs } from "../../shared/stream.ts";
import { api, describeFailure } from "../api.ts";
import { firstLine } from "../format.ts";
import { showToast, useStore } from "../store.ts";
import { buildBlocks } from "../transcript.ts";
import { SessionsButton } from "./Sessions.tsx";
import { Icon } from "./Icons.tsx";
import { Transcript } from "./Transcript.tsx";

const TONES: Record<AgentStatus, StatusTone> = { queued: "idle", running: "working", done: "done", failed: "error", stopped: "idle" };
const LABELS: Record<AgentStatus, string> = { queued: "Queued", running: "Working", done: "Done", failed: "Failed", stopped: "Stopped" };

/** How many of the session's agents are at work: running, and waiting their turn. */
function counts(rows: readonly AgentRow[]): { running: number; queued: number } {
	return { running: rows.filter((row) => row.status === "running").length, queued: rows.filter((row) => row.status === "queued").length };
}

function countText({ running, queued }: { running: number; queued: number }): string {
	return [running > 0 ? `${running} running` : "", queued > 0 ? `${queued} queued` : ""].filter((part) => part !== "").join(", ");
}

/** The current time, every second while `ticking`, for the time agents at work have taken. */
function useNow(ticking: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!ticking) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [ticking]);
	return now;
}

function elapsed(row: AgentRow, now: number): string {
	if (row.startedAt === undefined) return "—";
	const seconds = Math.max(0, Math.round(((row.endedAt ?? now) - row.startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function tokens(usage: UsageState | undefined): string {
	const total = Object.values(usage?.models ?? {}).reduce((sum, entry) => sum + entry.totalTokens, 0);
	return total < 1000 ? `${total} tokens` : `${(total / 1000).toFixed(1)}k tokens`;
}

function ordinal(n: number): string {
	const tens = n % 100;
	const suffix = tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
	return `${n}${suffix}`;
}

/**
 * What a running agent is doing now, as its live state says: the tool it runs, with the last line it printed, or
 * thinking or writing. A call's arguments are in its transcript entry, not in the live state, so they are not shown.
 */
function doing(live: LiveState | undefined): string {
	const slot = live?.tools?.find((tool) => tool.status === "running");
	if (slot !== undefined) {
		const printed = slot.output?.trimEnd().split("\n").at(-1)?.trim() ?? "";
		return printed === "" ? slot.name : `${slot.name} · ${firstLine(printed, 48)}`;
	}
	const content = live?.generation?.message?.content;
	return content?.at(-1)?.type === "text" ? "writing" : "thinking";
}

/** The line under an agent: what it is doing while it runs, its place in line while it waits, how it ended after. */
function detail(row: AgentRow, docs: Partial<AgentDocs> | undefined, place: number): string {
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

async function stop(session: number, agent: AgentRow): Promise<void> {
	try {
		await api.stopAgent(session, agent.id);
	} catch (error) {
		showToast({ message: describeFailure(error).message });
	}
}

/** The Agents button, in the session's bar once the session has an agent; its badge counts those at work. */
export function AgentsButton(props: { doc: SessionDoc; open: boolean; onToggle: () => void }): JSX.Element | null {
	const rows = props.doc.agents ?? [];
	if (rows.length === 0) return null;
	const live = counts(rows);
	const total = live.running + live.queued;
	return (
		<button
			type="button"
			class="icon-button"
			aria-label={total === 0 ? "Agents" : `Agents, ${countText(live)}`}
			aria-haspopup="dialog"
			aria-expanded={props.open}
			aria-controls="agents-panel"
			onClick={props.onToggle}
		>
			<Icon name="agents" />
			{total > 0 ? (
				<span class="count-badge" aria-hidden="true">
					{total}
				</span>
			) : null}
		</button>
	);
}

/** The panel over the page, on the session picker's veil: one row per agent, newest first. */
export function AgentsPanel(props: { doc: SessionDoc; onClose: () => void }): JSX.Element {
	const docs = useStore((state) => state.agents);
	const rows = props.doc.agents ?? [];
	const now = useNow(rows.some(agentLive));
	const newest = [...rows].sort((a, b) => b.createdAt - a.createdAt);
	const waiting = rows.filter((row) => row.status === "queued").sort((a, b) => a.task - b.task);
	const live = counts(rows);
	const list = useRef<HTMLUListElement>(null);

	useEffect(() => {
		// The first agent takes the focus, and the button that opened the panel gets it back.
		const opener = document.activeElement as HTMLElement | null;
		list.current?.querySelector<HTMLElement>(".agent-open")?.focus({ preventScroll: true });
		const onKey = (event: KeyboardEvent) => event.key === "Escape" && props.onClose();
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("keydown", onKey);
			opener?.focus({ preventScroll: true });
		};
		// The panel opens once and closes; there is nothing to re-run this for.
	}, []);

	return (
		<>
			<div class="picker-veil" onClick={props.onClose} aria-hidden="true" />
			<section class="agents-panel" role="dialog" aria-modal="true" aria-label="Agents" id="agents-panel">
				<header class="picker-bar">
					<h2>Agents</h2>
					<p class="agents-count">{countText(live) || "none at work"}</p>
					<button type="button" class="icon-button" aria-label="Close" onClick={props.onClose}>
						<Icon name="close" size={20} />
					</button>
				</header>
				<ul class="agent-list" ref={list}>
					{newest.map((row) => (
						<li key={row.id} class={`agent-row ${row.status}`}>
							<a class="agent-open" href={`#/s/${props.doc.id}/agent/${row.id}`} aria-label={`${row.type}: ${row.description}, ${LABELS[row.status].toLowerCase()}`}>
								<span class={`indicator ${TONES[row.status]}`} aria-hidden="true" />
								<span class="agent-main">
									<span class="agent-line">
										<span class="agent-type">{row.type}</span>
										<span class="agent-description">{row.description}</span>
									</span>
									<span class="agent-detail">{detail(row, docs[row.id], waiting.indexOf(row) + 1)}</span>
								</span>
								<span class="agent-time">{elapsed(row, now)}</span>
							</a>
							{agentLive(row) ? (
								<button type="button" class="secondary agent-stop" aria-label={`Stop ${row.type}: ${row.description}`} onClick={() => void stop(props.doc.id, row)}>
									Stop
								</button>
							) : null}
						</li>
					))}
				</ul>
			</section>
		</>
	);
}

/** One agent's conversation, as it goes, with nothing to send: the agent answers the session's agent, not the person. */
export function AgentView(props: { session: number; agent: number }): JSX.Element {
	const session = useStore((state) => state.session);
	const view = useStore((state) => state.view);
	const missing = useStore((state) => state.missing);
	const doc = session?.id === props.session ? session : undefined;
	const row = doc?.agents?.find((agent) => agent.id === props.agent);
	const running = (view?.docs["pi.live"] as LiveState | undefined)?.run !== undefined;
	const blocks = useMemo(() => buildBlocks(view, undefined, running), [view, running]);
	const back = (
		<a class="icon-button back" href={`#/s/${props.session}`} aria-label="Back to the session">
			<Icon name="back" />
		</a>
	);
	if (missing || (doc !== undefined && row === undefined)) {
		return (
			<div class="session">
				<header class="topbar">
					{back}
					<h1 class="title">Not found</h1>
				</header>
				<p class="empty">This session has no such agent.</p>
			</div>
		);
	}
	if (row === undefined) {
		return (
			<div class="session">
				<header class="topbar">
					{back}
					<h1 class="title">Loading…</h1>
				</header>
			</div>
		);
	}
	return (
		<div class="session agent-view">
			<div class="pinned">
				<header class="topbar">
					{back}
					<div class="title-block">
						<h1 class="title">{row.description}</h1>
						<p class="subtitle" role="status">
							<span class={`session-status ${TONES[row.status]}`}>{LABELS[row.status]}</span>
							<span class="where">{row.type}</span>
						</p>
					</div>
					{agentLive(row) ? (
						<button type="button" class="secondary agent-stop" onClick={() => void stop(props.session, row)}>
							Stop
						</button>
					) : null}
					<SessionsButton />
				</header>
			</div>
			<Transcript blocks={blocks} session={undefined} running={running} />
		</div>
	);
}
