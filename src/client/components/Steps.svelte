<script lang="ts">
	// The steps as a checklist: each box holds its step's number until the step is done, then a tick. While the agent
	// works, the first step not yet done is the one it is on.
	import type { Plan } from "../../shared/session.ts";
	import Icon from "./Icons.svelte";
	import Inline from "./Inline.svelte";
	import Part from "./Part.svelte";
	import Paths from "./Paths.svelte";

	let { plan, done, working }: { plan: Plan; done: string[]; working?: boolean } = $props();

	const current = $derived(working === true ? plan.steps.find((step) => !done.includes(step.id))?.id : undefined);
</script>

<Part title="Steps" count={plan.steps.length}>
	<ol class="steps">
		{#each plan.steps as step, index (step.id)}
			<li class={done.includes(step.id) ? "done" : step.id === current ? "current" : ""} aria-current={step.id === current ? "step" : undefined}>
				<span class="box">{#if done.includes(step.id)}<Icon name="check" size={14} label={`Step ${index + 1}, done`} />{:else}{index + 1}{/if}</span>
				<span class="item-text">
					<Inline text={step.text} />
					<Paths paths={step.files} />
				</span>
			</li>
		{/each}
	</ol>
</Part>
