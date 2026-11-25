<script lang="ts">
	import type { Plan } from "../../shared/session.ts";
	import Inline from "./Inline.svelte";
	import Part from "./Part.svelte";

	let { plan }: { plan: Plan } = $props();
</script>

<Part title="Done when" count={plan.endState.length}>
	<ul class="items targets">
		{#each plan.endState as condition, index (index)}
			<li>
				<span class="marker" aria-hidden="true">
					<span class="ring"></span>
				</span>
				<Inline text={condition} />
			</li>
		{/each}
	</ul>
</Part>
