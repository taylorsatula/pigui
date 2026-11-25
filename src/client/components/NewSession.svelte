<script lang="ts">
	// Starting a session. On a server: a repository (the last one used), a branch choice (a new branch from the default
	// branch unless changed), then the composer. In pigui OnPrem, a directory on this computer comes first, the home
	// directory unless changed, with the starred and recent directories under it to choose from, and a repository is the
	// other choice where gh can list them. File and skill pickers read the chosen directory, or the chosen branch, before
	// anything starts.
	import type { BranchList, RepoSummary } from "../../shared/api.ts";
	import { api, describeFailure } from "../api.ts";
	import { app, navigate } from "../store.svelte.ts";
	import Composer from "./Composer.svelte";
	import ComposerDock from "./ComposerDock.svelte";
	import Directories from "./Directories.svelte";
	import DirectoryField from "./DirectoryField.svelte";
	import SessionsButton from "./SessionsButton.svelte";

	const bootstrap = $derived(app.bootstrap);
	const home = $derived(bootstrap?.onPrem?.home);
	const onPrem = $derived(home !== undefined);

	let place = $state<"local" | "repo">("local");
	let dir = $state("~");
	let repos = $state<RepoSummary[] | undefined>(undefined);
	let repo = $state<string | undefined>(undefined);
	let branches = $state<BranchList | undefined>(undefined);
	let mode = $state<"new" | "continue">("new");
	let base = $state("");
	let branch = $state("");
	let error = $state<string | undefined>(undefined);

	// Until the server says it is OnPrem, the screen is a server's; only OnPrem has directories to choose.
	const local = $derived(onPrem && place === "local");

	$effect(() => {
		// Read bootstrap?.lastRepo so this re-runs when it changes.
		void bootstrap?.lastRepo;
		api.repos().then(
			(list) => {
				repos = list;
				const preferred = list.find((item) => item.name === bootstrap?.lastRepo) ?? list[0];
				repo = repo ?? preferred?.name;
			},
			(failure: unknown) => (error = describeFailure(failure).message),
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
			(failure: unknown) => (error = describeFailure(failure).message),
		);
	});

	const ref = $derived(mode === "new" ? base : branch);
	const ready = $derived(local ? dir.trim() !== "" : repo !== undefined && branches !== undefined && ref !== "");
</script>

<div class="session new-session">
	<header class="topbar">
		<SessionsButton />
		<h1 class="title">New session</h1>
	</header>
	<div class="setup-form">
		<p class="intro">
			{onPrem
				? "Choose where Pi works: a directory on this computer, with your full access, or a repository on a branch of its own. Then describe the task. Pi asks what it needs to know, writes a plan, and waits for your approval before it builds."
				: "Choose a repository and a branch, then describe the task. Pi asks what it needs to know, writes a plan, and waits for your approval before it builds."}
		</p>
		{#if onPrem}
			<div class="segmented" role="radiogroup" aria-label="Where Pi works">
				<button type="button" role="radio" aria-checked={place === "local"} class={place === "local" ? "selected" : ""} onclick={() => (place = "local")}>
					This computer
				</button>
				<button type="button" role="radio" aria-checked={place === "repo"} class={place === "repo" ? "selected" : ""} onclick={() => (place = "repo")}>
					A repository
				</button>
			</div>
		{/if}
		{#if local && home !== undefined}
			<DirectoryField dir={dir} home={home} onInput={(d) => (dir = d)} />
			<Directories dir={dir} home={home} onChoose={(d) => (dir = d)} />
		{:else}
			<!-- Listing repositories needs gh on the server; when it fails, a local session still can start. -->
			{#if error !== undefined}<p class="error-text" role="alert">{error}</p>{/if}
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
				<button type="button" role="radio" aria-checked={mode === "new"} class={mode === "new" ? "selected" : ""} onclick={() => (mode = "new")}>
					New branch
				</button>
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
		{/if}
	</div>
	<ComposerDock>
		<Composer
			draftKey="new"
			placeholder="Describe the task…"
			running={false}
			disabled={!ready}
			focusToken={0}
			files={async () => (local ? (await api.localFiles(dir)).files : repo === undefined ? [] : (await api.repoFiles(repo, ref)).files)}
			skills={() => (local ? api.localSkills(dir) : repo === undefined ? Promise.resolve([]) : api.repoSkills(repo, ref))}
			onSend={async (text, attachments, requestId) => {
				if (local) {
					const { id } = await api.create({ requestId, place: "local", dir, text, attachments });
					navigate({ kind: "session", id });
					return;
				}
				if (repo === undefined) return;
				const start = mode === "new" ? { kind: "new" as const, base } : { kind: "continue" as const, branch };
				const { id } = await api.create({ requestId, place: "repo", repo, start, text, attachments });
				navigate({ kind: "session", id });
			}}
		/>
	</ComposerDock>
</div>
