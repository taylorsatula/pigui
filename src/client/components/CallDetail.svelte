<script lang="ts" module>
	/** How many of a call's last output lines show while its turn runs. */
	const TAIL_LINES = 4;

	/** Stringified arguments, by identity: call args are immutable, so this pays once per call, not per update. */
	const stringified = new WeakMap<object, string>();
	function json(value: unknown): string {
		if (typeof value !== "object" || value === null) return JSON.stringify(value, null, 2);
		let out = stringified.get(value);
		if (out === undefined) {
			out = JSON.stringify(value, null, 2);
			stringified.set(value, out);
		}
		return out;
	}

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
	import Markdown from "./Markdown.svelte";
	import Patch from "./Patch.svelte";
	import ReportBody from "./ReportBody.svelte";

	let { call, live }: { call: CallView; live: boolean } = $props();

	const bash = $derived(call.name === "bash");
	const agent = $derived(call.name === "Agent");
	const editing = $derived(call.name === "edit" && call.diff !== undefined);
	const writing = $derived(call.name === "write" && typeof call.args.content === "string");
	const input = $derived(bash ? String(call.args.command ?? "") : json(call.args));
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
			{#if agent}
				<div class="io-label">Prompt</div>
				<Markdown class="prompt-prose" text={String(call.args.prompt ?? "")} />
			{:else if editing}
				<div class="io-label">Change</div>
				<Patch text={call.diff ?? ""} />
			{:else if writing}
				<div class="io-label">File</div>
				<pre class="io file-content">{String(call.args.content)}</pre>
			{:else if bash}
				<div class="io-label">Input</div>
				<pre class="io">{input}</pre>
			{/if}
			{#if call.output !== undefined}
				<div class="io-label">{agent ? "Answer" : "Output"}</div>
				{#if agent}
					<ReportBody text={call.output} />
				{:else}
					<pre class="io">{call.output === "" ? "(no output)" : call.output}</pre>
				{/if}
			{/if}
			{#if !bash}
				<details class="raw">
					<summary>Raw input</summary>
					<pre class="io">{input}</pre>
				</details>
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
