// Cards are how a run waits for the person. The waiting tool commits its card and its phone notification in one
// commit, then parks on a durable signal; the server signals that same signal, in the same commit that clears the
// card and records the person's words. This module holds what both sides of that arrangement share.
import type { Context } from "@earendil-works/chord/context";
import type { Draft } from "@earendil-works/chord/delta";
import { defineSignal, type ToolExecutionApi, type ToolPark } from "@earendil-works/pi-durable";
import { arr, lit, obj, opt, str, union } from "@earendil-works/pi-schema";
import type { CardAnswer, PendingCard, SessionDoc } from "../../shared/session.ts";
import { editSession, SessionDocToken } from "../documents.ts";
import type { AgentServices } from "./services.ts";

// Every answer arrives on one signal, under one key, for one call's wait. The schema mirrors CardAnswer.
const answerSchema = union([
	obj({ kind: lit("questions"), answers: arr(obj({ questionId: str(), selected: arr(str()), text: opt(str()) })) }),
	obj({ kind: lit("text"), text: str() }),
	obj({ kind: lit("approve") }),
	obj({ kind: lit("revise"), feedback: str() }),
]);

export const CardAnswerSignal = defineSignal({ name: "pigui.card-answer", version: 1, schema: answerSchema });

/** The key a card's answer is signalled under; one wait per call, so one key. */
export const ANSWER_KEY = "answer";

/** The session document behind a tool call, or a refusal: not every conversation is a session. */
export async function sessionOf(api: ToolExecutionApi, context: Context): Promise<Readonly<SessionDoc>> {
	const doc = await api.snapshot(SessionDocToken, api.conversationId, context);
	if (doc?.id === undefined) throw new Error("This conversation is not a pigui session.");
	return doc;
}

/**
 * Either hand back the answer this call already received, or show `card` and park until it arrives. The card, its
 * document state and its notification go out in one commit; the card keeps the call's ID, so a rerun of the call
 * after a crash finds the card it already showed and does not show or notify twice.
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
	if (state !== undefined) {
		if ("value" in state) return state.value as CardAnswer;
		// Signalled but retracted: the answer is gone, and re-showing the card is not the caller's place to decide.
		throw new Error("The card expired without an answer.");
	}
	await api.commit(async (tx) => {
		await editSession(tx, api.conversationId, services.now(), async (doc) => {
			if (doc.card?.id === card.id) return; // already shown by an earlier rerun of this call
			doc.card = card;
			doc.attentionAt = services.now();
			prepare?.(doc);
			// Keyed by the parked task, not the call ID: the provider's call IDs repeat, and a second card still deserves a notification.
			await services.notifications.enqueue(tx, doc, { key: `card:${card.taskId}`, ...notice });
		});
	}, context);
	await services.faults.afterCard?.(context);
	return { sleep: { signals: [CardAnswerSignal.key(ANSWER_KEY)] } };
}

/** Distinguishes a park from an answer in what a waiting tool returns. */
export function isPark(value: CardAnswer | ToolPark): value is ToolPark {
	return "sleep" in value;
}
