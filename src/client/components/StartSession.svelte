<script lang="ts">
	// A spawned session the server does not know exists yet: the screen between choosing where to work and the first
	// message. The target is kept client-side in the pending-start slot, so a tap in and straight out makes nothing;
	// only the send creates the session. The words typed here ride the composer's own "new" draft, so they survive a
	// reload and the back button.
	import { api, describeFailure } from "../api.ts";
	import { app, clearPendingStart, navigate, showToast } from "../store.svelte.ts";
	import Composer from "./Composer.svelte";
	import ComposerDock from "./ComposerDock.svelte";
	import Icon from "./Icons.svelte";

	const pending = $derived(app.pendingStart);
	// A stale or cleared pending on the start route is a link with nothing behind it; show the splash instead.
	$effect(() => {
		if (pending === undefined) navigate({ kind: "new" });
	});
	const ref = $derived(pending?.place === "repo" ? (pending.start.kind === "new" ? pending.start.base : pending.start.branch) : "~");
	const where = $derived(
		pending?.place === "local"
			? pending.dir
			: pending?.place === "repo"
				? `${pending.repo} · ${pending.start.kind === "new" ? `new branch from ${pending.start.base}` : `continue ${pending.start.branch}`}`
				: "",
	);
</script>

{#if pending !== undefined}
	<div class="session blank">
		<div class="pinned">
			<header class="topbar">
				<button type="button" class="icon-button back" aria-label="Back to New session" onclick={() => navigate({ kind: "new" })}>
					<Icon name="back" />
				</button>
				<div class="title-block">
					<h1 class="title">New session</h1>
					<p class="subtitle"><span class="where">{where}</span></p>
				</div>
			</header>
		</div>
		<div class="blank-body" aria-hidden="true"></div>
		<ComposerDock>
			<Composer
				draftKey="new"
				placeholder="Describe the task…"
				running={false}
				disabled={false}
				focusToken={1}
				files={async () =>
					pending.place === "local"
						? (await api.localFiles(pending.dir)).files
						: (await api.repoFiles(pending.repo, ref)).files}
				skills={() =>
					pending.place === "local"
						? api.localSkills(pending.dir)
						: api.repoSkills(pending.repo, ref)}
				onSend={async (text, attachments, requestId) => {
					try {
						const { id } =
							pending.place === "local"
								? await api.create({ requestId, place: "local", dir: pending.dir, text, attachments })
								: await api.create({ requestId, place: "repo", repo: pending.repo, start: pending.start, text, attachments });
						clearPendingStart();
						navigate({ kind: "session", id });
					} catch (error) {
						// The spawn stays pending, so a flaky connection cannot strand the words or the target.
						showToast({ message: describeFailure(error).message });
					}
				}}
			/>
		</ComposerDock>
	</div>
{/if}
