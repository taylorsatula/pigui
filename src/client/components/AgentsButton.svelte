<script lang="ts">
	// The Agents button, in the session's bar once the session has an agent; its badge counts those at work.
	import type { SessionDoc } from "../../shared/session.ts";
	import { counts, countText } from "./agents.ts";
	import Icon from "./Icons.svelte";

	let { doc, open, onToggle }: { doc: SessionDoc; open: boolean; onToggle: () => void } = $props();

	const rows = $derived(doc.agents ?? []);
	const live = $derived(counts(rows));
	const total = $derived(live.running + live.queued);
</script>

{#if rows.length > 0}
	<button
		type="button"
		class="icon-button"
		aria-label={total === 0 ? "Agents" : `Agents, ${countText(live)}`}
		aria-haspopup="dialog"
		aria-expanded={open}
		aria-controls="agents-panel"
		onclick={onToggle}
	>
		<Icon name="agents" />
		{#if total > 0}<span class="count-badge" aria-hidden="true">{total}</span>{/if}
	</button>
{/if}
