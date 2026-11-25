<script lang="ts">
	// The ☰ button that opens the picker, with a dot when a session other than the open one needs the person.
	import { needsAttention } from "../../shared/session.ts";
	import { app } from "../store.svelte.ts";
	import Icon from "./Icons.svelte";

	const index = $derived(app.index);
	const route = $derived(app.route);
	const open = $derived(app.pickerOpen);
	const current = $derived(route.kind === "session" ? route.id : undefined);
	const others = $derived(Object.values(index?.rows ?? {}).filter((row) => row.id !== current && needsAttention(row)).length);
</script>

<button
	type="button"
	class="icon-button menu"
	aria-label={others > 0 ? `Sessions, ${others} need${others === 1 ? "s" : ""} you` : "Sessions"}
	aria-haspopup="dialog"
	aria-expanded={open}
	aria-controls="session-picker"
	onclick={() => (app.pickerOpen = !open)}
>
	<Icon name="menu" />
	{#if others > 0}<span class="dot badge-dot" data-testid="attention-dot"></span>{/if}
</button>
