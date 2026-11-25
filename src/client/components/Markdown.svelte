<script lang="ts">
	import { renderMarkdown } from "./markdown.ts";

	let { text, class: className }: { text: string; class?: string } = $props();

	let html = $state<string>();

	$effect(() => {
		let cancelled = false;
		const current = text;
		void renderMarkdown(current).then((rendered) => {
			if (!cancelled) html = rendered;
		});
		return () => {
			cancelled = true;
		};
	});
</script>

{#if html !== undefined}
	<div class={`markdown ${className ?? ""}`}>{@html html}</div>
{/if}
