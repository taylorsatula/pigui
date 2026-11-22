// The transcript. Detail is collapsed until asked for: thinking, tool activity (one line per stretch of work, then each
// call, then its full input and output) and compaction checkpoints all open on a tap. Failures show while collapsed.
import type { JSX } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { SessionDoc } from "../../shared/session.ts";
import { describeCall, describeGroup } from "../format.ts";
import { live } from "../live.ts";
import type { Block, CallView } from "../transcript.ts";
import { followEnd, keepPosition, pinToEnd, stopFollowing } from "../viewport.ts";
import { type CardActions, type DeliveryActions, PlanCardView, QuestionsCard, ReportCard } from "./Cards.tsx";
import { Icon } from "./Icons.tsx";
import { Markdown } from "./Markdown.tsx";
import { Speak } from "./Speak.tsx";

function CallDetail(props: { call: CallView }): JSX.Element {
	const { call } = props;
	const input = call.name === "bash" ? String(call.args.command ?? "") : JSON.stringify(call.args, null, 2);
	return (
		<details class={`call ${call.status}`}>
			<summary>
				<Icon name="chevron" size={16} />
				<span class="call-summary">{describeCall(call.name, call.args)}</span>
				{call.status === "failed" ? <span class="failed-tag">failed</span> : null}
				{call.status === "running" ? <span class="spinner" aria-label="running" /> : null}
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
				<Icon name="chevron" size={16} />
				<span class="activity-summary">{describeGroup(props.calls.map((call) => call.name))}</span>
				{failed > 0 ? <span class="failed-tag">{failed} failed</span> : null}
				{running ? <span class="spinner" aria-label="running" /> : null}
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
		<div class="person">
			<div class="bubble">{data.text}</div>
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
		</div>
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

	return (
		<div class="transcript" role="log" aria-live="polite" aria-relevant="additions">
			{props.blocks.map((block) => {
				switch (block.kind) {
					case "earlier":
						return (
							<button key={block.key} type="button" class="link center" disabled={loading} onClick={() => void load(() => live.loadEarlier(), true)}>
								{loading ? "Loading…" : "Load earlier messages"}
							</button>
						);
					case "gap":
						return (
							<button key={block.key} type="button" class="link center" disabled={loading} onClick={() => void load(() => live.fillGap(block.gap), false)}>
								Load missed messages
							</button>
						);
					case "person":
						return <Person key={block.key} data={block.data} />;
					case "nudge":
						return (
							<p key={block.key} class="system-note">
								Continuing automatically ({block.data.attempt} of {block.data.limit}): no report yet.
							</p>
						);
					case "text":
						return <Markdown key={block.key} text={block.text} class={`agent ${block.streaming ? "streaming" : ""}`} />;
					case "speak":
						return props.session === undefined ? null : <Speak key={block.key} id={block.key} session={props.session.id} markdown={block.text} />;
					case "thinking":
						return (
							<details key={block.key} class="thinking">
								<summary>
									<Icon name="chevron" size={16} />
									{block.streaming ? "Thinking…" : "Thought"}
								</summary>
								<p>{block.text}</p>
							</details>
						);
					case "activity":
						return <Activity key={block.key} calls={block.calls} />;
					case "questions":
						return <QuestionsCard key={block.key} card={block.card} pending={block.pending} actions={props.cards} {...(block.answer === undefined ? {} : { answer: block.answer })} />;
					case "plan":
						return (
							<PlanCardView
								key={block.key}
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
								key={block.key}
								report={block.report}
								latest={block.latest}
								running={props.running}
								actions={props.delivery}
								{...(props.session === undefined ? {} : { session: props.session })}
							/>
						);
					case "compaction":
						return (
							<details key={block.key} class="compaction">
								<summary>
									<Icon name="chevron" size={16} />
									Context compacted ·{" "}
									{block.retained === undefined ? "see what was carried forward" : `kept ${block.retained} message${block.retained === 1 ? "" : "s"}`}
								</summary>
								<Markdown text={block.summary} />
							</details>
						);
					case "notice":
						return (
							<p key={block.key} class={`system-note ${block.tone}`}>
								{block.text}
							</p>
						);
				}
			})}
		</div>
	);
}
