<script lang="ts">
	// Questions, plans and reports appear as cards, not tool calls. A waiting card is answered by tapping: recommended
	// options are already chosen, so accepting them is one tap, and free text is always there. What waits for the person
	// is marked in the highlighter's yellow; nothing else is.
	import type { CardAnswer, QuestionAnswer, QuestionCard } from "../../shared/session.ts";
	import { initialSelection, type CardActions } from "./cards.ts";

	let { card, answer, pending, actions }: { card: QuestionCard; answer?: CardAnswer; pending: boolean; actions: CardActions } = $props();

	// The selection starts from the card's recommendation and is then the person's to change; later props must not reset it.
	// svelte-ignore state_referenced_locally
	let selected = $state<Record<string, string[]>>(initialSelection(card));
	let notes = $state<Record<string, string>>({});
	let noting = $state<Record<string, boolean>>({});
	let busy = $state(false);

	const answered = $derived(answer);

	const toggle = (questionId: string, optionId: string, multiple: boolean) => {
		const chosen = selected[questionId] ?? [];
		const next = multiple ? (chosen.includes(optionId) ? chosen.filter((id) => id !== optionId) : [...chosen, optionId]) : [optionId];
		selected = { ...selected, [questionId]: next };
	};

	// Typed freeform and a chosen option are mutually exclusive answers: typing un-chooses, and the options dim until the note is empty again.
	const noteInput = (questionId: string, text: string) => {
		notes = { ...notes, [questionId]: text };
		if (text.trim() !== "") selected = { ...selected, [questionId]: [] };
	};

	const typed = (questionId: string): boolean => (notes[questionId] ?? "").trim() !== "";

	const submit = async () => {
		busy = true;
		const answers: QuestionAnswer[] = card.questions.map((question) => {
			const text = notes[question.id]?.trim();
			const answer: QuestionAnswer = { questionId: question.id, selected: selected[question.id] ?? [] };
			if (text !== undefined && text !== "") answer.text = text;
			return answer;
		});
		try {
			await actions.answer(card.id, { kind: "questions", answers });
		} finally {
			busy = false;
		}
	};

	const chosenFor = (questionId: string): string[] => {
		if (pending) return selected[questionId] ?? [];
		// Answered in the person's own words, or never answered: no option was chosen.
		if (answered?.kind !== "questions") return [];
		return answered.answers.find((item) => item.questionId === questionId)?.selected ?? [];
	};
</script>

<section class={`card questions ${pending ? "waiting" : ""}`} aria-label={pending ? "Questions waiting for your answer" : "Answered questions"}>
	<header class="card-title">
		{#if pending}<span class="mark">{card.questions.length > 1 ? `${card.questions.length} questions for you` : "A question for you"}</span>{:else}Questions{/if}
	</header>
	{#each card.questions as question (question.id)}
		{@const name = `${card.id}-${question.id}`}
		{@const chosen = chosenFor(question.id)}
		{@const given = answered?.kind === "questions" ? answered.answers.find((item) => item.questionId === question.id)?.text : undefined}
		<fieldset class="question" class:freeform={typed(question.id)} disabled={!pending || busy}>
			<legend>{question.prompt}</legend>
			{#each question.options as option (option.id)}
				<label class={`option ${chosen.includes(option.id) ? "chosen" : ""}`}>
					<input
						type={question.multiple ? "checkbox" : "radio"}
						name={name}
						checked={chosen.includes(option.id)}
						onchange={() => toggle(question.id, option.id, question.multiple)}
					/>
					<span class="option-text">
						<span class="option-label">
							{option.label}
							{#if option.id === question.recommended}<span class="recommended">Recommended</span>{/if}
						</span>
						{#if option.description !== undefined}<span class="option-description">{option.description}</span>{/if}
					</span>
				</label>
			{/each}
			{#if pending}
				{#if noting[question.id] === true}
					<textarea
						class="note"
						rows={2}
						placeholder="Your own answer"
						aria-label={`Your own answer to: ${question.prompt}`}
						value={notes[question.id] ?? ""}
						oninput={(event) => noteInput(question.id, event.currentTarget.value)}
					></textarea>
				{:else}
					<button type="button" class="link" onclick={() => (noting = { ...noting, [question.id]: true })}>
						Answer in your own words
					</button>
				{/if}
			{:else if given !== undefined}
				<p class="given">“{given}”</p>
			{/if}
		</fieldset>
	{/each}
	{#if answered?.kind === "text"}<p class="given">You replied: “{answered.text}”</p>{/if}
	{#if pending}
		<div class="card-actions">
			<button type="button" class="primary" disabled={busy} onclick={() => void submit()}>
				Send answers
			</button>
		</div>
	{/if}
</section>
