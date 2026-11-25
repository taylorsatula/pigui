<script lang="ts" module>
	import type { SessionRow } from "../../shared/session.ts";
	import { names, shortDir } from "../format.ts";

	const RECENT = 5;

	/** When a session last worked in each directory on this computer. */
	function lastWorked(rows: readonly SessionRow[]): Map<string, number> {
		const at = new Map<string, number>();
		for (const row of rows) if (row.place === "local") at.set(row.dir, Math.max(at.get(row.dir) ?? 0, row.updatedAt));
		return at;
	}
</script>

<script lang="ts">
	// Where a local session can start (pigui OnPrem), offered under the Directory field: every directory the person
	// starred, then the five most recently worked in that are not starred. The recent ones are read from the sessions
	// themselves, so there is no second record of them; the stars are kept in the index document, so a star made at the
	// computer is there on the phone. Choosing one fills the field.
	import { timeAgo } from "../format.ts";
	import { app } from "../store.svelte.ts";
	import Icon from "./Icons.svelte";
	import StarButton from "./StarButton.svelte";

	let { dir: typed, home, onChoose }: { dir: string; home: string; onChoose: (dir: string) => void } = $props();

	const index = $derived(app.index);
	const shown = (d: string) => shortDir(d, home);
	const starred = $derived([...(index?.starred ?? [])].sort((a, b) => shown(a).localeCompare(shown(b))));
	const worked = $derived(lastWorked(Object.values(index?.rows ?? {})));
	const recent = $derived(
		[...worked]
			.filter(([d]) => !starred.includes(d))
			.sort((a, b) => b[1] - a[1])
			.slice(0, RECENT)
			.map(([d]) => d),
	);
</script>

{#snippet group(title: string, dirs: string[], isStarred: boolean)}
	{#if dirs.length > 0}
		<section class="dir-group" aria-label={title}>
			<h2 class="dir-heading">{title}</h2>
			<ul class="dir-list">
				{#each dirs as dir, at (dir)}
					{@const chosen = names(typed, dir, home)}
					{@const when = worked.get(dir)}
					<li class={`dir-row ${chosen ? "chosen" : ""} ${at % 2 === 1 ? "striped" : ""}`}>
						<button type="button" class="dir-choose" aria-current={chosen ? "true" : undefined} onclick={() => onChoose(shown(dir))}>
							<span class="folder-mark">
								<Icon name="folder" size={16} />
							</span>
							<span class="dir-path">{shown(dir)}</span>
							{#if when !== undefined}
								<time class="dir-when" dateTime={new Date(when).toISOString()}>{timeAgo(when)}</time>
							{/if}
						</button>
						<StarButton dir={dir} label={`Star ${shown(dir)}`} starred={isStarred} />
					</li>
				{/each}
			</ul>
		</section>
	{/if}
{/snippet}

{#if starred.length > 0 || recent.length > 0}
	<div class="directories">
		{@render group("Starred", starred, true)}
		{@render group("Recent", recent, false)}
	</div>
{/if}
