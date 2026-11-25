<script lang="ts">
	// Repository paths under an item, in the record's monospace.
	let { paths }: { paths: string[] } = $props();
</script>

{#if paths.length > 0}
	<span class="paths">{paths.join("  ")}</span>
{/if}
