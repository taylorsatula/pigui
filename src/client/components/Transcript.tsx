// The transcript, set as a conversation is set in print: the person's words in the serif, the agent's in the sans, and a
// date between them where a session runs into a new day. While the agent works, its work reads as Pi's own terminal
// shows it: thinking inline as it comes, and each tool call as a block with the last lines it printed. When the turn
// ends each stretch folds into one line, which opens on a tap, as each call does to its full input and output.
// Failures show while folded.
import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { AgentResultData, SessionDoc } from "../../shared/session.ts";
import { dayHeading, describeCall, describeGroup, sameDay } from "../format.ts";
import { live } from "../live.ts";
import { type Block, type CallView, turnStart, type WorkItem } from "../transcript.ts";
import { followEnd, keepPosition, pinToEnd, stopFollowing } from "../viewport.ts";
import { type CardActions, type DeliveryActions, PlanCardView, QuestionsCard, ReportCard } from "./Cards.tsx";
import { Icon } from "./Icons.tsx";
import { Markdown } from "./Markdown.tsx";
import { Speak } from "./Speak.tsx";

/** While something is still being written: a cursor, holding its place. */
function Cursor(): JSX.Element {
	return <span class="cursor" role="img" aria-label="running" />;
}

/** How many of a call's last output lines show while its turn runs. */
const TAIL_LINES = 4;

/** A call's last lines of output, and how many came before them. */
function tail(output: string | undefined): { lines: string; earlier: number } {
	const all = (output ?? "").trimEnd().split("\n");
	if (all.length === 1 && all[0] === "") return { lines: "", earlier: 0 };
	return { lines: all.slice(-TAIL_LINES).join("\n"), earlier: Math.max(0, all.length - TAIL_LINES) };
}

/**
 * One tool call. While its turn runs it is a block headed by what it runs (`$ command`, or what it edits or reads) with
 * the last lines of a command's output, or of any failure, under it, as Pi's own terminal shows a call. Folded, it is
 * one line. Either way it opens on a tap to its full input and output.
 */
function CallDetail(props: { call: CallView; live: boolean }): JSX.Element {
	const { call } = props;
	const bash = call.name === "bash";
	const input = bash ? String(call.args.command ?? "") : JSON.stringify(call.args, null, 2);
	const shown = props.live && (bash || call.status === "failed") ? tail(call.output) : { lines: "", earlier: 0 };
	const details = (
		<details class={`call ${call.status}`}>
			<summary>
				{props.live ? null : <Icon name="chevron" size={14} />}
				{props.live && bash ? (
					<span class="call-command">
						<span class="prompt">$ </span>
						{input}
					</span>
				) : (
					<span class="call-summary">{describeCall(call.name, call.args)}</span>
				)}
				{call.status === "failed" ? <span class="failed-tag">failed</span> : null}
				{call.status === "running" ? <Cursor /> : null}
			</summary>
			<div class="call-body">
				<div class="io-label">Input</div>
				<pre class="io">{input}</pre>
				{call.output === undefined ? null : (
					<>
						<div class="io-label">Output</div>
						<pre class="io">{call.output === "" ? "(no output)" : call.output}</pre>
					</>
				)}
			</div>
		</details>
	);
	if (!props.live) return details;
	return (
		<div class={`live-call ${call.status}`}>
			{details}
			{/* Outside the call's own disclosure, so what it printed last shows without a tap. */}
			{shown.lines === "" ? null : (
				<pre class="tail">
					{shown.earlier > 0 ? <span class="earlier">… {shown.earlier} earlier line{shown.earlier === 1 ? "" : "s"}{"\n"}</span> : null}
					{shown.lines}
				</pre>
			)}
		</div>
	);
}

/**
 * A stretch of work. While its turn runs, nothing hides it: the thinking reads inline as it comes and each call shows
 * as a block, in the order they happened. Once the turn ends it folds to one line that opens on a tap.
 */
function Work(props: { items: WorkItem[]; live: boolean }): JSX.Element {
	if (props.live) {
		return (
			<div class="work live">
				{props.items.map((item) =>
					item.kind === "thinking" ? (
						<p key={item.key} class="thought">
							{item.text}
							{item.streaming ? <Cursor /> : null}
						</p>
					) : (
						<CallDetail key={item.key} call={item.call} live />
					),
				)}
			</div>
		);
	}
	const calls = props.items.flatMap((item) => (item.kind === "call" ? [item.call] : []));
	const failed = calls.filter((call) => call.status === "failed").length;
	return (
		<details class="work">
			<summary>
				<Icon name="chevron" size={14} />
				<span class="work-summary">{calls.length > 0 ? describeGroup(calls.map((call) => call.name)) : "Thought"}</span>
				{failed > 0 ? <span class="failed-tag">{failed} failed</span> : null}
			</summary>
			<div class="timeline">
				{props.items.map((item) =>
					item.kind === "thinking" ? (
						<p key={item.key} class="thought">
							{item.text}
						</p>
					) : (
						<CallDetail key={item.key} call={item.call} live={false} />
					),
				)}
			</div>
		</details>
	);
}

/** How many of an agent's answer's lines show before it is opened. */
const PREVIEW_LINES = 3;

/**
 * A background agent's answer, as the session's agent got it: its own block, headed by the agent, showing its first
 * lines until it is opened to the whole answer.
 */
function AgentResult(props: { data: AgentResultData }): JSX.Element {
	const { data } = props;
	const preview = data.text.split("\n").filter((line) => line.trim() !== "").slice(0, PREVIEW_LINES).join("\n");
	return (
		<details class={`agent-result ${data.status}`}>
			<summary>
				<span class="agent-result-head">
					<Icon name="chevron" size={14} />
					<span class="agent-type">{data.type}</span>
					<span class="agent-description">{data.description}</span>
					<span class="agent-ended">{data.status === "done" ? "answered" : "failed"}</span>
				</span>
				<span class="agent-preview">{preview}</span>
			</summary>
			<Markdown text={data.text} class="agent" />
		</details>
	);
}

function Person(props: { data: Extract<Block, { kind: "person" }>["data"] }): JSX.Element {
	const { data } = props;
	return (
		<>
			<p class="said">{data.text}</p>
			{data.references.length + data.attachments.length > 0 ? (
				<div class="context-chips" aria-label="Added to the message">
					{data.references.map((reference) => (
						<span class="chip" key={`${reference.kind}:${reference.value}`} title={reference.note}>
							{reference.kind === "file" ? "@" : "#"}
							{reference.value}
							{reference.status === "pointer" ? ` (${reference.note ?? "pointer"})` : ""}
						</span>
					))}
					{data.attachments.map((attachment) => (
						<span class="chip" key={attachment.path}>
							<Icon name="clip" size={14} /> {attachment.name}
						</span>
					))}
				</div>
			) : null}
		</>
	);
}

export function Transcript(props: {
	blocks: Block[];
	session: SessionDoc | undefined;
	running: boolean;
	/** Absent where nothing can be answered or delivered, as in an agent's conversation. */
	cards?: CardActions;
	delivery?: DeliveryActions;
}): JSX.Element {
	const [loading, setLoading] = useState(false);
	// While earlier messages load, what was on screen stays where it is; the first message tells when they arrived.
	const firstKey = props.blocks.find((block) => block.kind !== "earlier" && block.kind !== "gap")?.key;
	const anchor = useRef<{ firstKey: string | undefined; restore: () => void } | undefined>(undefined);

	useLayoutEffect(() => pinToEnd(), []);
	useLayoutEffect(() => {
		const held = anchor.current;
		if (held === undefined) followEnd();
		else if (held.firstKey !== firstKey) {
			held.restore();
			anchor.current = undefined;
		}
	});

	// The turn under way shows whole: the live window holds only the newest entries, so while the agent works, what it
	// left out of the turn (its start, or a gap after a reconnect) loads on its own.
	// A load that failed is not retried until something new arrives.
	const working = props.running && props.session?.card === undefined;
	const failedOn = useRef<Block[] | undefined>(undefined);
	useEffect(() => {
		if (!working || loading || failedOn.current === props.blocks) return;
		const start = turnStart(props.blocks);
		const gap = props.blocks.find((block, index): block is Extract<Block, { kind: "gap" }> => block.kind === "gap" && index > start);
		const blocks = props.blocks;
		const fail = () => {
			failedOn.current = blocks;
		};
		// Filled in place rather than as a tap would: the page keeps following the end, as it does while the agent works.
		if (gap !== undefined) load(() => live.fillGap(gap.gap), "follow").catch(fail);
		else if (start === -1 && blocks[0]?.kind === "earlier") load(() => live.loadEarlier(), "keep").catch(fail);
	});

	/** `keep`: what is on screen stays put. `release`: the page stops following the end. `follow`: it goes on following. */
	const load = async (work: () => Promise<void>, position: "keep" | "release" | "follow") => {
		setLoading(true);
		if (position === "keep") anchor.current = { firstKey, restore: keepPosition() };
		else if (position === "release") stopFollowing();
		try {
			await work();
		} finally {
			setLoading(false);
			// Nothing earlier arrived: let go of the anchor once the frame has rendered.
			requestAnimationFrame(() => {
				anchor.current = undefined;
			});
		}
	};

	const content = (block: Block): JSX.Element | null => {
		switch (block.kind) {
			case "earlier":
				return (
					<button type="button" class="link" disabled={loading} onClick={() => void load(() => live.loadEarlier(), "keep")}>
						{loading ? "Loading…" : "Load earlier messages"}
					</button>
				);
			case "gap":
				return (
					<button type="button" class="link" disabled={loading} onClick={() => void load(() => live.fillGap(block.gap), "release")}>
						Load missed messages
					</button>
				);
			case "person":
				return <Person data={block.data} />;
			case "nudge":
				return (
					<p class="system-note">
						Continuing automatically ({block.data.attempt} of {block.data.limit}): no report yet.
					</p>
				);
			case "agent-result":
				return <AgentResult data={block.data} />;
			case "agent-stopped":
				return (
					<p class="system-note">
						Agent {block.data.type} ({block.data.description}) was stopped.
					</p>
				);
			case "text":
				return <Markdown text={block.text} class={`agent ${block.streaming ? "streaming" : ""}`} />;
			case "speak":
				return props.session === undefined ? null : <Speak id={block.key} session={props.session.id} markdown={block.text} />;
			case "work":
				return <Work items={block.items} live={block.live} />;
			case "questions":
				if (props.cards === undefined) return null;
				return <QuestionsCard card={block.card} pending={block.pending} actions={props.cards} {...(block.answer === undefined ? {} : { answer: block.answer })} />;
			case "plan":
				if (props.cards === undefined) return null;
				return (
					<PlanCardView
						card={block.card}
						pending={block.pending}
						running={props.running}
						actions={props.cards}
						{...(block.answer === undefined ? {} : { answer: block.answer })}
						{...(props.session === undefined ? {} : { session: props.session })}
					/>
				);
			case "report":
				if (props.delivery === undefined) return null;
				return (
					<ReportCard
						report={block.report}
						latest={block.latest}
						running={props.running}
						actions={props.delivery}
						{...(props.session === undefined ? {} : { session: props.session })}
					/>
				);
			case "compaction":
				return (
					<details class="compaction">
						<summary>
							<Icon name="chevron" size={14} />
							Context compacted ·{" "}
							{block.retained === undefined ? "see what was carried forward" : `kept ${block.retained} message${block.retained === 1 ? "" : "s"}`}
						</summary>
						<Markdown text={block.summary} />
					</details>
				);
			case "notice":
				return <p class={`system-note ${block.tone}`}>{block.text}</p>;
		}
	};

	// A date goes between entries where the day changes; a session that stays within one day shows none.
	const rows: JSX.Element[] = [];
	let day: number | undefined;
	for (const block of props.blocks) {
		const at = block.at;
		if (at !== undefined) {
			if (day !== undefined && !sameDay(day, at)) {
				rows.push(
					<h2 key={`day:${block.key}`} class="day">
						{dayHeading(at)}
					</h2>,
				);
			}
			day = at;
		}
		rows.push(
			<div key={block.key} class={`entry is-${block.kind}`}>
				{content(block)}
			</div>,
		);
	}

	return (
		<div class="transcript" role="log" aria-live="polite" aria-relevant="additions">
			{rows}
		</div>
	);
}
