// The two question tools. Each puts several questions on one card, so one interruption gathers every answer, and each
// question accepts free text instead of, or as well as, its options.
import type { JsonValue } from "@earendil-works/chord/json";
import { defineTool, type ToolExecutionResult, type ToolPark } from "@earendil-works/pi-durable";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import type { CardAnswer, Question, QuestionCard } from "../../shared/session.ts";
import { awaitCard, isPark } from "./cards.ts";
import type { AgentServices } from "./services.ts";

export const ASK_SINGLE = "ask_single_choice";
export const ASK_MULTIPLE = "ask_multiple_choice";

const Option = obj({
	label: str({ minLength: 1, maxLength: 200, description: "What the person taps; a few words" }),
	description: opt(str({ maxLength: 500, description: "One line on what choosing it means" })),
});

const SingleParameters = obj({
	questions: arr(
		obj({
			question: str({ minLength: 1, maxLength: 1000 }),
			options: arr(Option, { minItems: 2, maxItems: 6 }),
			recommended: str({ description: "The label of the option you recommend; it is shown first and pre-selected" }),
		}),
		{ minItems: 1, maxItems: 8 },
	),
});

const MultipleParameters = obj({
	questions: arr(
		obj({
			question: str({ minLength: 1, maxLength: 1000 }),
			options: arr(Option, { minItems: 2, maxItems: 10 }),
		}),
		{ minItems: 1, maxItems: 8 },
	),
});

type RawQuestion = { question: string; options: { label: string; description?: string }[]; recommended?: string };

function buildQuestions(raw: readonly RawQuestion[], multiple: boolean): Question[] {
	return raw.map((item, index) => {
		const options = item.options.map((option, optionIndex) => {
			const built: Question["options"][number] = { id: `o${optionIndex + 1}`, label: option.label };
			if (option.description !== undefined) built.description = option.description;
			return built;
		});
		const question: Question = { id: `q${index + 1}`, prompt: item.question, options, multiple };
		if (item.recommended !== undefined) {
			const recommended = options.find((option) => option.label.trim().toLowerCase() === item.recommended?.trim().toLowerCase());
			if (recommended === undefined) {
				throw new Error(`Question ${index + 1}: "recommended" must be the label of one of its options.`);
			}
			question.recommended = recommended.id;
		}
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
	questions.forEach((question, index) => {
		const given = answer.answers.find((item) => item.questionId === question.id);
		const chosen = question.options
			.filter((option) => given?.selected.includes(option.id))
			.map((option) => `${option.label}${option.id === question.recommended ? " (your recommendation)" : ""}`);
		lines.push(`${index + 1}. ${question.prompt}`);
		lines.push(`   Chose: ${chosen.length > 0 ? chosen.join(", ") : "nothing from the options"}`);
		if (given?.text !== undefined && given.text.trim() !== "") lines.push(`   Wrote: """${given.text}"""`);
	});
	return lines.join("\n");
}

function questionTool(name: string, multiple: boolean, services: AgentServices) {
	const description = multiple
		? "Ask the person questions where several options may apply (checkboxes); they can always write their own answer instead. Put every question you have on one card, since each card notifies their phone: a question with a single answer can go on this card too. Write each question so it makes sense on its own, read hours later. Waits until they answer."
		: "Ask the person questions that each take one answer from your options (radio buttons), with the one you recommend; they can always write their own answer instead. Put every question you have on one card, since each card notifies their phone. Write each question so it makes sense on its own, read hours later, with options that cover the likely answers so one tap is enough. Waits until they answer.";
	return defineTool({
		name,
		description,
		parameters: multiple ? MultipleParameters : SingleParameters,
		replay: "safe",
		async execute(args, api, context): Promise<ToolExecutionResult | ToolPark> {
			const questions = buildQuestions(args.questions as RawQuestion[], multiple);
			const createdAt = await api.memo("createdAt", services.now(), context);
			const card: QuestionCard = { kind: "questions", id: api.callId, taskId: api.taskId, questions, createdAt };
			const first = questions[0]?.prompt ?? "";
			const outcome = await awaitCard(api, context, services, card, {
				title: questions.length > 1 ? `${questions.length} questions` : "A question",
				body: first,
			});
			if (isPark(outcome)) return outcome;
			const details = { card, answer: outcome } as unknown as JsonValue;
			return { output: [{ type: "text", text: describeAnswer(questions, outcome) }], details };
		},
	});
}

export function questionTools(services: AgentServices) {
	return [questionTool(ASK_SINGLE, false, services), questionTool(ASK_MULTIPLE, true, services)];
}
