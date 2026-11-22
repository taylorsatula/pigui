// The transcript, set as a conversation is set in print: the person's words in the serif, the agent's in the sans, and a
// date between them where a session runs into a new day. While the agent works, each stretch of its work is open to
// watch: its thinking as it comes, each tool call as a line, and the running call's latest output. When the turn ends
// the stretch folds into one line, which opens on a tap, as each call does to its full input and output. Failures show
// while folded.
import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { SessionDoc } from "../../shared/session.ts";
import { dayHeading, describeCall, describeGroup, sameDay } from "../format.ts";
import { live } from "../live.ts";
import type { Block, CallView, WorkItem } from "../transcript.ts";
import { followEnd, keepPosition, pinToEnd, stopFollowing } from "../viewport.ts";
import { type CardActions, type DeliveryActions, PlanCardView, QuestionsCard, ReportCard } from "./Cards.tsx";
import { Icon } from "./Icons.tsx";
import { Markdown } from "./Markdown.tsx";
import { Speak } from "./Speak.tsx";

/** While something is still being written: a cursor, holding its place. */
function Cursor(): JSX.Element {
	return <span class="cursor" role="img" aria-label="running" />;
}

/** The last lines of a running call's output, enough to see what it is doing. */
const PEEK_LINES = 3;

function peek(output: string | undefined): string {
	return (output ?? "").trimEnd().split("\n").slice(-PEEK_LINES).join("\n");
}

function CallDetail(props: { call: CallView }): JSX.Element {
	const { call } = props;
	const input = call.name === "bash" ? String(call.args.command ?? "") : JSON.stringify(call.args, null, 2);
	const latest = call.status === "running" ? peek(call.output) : "";
	return (
		<>
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
			{/* Outside the call's own disclosure, so what a running call is doing shows without a tap. */}
			{latest === "" ? null : <pre class="peek">{latest}</pre>}
		</>
	);
}

/**
 * A stretch of work: open while its turn runs, folded once it ends. A tap opens or folds it at any time; the next
 * change between running and finished sets it again.
 */
function Work(props: { items: WorkItem[]; live: boolean }): JSX.Element {
	const [open, setOpen] = useState(props.live);
	useEffect(() => setOpen(props.live), [props.live]);
	const calls = props.items.flatMap((item) => (item.kind === "call" ? [item.call] : []));
	const failed = calls.filter((call) => call.status === "failed").length;
	const busy = props.items.some((item) => (item.kind === "call" ? item.call.status === "running" : item.streaming));
	return (
		<details class={`work ${props.live ? "live" : ""}`} open={open} onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
			<summary>
				<Icon name="chevron" size={14} />
				<span class="work-summary">{calls.length > 0 ? describeGroup(calls.map((call) => call.name)) : busy ? "Thinking" : "Thought"}</span>
				{failed > 0 ? <span class="failed-tag">{failed} failed</span> : null}
				{busy && !open ? <Cursor /> : null}
			</summary>
			<div class="timeline">
				{props.items.map((item) =>
					item.kind === "thinking" ? (
						<p key={item.key} class="thought">
							{item.text}
							{item.streaming ? <Cursor /> : null}
						</p>
					) : (
						<CallDetail key={item.key} call={item.call} />
					),
				)}
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
						{loading ? "Loading…" : "Load earlier messages"}
					</button>
				);
			case "gap":
				return (
					<button type="button" class="link" disabled={loading} onClick={() => void load(() => live.fillGap(block.gap), false)}>
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
			case "text":
				return <Markdown text={block.text} class={`agent ${block.streaming ? "streaming" : ""}`} />;
			case "speak":
				return props.session === undefined ? null : <Speak id={block.key} session={props.session.id} markdown={block.text} />;
			case "work":
				return <Work items={block.items} live={block.live} />;
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
