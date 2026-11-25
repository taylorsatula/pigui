<script lang="ts">
	import type { MessageEntryData } from "../../shared/session.ts";
	import Icon from "./Icons.svelte";

	let { data }: { data: MessageEntryData } = $props();
</script>

<p class="said">{data.text}</p>
{#if data.references.length + data.attachments.length > 0}
	<div class="context-chips" aria-label="Added to the message">
		{#each data.references as reference (`${reference.kind}:${reference.value}`)}
			<span class="chip" title={reference.note}>
				{reference.kind === "file" ? "@" : "#"}{reference.value}{reference.status === "pointer" ? ` (${reference.note ?? "pointer"})` : ""}
			</span>
		{/each}
		{#each data.attachments as attachment (attachment.path)}
			<span class="chip"><Icon name="clip" size={14} /> {attachment.name}</span>
		{/each}
	</div>
{/if}
