<script lang="ts">
	import type { Plan } from "../../shared/session.ts";
	import Inline from "./Inline.svelte";
	import Part from "./Part.svelte";

	let { plan }: { plan: Plan } = $props();
</script>

<Part title="Decided for you" count={plan.decisions.length}>
	<ul class="items decisions">
		{#each plan.decisions as decision, index (index)}
			<li>
				<Inline text={decision.choice} class="item-main" />
				<Inline text={decision.reason} class="item-detail" />
			</li>
		{/each}
	</ul>
</Part>
