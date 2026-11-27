<script lang="ts">
	// A message the person sent while Pi works, waiting for a break in its work: shown as their words with the cancel
	// offered, until Durable places it as an entry of its own, at which point this becomes the person message itself.
	import type { MessageEntryData } from "../../shared/session.ts";
	import { api, describeFailure } from "../api.ts";
	import { showToast } from "../store.svelte.ts";
	import Person from "./Person.svelte";

	let { data, session, submission }: { data: MessageEntryData; session?: number; submission: number } = $props();
	let canceling = $state(false);

	const cancel = async () => {
		if (session === undefined || canceling) return;
		canceling = true;
		try {
			const { result } = await api.cancelQueued(session, submission);
			if (result === "already_placed") showToast({ message: "That message already reached Pi." });
			else if (result === "aborted") showToast({ message: "Message canceled." });
		} catch (error) {
			showToast({ message: describeFailure(error).message });
		} finally {
			canceling = false;
		}
	};
</script>

<Person data={data} />
<div class="queued-row">
	<span class="queued-note">Queued — Pi will read this when its current step ends</span>
	{#if session !== undefined}
		<button type="button" class="link queued-cancel" disabled={canceling} onclick={() => void cancel()}>
			{canceling ? "Canceling…" : "Cancel"}
		</button>
	{/if}
</div>
