// Questions, plans and reports appear as cards, not tool calls. A waiting card is answered by tapping: recommended
// options are already chosen, so accepting them is one tap, and free text is always there. What waits for the person
// is marked in the highlighter's yellow; nothing else is.
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import {
	type CardAnswer,
	type Plan,
	type PlanCard,
	planOf,
	type QuestionAnswer,
	type QuestionCard,
	type Report,
	type ReportMemory,
	type SessionDoc,
} from "../../shared/session.ts";
import { Icon } from "./Icons.tsx";
import { Inline, Markdown } from "./Markdown.tsx";
import { Speak } from "./Speak.tsx";

export type CardActions = {
	answer(cardId: string, answer: CardAnswer): Promise<void>;
	focusComposer(): void;
};

function initialSelection(card: QuestionCard): Record<string, string[]> {
	return Object.fromEntries(card.questions.map((question) => [question.id, question.recommended === undefined ? [] : [question.recommended]]));
}

export function QuestionsCard(props: { card: QuestionCard; answer?: CardAnswer; pending: boolean; actions: CardActions }): JSX.Element {
	const { card } = props;
	const [selected, setSelected] = useState(() => initialSelection(card));
	const [notes, setNotes] = useState<Record<string, string>>({});
	const [noting, setNoting] = useState<Record<string, boolean>>({});
	const [busy, setBusy] = useState(false);
	const answered = props.answer;

	const toggle = (questionId: string, optionId: string, multiple: boolean) => {
		setSelected((current) => {
			const chosen = current[questionId] ?? [];
			const next = multiple ? (chosen.includes(optionId) ? chosen.filter((id) => id !== optionId) : [...chosen, optionId]) : [optionId];
			return { ...current, [questionId]: next };
		});
	};

	const submit = async () => {
		setBusy(true);
		const answers: QuestionAnswer[] = card.questions.map((question) => {
			const text = notes[question.id]?.trim();
			const answer: QuestionAnswer = { questionId: question.id, selected: selected[question.id] ?? [] };
			if (text !== undefined && text !== "") answer.text = text;
			return answer;
		});
		try {
			await props.actions.answer(card.id, { kind: "questions", answers });
		} finally {
			setBusy(false);
		}
	};

	const chosenFor = (questionId: string): string[] => {
		if (props.pending) return selected[questionId] ?? [];
		// Answered in the person's own words, or never answered: no option was chosen.
		if (answered?.kind !== "questions") return [];
		return answered.answers.find((item) => item.questionId === questionId)?.selected ?? [];
	};

	return (
		<section class={`card questions ${props.pending ? "waiting" : ""}`} aria-label={props.pending ? "Questions waiting for your answer" : "Answered questions"}>
			<header class="card-title">
				{props.pending ? <span class="mark">{card.questions.length > 1 ? `${card.questions.length} questions for you` : "A question for you"}</span> : "Questions"}
			</header>
			{card.questions.map((question) => {
				const name = `${card.id}-${question.id}`;
				const chosen = chosenFor(question.id);
				const given = answered?.kind === "questions" ? answered.answers.find((item) => item.questionId === question.id)?.text : undefined;
				return (
					<fieldset class="question" key={question.id} disabled={!props.pending || busy}>
						<legend>{question.prompt}</legend>
						{question.options.map((option) => (
							<label class={`option ${chosen.includes(option.id) ? "chosen" : ""}`} key={option.id}>
								<input
									type={question.multiple ? "checkbox" : "radio"}
									name={name}
									checked={chosen.includes(option.id)}
									onChange={() => toggle(question.id, option.id, question.multiple)}
								/>
								<span class="option-text">
									<span class="option-label">
										{option.label}
										{option.id === question.recommended ? <span class="recommended">Recommended</span> : null}
									</span>
									{option.description === undefined ? null : <span class="option-description">{option.description}</span>}
								</span>
							</label>
						))}
						{props.pending ? (
							noting[question.id] === true ? (
								<textarea
									class="note"
									rows={2}
									placeholder="Your own answer"
									aria-label={`Your own answer to: ${question.prompt}`}
									value={notes[question.id] ?? ""}
									onInput={(event) => setNotes({ ...notes, [question.id]: (event.target as HTMLTextAreaElement).value })}
								/>
							) : (
								<button type="button" class="link" onClick={() => setNoting({ ...noting, [question.id]: true })}>
									Answer in your own words
								</button>
							)
						) : given !== undefined ? (
							<p class="given">“{given}”</p>
						) : null}
					</fieldset>
				);
			})}
			{answered?.kind === "text" ? <p class="given">You replied: “{answered.text}”</p> : null}
			{props.pending ? (
				<div class="card-actions">
					<button type="button" class="primary" disabled={busy} onClick={() => void submit()}>
						Send answers
					</button>
				</div>
			) : null}
		</section>
	);
}

/** One part of a plan or report under its label; a part with nothing in it is left out. */
function Part(props: { title: string; count: number; children: ComponentChildren }): JSX.Element | null {
	if (props.count === 0) return null;
	return (
		<section class="part" aria-label={props.title}>
			<h4 class="part-title">{props.title}</h4>
			{props.children}
		</section>
	);
}

/** Repository paths under an item, in the record's monospace. */
function Paths(props: { paths: string[] }): JSX.Element | null {
	return props.paths.length === 0 ? null : <span class="paths">{props.paths.join("  ")}</span>;
}

/** A list of one-line items, each after a dash; `caution` for what a reviewer should weigh (risks, departures). */
function Lines(props: { lines: string[]; caution?: boolean }): JSX.Element {
	return (
		<ul class={`items dashed ${props.caution === true ? "caution" : ""}`}>
			{props.lines.map((line, index) => (
				<li key={index}>
					<Inline text={line} />
				</li>
			))}
		</ul>
	);
}

function EndState(props: { plan: Plan }): JSX.Element | null {
	return (
		<Part title="Done when" count={props.plan.endState.length}>
			<ul class="items targets">
				{props.plan.endState.map((condition, index) => (
					<li key={index}>
						<span class="marker" aria-hidden="true">
							<span class="ring" />
						</span>
						<Inline text={condition} />
					</li>
				))}
			</ul>
		</Part>
	);
}

function Decisions(props: { plan: Plan }): JSX.Element | null {
	return (
		<Part title="Decided for you" count={props.plan.decisions.length}>
			<ul class="items decisions">
				{props.plan.decisions.map((decision, index) => (
					<li key={index}>
						<Inline text={decision.choice} class="item-main" />
						<Inline text={decision.reason} class="item-detail" />
					</li>
				))}
			</ul>
		</Part>
	);
}

/**
 * The steps as a checklist: each box holds its step's number until the step is done, then a tick. While the agent
 * works, the first step not yet done is the one it is on.
 */
function Steps(props: { plan: Plan; done: string[]; working?: boolean }): JSX.Element {
	const current = props.working === true ? props.plan.steps.find((step) => !props.done.includes(step.id))?.id : undefined;
	return (
		<Part title="Steps" count={props.plan.steps.length}>
			<ol class="steps">
				{props.plan.steps.map((step, index) => (
					<li key={step.id} class={props.done.includes(step.id) ? "done" : step.id === current ? "current" : ""} aria-current={step.id === current ? "step" : undefined}>
						<span class="box">{props.done.includes(step.id) ? <Icon name="check" size={14} label={`Step ${index + 1}, done`} /> : index + 1}</span>
						<span class="item-text">
							<Inline text={step.text} />
							<Paths paths={step.files} />
						</span>
					</li>
				))}
			</ol>
		</Part>
	);
}

/** What the person checks last: how the work will be proved, what is left out, what could go wrong, and the sources. */
function PlanRest(props: { plan: Plan }): JSX.Element {
	const { plan } = props;
	return (
		<>
			<Part title="Verified by" count={plan.verification.length}>
				<ul class="items dashed commands">
					{plan.verification.map((command, index) => (
						<li key={index}>
							<Inline text={command} />
						</li>
					))}
				</ul>
			</Part>
			<Part title="Not doing" count={plan.outOfScope.length}>
				<Lines lines={plan.outOfScope} />
			</Part>
			<Part title="Risks" count={plan.risks.length}>
				<Lines lines={plan.risks} caution />
			</Part>
			{plan.citations.length === 0 ? null : (
				<details class="part sources">
					<summary>
						<Icon name="chevron" size={14} />
						{plan.citations.length === 1 ? "1 source" : `${plan.citations.length} sources`} read for this plan
					</summary>
					<ul class="items">
						{plan.citations.map((citation, index) => (
							<li key={index}>
								<span class="item-text">
									<span class="paths ref">{citation.ref}</span>
									<Inline text={citation.note} class="item-detail" />
								</span>
							</li>
						))}
					</ul>
				</details>
			)}
		</>
	);
}

export function PlanCardView(props: { card: PlanCard; answer?: CardAnswer; pending: boolean; session?: SessionDoc; running: boolean; actions: CardActions }): JSX.Element {
	const { card } = props;
	const plan = planOf(card.plan);
	const [busy, setBusy] = useState(false);
	const working = props.running && props.session?.card === undefined;
	const done = props.session?.plan?.revision === card.revision && props.session.plan.approved ? props.session.plan.done : [];
	const approve = async () => {
		setBusy(true);
		try {
			await props.actions.answer(card.id, { kind: "approve" });
		} finally {
			setBusy(false);
		}
	};
	const status =
		props.answer?.kind === "approve"
			? "Approved"
			: props.answer?.kind === "revise"
				? "Changes requested"
				: props.answer?.kind === "text"
					? "Changes requested"
					: props.pending
						? "Waiting for your approval"
						: undefined;
	const feedback = props.answer?.kind === "revise" ? props.answer.feedback : props.answer?.kind === "text" ? props.answer.text : undefined;
	return (
		<section class={`card plan ${props.pending ? "waiting" : ""}`} aria-label={`Plan: ${plan.title}`}>
			<header class="card-title">
				<span>Plan{card.revision > 1 ? `, revision ${card.revision}` : ""}</span>
				{status === undefined ? null : (
					<span class={`verdict ${props.answer?.kind === "approve" ? "good" : props.pending ? "mark" : "warn"}`}>{status}</span>
				)}
			</header>
			<h3>{plan.title}</h3>
			<p class="goal">
				<Inline text={plan.goal} />
			</p>
			{props.pending ? (
				<>
					<EndState plan={plan} />
					<Decisions plan={plan} />
					<Steps plan={plan} done={done} />
					<PlanRest plan={plan} />
				</>
			) : (
				// Once answered, the plan is what is being carried out: its steps, ticking off. The rest opens on a tap.
				<>
					<Steps plan={plan} done={done} working={working} />
					<details class="part more">
						<summary>
							<Icon name="chevron" size={14} />
							The rest of the plan
						</summary>
						<EndState plan={plan} />
						<Decisions plan={plan} />
						<PlanRest plan={plan} />
					</details>
				</>
			)}
			{feedback === undefined ? null : <p class="given">You asked: “{feedback}”</p>}
			{props.pending ? (
				<div class="card-actions">
					<button type="button" class="primary" disabled={busy} onClick={() => void approve()}>
						Approve
					</button>
					<button type="button" class="secondary" disabled={busy} onClick={() => props.actions.focusComposer()}>
						Request changes
					</button>
				</div>
			) : null}
		</section>
	);
}

export type DeliveryActions = {
	deliver(action: "push" | "pr"): Promise<void>;
	showDiff(): void;
	focusComposer(): void;
};

/** A button's label, or while its action runs, a spinner and what it is doing. */
function Busy(props: { busy: boolean; label: string; working: string }): JSX.Element {
	return props.busy ? (
		<>
			<span class="spinner" aria-hidden="true" />
			{props.working}
		</>
	) : (
		<>{props.label}</>
	);
}

/** The prose a report card shows, as Markdown to read aloud: what the person reads first, not the record under it. */
function reportProse(report: Report): string {
	return [
		report.headline,
		report.summary,
		...(report.deviations.length === 0 ? [] : ["## Changed from the plan", report.deviations.map((line) => `- ${line}`).join("\n")]),
		...(report.notes.length === 0 ? [] : ["## Notes", report.notes.map((line) => `- ${line}`).join("\n")]),
	]
		.filter((part) => part !== "")
		.join("\n\n");
}

/** How a report graded long-term memory, in one line: "Rated 3 memories: 2 helpful, 1 not. Removed 1." */
function grading(memory: ReportMemory): string {
	const rated = memory.helpful + memory.unhelpful;
	return [
		rated === 0 ? "" : `Rated ${rated === 1 ? "1 memory" : `${rated} memories`}: ${memory.helpful} helpful, ${memory.unhelpful} not.`,
		memory.deleted.length === 0 ? "" : `Removed ${memory.deleted.length}.`,
	]
		.filter((part) => part !== "")
		.join(" ");
}

/** What the report recorded in long-term memory, and its grading of what it was shown. Not part of what is read aloud. */
function Remembered(props: { memory: ReportMemory }): JSX.Element {
	const { memory } = props;
	const graded = grading(memory);
	const written = [...memory.created.map((item) => ({ ...item, edited: false })), ...memory.edited.map((item) => ({ ...item, edited: true }))];
	return (
		<Part title="Remembered" count={written.length + (graded === "" ? 0 : 1)}>
			{written.length === 0 ? null : (
				<ul class="items dashed">
					{written.map((item) => (
						<li key={item.id}>
							<span class="item-text">
								<Inline text={item.text} />
								{item.edited ? <span class="item-detail">Corrected</span> : null}
							</span>
						</li>
					))}
				</ul>
			)}
			{graded === "" ? null : <p class="item-detail grading">{graded}</p>}
		</Part>
	);
}

const OUTCOME: Record<Report["outcome"], { label: string; tone: string }> = {
	complete: { label: "Complete", tone: "good" },
	partial: { label: "Partly done", tone: "warn" },
	blocked: { label: "Blocked", tone: "bad" },
};

const CHECK_ICON = { passed: "check", failed: "close", "not run": "minus" } as const;

export function ReportCard(props: { report: Report; latest: boolean; session?: SessionDoc; running: boolean; actions: DeliveryActions }): JSX.Element {
	const { report, session } = props;
	const [busy, setBusy] = useState<"push" | "pr" | undefined>(undefined);
	const delivery = session?.delivery;
	const pushed = delivery?.pushed?.commit === report.commit;
	const run = async (action: "push" | "pr") => {
		setBusy(action);
		try {
			await props.actions.deliver(action);
		} finally {
			setBusy(undefined);
		}
	};
	return (
		<section class="card report" aria-label="Report">
			<header class="card-title">
				<span>Report</span>
				<span class="commit">{report.commit.slice(0, 7)}</span>
				<span class={`verdict ${OUTCOME[report.outcome].tone}`}>{OUTCOME[report.outcome].label}</span>
				{pushed ? <span class="verdict good">Pushed</span> : null}
				{session === undefined ? null : <Speak id={`report:${report.commit}:${report.filedAt}`} session={session.id} markdown={reportProse(report)} />}
			</header>
			<p class="lede">
				<Inline text={report.headline} />
			</p>
			{report.summary === "" ? null : <Markdown text={report.summary} />}
			<Part title="Done when" count={report.endState.length}>
				<ul class="items results">
					{report.endState.map((check, index) => (
						<li key={index} class={check.met ? "met" : "unmet"}>
							<span class="marker">
								<Icon name={check.met ? "check" : "close"} size={16} label={check.met ? "Met" : "Not met"} />
							</span>
							<span class="item-text">
								<Inline text={check.criterion} />
								<Inline text={check.evidence} class="item-detail" />
							</span>
						</li>
					))}
				</ul>
			</Part>
			<Part title="Changes" count={report.changes.length}>
				<ul class="items dashed">
					{report.changes.map((change, index) => (
						<li key={index}>
							<span class="item-text">
								<Inline text={change.change} />
								<Paths paths={change.files} />
							</span>
						</li>
					))}
				</ul>
			</Part>
			<Part title="Checks" count={report.checks.length}>
				<ul class="items results">
					{report.checks.map((check, index) => (
						<li key={index} class={check.result === "passed" ? "met" : check.result === "failed" ? "unmet" : "skipped"}>
							<span class="marker">
								<Icon name={CHECK_ICON[check.result]} size={16} label={check.result === "not run" ? "Not run" : check.result === "passed" ? "Passed" : "Failed"} />
							</span>
							<span class="item-text">
								<span class="paths command">{check.command}</span>
								{check.detail === "" ? null : <Inline text={check.detail} class="item-detail" />}
							</span>
						</li>
					))}
				</ul>
			</Part>
			<Part title="Changed from the plan" count={report.deviations.length}>
				<Lines lines={report.deviations} caution />
			</Part>
			<Part title="Notes" count={report.notes.length}>
				<Lines lines={report.notes} />
			</Part>
			{report.memory === undefined ? null : <Remembered memory={report.memory} />}
			{report.learned.trim() === "" ? null : (
				<details class="part more">
					<summary>
						<Icon name="chevron" size={14} />
						What Pi learned about this repository
					</summary>
					<Markdown text={report.learned} />
				</details>
			)}
			{props.latest && session !== undefined ? (
				// One prominent action, the quieter ones beside each other under it, and a way back to the conversation.
				<div class="card-actions">
					{delivery?.pr === undefined ? (
						<>
							<button type="button" class="primary wide deliver" disabled={props.running || busy !== undefined} onClick={() => void run("pr")}>
								<Busy busy={busy === "pr"} label="Open pull request" working="Opening…" />
							</button>
							<button type="button" class="secondary" onClick={() => props.actions.showDiff()}>
								View changes
							</button>
							<button type="button" class="secondary deliver" disabled={props.running || busy !== undefined} onClick={() => void run("push")}>
								<Busy busy={busy === "push"} label={pushed ? "Push again" : "Push branch"} working="Pushing…" />
							</button>
						</>
					) : pushed && busy === undefined ? (
						// The pull request already has this commit: the next step is to look at it.
						<>
							<a class="button primary wide deliver" href={delivery.pr.url} target="_blank" rel="noopener noreferrer">
								View PR #{delivery.pr.number}
							</a>
							<button type="button" class="secondary" onClick={() => props.actions.showDiff()}>
								View changes
							</button>
						</>
					) : (
						<>
							<button type="button" class="primary wide deliver" disabled={props.running || busy !== undefined} onClick={() => void run("pr")}>
								<Busy busy={busy === "pr"} label={`Update PR #${delivery.pr.number}`} working="Updating…" />
							</button>
							<button type="button" class="secondary" onClick={() => props.actions.showDiff()}>
								View changes
							</button>
							<a class="button secondary deliver" href={delivery.pr.url} target="_blank" rel="noopener noreferrer">
								View PR #{delivery.pr.number}
							</a>
						</>
					)}
					<button type="button" class="link wide" onClick={() => props.actions.focusComposer()}>
						Keep working
					</button>
				</div>
			) : null}
			{props.latest && delivery?.error !== undefined ? <p class="error-text" role="alert">{delivery.error.message}</p> : null}
		</section>
	);
}
