<script lang="ts">
	// The + on the splash page: the choices off the cow path, in one dense popover. The repository side is one line of
	// two pickers, the branch greyed until a repository is picked and defaulting to its own default branch; the directory
	// side is the ~ input. The chonky toggle picks which side is live and remembers it; the other side is greyed out.
	// The popover always opens empty (nothing prefilled, ~ in the directory input) and stays open until the task is
	// sent or a tap outside closes it; what is picked writes through to the page at once.
	import type { BranchList, RepoSummary } from "../../shared/api.ts";

	type Side = "dir" | "repo";

	type Props = {
		/** pigui OnPrem only: a directory on this computer is a choice. */
		onPrem: boolean;
		repos?: RepoSummary[];
		/** The branches of the repository the page currently has selected. */
		reposBranches?: BranchList;
		repo?: string;
		mode: "new" | "continue";
		base: string;
		branch: string;
		onLocal: (dir: string) => void;
		onRepo: (name: string) => void;
		onMode: (mode: "new" | "continue") => void;
		onBase: (base: string) => void;
		onBranch: (branch: string) => void;
		onClose: () => void;
	};

	let { onPrem, repos, reposBranches, repo, mode, base, branch, onLocal, onRepo, onMode, onBase, onBranch, onClose }: Props = $props();

	const SIDE_KEY = "pigui.splash-more";

	const remembered = (): Side => {
		try {
			return localStorage.getItem(SIDE_KEY) === "dir" && onPrem ? "dir" : "repo";
		} catch {
			// Storage can be unavailable (private browsing); the toggle then opens on the repository side.
			return "repo";
		}
	};

	let side = $state<Side>(remembered());
	// What this opening of the popover picked, so nothing shows the page's selection before something changes.
	let picked = $state("");
	let dirInput = $state("~");

	const chooseSide = (next: Side) => {
		side = next;
		try {
			localStorage.setItem(SIDE_KEY, next);
		} catch {
			// Storage can be unavailable; the toggle simply forgets.
		}
	};

	const branchReady = $derived(picked !== "" && repo === picked && reposBranches !== undefined);
	const ref = $derived(mode === "new" ? base : branch);

	const onKeydown = (event: KeyboardEvent) => {
		if (event.key === "Escape") onClose();
	};
</script>

<svelte:window onkeydown={onKeydown} />

<button type="button" class="popover-backdrop" aria-label="Close" onclick={onClose}></button>
<div class="place-popover" id="place-popover" role="dialog" aria-label="More places">
	{#if onPrem}
		<div class="chonky" role="radiogroup" aria-label="Starting from">
			<button type="button" role="radio" aria-checked={side === "dir"} class={side === "dir" ? "selected" : ""} onclick={() => chooseSide("dir")}>Directory</button>
			<button type="button" role="radio" aria-checked={side === "repo"} class={side === "repo" ? "selected" : ""} onclick={() => chooseSide("repo")}>
				Repository / Branch
			</button>
		</div>
	{/if}
	<fieldset class="place-side" disabled={side !== "repo"}>
		<legend class="visually-hidden">Repository and branch</legend>
		<div class="pick-line">
			<label class="mini">
				<span>Repository</span>
				<select
					value={picked}
					disabled={repos === undefined}
					onchange={(event) => {
						picked = event.currentTarget.value;
						if (picked !== "") onRepo(picked);
					}}
				>
					<option value="">Repository…</option>
					{#each repos ?? [] as item (item.name)}
						<option value={item.name}>{item.name}</option>
					{/each}
				</select>
			</label>
			<label class="mini">
				<span>{mode === "new" ? "Start from" : "Continue"}</span>
				<select
					value={ref}
					disabled={!branchReady}
					onchange={(event) => (mode === "new" ? onBase(event.currentTarget.value) : onBranch(event.currentTarget.value))}
				>
					{#each reposBranches?.branches ?? [] as name (name)}
						<option value={name}>{name}{name === reposBranches?.defaultBranch ? " (default)" : ""}</option>
					{/each}
				</select>
			</label>
		</div>
		<div class="segmented mini-segmented" role="radiogroup" aria-label="Branch">
			<button type="button" role="radio" aria-checked={mode === "new"} class={mode === "new" ? "selected" : ""} onclick={() => onMode("new")}>New branch</button>
			<button type="button" role="radio" aria-checked={mode === "continue"} class={mode === "continue" ? "selected" : ""} onclick={() => onMode("continue")}>
				Continue a branch
			</button>
		</div>
	</fieldset>
	<fieldset class="place-side place-dir" disabled={!onPrem || side !== "dir"}>
		<legend class="visually-hidden">Directory</legend>
		<label class="mini" for="more-directory">
			<span>Directory</span>
			<input id="more-directory" type="text" value={dirInput} autocapitalize="off" autocorrect="off" spellcheck={false} oninput={(event) => {
				dirInput = event.currentTarget.value;
				onLocal(dirInput);
			}} />
		</label>
	</fieldset>
</div>
