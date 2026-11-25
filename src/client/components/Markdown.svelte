<script lang="ts">
	// Markdown of the agent's prose. While the text grows token by token the render is throttled, so a long reply costs
	// a parse every ~100 ms, not one per token; the newest text always renders once the throttle window passes.
	import { renderMarkdown } from "./markdown.ts";

	const THROTTLE_MS = 100;

	let { text, class: className }: { text: string; class?: string } = $props();

	let html = $state<string>();
	// Not reactive: bookkeeping for the throttle and for dropping stale renders.
	let lastRender = 0;
	let latest = "";

	$effect(() => {
		const current = text;
		latest = current;
		const renderNow = () => {
			lastRender = Date.now();
			void renderMarkdown(current).then((rendered) => {
				if (current === latest) html = rendered;
			});
		};
		const elapsed = Date.now() - lastRender;
		if (elapsed >= THROTTLE_MS) {
			renderNow();
			return;
		}
		const timer = setTimeout(renderNow, THROTTLE_MS - elapsed);
		return () => clearTimeout(timer);
	});
</script>

{#if html !== undefined}
	<div class={`markdown ${className ?? ""}`}>{@html html}</div>
{/if}
