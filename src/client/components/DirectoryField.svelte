<script lang="ts" module>
	import { names } from "../format.ts";
</script>

<script lang="ts">
	// The Directory field, with a star for the directory typed in it.
	import { app } from "../store.svelte.ts";
	import StarButton from "./StarButton.svelte";

	let { dir, home, onInput }: { dir: string; home: string; onInput: (dir: string) => void } = $props();

	const index = $derived(app.index);
	const starred = $derived((index?.starred ?? []).some((d) => names(dir, d, home)));
</script>

<div class="field">
	<label for="directory">Directory</label>
	<div class="field-row">
		<input
			id="directory"
			type="text"
			value={dir}
			autocapitalize="off"
			autocorrect="off"
			spellcheck={false}
			oninput={(event) => onInput(event.currentTarget.value)}
		/>
		<StarButton dir={dir} label="Star this directory" starred={starred} disabled={dir.trim() === ""} />
	</div>
</div>
