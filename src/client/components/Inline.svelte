<script lang="ts">
	import { renderInline } from "./markdown.ts";

	let { text, class: className }: { text: string; class?: string } = $props();

	let html = $state<string>();

	$effect(() => {
		let cancelled = false;
		const current = text;
		void renderInline(current).then((rendered) => {
			if (!cancelled) html = rendered;
		});
		return () => {
			cancelled = true;
		};
	});
</script>

{#if html !== undefined}
	<span class={`inline ${className ?? ""}`}>{@html html}</span>
{/if}
