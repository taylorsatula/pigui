<script lang="ts" module>
	/** After its content scrolls, the sheet waits this long before a drag on the content may move it (as Vaul does). */
	const SCROLL_SETTLE = 100;
</script>

<script lang="ts">
	// The session's changes, file by file with added and removed counts; each file opens to its patch. Shown as a sheet
	// that rises over the session and closes with Done, Escape, a tap on the dimmed page, or a swipe down.
	import type { SessionDiff } from "../../shared/api.ts";
	import { api, describeFailure } from "../api.ts";
	import { exitMs, swipeDown } from "../motion.ts";
	import Icon from "./Icons.svelte";
	import Patch from "./Patch.svelte";

	let { session, onClose }: { session: number; onClose: () => void } = $props();

	let diff = $state<SessionDiff | undefined>(undefined);
	let error = $state<string | undefined>(undefined);
	let closing = $state(false);

	let sheet: HTMLDivElement | undefined;
	let scrim: HTMLDivElement | undefined;
	let header: HTMLElement | undefined;
	let body: HTMLDivElement | undefined;
	let scrolledAt = 0;

	const close = () => {
		closing = true;
	};

	$effect(() => {
		api.diff(session).then(
			(value) => (diff = value),
			(failure: unknown) => (error = describeFailure(failure).message),
		);
	});

	$effect(() => {
		const onKey = (event: KeyboardEvent) => event.key === "Escape" && (closing = true);
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	// Leave the page once the sheet has slid away.
	$effect(() => {
		if (!closing) return;
		const timer = setTimeout(onClose, exitMs());
		return () => clearTimeout(timer);
	});

	// Focus moves into the sheet, and back to whatever opened it when it goes.
	$effect(() => {
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
		sheet?.focus({ preventScroll: true });
		return () => opener?.focus({ preventScroll: true });
	});

	const added = $derived(diff?.files.reduce((sum, file) => sum + file.added, 0) ?? 0);
	const removed = $derived(diff?.files.reduce((sum, file) => sum + file.removed, 0) ?? 0);
</script>

{#snippet counts(added: number, removed: number)}
	<span class="diff-counts"><span class={`add ${added === 0 ? "zero" : ""}`}>+{added}</span> <span class={`del ${removed === 0 ? "zero" : ""}`}>−{removed}</span></span>
{/snippet}

<div class={`sheet-scrim ${closing ? "closing" : ""}`} onclick={close} aria-hidden="true"></div>
<div
	class={`sheet ${closing ? "closing" : ""}`}
	role="dialog"
	aria-modal="true"
	aria-labelledby="diff-title"
	tabindex={-1}
	bind:this={sheet}
	use:swipeDown={{
		// From the top bar always; from the content only when it rests at its top, so a scroll that just reached the
		// top, still gliding, is not caught as a dismissal.
		canStart: (target) =>
			(target instanceof Node && header?.contains(target) === true) ||
			((body?.scrollTop ?? 0) <= 0 && performance.now() - scrolledAt > SCROLL_SETTLE),
		distance: (height) => height * 0.25,
		onDismiss: close,
		onProgress: (shown) => {
			const element = scrim;
			if (element === null || element === undefined) return;
			element.classList.toggle("dragging", shown !== undefined);
			element.style.opacity = shown === undefined ? "" : String(shown);
		},
	}}
>
	<header class="sheet-header" bind:this={header}>
		<span class="grabber" aria-hidden="true"></span>
		<h2 id="diff-title">Changes</h2>
		<button type="button" class="link done" onclick={close}>Done</button>
	</header>
	<div class="sheet-body" bind:this={body} onscroll={() => (scrolledAt = performance.now())}>
		{#if error !== undefined}
			<p class="error-text">{error}</p>
		{:else if diff === undefined}
			<p class="sheet-status"><span class="spinner" aria-hidden="true"></span> Loading…</p>
		{:else}
			<p class="diff-summary">
				<span>{diff.files.length} file{diff.files.length === 1 ? "" : "s"} changed against {diff.base}</span>
				{#if diff.files.length > 0}{@render counts(added, removed)}{/if}
			</p>
			{#if diff.uncommitted > 0}<p class="diff-note warn">{diff.uncommitted} uncommitted, not included</p>{/if}
			{#if diff.files.length === 0}<p class="sheet-status">No committed changes yet.</p>{/if}
			{#each diff.files as file (file.path)}
				<details class="diff-file">
					<summary>
						<Icon name="chevron" size={16} />
						<span class="diff-path">{file.from === undefined ? file.path : `${file.from} → ${file.path}`}</span>
						{#if file.binary}<span class="diff-counts">binary</span>{:else}{@render counts(file.added, file.removed)}{/if}
					</summary>
					{#if file.binary}<p class="diff-note">A binary file.</p>{:else}<Patch text={file.patch} />{/if}
					{#if file.truncated}<p class="diff-note">The rest of this file's changes are too long to show here.</p>{/if}
				</details>
			{/each}
		{/if}
	</div>
</div>
