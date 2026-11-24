// The two asking tools. A card can carry several questions so one interruption collects them all, and every
// question takes free text instead of, or beside, its options.
import type { JsonValue } from "@earendil-works/chord/json";
import { defineTool, type ToolExecutionResult, type ToolPark } from "@earendil-works/pi-durable";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import type { CardAnswer, ChoiceOption, Question, QuestionCard } from "../../shared/session.ts";
import { awaitCard, isPark } from "./cards.ts";
import type { AgentServices } from "./services.ts";

export const ASK_SINGLE = "ask_single_choice";
export const ASK_MULTIPLE = "ask_multiple_choice";

const choice = obj({
	label: str({ minLength: 1, maxLength: 200, description: "What the person taps; a few words" }),
	description: opt(str({ maxLength: 500, description: "One line on what choosing it means" })),
});

// One question, as the single-choice card asks it: a recommendation is required so one tap is enough.
const singleQuestion = obj({
	question: str({ minLength: 1, maxLength: 1000 }),
	options: arr(choice, { minItems: 2, maxItems: 6 }),
	recommended: str({ description: "The label of the option you recommend; it is shown first and pre-selected" }),
});

// The multi-choice card asks the same thing without a recommendation; several options may apply.
const multipleQuestion = obj({
	question: str({ minLength: 1, maxLength: 1000 }),
	options: arr(choice, { minItems: 2, maxItems: 10 }),
});

const SingleParameters = obj({ questions: arr(singleQuestion, { minItems: 1, maxItems: 8 }) });
const MultipleParameters = obj({ questions: arr(multipleQuestion, { minItems: 1, maxItems: 8 }) });

/** A question as it arrives from the model: a recommendation, when present, as the label it recommended. */
type RawQuestion = { question: string; options: { label: string; description?: string }[]; recommended?: string };

/** The option labels the model recommended, matched against the options the way a person reads them. */
function sameLabel(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Turn the raw questions into cards' questions: stable IDs, and the recommendation resolved to its option. */
function assembleQuestions(raw: readonly RawQuestion[], multiple: boolean): Question[] {
	return raw.map((item, at) => {
		const options: ChoiceOption[] = item.options.map((option, index) => {
			const built: ChoiceOption = { id: `o${index + 1}`, label: option.label };
			if (option.description !== undefined) built.description = option.description;
			return built;
		});
		const question: Question = { id: `q${at + 1}`, prompt: item.question, options, multiple };
		if (item.recommended === undefined) return question;
		const wanted = item.recommended;
		const pick = options.find((option) => sameLabel(option.label, wanted));
		if (pick === undefined) throw new Error(`Question ${at + 1}: "recommended" must be the label of one of its options.`);
		question.recommended = pick.id;
		return question;
	});
}

/** The answers as the model reads them: each question with what was chosen, and the person's own words verbatim. */
export function describeAnswer(questions: readonly Question[], answer: CardAnswer): string {
	if (answer.kind === "text") {
		return `The person replied in their own words instead of choosing options:\n"""\n${answer.text}\n"""`;
	}
	if (answer.kind !== "questions") return "The card was answered.";
	const lines = ["The person answered:"];
	questions.forEach((question, at) => {
		const given = answer.answers.find((item) => item.questionId === question.id);
		const chosen = question.options
			.filter((option) => given?.selected.includes(option.id))
			.map((option) => (option.id === question.recommended ? `${option.label} (your recommendation)` : option.label));
		lines.push(`${at + 1}. ${question.prompt}`);
		lines.push(`   Chose: ${chosen.length > 0 ? chosen.join(", ") : "nothing from the options"}`);
		const wrote = given?.text?.trim();
		if (wrote !== undefined && wrote !== "") lines.push(`   Wrote: """${given?.text}"""`);
	});
	return lines.join("\n");
}

type QuestionStyle = { multiple: boolean; name: string; description: string };

const STYLES: Record<"single" | "multiple", QuestionStyle> = {
	single: {
		multiple: false,
		name: ASK_SINGLE,
		description:
			"Ask the person questions that each take one answer from your options (radio buttons), with the one you recommend; they can always write their own answer instead. Put every question you have on one card, since each card notifies their phone. Write each question so it makes sense on its own, read hours later, with options that cover the likely answers so one tap is enough. Waits until they answer.",
	},
	multiple: {
		multiple: true,
		name: ASK_MULTIPLE,
		description:
			"Ask the person questions where several options may apply (checkboxes); they can always write their own answer instead. Put every question you have on one card, since each card notifies their phone: a question with a single answer can go on this card too. Write each question so it makes sense on its own, read hours later. Waits until they answer.",
	},
};

function questionTool(style: QuestionStyle, services: AgentServices) {
	return defineTool({
		name: style.name,
		description: style.description,
		parameters: style.multiple ? MultipleParameters : SingleParameters,
		replay: "safe",
		async execute(args, api, context): Promise<ToolExecutionResult | ToolPark> {
			const questions = assembleQuestions(args.questions as RawQuestion[], style.multiple);
			const createdAt = await api.memo("createdAt", services.now(), context);
			const card: QuestionCard = { kind: "questions", id: api.callId, taskId: api.taskId, questions, createdAt };
			const outcome = await awaitCard(
				api,
				context,
				services,
				card,
				{ title: questions.length > 1 ? `${questions.length} questions` : "A question", body: questions[0]?.prompt ?? "" },
			);
			if (isPark(outcome)) return outcome;
			const details = { card, answer: outcome } as unknown as JsonValue;
			return { output: [{ type: "text", text: describeAnswer(questions, outcome) }], details };
		},
	});
}

export function questionTools(services: AgentServices) {
	return [questionTool(STYLES.single, services), questionTool(STYLES.multiple, services)];
}
