// Questions, plans and reports appear as cards, not tool calls. A waiting card is answered by tapping: recommended
// options are already chosen, so accepting them is one tap, and free text is always there.
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { CardAnswer, PlanCard, QuestionAnswer, QuestionCard, Report, SessionDoc } from "../../shared/session.ts";
import { Icon } from "./Icons.tsx";
import { Markdown } from "./Markdown.tsx";

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
			<header class="card-title">{props.pending ? (card.questions.length > 1 ? `${card.questions.length} questions` : "A question") : "Questions"}</header>
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
										{option.id === question.recommended ? <span class="badge">Recommended</span> : null}
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

export function PlanCardView(props: { card: PlanCard; answer?: CardAnswer; pending: boolean; session?: SessionDoc; actions: CardActions }): JSX.Element {
	const { card } = props;
	const [busy, setBusy] = useState(false);
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
		<section class={`card plan ${props.pending ? "waiting" : ""}`} aria-label={`Plan: ${card.plan.title}`}>
			<header class="card-title">
				Plan{card.revision > 1 ? `, revision ${card.revision}` : ""}
				{status === undefined ? null : <span class={`status-tag ${props.answer?.kind === "approve" ? "good" : ""}`}>{status}</span>}
			</header>
			<h3>{card.plan.title}</h3>
			<Markdown text={card.plan.summary} />
			<ol class="steps">
				{card.plan.steps.map((step, index) => (
					<li key={step.id} class={done.includes(step.id) ? "done" : ""}>
						<span class="step-marker">{done.includes(step.id) ? <Icon name="check" size={16} label="Done" /> : `${index + 1}.`}</span>
						<span>{step.text}</span>
					</li>
				))}
			</ol>
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
				Report
				{pushed ? <span class="status-tag good">Pushed</span> : null}
			</header>
			<Markdown text={report.summary} />
			{report.changes.length > 0 ? (
				<ul class="changes">
					{report.changes.map((change, index) => (
						<li key={index}>{change}</li>
					))}
				</ul>
			) : null}
			{report.verification.trim() === "" ? null : (
				<details>
					<summary>
						<Icon name="chevron" size={16} />
						How it was verified
					</summary>
					<Markdown text={report.verification} />
				</details>
			)}
			{report.notes.trim() === "" ? null : (
				<div class="report-notes">
					<strong>Notes</strong>
					<Markdown text={report.notes} />
				</div>
			)}
			{report.learned.trim() === "" ? null : (
				<details>
					<summary>
						<Icon name="chevron" size={16} />
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
							<button type="button" class="primary wide" disabled={props.running || busy !== undefined} onClick={() => void run("pr")}>
								<Busy busy={busy === "pr"} label="Open pull request" working="Opening…" />
							</button>
							<button type="button" class="secondary" onClick={() => props.actions.showDiff()}>
								View changes
							</button>
							<button type="button" class="secondary" disabled={props.running || busy !== undefined} onClick={() => void run("push")}>
								<Busy busy={busy === "push"} label={pushed ? "Push again" : "Push branch"} working="Pushing…" />
							</button>
						</>
					) : pushed && busy === undefined ? (
						// The pull request already has this commit: the next step is to look at it.
						<>
							<a class="button primary wide" href={delivery.pr.url} target="_blank" rel="noopener noreferrer">
								View PR #{delivery.pr.number}
							</a>
							<button type="button" class="secondary" onClick={() => props.actions.showDiff()}>
								View changes
							</button>
						</>
					) : (
						<>
							<button type="button" class="primary wide" disabled={props.running || busy !== undefined} onClick={() => void run("pr")}>
								<Busy busy={busy === "pr"} label={`Update PR #${delivery.pr.number}`} working="Updating…" />
							</button>
							<button type="button" class="secondary" onClick={() => props.actions.showDiff()}>
								View changes
							</button>
							<a class="button secondary" href={delivery.pr.url} target="_blank" rel="noopener noreferrer">
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
