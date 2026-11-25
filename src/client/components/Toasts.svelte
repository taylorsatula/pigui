<script lang="ts">
	// The toasts the person should not miss: a slip in ink, rising above the composer, swipeable down, with an optional action.
	import { exitMs, swipeDown } from "../motion.ts";
	import { app, dismissToast, holdToast, type Toast } from "../store.svelte.ts";

	// The current toast, kept on screen while it leaves. A new message is a new toast, so it rises again.
	const current = $derived(app.toast);
	// The leaving toast starts from whatever is current at mount; the effect below keeps it in step.
	// svelte-ignore state_referenced_locally
	let shown = $state<Toast | undefined>(current);
	$effect(() => {
		if (current !== undefined) {
			shown = current;
			return;
		}
		const timer = setTimeout(() => (shown = undefined), exitMs());
		return () => clearTimeout(timer);
	});
	const toast = $derived(current ?? shown);
</script>

{#if toast !== undefined}
	{#key toast.message}
		<div
			use:swipeDown={{ canStart: () => true, distance: () => 45, onDismiss: dismissToast, onHold: holdToast }}
			class={`toast ${current === undefined ? "leaving" : ""}`}
			role="status"
			aria-live="polite"
		>
			<span>{toast.message}</span>
			{#if toast.action !== undefined}
				<button
					type="button"
					class="link"
					onclick={() => {
						toast.action?.run();
						dismissToast();
					}}
				>
					{toast.action.label}
				</button>
			{/if}
		</div>
	{/key}
{/if}
