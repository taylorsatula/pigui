<script lang="ts">
	// The page frame: which page the route shows, the session picker, the toasts the person should not miss, and the live
	// connection's lifecycle.
	import { api } from "./api.ts";
	import AgentView from "./components/AgentView.svelte";
	import NewSession from "./components/NewSession.svelte";
	import SessionPicker from "./components/SessionPicker.svelte";
	import SessionView from "./components/SessionView.svelte";
	import Toasts from "./components/Toasts.svelte";
	import { live } from "./live.ts";
	import { refreshSubscription } from "./push.ts";
	import { app, holdToast, routeFromHash, setBootstrap } from "./store.svelte.ts";
	import { watchViewport } from "./viewport.ts";

	$effect(() => {
		api.bootstrap().then(setBootstrap, () => undefined);
		void refreshSubscription().catch(() => undefined);
		const onHash = () => {
			app.route = routeFromHash(location.hash);
			app.pickerOpen = false;
		};
		// A backgrounded app holds no stream; coming back catches up from where it was.
		const onVisibility = () => {
			// A toast waits for the person to come back rather than timing out unseen.
			holdToast(document.visibilityState === "hidden");
			if (document.visibilityState === "hidden") live.pause();
			else {
				const current = app.route;
				if (current.kind === "session") live.follow(current.id, current.agent);
				else live.follow(undefined);
			}
		};
		window.addEventListener("hashchange", onHash);
		document.addEventListener("visibilitychange", onVisibility);
		const unwatch = watchViewport();
		return () => {
			window.removeEventListener("hashchange", onHash);
			document.removeEventListener("visibilitychange", onVisibility);
			unwatch();
		};
	});

	const session = $derived(app.route.kind === "session" ? app.route.id : undefined);
	const agent = $derived(app.route.kind === "session" ? app.route.agent : undefined);
	$effect(() => {
		live.follow(session, agent);
	});
</script>

<div class="app">
	<main class="main">
		{#if session === undefined}
			<NewSession />
		{:else if agent === undefined}
			{#key session}<SessionView id={session} />{/key}
		{:else}
			{#key `${session}:${agent}`}<AgentView {session} {agent} />{/key}
		{/if}
	</main>
	<SessionPicker />
	<Toasts />
</div>
