<script lang="ts">
	// A list of one-line items, each after a dash; `caution` for what a reviewer should weigh (risks, departures).
	import Inline from "./Inline.svelte";

	let { lines, caution }: { lines: string[]; caution?: boolean } = $props();
</script>

<ul class={`items dashed ${caution === true ? "caution" : ""}`}>
	{#each lines as line, index (index)}
		<li>
			<Inline text={line} />
		</li>
	{/each}
</ul>
