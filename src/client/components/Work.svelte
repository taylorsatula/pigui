<script lang="ts">
	// A stretch of work. While its turn runs, nothing hides it: the thinking reads inline as it comes and each call shows
	// as a block, in the order they happened. Once the turn ends it folds to one line that opens on a tap.
	import { describeGroup } from "../format.ts";
	import type { WorkItem } from "../transcript.ts";
	import CallDetail from "./CallDetail.svelte";
	import Cursor from "./Cursor.svelte";
	import Icon from "./Icons.svelte";

	let { items, live }: { items: WorkItem[]; live: boolean } = $props();

	const calls = $derived(items.flatMap((item) => (item.kind === "call" ? [item.call] : [])));
	const failed = $derived(calls.filter((call) => call.status === "failed").length);
</script>

{#if live}
	<div class="work live">
		{#each items as item (item.key)}
			{#if item.kind === "thinking"}
				<p class="thought">{item.text}{#if item.streaming}<Cursor />{/if}</p>
			{:else}
				<CallDetail call={item.call} live />
			{/if}
		{/each}
	</div>
{:else}
	<details class="work">
		<summary>
			<Icon name="chevron" size={14} />
			<span class="work-summary">{calls.length > 0 ? describeGroup(calls.map((call) => call.name)) : "Thought"}</span>
			{#if failed > 0}<span class="failed-tag">{failed} failed</span>{/if}
		</summary>
		<div class="timeline">
			{#each items as item (item.key)}
				{#if item.kind === "thinking"}
					<p class="thought">{item.text}</p>
				{:else}
					<CallDetail call={item.call} live={false} />
				{/if}
			{/each}
		</div>
	</details>
{/if}
