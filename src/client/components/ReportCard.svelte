<script lang="ts">
	import type { Report, SessionDoc } from "../../shared/session.ts";
	import { CHECK_ICON, OUTCOME, reportProse, type DeliveryActions } from "./cards.ts";
	import Busy from "./Busy.svelte";
	import Icon from "./Icons.svelte";
	import Inline from "./Inline.svelte";
	import Lines from "./Lines.svelte";
	import Markdown from "./Markdown.svelte";
	import Part from "./Part.svelte";
	import Paths from "./Paths.svelte";
	import Remembered from "./Remembered.svelte";
	import Speak from "./Speak.svelte";

	let { report, latest, session, running, actions }: { report: Report; latest: boolean; session?: SessionDoc; running: boolean; actions: DeliveryActions } = $props();

	let busy = $state<"push" | "pr" | undefined>(undefined);
	// A local session works in place: nothing to push, no pull request and no diff, so the card offers none.
	const local = $derived(session?.place === "local");
	const delivery = $derived(session?.place === "repo" ? session.delivery : undefined);
	const pushed = $derived(report.commit !== undefined && delivery?.pushed?.commit === report.commit);

	const run = async (action: "push" | "pr") => {
		busy = action;
		try {
			await actions.deliver(action);
		} finally {
			busy = undefined;
		}
	};
</script>

<section class="card report" aria-label="Report">
	<header class="card-title">
		<span>Report</span>
		{#if report.commit !== undefined}<span class="commit">{report.commit.slice(0, 7)}</span>{/if}
		<span class={`verdict ${OUTCOME[report.outcome].tone}`}>{OUTCOME[report.outcome].label}</span>
		{#if pushed}<span class="verdict good">Pushed</span>{/if}
		{#if session !== undefined}<Speak id={`report:${report.commit ?? "local"}:${report.filedAt}`} session={session.id} markdown={reportProse(report)} />{/if}
	</header>
	<p class="lede">
		<Inline text={report.headline} />
	</p>
	{#if report.summary !== ""}<Markdown text={report.summary} />{/if}
	<Part title="Done when" count={report.endState.length}>
		<ul class="items results">
			{#each report.endState as check, index (index)}
				<li class={check.met ? "met" : "unmet"}>
					<span class="marker">
						<Icon name={check.met ? "check" : "close"} size={16} label={check.met ? "Met" : "Not met"} />
					</span>
					<span class="item-text">
						<Inline text={check.criterion} />
						<Inline text={check.evidence} class="item-detail" />
					</span>
				</li>
			{/each}
		</ul>
	</Part>
	<Part title="Changes" count={report.changes.length}>
		<ul class="items dashed">
			{#each report.changes as change, index (index)}
				<li>
					<span class="item-text">
						<Inline text={change.change} />
						<Paths paths={change.files} />
					</span>
				</li>
			{/each}
		</ul>
	</Part>
	<Part title="Checks" count={report.checks.length}>
		<ul class="items results">
			{#each report.checks as check, index (index)}
				<li class={check.result === "passed" ? "met" : check.result === "failed" ? "unmet" : "skipped"}>
					<span class="marker">
						<Icon name={CHECK_ICON[check.result]} size={16} label={check.result === "not run" ? "Not run" : check.result === "passed" ? "Passed" : "Failed"} />
					</span>
					<span class="item-text">
						<span class="paths command">{check.command}</span>
						{#if check.detail !== ""}<Inline text={check.detail} class="item-detail" />{/if}
					</span>
				</li>
			{/each}
		</ul>
	</Part>
	<Part title="Changed from the plan" count={report.deviations.length}>
		<Lines lines={report.deviations} caution />
	</Part>
	<Part title="Notes" count={report.notes.length}>
		<Lines lines={report.notes} />
	</Part>
	{#if report.memory !== undefined}<Remembered memory={report.memory} />{/if}
	{#if report.learned.trim() !== ""}
		<details class="part more">
			<summary>
				<Icon name="chevron" size={14} />
				{local ? "What Pi learned about this computer" : "What Pi learned about this repository"}
			</summary>
			<Markdown text={report.learned} />
		</details>
	{/if}
	{#if latest && local}
		<div class="card-actions">
			<button type="button" class="link wide" onclick={() => actions.focusComposer()}>
				Keep working
			</button>
		</div>
	{:else if latest && session !== undefined}
		<!-- One prominent action, the quieter ones beside each other under it, and a way back to the conversation. -->
		<div class="card-actions">
			{#if delivery?.pr === undefined}
				<button type="button" class="primary wide deliver" disabled={running || busy !== undefined} onclick={() => void run("pr")}>
					<Busy busy={busy === "pr"} label="Open pull request" working="Opening…" />
				</button>
				<button type="button" class="secondary" onclick={() => actions.showDiff()}>
					View changes
				</button>
				<button type="button" class="secondary deliver" disabled={running || busy !== undefined} onclick={() => void run("push")}>
					<Busy busy={busy === "push"} label={pushed ? "Push again" : "Push branch"} working="Pushing…" />
				</button>
			{:else if pushed && busy === undefined}
				<!-- The pull request already has this commit: the next step is to look at it. -->
				<a class="button primary wide deliver" href={delivery.pr.url} target="_blank" rel="noopener noreferrer">
					View PR #{delivery.pr.number}
				</a>
				<button type="button" class="secondary" onclick={() => actions.showDiff()}>
					View changes
				</button>
			{:else}
				<button type="button" class="primary wide deliver" disabled={running || busy !== undefined} onclick={() => void run("pr")}>
					<Busy busy={busy === "pr"} label={`Update PR #${delivery.pr.number}`} working="Updating…" />
				</button>
				<button type="button" class="secondary" onclick={() => actions.showDiff()}>
					View changes
				</button>
				<a class="button secondary deliver" href={delivery.pr.url} target="_blank" rel="noopener noreferrer">
					View PR #{delivery.pr.number}
				</a>
			{/if}
			<button type="button" class="link wide" onclick={() => actions.focusComposer()}>
				Keep working
			</button>
		</div>
	{/if}
	{#if latest && delivery?.error !== undefined}<p class="error-text" role="alert">{delivery.error.message}</p>{/if}
</section>
