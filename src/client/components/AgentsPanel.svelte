<script lang="ts">
	// The panel over the page, on the session picker's veil: one row per agent, newest first.
	import { agentLive, type SessionDoc } from "../../shared/session.ts";
	import { app } from "../store.svelte.ts";
	import { counts, countText, detail, elapsed, LABELS, stop, TONES } from "./agents.ts";
	import Icon from "./Icons.svelte";

	let { doc, onClose }: { doc: SessionDoc; onClose: () => void } = $props();

	const docs = $derived(app.agents);
	const rows = $derived(doc.agents ?? []);
	const ticking = $derived(rows.some(agentLive));
	let now = $state(Date.now());
	$effect(() => {
		if (!ticking) return;
		const timer = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(timer);
	});
	const newest = $derived([...rows].sort((a, b) => b.createdAt - a.createdAt));
	const waiting = $derived(rows.filter((row) => row.status === "queued").sort((a, b) => a.task - b.task));
	const live = $derived(counts(rows));
	let list: HTMLUListElement | undefined;

	$effect(() => {
		// The first agent takes the focus, and the button that opened the panel gets it back.
		const opener = document.activeElement as HTMLElement | null;
		list?.querySelector<HTMLElement>(".agent-open")?.focus({ preventScroll: true });
		const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("keydown", onKey);
			opener?.focus({ preventScroll: true });
		};
		// The panel opens once and closes; there is nothing to re-run this for.
	});
</script>

<div class="picker-veil" onclick={onClose} aria-hidden="true"></div>
<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
<section class="agents-panel" role="dialog" aria-modal="true" aria-label="Agents" id="agents-panel">
	<header class="picker-bar">
		<h2>Agents</h2>
		<p class="agents-count">{countText(live) || "none at work"}</p>
		<button type="button" class="icon-button" aria-label="Close" onclick={onClose}>
			<Icon name="close" size={20} />
		</button>
	</header>
	<ul class="agent-list" bind:this={list}>
		{#each newest as row (row.id)}
			<li class={`agent-row ${row.status}`}>
				<a class="agent-open" href={`#/s/${doc.id}/agent/${row.id}`} aria-label={`${row.type}: ${row.description}, ${LABELS[row.status].toLowerCase()}`}>
					<span class={`indicator ${TONES[row.status]}`} aria-hidden="true"></span>
					<span class="agent-main">
						<span class="agent-line">
							<span class="agent-type">{row.type}</span>
							<span class="agent-description">{row.description}</span>
						</span>
						<span class="agent-detail">{detail(row, docs[row.id], waiting.indexOf(row) + 1)}</span>
					</span>
					<span class="agent-time">{elapsed(row, now)}</span>
				</a>
				{#if agentLive(row)}
					<button type="button" class="secondary agent-stop" aria-label={`Stop ${row.type}: ${row.description}`} onclick={() => void stop(doc.id, row)}>Stop</button>
				{/if}
			</li>
		{/each}
	</ul>
</section>
