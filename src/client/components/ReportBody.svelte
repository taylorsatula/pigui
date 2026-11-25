<script lang="ts" module>
	/** What a report-ish answer splits into: a preamble (no label) and one section per `LABEL:` line. */
	export type ReportSection = { label?: string; body: string };

	const LABEL = /^([A-Z][A-Z0-9][A-Z0-9 ._/&()-]{0,40}):[ \t]*(.*)$/;

	function sectionsOf(text: string): { sections: ReportSection[]; structured: boolean } {
		const sections: ReportSection[] = [];
		let current: ReportSection = { body: "" };
		for (const line of text.split("\n")) {
			const match = LABEL.exec(line);
			if (match) {
				if (current.label !== undefined || current.body.trim() !== "") sections.push(current);
				current = { label: match[1] ?? "", body: match[2] ?? "" };
				continue;
			}
			current.body += (current.body === "" ? "" : "\n") + line;
		}
		sections.push(current);
		const labelled = sections.filter((section) => section.label !== undefined);
		return { sections, structured: labelled.length >= 2 };
	}
</script>

<script lang="ts">
	// An agent's answer, structured when it follows the report shape: a preamble, then one labelled section per
	// `LABEL:` line. Answers without the shape render as plain Markdown, as before.
	import Markdown from "./Markdown.svelte";

	let { text, class: className }: { text: string; class?: string } = $props();

	const parsed = $derived(sectionsOf(text));
</script>

{#if parsed.structured}
	<div class="report {className ?? ""}">
		{#each parsed.sections as section, index (index)}
			{#if section.label !== undefined}
				<div class="report-section">
					<div class="report-label">{section.label}</div>
					{#if section.body.trim() !== ""}<Markdown text={section.body.trim()} />{/if}
				</div>
			{:else if section.body.trim() !== ""}
				<Markdown text={section.body.trim()} />
			{/if}
		{/each}
	</div>
{:else}
	<Markdown {text} class={className} />
{/if}
