<script lang="ts">
	// The speaker under a reply and on the report card: quiet until tapped, a spinner while its first words are prepared,
	// then a stop button while it reads. It shows only where the server reads aloud.
	import { speak, stopReading } from "../speech.ts";
	import { app } from "../store.svelte.ts";
	import Icon from "./Icons.svelte";

	const LABELS = { idle: "Read aloud", preparing: "Preparing to read aloud", playing: "Stop reading aloud" } as const;

	/** `id` names what is read, so the button knows its own reading and the script is kept for a replay. */
	let { id, session, markdown }: { id: string; session: number; markdown: string } = $props();

	const available = $derived(app.bootstrap?.speech === true);
	const state = $derived(app.reading?.key === id ? app.reading.state : "idle");
</script>

{#if available}
	<button
		type="button"
		class={`icon-button speak ${state}`}
		aria-label={LABELS[state]}
		onclick={() => (state === "idle" ? speak(id, session, markdown) : stopReading())}
	>
		{#if state === "preparing"}
			<span class="spinner" aria-hidden="true"></span>
		{:else}
			<Icon name={state === "playing" ? "stop" : "speaker"} size={20} />
		{/if}
	</button>
{/if}
