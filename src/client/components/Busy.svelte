<script lang="ts">
	// A button's label, or while its action runs, a spinner and what it is doing.
	let { busy, label, working }: { busy: boolean; label: string; working: string } = $props();
</script>

{#if busy}
	<span class="spinner" aria-hidden="true"></span>
	{working}
{:else}
	{label}
{/if}
