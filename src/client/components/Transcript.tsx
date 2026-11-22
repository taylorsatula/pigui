// The transcript, kept as a log: each entry has its time in the margin, a new day starts under its date, and detail is
// collapsed until asked for. Thinking, tool activity (one line per stretch of work, then each call, then its full
// input and output) and compaction checkpoints all open on a tap. Failures show while collapsed.
import type { ComponentChildren, JSX } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { SessionDoc } from "../../shared/session.ts";
import { clockTime, dayHeading, describeCall, describeGroup, sameDay } from "../format.ts";
import { live } from "../live.ts";
import type { Block, CallView } from "../transcript.ts";
import { followEnd, keepPosition, pinToEnd, stopFollowing } from "../viewport.ts";
import { type CardActions, type DeliveryActions, PlanCardView, QuestionsCard, ReportCard } from "./Cards.tsx";
import { Icon } from "./Icons.tsx";
import { Markdown } from "./Markdown.tsx";
import { Speak } from "./Speak.tsx";

/** While something is still being written: the log's cursor, holding its place. */
function Cursor(): JSX.Element {
	return <span class="cursor" role="img" aria-label="running" />;
}

function CallDetail(props: { call: CallView }): JSX.Element {
	const { call } = props;
	const input = call.name === "bash" ? String(call.args.command ?? "") : JSON.stringify(call.args, null, 2);
	return (
		<details class={`call ${call.status}`}>
			<summary>
				<Icon name="chevron" size={14} />
				<span class="call-summary">{describeCall(call.name, call.args)}</span>
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
}

function Activity(props: { calls: CallView[] }): JSX.Element {
	const failed = props.calls.filter((call) => call.status === "failed").length;
	const running = props.calls.some((call) => call.status === "running");
	return (
		<details class={`activity ${failed > 0 ? "has-failure" : ""}`}>
			<summary>
				<Icon name="chevron" size={14} />
				<span class="activity-summary">{describeGroup(props.calls.map((call) => call.name))}</span>
				{failed > 0 ? <span class="failed-tag">{failed} failed</span> : null}
				{running ? <Cursor /> : null}
			</summary>
			<div class="calls">
				{props.calls.map((call) => (
					<CallDetail key={call.id} call={call} />
				))}
			</div>
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

/** One line of the log: the margin, holding the time and who wrote it, and the entry. */
function Entry(props: { kind: string; time?: number; who?: string; children: ComponentChildren }): JSX.Element {
	return (
		<div class={`entry ${props.kind}`}>
			<div class="stamp">
				{props.time === undefined ? null : <time dateTime={new Date(props.time).toISOString()}>{clockTime(props.time)}</time>}
				{props.who === undefined ? null : <span class="who">{props.who}</span>}
			</div>
			<div class="body">{props.children}</div>
		</div>
	);
}

/** Entries that always show their time: the person's words and the cards, the moments someone looks for. */
const ALWAYS_STAMPED = new Set<Block["kind"]>(["person", "questions", "plan", "report"]);

export function Transcript(props: {
	blocks: Block[];
	session: SessionDoc | undefined;
	running: boolean;
	cards: CardActions;
	delivery: DeliveryActions;
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

	const load = async (work: () => Promise<void>, keep: boolean) => {
		setLoading(true);
		if (keep) anchor.current = { firstKey, restore: keepPosition() };
		else stopFollowing();
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
					<button type="button" class="link" disabled={loading} onClick={() => void load(() => live.loadEarlier(), true)}>
						{loading ? "Loading…" : "Load earlier entries"}
					</button>
				);
			case "gap":
				return (
					<button type="button" class="link" disabled={loading} onClick={() => void load(() => live.fillGap(block.gap), false)}>
						Load missed entries
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
			case "text":
				return <Markdown text={block.text} class={`agent ${block.streaming ? "streaming" : ""}`} />;
			case "speak":
				return props.session === undefined ? null : <Speak id={block.key} session={props.session.id} markdown={block.text} />;
			case "thinking":
				return (
					<details class="thinking">
						<summary>
							<Icon name="chevron" size={14} />
							{block.streaming ? "Thinking" : "Thought"}
							{block.streaming ? <Cursor /> : null}
						</summary>
						<p>{block.text}</p>
					</details>
				);
			case "activity":
				return <Activity calls={block.calls} />;
			case "questions":
				return <QuestionsCard card={block.card} pending={block.pending} actions={props.cards} {...(block.answer === undefined ? {} : { answer: block.answer })} />;
			case "plan":
				return (
					<PlanCardView
						card={block.card}
						pending={block.pending}
						actions={props.cards}
						{...(block.answer === undefined ? {} : { answer: block.answer })}
						{...(props.session === undefined ? {} : { session: props.session })}
					/>
				);
			case "report":
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

	// The margin shows a time when the minute changes, as a hand-kept log does, and a date heading starts each day.
	const rows: JSX.Element[] = [];
	let shownMinute: number | undefined;
	let day: number | undefined;
	for (const block of props.blocks) {
		const at = block.at;
		if (at !== undefined && (day === undefined || !sameDay(day, at))) {
			day = at;
			rows.push(
				<h2 key={`day:${block.key}`} class="day">
					{dayHeading(at)}
				</h2>,
			);
		}
		const minute = at === undefined ? undefined : Math.floor(at / 60_000);
		const time = block.kind !== "speak" && (ALWAYS_STAMPED.has(block.kind) || minute !== shownMinute) ? at : undefined;
		if (time !== undefined) shownMinute = minute;
		const waiting = (block.kind === "questions" || block.kind === "plan") && block.pending;
		rows.push(
			<Entry
				key={block.key}
				kind={`is-${block.kind}${waiting ? " waiting" : ""}`}
				{...(time === undefined ? {} : { time })}
				{...(block.kind === "person" ? { who: "you" } : {})}
			>
				{content(block)}
			</Entry>,
		);
	}

	return (
		<div class="transcript" role="log" aria-live="polite" aria-relevant="additions">
			{rows}
		</div>
	);
}
