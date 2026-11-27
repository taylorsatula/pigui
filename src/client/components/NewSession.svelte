<script lang="ts">
	// Starting a session is an IF-tree, not a form: work on this computer (OnPrem), or in a repository. Tapping either
	// tile opens the blank screen to type the task; the first send is what creates the session. Below the tiles are
	// the starred repositories, the pinned favorites and the five most recent repository sessions, tapping a
	// favorite or a recent row to open the session it names, a Starred row spawning the blank screen continuing its
	// branch. A branch already shown in Starred or in Pinned is not repeated in Recent. Anything else — a branch to
	// cut from, a branch to continue, a repository not in either list — lives behind the Repository tile.
	import type { BranchList } from "../../shared/api.ts";
	import type { SessionRow } from "../../shared/session.ts";
	import { api } from "../api.ts";
	import { shortDir, timeAgo } from "../format.ts";
	import { app, navigate, setPendingStart } from "../store.svelte.ts";
	import Icon from "./Icons.svelte";
	import PinButton from "./PinButton.svelte";
	import RepoPicker from "./RepoPicker.svelte";
	import SessionsButton from "./SessionsButton.svelte";
	import StarButton from "./StarButton.svelte";

	const bootstrap = $derived(app.bootstrap);
	const onPrem = $derived(bootstrap?.onPrem !== undefined);

	let pickerOpen = $state(false);
	/** The default branch of starred repositories never worked in; fetched at mount, empty until then. */
	let starredDefaults = $state<Record<string, string>>({});
	/** Repositories whose default branch could not be fetched. Not state: a failure writes nothing, so it never re-triggers the effect. */
	const unreachable = new Set<string>();

	const index = $derived(app.index);
	const starredRepos = $derived([...(index?.starredRepos ?? [])].sort((a, b) => a.localeCompare(b)));

	const home = $derived(bootstrap?.onPrem?.home);
	/** Where a session worked, for a favorite's quiet second line: the directory on this computer, or the repository and branch. */
	const whereOf = (row: SessionRow) => (row.place === "local" ? shortDir(row.dir, home) : `${row.repo} · ${row.branch}`);

	/** The pinned favorites, newest first, whatever their place or state; an archived favorite shows until unpinned. */
	const pinned = $derived(Object.values(index?.rows ?? {}).filter((row) => (index?.pinned ?? []).includes(row.id)).sort((a, b) => b.updatedAt - a.updatedAt));

	const newestBranchFor = (name: string) => {
		const rows = Object.values(index?.rows ?? {}).filter((row) => row.place === "repo" && row.repo === name && !row.archived);
		rows.sort((a, b) => b.updatedAt - a.updatedAt);
		const newest = rows[0];
		return newest !== undefined && newest.place === "repo" ? newest.branch : undefined;
	};

	/** The repository/branch pairs the Starred section shows, so Recent does not repeat them, nor the pairs the Pinned section shows. */
	const shownElsewhere = $derived(
		new Set([
			...starredRepos.flatMap((name) => {
				const branch = newestBranchFor(name);
				return branch === undefined ? [] : [`${name}@${branch}`];
			}),
			...pinned.flatMap((row) => (row.place === "repo" ? [`${row.repo}@${row.branch}`] : [])),
		]),
	);

	/** The recent sessions themselves, one row each, branches unique, skipping what the Starred and Pinned sections show. */
	const recent = $derived.by(() => {
		const byPlace = new Map<string, SessionRow & { place: "repo"; repo: string; branch: string }>();
		for (const row of Object.values(index?.rows ?? {})) {
			if (row.place !== "repo" || row.archived) continue;
			const key = `${row.repo}@${row.branch}`;
			if (shownElsewhere.has(key)) continue;
			const seen = byPlace.get(key);
			if (seen === undefined || row.updatedAt > seen.updatedAt) byPlace.set(key, row);
		}
		return [...byPlace.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);
	});

	$effect(() => {
		// Starred repositories never worked in have no row to continue; ask their host for a default branch, so the
		// row can offer one. Failures leave the row saying what it is and the tap opens the picker.
		for (const name of starredRepos) {
			// One attempt per repository per page load: a failure is not retried while this page lives.
			if (newestBranchFor(name) !== undefined || starredDefaults[name] !== undefined || unreachable.has(name)) continue;
			unreachable.add(name);
			api.branches(name).then(
				(list: BranchList) => (starredDefaults = { ...starredDefaults, [name]: list.defaultBranch }),
				() => undefined,
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
		{#if pinned.length > 0}
			<section class="splash-section" aria-label="Pinned">
				<h2 class="splash-heading">Pinned</h2>
				<ul class="place-list">
					{#each pinned as row (row.id)}
						<li class="place-row">
							<a href={`#/s/${row.id}`} class="place-choose">
								<span class="place-icon"><Icon name={row.place === "local" ? "monitor" : "branch"} size={17} /></span>
								<span class="place-text">
									<span class="place-name">{row.title}</span>
									<span class="place-sub">{whereOf(row)} · {timeAgo(row.updatedAt)}</span>
								</span>
							</a>
							<PinButton id={row.id} label={`Unpin ${row.title}`} pinned={true} />
						</li>
					{/each}
				</ul>
			</section>
		{/if}
		{#if recent.length > 0}
			<section class="splash-section" aria-label="Recent">
				<h2 class="splash-heading">Recent</h2>
				<ul class="place-list">
					{#each recent as row (row.id)}
						<li class="place-row">
							<a href={`#/s/${row.id}`} class="place-choose">
								<span class="place-icon"><Icon name="branch" size={17} /></span>
								<span class="place-text">
									<span class="place-name">{row.title}</span>
									<span class="place-sub">{row.repo} · {row.branch} · {timeAgo(row.updatedAt)}</span>
								</span>
							</a>
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
