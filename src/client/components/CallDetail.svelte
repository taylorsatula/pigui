<script lang="ts" module>
	/** How many of a call's last output lines show while its turn runs. */
	const TAIL_LINES = 4;

	/** A call's last lines of output, and how many came before them. */
	function tail(output: string | undefined): { lines: string; earlier: number } {
		const all = (output ?? "").trimEnd().split("\n");
		if (all.length === 1 && all[0] === "") return { lines: "", earlier: 0 };
		return { lines: all.slice(-TAIL_LINES).join("\n"), earlier: Math.max(0, all.length - TAIL_LINES) };
	}
</script>

<script lang="ts">
	// One tool call. While its turn runs it is a block headed by what it runs (`$ command`, or what it edits or reads) with
	// the last lines of a command's output, or of any failure, under it, as Pi's own terminal shows a call. Folded, it is
	// one line. Either way it opens on a tap to its full input and output.
	import { describeCall } from "../format.ts";
	import type { CallView } from "../transcript.ts";
	import Cursor from "./Cursor.svelte";
	import Icon from "./Icons.svelte";

	let { call, live }: { call: CallView; live: boolean } = $props();

	const bash = $derived(call.name === "bash");
	const input = $derived(bash ? String(call.args.command ?? "") : JSON.stringify(call.args, null, 2));
	const shown = $derived(live && (bash || call.status === "failed") ? tail(call.output) : { lines: "", earlier: 0 });
</script>

{#snippet details()}
	<details class={`call ${call.status}`}>
		<summary>
			{#if !live}<Icon name="chevron" size={14} />{/if}
			{#if live && bash}
				<span class="call-command">
					<span class="prompt">$ </span>
					{input}
				</span>
			{:else}
				<span class="call-summary">{describeCall(call.name, call.args)}</span>
			{/if}
			{#if call.status === "failed"}<span class="failed-tag">failed</span>{/if}
			{#if call.status === "running"}<Cursor />{/if}
		</summary>
		<div class="call-body">
			<div class="io-label">Input</div>
			<pre class="io">{input}</pre>
			{#if call.output !== undefined}
				<div class="io-label">Output</div>
				<pre class="io">{call.output === "" ? "(no output)" : call.output}</pre>
			{/if}
		</div>
	</details>
{/snippet}

{#if live}
	<div class={`live-call ${call.status}`}>
		{@render details()}
		<!-- Outside the call's own disclosure, so what it printed last shows without a tap. -->
		{#if shown.lines !== ""}
			<pre class="tail">{#if shown.earlier > 0}<span class="earlier">… {shown.earlier} earlier line{shown.earlier === 1 ? "" : "s"}{"\n"}</span>{/if}{shown.lines}</pre>
		{/if}
	</div>
{:else}
	{@render details()}
{/if}
