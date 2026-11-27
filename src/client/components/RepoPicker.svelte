<script lang="ts">
	// Full screen for choosing the repository to start from, reached from the Repository tile. Prefilled with the most
	// recent repository on its default branch; the branch can be changed to any the repository host lists. Start session
	// spawns the blank screen; the server session is created by its first message, never by this screen.
	import type { BranchList, RepoSummary } from "../../shared/api.ts";
	import type { SessionRow } from "../../shared/session.ts";
	import { api, describeFailure } from "../api.ts";
	import { setPendingStart, navigate, app, showToast } from "../store.svelte.ts";
	import Icon from "./Icons.svelte";

	let { onClose }: { onClose: () => void } = $props();

	const bootstrap = $derived(app.bootstrap);
	const newestRowRepo = $derived.by(() => {
		const rows = Object.values(app.index?.rows ?? {}).filter((row) => row.place === "repo" && !row.archived);
		rows.sort((a, b) => b.updatedAt - a.updatedAt);
		const newest = rows[0] as (SessionRow & { place: "repo"; repo: string }) | undefined;
		return newest?.repo;
	});

	let repos = $state<RepoSummary[] | undefined>(undefined);
	// The prefill is deliberately the values at open time, like the rest of the spawn.
	// svelte-ignore state_referenced_locally
	let repo = $state<string | undefined>(bootstrap?.lastRepo ?? newestRowRepo);
	let branches = $state<BranchList | undefined>(undefined);
	let mode = $state<"new" | "continue">("new");
	let base = $state("");
	let branch = $state("");

	$effect(() => {
		api.repos().then(
			(list) => {
				repos = list;
				const preferred = list.find((item) => item.name === repo) ?? list.find((item) => item.name === bootstrap?.lastRepo) ?? list[0];
				repo = preferred?.name;
			},
			(failure: unknown) => showToast({ message: describeFailure(failure).message }),
		);
	});

	$effect(() => {
		if (repo === undefined) return;
		branches = undefined;
		api.branches(repo).then(
			(list) => {
				branches = list;
				base = list.defaultBranch;
				branch = list.branches.find((name) => name !== list.defaultBranch) ?? list.defaultBranch;
			},
			(failure: unknown) => showToast({ message: describeFailure(failure).message }),
		);
	});

	const ref = $derived(mode === "new" ? base : branch);
	const ready = $derived(repo !== undefined && branches !== undefined && ref !== "");
	const start = () => {
		if (repo === undefined || !ready) return;
		setPendingStart({ place: "repo", repo, start: mode === "new" ? { kind: "new", base } : { kind: "continue", branch } });
		onClose();
		navigate({ kind: "start" });
	};

	const onKeydown = (event: KeyboardEvent) => {
		if (event.key === "Escape") onClose();
	};
</script>

<svelte:window onkeydown={onKeydown} />

<div class="repo-picker" role="dialog" aria-modal="true" aria-label="Start from a repository">
	<header class="topbar">
		<button type="button" class="icon-button back" aria-label="Back" onclick={onClose}>
			<Icon name="back" />
		</button>
		<h1 class="title">Repository</h1>
	</header>
	<div class="repo-picker-body">
		<label class="field">
			<span>Repository</span>
			<select value={repo ?? ""} disabled={repos === undefined} onchange={(event) => (repo = event.currentTarget.value)}>
				{#if repos === undefined}<option value="">Loading…</option>{/if}
				{#each repos ?? [] as item (item.name)}
					<option value={item.name}>{item.name}</option>
				{/each}
			</select>
		</label>
		<div class="segmented" role="radiogroup" aria-label="Branch">
			<button type="button" role="radio" aria-checked={mode === "new"} class={mode === "new" ? "selected" : ""} onclick={() => (mode = "new")}>New branch</button>
			<button type="button" role="radio" aria-checked={mode === "continue"} class={mode === "continue" ? "selected" : ""} onclick={() => (mode = "continue")}>
				Continue a branch
			</button>
		</div>
		<label class="field">
			<span>{mode === "new" ? "Start from" : "Branch to continue"}</span>
			<select
				value={ref}
				disabled={branches === undefined}
				onchange={(event) => {
					const value = event.currentTarget.value;
					if (mode === "new") base = value;
					else branch = value;
				}}
			>
				{#each branches?.branches ?? [] as name (name)}
					<option value={name}>{name}{name === branches?.defaultBranch ? " (default)" : ""}</option>
				{/each}
			</select>
		</label>
	</div>
	<footer class="repo-picker-footer">
		<button type="button" class="start-button" disabled={!ready} onclick={start}>Start session</button>
	</footer>
</div>
