<script lang="ts">
	// One agent's conversation, as it goes, with nothing to send: the agent answers the session's agent, not the person.
	import type { LiveState } from "@earendil-works/pi-durable";
	import { agentLive } from "../../shared/session.ts";
	import { app } from "../store.svelte.ts";
	import { buildBlocks } from "../transcript.ts";
	import SessionsButton from "./SessionsButton.svelte";
	import Icon from "./Icons.svelte";
	import Transcript from "./Transcript.svelte";
	import { LABELS, stop, TONES } from "./agents.ts";

	let { session, agent }: { session: number; agent: number } = $props();

	const sessionDoc = $derived(app.session);
	const view = $derived(app.view);
	const missing = $derived(app.missing);
	const doc = $derived(sessionDoc?.id === session ? sessionDoc : undefined);
	const row = $derived(doc?.agents?.find((item) => item.id === agent));
	const running = $derived((view?.docs["pi.live"] as LiveState | undefined)?.run !== undefined);
	const blocks = $derived(buildBlocks(view, undefined, running));
</script>

{#snippet back()}
	<a class="icon-button back" href={`#/s/${session}`} aria-label="Back to the session">
		<Icon name="back" />
	</a>
{/snippet}

{#if missing || (doc !== undefined && row === undefined)}
	<div class="session">
		<header class="topbar">
			{@render back()}
			<h1 class="title">Not found</h1>
		</header>
		<p class="empty">This session has no such agent.</p>
	</div>
{:else if row === undefined}
	<div class="session">
		<header class="topbar">
			{@render back()}
			<h1 class="title">Loading…</h1>
		</header>
	</div>
{:else}
	<div class="session agent-view">
		<div class="pinned">
			<header class="topbar">
				{@render back()}
				<div class="title-block">
					<h1 class="title">{row.description}</h1>
					<p class="subtitle" role="status">
						<span class={`session-status ${TONES[row.status]}`}>{LABELS[row.status]}</span>
						<span class="where">{row.type}</span>
					</p>
				</div>
				{#if agentLive(row)}<button type="button" class="secondary agent-stop" onclick={() => void stop(session, row)}>Stop</button>{/if}
				<SessionsButton />
			</header>
		</div>
		<Transcript blocks={blocks} session={undefined} running={running} />
	</div>
{/if}
