<script lang="ts">
	// What the report recorded in long-term memory, and its grading of what it was shown. Not part of what is read aloud.
	import type { ReportMemory } from "../../shared/session.ts";
	import { grading } from "./cards.ts";
	import Inline from "./Inline.svelte";
	import Part from "./Part.svelte";

	let { memory }: { memory: ReportMemory } = $props();

	const graded = $derived(grading(memory));
	const written = $derived([...memory.created.map((item) => ({ ...item, edited: false })), ...memory.edited.map((item) => ({ ...item, edited: true }))]);
</script>

<Part title="Remembered" count={written.length + (graded === "" ? 0 : 1)}>
	{#if written.length > 0}
		<ul class="items dashed">
			{#each written as item (item.id)}
				<li>
					<span class="item-text">
						<Inline text={item.text} />
						{#if item.edited}<span class="item-detail">Corrected</span>{/if}
					</span>
				</li>
			{/each}
		</ul>
	{/if}
	{#if graded !== ""}<p class="item-detail grading">{graded}</p>{/if}
</Part>
