<script lang="ts" module>
	import { type SessionRow } from "../../shared/session.ts";
	import { api, describeFailure } from "../api.ts";
	import { shortDir } from "../format.ts";
	import { navigate, showToast } from "../store.svelte.ts";

	function whereOf(row: SessionRow, home: string | undefined): string {
		return row.place === "local" ? shortDir(row.dir, home) : row.repo;
	}

	/**
	 * Archive a session, or put an archived one back, with Undo in the toast rather than a confirmation. Archiving the open
	 * session leaves it for New session, as it can no longer be worked in; Undo comes back to it.
	 */
	async function setArchived(row: SessionRow, archived: boolean, open: boolean): Promise<void> {
		try {
			await api.archive(row.id, archived);
		} catch (error) {
			showToast({ message: describeFailure(error).message });
			return;
		}
		if (archived && open) navigate({ kind: "new" });
		showToast({
			message: archived ? "Session archived." : "Session restored.",
			action: {
				label: "Undo",
				run: () => {
					void api.archive(row.id, !archived).then(() => {
						if (archived && open) navigate({ kind: "session", id: row.id });
					});
				},
			},
		});
	}
</script>

<script lang="ts">
	import { needsAttention } from "../../shared/session.ts";
	import { listingDate, timeAgo } from "../format.ts";
	import { app } from "../store.svelte.ts";
	import Icon from "./Icons.svelte";
	import PinButton from "./PinButton.svelte";

	let { row, current, striped, nested, home, pinned }: { row: SessionRow; current: boolean; striped: boolean; nested: boolean; home: string | undefined; pinned: boolean } =
		$props();

	const classes = $derived(["row", current ? "current" : "", striped ? "striped" : "", nested ? "nested" : "", needsAttention(row) ? "unseen" : ""]);
	const action = $derived(row.archived ? "Restore" : "Archive");
</script>

<li class="entry">
	<a href={`#/s/${row.id}`} class={classes.join(" ")} aria-current={current ? "page" : undefined} onclick={() => (app.pickerOpen = false)}>
		<span class="row-name">
			<span class={`indicator ${row.tone}`} aria-hidden="true"></span>
			<span class="row-title">{row.title}</span>
		</span>
		<span class="row-where">{whereOf(row, home)}</span>
		<time class="row-modified" dateTime={new Date(row.updatedAt).toISOString()}>
			<span class="when-wide">{listingDate(row.updatedAt)}</span>
			<span class="when-narrow">{timeAgo(row.updatedAt)}</span>
		</time>
		<span class="row-status">{row.label}</span>
	</a>
	<!-- Beside the line rather than in it, since a button cannot sit inside a link; they are drawn on the line's right edge. -->
	<PinButton id={row.id} label={`${pinned ? "Unpin" : "Pin"} ${row.title}`} pinned={pinned} class="row-action row-pin" />
	<button type="button" class="icon-button row-action" aria-label={`${action} ${row.title}`} title={action} onclick={() => void setArchived(row, !row.archived, current)}>
		<Icon name={row.archived ? "restore" : "archive"} size={18} />
	</button>
</li>
