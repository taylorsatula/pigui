<script lang="ts">
	// Any problem with the session's next step, and the one action that clears it.
	import { runFailureText, type SessionDoc } from "../../shared/session.ts";
	import { formatDollars } from "../../shared/spend.ts";
	import { api } from "../api.ts";

	let { doc, spent, running, onAction }: { doc: SessionDoc; spent: number; running: boolean; onAction: (work: () => Promise<unknown>) => void } = $props();
</script>

{#if doc.setup.status === "failed"}
	<div class="banner error" role="alert">
		<p>
			<strong>Setup failed.</strong> {doc.setup.error}
		</p>
		<button type="button" class="primary" onclick={() => onAction(() => api.retrySetup(doc.id))}>
			Retry setup
		</button>
	</div>
{:else if !running && doc.outcome !== undefined}
	{#if doc.outcome.kind === "failed"}
		<div class="banner error" role="alert">
			<p>
				<strong>{runFailureText(doc.outcome.reason)}.</strong> {doc.outcome.detail ?? ""}
			</p>
			<button type="button" class="primary" onclick={() => onAction(() => api.continue(doc.id))}>
				Continue
			</button>
		</div>
	{:else if doc.outcome.kind === "budget"}
		{@const raised = Math.max((doc.cap ?? 0) * 2, Math.ceil(spent) + 1)}
		<div class="banner warn" role="alert">
			<p>
				<strong>Budget reached.</strong> {formatDollars(spent)} spent of {formatDollars(doc.cap ?? 0)}.
			</p>
			<button type="button" class="primary" onclick={() => onAction(() => api.budget(doc.id, raised))}>
				Raise to {formatDollars(raised)} and continue
			</button>
		</div>
	{:else if doc.outcome.kind === "no-report"}
		<div class="banner warn" role="alert">
			<p>
				<strong>Pi stopped without a report.</strong> It was continued automatically and still did not finish.
			</p>
			<button type="button" class="primary" onclick={() => onAction(() => api.continue(doc.id))}>
				Continue
			</button>
		</div>
	{:else if doc.outcome.kind === "stopped"}
		<div class="banner" role="status">
			<p>Stopped.</p>
			<button type="button" class="secondary" onclick={() => onAction(() => api.continue(doc.id))}>
				Continue
			</button>
		</div>
	{/if}
{/if}
