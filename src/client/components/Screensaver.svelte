<script lang="ts">
	// The screensaver: after five idle minutes, while the session is in its implementing workflow, girl.gif dances in the
	// lower right corner over everything. Any input dismisses it and re-arms the wait. Reduced motion suppresses it, as
	// does a hidden tab; a missing or broken asset disables it rather than showing a broken image.
	import { IDLE_MS, INPUT_EVENTS, idleTimer } from "../idle.ts";

	let { active }: { active: boolean } = $props();

	let shown = $state(false);
	let failed = $state(false);

	$effect(() => {
		if (!active || failed) {
			shown = false;
			return;
		}
		const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
		const timer = idleTimer(() => {
			if (document.visibilityState === "visible" && !reduced()) shown = true;
		}, IDLE_MS);
		const onInput = () => {
			shown = false;
			timer.reset();
		};
		const onVisibility = () => {
			if (document.visibilityState === "hidden") shown = false;
		};
		for (const event of INPUT_EVENTS) window.addEventListener(event, onInput, { capture: true, passive: true });
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			shown = false;
			timer.cancel();
			for (const event of INPUT_EVENTS) window.removeEventListener(event, onInput, { capture: true });
			document.removeEventListener("visibilitychange", onVisibility);
		};
	});
</script>

{#if shown}
	<div class="screensaver" aria-hidden="true">
		<img
			src="/girl.gif"
			width="500"
			height="500"
			alt=""
			onerror={() => {
				failed = true;
				shown = false;
			}}
		/>
	</div>
{/if}
