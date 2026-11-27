<script lang="ts">
	// Starting a session is an IF-tree, not a form: work on this computer (OnPrem), or in a repository. Tapping either
	// opens the blank screen to type the task; the first send is what creates the session. Below the choices are the
	// starred repositories and the five most recently used repository branches; tapping a row spawns the blank screen
	// continuing the branch shown. Anything else — a branch to cut from, a branch to continue, a repository not in
	// either list — lives behind the Repository tile.
	import type { BranchList } from "../../shared/api.ts";
	import type { SessionRow } from "../../shared/session.ts";
	import { api } from "../api.ts";
	import { timeAgo } from "../format.ts";
	import { app, navigate, setPendingStart } from "../store.svelte.ts";
	import Icon from "./Icons.svelte";
	import RepoPicker from "./RepoPicker.svelte";
	import SessionsButton from "./SessionsButton.svelte";
	import StarButton from "./StarButton.svelte";

	const bootstrap = $derived(app.bootstrap);
	const onPrem = $derived(bootstrap?.onPrem !== undefined);

	let pickerOpen = $state(false);
	/** The default branch of starred repositories never worked in; fetched at mount, empty until then. */
	let starredDefaults = $state<Record<string, string>>({});

	const index = $derived(app.index);
	const starredRepos = $derived([...(index?.starredRepos ?? [])].sort((a, b) => a.localeCompare(b)));

	/** The repository/branch pairs worked in most recently, one row each, whatever the session's outcome. */
	const recent = $derived.by(() => {
		const byPlace = new Map<string, SessionRow & { place: "repo"; repo: string; branch: string }>();
		for (const row of Object.values(index?.rows ?? {})) {
			if (row.place !== "repo" || row.archived) continue;
			const key = `${row.repo}@${row.branch}`;
			const seen = byPlace.get(key);
			if (seen === undefined || row.updatedAt > seen.updatedAt) byPlace.set(key, row);
		}
		return [...byPlace.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);
	});

	const newestBranchFor = (name: string) => {
		const rows = Object.values(index?.rows ?? {}).filter((row) => row.place === "repo" && row.repo === name && !row.archived);
		rows.sort((a, b) => b.updatedAt - a.updatedAt);
		const newest = rows[0];
		return newest !== undefined && newest.place === "repo" ? newest.branch : undefined;
	};

	$effect(() => {
		// Starred repositories never worked in have no row to continue; ask their host for a default branch, so the
		// row can offer one. Failures leave the row saying what it is and the tap opens the picker.
		for (const name of starredRepos) {
			if (newestBranchFor(name) !== undefined || starredDefaults[name] !== undefined) continue;
			api.branches(name).then(
				(list: BranchList) => (starredDefaults = { ...starredDefaults, [name]: list.defaultBranch }),
				() => (starredDefaults = { ...starredDefaults }),
			);
		}
	});

	const spawnRepo = (repo: string, start: { kind: "new"; base: string } | { kind: "continue"; branch: string }) => {
		setPendingStart({ place: "repo", repo, start });
		navigate({ kind: "start" });
	};
	/** A row always means "keep going on the branch it names"; starred rows with no branch to continue cut a fresh one from the repository's default branch. */
	const spawnRow = (name: string) => {
		const known = newestBranchFor(name);
		if (known !== undefined) {
			spawnRepo(name, { kind: "continue", branch: known });
			return;
		}
		const fresh = starredDefaults[name];
		if (fresh !== undefined) {
			spawnRepo(name, { kind: "new", base: fresh });
			return;
		}
		pickerOpen = true;
	};
	const spawnLocal = () => {
		setPendingStart({ place: "local", dir: "~" });
		navigate({ kind: "start" });
	};
</script>

<div class="session new-session">
	<header class="topbar">
		<SessionsButton />
		<h1 class="title">New session</h1>
	</header>
	<div class="splash">
		<div class="tiles">
			{#if onPrem}
				<button type="button" class="tile" onclick={spawnLocal}>
					<Icon name="monitor" size={34} />
					<span class="tile-label">This computer</span>
				</button>
			{/if}
			<button type="button" class="tile" onclick={() => (pickerOpen = true)}>
				<Icon name="branch" size={34} />
				<span class="tile-label">Repository</span>
			</button>
		</div>
		{#if starredRepos.length > 0}
			<section class="splash-section" aria-label="Starred">
				<h2 class="splash-heading">Starred</h2>
				<ul class="place-list">
					{#each starredRepos as name (name)}
						{@const known = newestBranchFor(name)}
						{@const fallback = starredDefaults[name]}
						<li class="place-row">
							<button type="button" class="place-choose" onclick={() => spawnRow(name)}>
								<span class="place-icon"><Icon name="branch" size={17} /></span>
								<span class="place-text">
									<span class="place-name">{name}</span>
									<span class="place-sub">{known !== undefined ? `continue ${known}` : fallback !== undefined ? `new branch from ${fallback}` : "Repository"}</span>
								</span>
							</button>
							<StarButton kind="repo" target={name} label={`Star ${name}`} starred={true} />
						</li>
					{/each}
				</ul>
			</section>
		{/if}
		{#if recent.length > 0}
			<section class="splash-section" aria-label="Recent">
				<h2 class="splash-heading">Recent</h2>
				<ul class="place-list">
					{#each recent as row (`${row.repo}@${row.branch}`)}
						<li class="place-row">
							<button type="button" class="place-choose" onclick={() => spawnRepo(row.repo, { kind: "continue", branch: row.branch })}>
								<span class="place-icon"><Icon name="branch" size={17} /></span>
								<span class="place-text">
									<span class="place-name">{row.repo}</span>
									<span class="place-sub">{row.branch} · {timeAgo(row.updatedAt)}</span>
								</span>
							</button>
							<StarButton kind="repo" target={row.repo} label={`Star ${row.repo}`} starred={(index?.starredRepos ?? []).includes(row.repo)} />
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	</div>
	{#if pickerOpen}
		<RepoPicker onClose={() => (pickerOpen = false)} />
	{/if}
</div>
