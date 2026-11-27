<script lang="ts">
	// A star that adds a place (a repository or a directory) to the starred ones, or takes it off; the index's watch shows the change.
	import { api, describeFailure } from "../api.ts";
	import { showToast } from "../store.svelte.ts";
	import Icon from "./Icons.svelte";

	let { kind, target, label, starred, disabled }: { kind: "dir" | "repo"; target: string; label: string; starred: boolean; disabled?: boolean } =
		$props();

	const toggle = async () => {
		try {
			if (kind === "dir") await api.star(target, !starred);
			else await api.starRepo(target, !starred);
		} catch (error) {
			showToast({ message: describeFailure(error).message });
		}
	};
</script>

<button type="button" class="icon-button dir-star" aria-label={label} aria-pressed={starred} disabled={disabled} onclick={() => void toggle()}>
	<Icon name="star" size={18} />
</button>
