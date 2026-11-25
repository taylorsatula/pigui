<script lang="ts">
	import { planOf, type CardAnswer, type PlanCard, type SessionDoc } from "../../shared/session.ts";
	import type { CardActions } from "./cards.ts";
	import Decisions from "./Decisions.svelte";
	import EndState from "./EndState.svelte";
	import Icon from "./Icons.svelte";
	import Inline from "./Inline.svelte";
	import PlanRest from "./PlanRest.svelte";
	import Steps from "./Steps.svelte";

	let { card, answer, pending, session, running, actions }: { card: PlanCard; answer?: CardAnswer; pending: boolean; session?: SessionDoc; running: boolean; actions: CardActions } = $props();

	const plan = $derived(planOf(card.plan));
	let busy = $state(false);
	const working = $derived(running && session?.card === undefined);
	const done = $derived(session?.plan?.revision === card.revision && session.plan.approved ? session.plan.done : []);

	const approve = async () => {
		busy = true;
		try {
			await actions.answer(card.id, { kind: "approve" });
		} finally {
			busy = false;
		}
	};

	const status = $derived(
		answer?.kind === "approve"
			? "Approved"
			: answer?.kind === "revise"
				? "Changes requested"
				: answer?.kind === "text"
					? "Changes requested"
					: pending
						? "Waiting for your approval"
						: undefined,
	);
	const feedback = $derived(answer?.kind === "revise" ? answer.feedback : answer?.kind === "text" ? answer.text : undefined);
</script>

<section class={`card plan ${pending ? "waiting" : ""}`} aria-label={`Plan: ${plan.title}`}>
	<header class="card-title">
		<span>Plan{card.revision > 1 ? `, revision ${card.revision}` : ""}</span>
		{#if status !== undefined}
			<span class={`verdict ${answer?.kind === "approve" ? "good" : pending ? "mark" : "warn"}`}>{status}</span>
		{/if}
	</header>
	<h3>{plan.title}</h3>
	<p class="goal">
		<Inline text={plan.goal} />
	</p>
	{#if pending}
		<EndState plan={plan} />
		<Decisions plan={plan} />
		<Steps plan={plan} done={done} />
		<PlanRest plan={plan} />
	{:else}
		<!-- Once answered, the plan is what is being carried out: its steps, ticking off. The rest opens on a tap. -->
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
	{/if}
	{#if feedback !== undefined}<p class="given">You asked: “{feedback}”</p>{/if}
	{#if pending}
		<div class="card-actions">
			<button type="button" class="primary" disabled={busy} onclick={() => void approve()}>
				Approve
			</button>
			<button type="button" class="secondary" disabled={busy} onclick={() => actions.focusComposer()}>
				Request changes
			</button>
		</div>
	{/if}
</section>
