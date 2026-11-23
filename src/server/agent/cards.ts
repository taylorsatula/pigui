// What the question and plan tools share: the signal a card's answer arrives on, and how a tool shows its card and
// waits for it.
import type { Context } from "@earendil-works/chord/context";
import type { Draft } from "@earendil-works/chord/delta";
import { defineSignal, type ToolExecutionApi, type ToolPark } from "@earendil-works/pi-durable";
import { arr, lit, obj, opt, str, union } from "@earendil-works/pi-schema";
import type { CardAnswer, PendingCard, SessionDoc } from "../../shared/session.ts";
import { editSession, SessionDocToken } from "../docs.ts";
import type { AgentServices } from "./services.ts";

/** A card's answer, delivered by the server to the parked tool task. One wait per tool call, so one key. */
export const CardAnswerSignal = defineSignal({
	name: "picloud.card-answer",
	version: 1,
	schema: union([
		obj({ kind: lit("questions"), answers: arr(obj({ questionId: str(), selected: arr(str()), text: opt(str()) })) }),
		obj({ kind: lit("text"), text: str() }),
		obj({ kind: lit("approve") }),
		obj({ kind: lit("revise"), feedback: str() }),
	]),
});

export const ANSWER_KEY = "answer";

export async function sessionOf(api: ToolExecutionApi, context: Context): Promise<Readonly<SessionDoc>> {
	const doc = await api.snapshot(SessionDocToken, api.conversationId, context);
	if (doc?.id === undefined) throw new Error("This conversation is not a picloud session.");
	return doc;
}

/**
 * The answer this call already received, or a park that shows `card` and waits for one. The card and its
 * notification are committed together, keyed by the call ID, so a rerun of the call before it parked neither shows a
 * second card nor notifies twice.
 */
export async function awaitCard(
	api: ToolExecutionApi,
	context: Context,
	services: AgentServices,
	card: PendingCard,
	notice: { title: string; body: string },
	prepare?: (doc: Draft<SessionDoc>) => void,
): Promise<CardAnswer | ToolPark> {
	const state = await api.readSignal(CardAnswerSignal, ANSWER_KEY, context);
	if (state !== undefined && "value" in state) return state.value as CardAnswer;
	if (state !== undefined) throw new Error("The card expired without an answer.");
	await api.commit(async (tx) => {
		await editSession(tx, api.conversationId, services.now(), async (doc) => {
			if (doc.card?.id === card.id) return;
			doc.card = card;
			doc.attentionAt = services.now();
			prepare?.(doc);
			// By the card's task: its id is the provider's call id, which can repeat, and a new card must still notify.
			await services.notifications.enqueue(tx, doc, { key: `card:${card.taskId}`, ...notice });
		});
	}, context);
	await services.faults.afterCard?.(context);
	return { sleep: { signals: [CardAnswerSignal.key(ANSWER_KEY)] } };
}

export function isPark(value: CardAnswer | ToolPark): value is ToolPark {
	return "sleep" in value;
}
