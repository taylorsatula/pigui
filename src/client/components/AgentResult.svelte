<script lang="ts" module>
	/** How many of an agent's answer's lines show before it is opened. */
	const PREVIEW_LINES = 3;
</script>

<script lang="ts">
	// A background agent's answer, as the session's agent got it: its own block, headed by the agent, showing its first
	// lines until it is opened to the whole answer.
	import type { AgentResultData } from "../../shared/session.ts";
	import Icon from "./Icons.svelte";
	import Markdown from "./Markdown.svelte";

	let { data }: { data: AgentResultData } = $props();

	const preview = $derived(data.text.split("\n").filter((line) => line.trim() !== "").slice(0, PREVIEW_LINES).join("\n"));
</script>

<details class={`agent-result ${data.status}`}>
	<summary>
		<span class="agent-result-head">
			<Icon name="chevron" size={14} />
			<span class="agent-type">{data.type}</span>
			<span class="agent-description">{data.description}</span>
			<span class="agent-ended">{data.status === "done" ? "answered" : "failed"}</span>
		</span>
		<span class="agent-preview">{preview}</span>
	</summary>
	<Markdown text={data.text} class="agent" />
</details>
