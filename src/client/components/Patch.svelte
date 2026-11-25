<script lang="ts">
	// A unified diff as labelled lines: the shared renderer for the session's changes and for edit calls.
	let { text }: { text: string } = $props();
</script>

<pre class="patch"><code>{#each text.replace(/\n$/, "").split("\n") as line, index (index)}<span class={line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : ""}>{line}{"\n"}</span>{/each}</code></pre>
