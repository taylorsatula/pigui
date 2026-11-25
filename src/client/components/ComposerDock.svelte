<script lang="ts">
	// The bar at the bottom that holds the composer and anything about to need the person. Its height is published as
	// `--dock-height` so toasts rise just above it, and when it grows the transcript's end stays in view.
	import type { Snippet } from "svelte";
	import { followEnd } from "../viewport.ts";

	let { children }: { children?: Snippet } = $props();

	let dock = $state<HTMLDivElement | null | undefined>(null);

	$effect(() => {
		const element = dock;
		if (element === null || element === undefined) return;
		const root = document.documentElement;
		const observer = new ResizeObserver(() => {
			root.style.setProperty("--dock-height", `${element.offsetHeight}px`);
			followEnd();
		});
		observer.observe(element);
		return () => {
			observer.disconnect();
			root.style.removeProperty("--dock-height");
		};
	});
</script>

<div class="composer-dock" bind:this={dock}>
	{@render children?.()}
</div>
