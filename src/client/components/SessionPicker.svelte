<script lang="ts" module>
	// The session picker: every session listed in columns, as a file browser lists a folder, in a panel over a dimmed and
	// blurred page. Switching sessions is deliberate, so the list is not on screen the rest of the time: the ☰ button opens
	// it, and choosing a session, Escape, or a tap outside closes it. Sessions under way are listed at the top; those done,
	// archived or quiet for half a day sit in a folder under them. The open session is the selection, and the arrow keys
	// move through the list as they do in a file browser.
	import { type SessionRow } from "../../shared/session.ts";
	import { shortDir } from "../format.ts";

	/** A session untouched this long has gone quiet: most are never returned to. */
	const STALE_MS = 12 * 60 * 60 * 1000;

	/** Under way: not archived, not done, and changed within the last half day. */
	function active(row: SessionRow, now: number): boolean {
		return !row.archived && row.tone !== "done" && now - row.updatedAt < STALE_MS;
	}

	type Column = "name" | "where" | "modified" | "status";
	type Sort = { column: Column; ascending: boolean };

	const COLUMNS: ReadonlyArray<{ column: Column; label: string }> = [
		{ column: "name", label: "Name" },
		{ column: "where", label: "Where" },
		{ column: "modified", label: "Modified" },
		{ column: "status", label: "Status" },
	];

	function whereOf(row: SessionRow, home: string | undefined): string {
		return row.place === "local" ? shortDir(row.dir, home) : row.repo;
	}

	function sorted(rows: readonly SessionRow[], sort: Sort, home: string | undefined): SessionRow[] {
		const text = (row: SessionRow) => (sort.column === "name" ? row.title : sort.column === "where" ? whereOf(row, home) : row.label);
		const order = (a: SessionRow, b: SessionRow) => (sort.column === "modified" ? a.updatedAt - b.updatedAt : text(a).localeCompare(text(b)));
		return [...rows].sort((a, b) => (sort.ascending ? order(a, b) : order(b, a)));
	}

	/** Up and down move through the list's entries, the folder among them, as in a file browser. */
	function moveFocus(list: HTMLElement, event: KeyboardEvent): void {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		const entries = [...list.querySelectorAll<HTMLElement>(".row")];
		if (entries.length === 0) return;
		event.preventDefault();
		const at = entries.indexOf(document.activeElement as HTMLElement);
		const next = at === -1 ? 0 : Math.min(entries.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)));
		entries[next]?.focus();
		entries[next]?.scrollIntoView({ block: "nearest" });
	}
</script>

<script lang="ts">
	import { describeFailure } from "../api.ts";
	import { enableNotifications, pushSupported } from "../push.ts";
	import { app, navigate, showToast } from "../store.svelte.ts";
	import Icon from "./Icons.svelte";
	import SessionEntry from "./SessionEntry.svelte";

	let sort = $state<Sort>({ column: "modified", ascending: false });
	let notifications = $state(pushSupported() ? Notification.permission : "unsupported");
	// Per component creation: the 12 h staleness boundary does not need finer grain.
	const rows = $derived(Object.values(app.index?.rows ?? {}));
	const pinnedIds = $derived(new Set(app.index?.pinned ?? []));
	const home = $derived(app.bootstrap?.onPrem?.home);
	const current = $derived(app.route.kind === "session" ? app.route.id : undefined);
	const underWay = $derived(sorted(rows.filter((row) => active(row, Date.now())), sort, home));
	const inactive = $derived(sorted(rows.filter((row) => !active(row, Date.now())), sort, home));
	// The folder starts open when the open session is in it, so the selection is in view.
	// svelte-ignore state_referenced_locally
	let folderOpen = $state(inactive.some((row) => row.id === current));
	let list = $state<HTMLDivElement | null>(null);

	const stripes = $derived.by(() => {
		let stripe = 0;
		const under = underWay.map(() => stripe++ % 2 === 1);
		const folder = stripe++ % 2 === 1;
		const nested = inactive.map(() => stripe++ % 2 === 1);
		return { under, folder, nested };
	});

	const close = () => {
		app.pickerOpen = false;
	};

	$effect(() => {
		// The selection takes focus, so the arrow keys start from it; the button that opened the picker gets it back.
		const opener = document.activeElement as HTMLElement | null;
		const selected = list?.querySelector<HTMLElement>(".row.current") ?? list?.querySelector<HTMLElement>(".row");
		selected?.focus({ preventScroll: true });
		selected?.scrollIntoView({ block: "nearest" });
		const onKey = (event: KeyboardEvent) => event.key === "Escape" && close();
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("keydown", onKey);
			opener?.focus({ preventScroll: true });
		};
	});

	const turnOn = async () => {
		const bootstrap = app.bootstrap;
		if (bootstrap === undefined) return;
		try {
			await enableNotifications(bootstrap.vapidPublicKey);
			notifications = "granted";
			showToast({ message: "Notifications are on." });
		} catch (error) {
			showToast({ message: describeFailure(error).message });
		}
	};
</script>

{#if app.pickerOpen}
	<div class="picker-veil" onclick={close} aria-hidden="true"></div>
	<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
	<section class="session-picker" role="dialog" aria-modal="true" aria-label="Sessions" id="session-picker">
		<header class="picker-bar">
			<h2>Sessions</h2>
			<button
				type="button"
				class="link"
				onclick={() => {
					close();
					navigate({ kind: "new" });
				}}
			>
				<Icon name="plus" size={20} /> New
			</button>
			<button type="button" class="icon-button" aria-label="Close" onclick={close}>
				<Icon name="close" size={20} />
			</button>
		</header>
		<div class="picker-columns" role="group" aria-label="Sort by">
			{#each COLUMNS as { column, label } (column)}
				<button
					type="button"
					class={`heading heading-${column} ${sort.column === column ? "sorted" : ""}`}
					aria-pressed={sort.column === column}
					onclick={() => (sort = sort.column === column ? { column, ascending: !sort.ascending } : { column, ascending: column !== "modified" })}
				>
					{label}
					{#if sort.column === column}
						<span class={`sort-mark ${sort.ascending ? "up" : "down"}`}>
							<Icon name="chevron" size={12} />
						</span>
					{/if}
				</button>
			{/each}
		</div>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="picker-list" bind:this={list} onkeydown={(event) => list !== null && list !== undefined && moveFocus(list, event)}>
			{#if rows.length === 0}<p class="empty">No sessions yet. Start one with New.</p>{/if}
			<ul class="listing" aria-label="Under way">
				{#each underWay as row, i (row.id)}
					<SessionEntry row={row} current={row.id === current} striped={stripes.under[i] ?? false} nested={false} home={home} pinned={pinnedIds.has(row.id)} />
				{/each}
				{#if inactive.length > 0}
					<li>
						<button type="button" class={`row folder ${stripes.folder ? "striped" : ""}`} aria-expanded={folderOpen} onclick={() => (folderOpen = !folderOpen)}>
							<span class="row-name">
								<span class="disclosure">
									<Icon name="chevron" size={12} />
								</span>
								<span class="folder-mark">
									<Icon name="folder" size={16} />
								</span>
								<span class="row-title">Inactive</span>
							</span>
							<span class="row-where"></span>
							<span class="row-modified">{inactive.length} {inactive.length === 1 ? "session" : "sessions"}</span>
							<span class="row-status">Folder</span>
						</button>
						{#if folderOpen}
							<ul class="listing" aria-label="Inactive">
								{#each inactive as row, i (row.id)}
									<SessionEntry row={row} current={row.id === current} striped={stripes.nested[i] ?? false} nested={true} home={home} pinned={pinnedIds.has(row.id)} />
								{/each}
							</ul>
						{/if}
					</li>
				{/if}
			</ul>
		</div>
		<footer class="picker-status">
			<p class="picker-count">
				{underWay.length} under way, {inactive.length} inactive
			</p>
			{#if app.bootstrap?.memory.on === false}
				<div class="banner warn picker-notice" role="status">
					<p>
						<strong>Memory is off</strong>{app.bootstrap.memory.reason}
					</p>
				</div>
			{/if}
			{#if notifications === "default" || notifications === "denied"}
				<button type="button" class="link" onclick={() => void turnOn()}>
					<Icon name="bell" size={18} /> Turn on notifications
				</button>
			{/if}
		</footer>
	</section>
{/if}
