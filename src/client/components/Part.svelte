<script lang="ts">
	// One part of a plan or report under its label; a part with nothing in it is left out.
	import type { Snippet } from "svelte";

	let { title, count, children }: { title: string; count: number; children?: Snippet } = $props();
</script>

{#if count > 0}
	<section class="part" aria-label={title}>
		<h4 class="part-title">{title}</h4>
		{@render children?.()}
	</section>
{/if}
