<script lang="ts">
	// A pin that keeps a session as a favorite on the New session page, or takes it off; the index's watch shows the change.
	import { api, describeFailure } from "../api.ts";
	import { showToast } from "../store.svelte.ts";
	import Icon from "./Icons.svelte";

	let { id, label, pinned, class: extra = "" }: { id: number; label: string; pinned: boolean; class?: string } = $props();

	const toggle = async () => {
		try {
			await api.pin(id, !pinned);
		} catch (error) {
			showToast({ message: describeFailure(error).message });
		}
	};
</script>

<button type="button" class={`icon-button dir-star${extra === "" ? "" : ` ${extra}`}`} aria-label={label} aria-pressed={pinned} onclick={() => void toggle()}>
	<Icon name="pin" size={18} />
</button>
