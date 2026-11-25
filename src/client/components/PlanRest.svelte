<script lang="ts">
	// What the person checks last: how the work will be proved, what is left out, what could go wrong, and the sources.
	import type { Plan } from "../../shared/session.ts";
	import Icon from "./Icons.svelte";
	import Inline from "./Inline.svelte";
	import Lines from "./Lines.svelte";
	import Part from "./Part.svelte";

	let { plan }: { plan: Plan } = $props();
</script>

<Part title="Verified by" count={plan.verification.length}>
	<ul class="items dashed commands">
		{#each plan.verification as command, index (index)}
			<li>
				<Inline text={command} />
			</li>
		{/each}
	</ul>
</Part>
<Part title="Not doing" count={plan.outOfScope.length}>
	<Lines lines={plan.outOfScope} />
</Part>
<Part title="Risks" count={plan.risks.length}>
	<Lines lines={plan.risks} caution />
</Part>
{#if plan.citations.length > 0}
	<details class="part sources">
		<summary>
			<Icon name="chevron" size={14} />
			{plan.citations.length === 1 ? "1 source" : `${plan.citations.length} sources`} read for this plan
		</summary>
		<ul class="items">
			{#each plan.citations as citation, index (index)}
				<li>
					<span class="item-text">
						<span class="paths ref">{citation.ref}</span>
						<Inline text={citation.note} class="item-detail" />
					</span>
				</li>
			{/each}
		</ul>
	</details>
{/if}
