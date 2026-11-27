<script lang="ts">
	// Starting a session. The common ways are the tiles and the short lists: an OnPrem computer tile that works in the
	// home directory, a microphone tile that focuses the composer (iOS dictation is the keyboard's mic key), and the
	// three most recent repository branches. Everything else lives behind the + popover: a repository not in either
	// list, a branch to continue, or a directory other than ~. Stars are kept in the index, so a star made on one
	// device is there on the other. The composer below files the first message, as before.
	import type { BranchList, RepoSummary } from "../../shared/api.ts";
	import type { SessionRow } from "../../shared/session.ts";
	import { api, describeFailure } from "../api.ts";
	import { names, shortDir, timeAgo } from "../format.ts";
	import { app, navigate, showToast } from "../store.svelte.ts";
	import Composer from "./Composer.svelte";
	import ComposerDock from "./ComposerDock.svelte";
	import Icon from "./Icons.svelte";
	import PlacePopover from "./PlacePopover.svelte";
	import SessionsButton from "./SessionsButton.svelte";
	import StarButton from "./StarButton.svelte";

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
	let moreOpen = $state(false);
	let focusToken = $state(0);

	// Until the server says it is OnPrem, the screen is a server's; only OnPrem has local sessions.
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
	const ready = $derived(local ? dir.trim() !== "" : repo !== undefined && branches !== undefined && ref !== "");

	const index = $derived(app.index);

	/** The three repository/branch pairs worked in most recently, one row each, whatever the session's outcome. */
	const recent = $derived.by(() => {
		const byPlace = new Map<string, SessionRow & { place: "repo"; repo: string; branch: string }>();
		for (const row of Object.values(index?.rows ?? {})) {
			if (row.place !== "repo" || row.archived) continue;
			const key = `${row.repo}@${row.branch}`;
			const seen = byPlace.get(key);
			if (seen === undefined || row.updatedAt > seen.updatedAt) byPlace.set(key, row);
		}
		return [...byPlace.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3);
	});

	const shown = (d: string) => shortDir(d, home);
	const starredRepos = $derived([...(index?.starredRepos ?? [])].sort((a, b) => a.localeCompare(b)));
	const starredDirs = $derived([...(index?.starred ?? [])].sort((a, b) => shown(a).localeCompare(shown(b))));

	const chooseDir = (d: string) => {
		place = "local";
		dir = d;
	};
	// A repository chosen from a row starts on a new branch from the default branch, like the repository default.
	const chooseRepo = (name: string) => {
		place = "repo";
		mode = "new";
		repo = name;
	};
	const caption = $derived(
		local
			? dir
			: repo === undefined
				? ""
				: `${repo} · ${mode === "new" ? `new branch from ${base === "" ? "…" : base}` : `continue ${branch === "" ? "…" : branch}`}`,
	);
</script>

<div class="session new-session">
	<header class="topbar">
		<SessionsButton />
		<h1 class="title">New session</h1>
	</header>
	<div class="splash">
		<div class="tiles-zone">
			<div class="tiles">
				{#if onPrem}
					<button type="button" class="tile" onclick={() => { place = "local"; dir = "~"; focusToken += 1; }}>
						<Icon name="monitor" size={30} />
						<span class="tile-label">This computer</span>
					</button>
				{/if}
				<button type="button" class="tile" onclick={() => (focusToken += 1)}>
					<Icon name="mic" size={30} />
					<span class="tile-label">Dictate</span>
				</button>
				<button type="button" class="tile" id="more-tile" aria-expanded={moreOpen} aria-controls="place-popover" onclick={() => (moreOpen = !moreOpen)}>
					<Icon name="plus" size={30} />
					<span class="tile-label">More</span>
				</button>
			</div>
			{#if moreOpen}
				<PlacePopover
					{onPrem}
					{repos}
					reposBranches={branches}
					{repo}
					{mode}
					{base}
					{branch}
					onLocal={(d) => chooseDir(d)}
					onRepo={(name) => {
						place = "repo";
						repo = name;
					}}
					onMode={(next) => (mode = next)}
					onBase={(next) => (base = next)}
					onBranch={(next) => (branch = next)}
					onClose={() => (moreOpen = false)}
				/>
			{/if}
		</div>
		{#if recent.length > 0}
			<section class="splash-section" aria-label="Recent">
				<h2 class="splash-heading">Recent</h2>
				<ul class="place-list">
					{#each recent as row (`${row.repo}@${row.branch}`)}
						{@const chosen = place === "repo" && repo === row.repo}
						<li class={`place-row ${chosen ? "chosen" : ""}`}>
							<button type="button" class="place-choose" aria-current={chosen ? "true" : undefined} onclick={() => chooseRepo(row.repo)}>
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
		{#if starredRepos.length > 0 || starredDirs.length > 0}
			<section class="splash-section" aria-label="Starred">
				<h2 class="splash-heading">Starred</h2>
				<ul class="place-list">
					{#each starredRepos as name (name)}
						{@const chosen = place === "repo" && repo === name}
						<li class={`place-row ${chosen ? "chosen" : ""}`}>
							<button type="button" class="place-choose" aria-current={chosen ? "true" : undefined} onclick={() => chooseRepo(name)}>
								<span class="place-icon"><Icon name="branch" size={17} /></span>
								<span class="place-text">
									<span class="place-name">{name}</span>
									<span class="place-sub">Repository</span>
								</span>
							</button>
							<StarButton kind="repo" target={name} label={`Star ${name}`} starred={true} />
						</li>
					{/each}
					{#each starredDirs as d (d)}
						{@const chosen = local && home !== undefined && names(dir, d, home)}
						<li class={`place-row ${chosen ? "chosen" : ""}`}>
							<button type="button" class="place-choose" aria-current={chosen ? "true" : undefined} onclick={() => chooseDir(shown(d))}>
								<span class="place-icon"><Icon name="folder" size={17} /></span>
								<span class="place-text">
									<span class="place-name">{shown(d)}</span>
									<span class="place-sub">Directory</span>
								</span>
							</button>
							<StarButton kind="dir" target={d} label={`Star ${shown(d)}`} starred={true} />
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	</div>
	<ComposerDock>
		{#if caption !== ""}
			<p class="place-line">{caption}</p>
		{/if}
		<Composer
			draftKey="new"
			placeholder="Describe the task…"
			running={false}
			disabled={!ready}
			{focusToken}
			files={async () => (local ? (await api.localFiles(dir)).files : repo === undefined ? [] : (await api.repoFiles(repo, ref)).files)}
			skills={() => (local ? api.localSkills(dir) : repo === undefined ? Promise.resolve([]) : api.repoSkills(repo, ref))}
			onSend={async (text, attachments, requestId) => {
				moreOpen = false;
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
