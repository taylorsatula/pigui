<script lang="ts" module>
	import type { SessionDoc } from "../../shared/session.ts";

	function placeholderFor(doc: SessionDoc, running: boolean): string {
		if (doc.setup.status === "preparing") return "Setting up the workspace…";
		if (doc.card?.kind === "questions") return "Answer in your own words…";
		if (doc.card?.kind === "plan") return "Ask for changes to the plan…";
		if (running) return "Steer Pi while it works…";
		if (doc.outcome?.kind === "budget") return "Raise the budget to continue…";
		if (doc.report !== undefined && doc.workflow === "reported") return "Ask for more changes…";
		return "Write to Pi…";
	}

	/** Spend in the warning colour from 80 % of the cap, and the error colour at it. */
	function spendTone(spent: number, cap: number | undefined): string {
		if (cap === undefined || cap <= 0) return "";
		return spent >= cap ? "over" : spent >= cap * 0.8 ? "near" : "";
	}
</script>

<script lang="ts">
	// One session: its title over one line of record (status, repository, branch, spend), any problem with its next step,
	// the transcript, and the composer, whose placeholder says what sending will do right now.
	import type { LiveState, UsageState } from "@earendil-works/pi-durable";
	import { type CardAnswer, sessionRow } from "../../shared/session.ts";
	import { formatDollars, sessionSpent } from "../../shared/spend.ts";
	import { api, describeFailure } from "../api.ts";
	import { shortDir } from "../format.ts";
	import { stopReading } from "../speech.ts";
	import { showToast, app } from "../store.svelte.ts";
	import { buildBlocks } from "../transcript.ts";
	import { pinToEnd } from "../viewport.ts";
	import AgentsButton from "./AgentsButton.svelte";
	import AgentsPanel from "./AgentsPanel.svelte";
	import type { CardActions, DeliveryActions } from "./cards.ts";
	import Composer from "./Composer.svelte";
	import ComposerDock from "./ComposerDock.svelte";
	import DiffSheet from "./DiffSheet.svelte";
	import SessionsButton from "./SessionsButton.svelte";
	import Icon from "./Icons.svelte";
	import Transcript from "./Transcript.svelte";
	import Banner from "./Banner.svelte";

	let { id }: { id: number } = $props();

	const sessionDoc = $derived(app.session);
	const view = $derived(app.view);
	const missing = $derived(app.missing);
	const home = $derived(app.bootstrap?.onPrem?.home);
	const agents = $derived(app.agents);

	let focus = $state(0);
	let diff = $state(false);
	let agentsOpen = $state(false);

	const doc = $derived(sessionDoc?.id === id ? sessionDoc : undefined);
	const liveState = $derived(view?.docs["pi.live"] as LiveState | undefined);
	// Durable's run, and pigui's until the supervisor has handled its end: in the commit between, a run that ends in
	// an automatic continuation would otherwise read as stopped for a moment.
	const running = $derived(liveState?.run !== undefined || doc?.activeRun !== undefined);
	const blocks = $derived(buildBlocks(view, doc, running));
	const row = $derived(doc === undefined ? undefined : sessionRow(doc));

	$effect(() => {
		// A reading belongs to the session on screen: leaving it stops the reading, while locking the phone does not.
		return () => stopReading();
	});

	// The whole session's: its own agent's, and every agent it started.
	const spent = $derived(sessionSpent(view?.docs["pi.usage"] as UsageState | undefined, (doc?.agents ?? []).map((agent) => agents[agent.id]?.["pi.usage"])));

	const act = (work: () => Promise<unknown>) => {
		void work().catch((error: unknown) => {
			const failure = describeFailure(error);
			showToast({ message: failure.hint === undefined ? failure.message : `${failure.message} ${failure.hint}` });
		});
	};

	const cards: CardActions = {
		answer: async (cardId: string, answer: CardAnswer) => {
			try {
				await api.answer(id, cardId, answer);
			} catch (error) {
				showToast({ message: describeFailure(error).message });
			}
		},
		focusComposer: () => (focus += 1),
	};

	const delivery: DeliveryActions = {
		deliver: async (action: "push" | "pr") => {
			try {
				const result = await api.deliver(id, action);
				showToast({ message: result.pr === undefined ? "Pushed." : result.pr.created ? `Opened PR #${result.pr.number}.` : `Updated PR #${result.pr.number}.` });
			} catch (error) {
				const failure = describeFailure(error);
				showToast({ message: failure.hint === undefined ? failure.message : `${failure.message} ${failure.hint}` }, 10_000);
			}
		},
		showDiff: () => (diff = true),
		focusComposer: () => (focus += 1),
	};
</script>

{#if missing}
	<div class="session">
		<header class="topbar">
			<SessionsButton />
			<h1 class="title">Not found</h1>
		</header>
		<p class="empty">This session does not exist.</p>
	</div>
{:else if doc === undefined}
	<div class="session">
		<header class="topbar">
			<SessionsButton />
			<h1 class="title">Loading…</h1>
		</header>
	</div>
{:else}
	<div class="session">
		<div class="pinned">
			<header class="topbar">
				<SessionsButton />
				<div class="title-block">
					<h1 class="title">{doc.title}</h1>
					<!-- Status leads, as a word: marked when it is the person's turn. -->
					<p class="subtitle" role="status">
						<span class={`session-status ${row?.tone}`}>{row?.label}</span>
						<span class="where">{doc.place === "local" ? shortDir(doc.dir, home) : `${doc.repo} · ${doc.branch}`}</span>
						<!-- Models with no price per request (a subscription's, such as lunaroute's) always read $0.00, which
						     says nothing; the spend shows once a model has charged something. -->
						{#if spent > 0}
							<span class={`spend ${spendTone(spent, doc.cap)}`}>
								{formatDollars(spent)}{doc.cap === undefined ? "" : ` of ${formatDollars(doc.cap)}`}
							</span>
						{/if}
					</p>
				</div>
				<!-- A local session works in place, with no branch to compare: there is no diff to view. -->
				{#if doc.place === "repo"}
					<button type="button" class="icon-button" aria-label="View changes" disabled={doc.setup.status !== "ready"} onclick={() => (diff = true)}>
						<Icon name="diff" />
					</button>
				{/if}
				<AgentsButton doc={doc} open={agentsOpen} onToggle={() => (agentsOpen = !agentsOpen)} />
			</header>
		</div>
		<Transcript blocks={blocks} session={doc} running={running} cards={cards} delivery={delivery} />
		<ComposerDock>
			<Banner doc={doc} spent={spent} running={running} onAction={act} />
			<Composer
				draftKey={`session:${id}`}
				placeholder={placeholderFor(doc, running)}
				running={running}
				disabled={doc.setup.status !== "ready" || doc.cleanedAt !== undefined}
				focusToken={focus}
				autoFocus
				files={async () => (await api.sessionFiles(id)).files}
				skills={() => api.sessionSkills(id)}
				onSend={async (text, attachments, requestId) => {
					pinToEnd();
					await api.send(id, requestId, text, attachments);
				}}
				onStop={async () => {
					try {
						await api.stop(id);
					} catch (error) {
						showToast({ message: describeFailure(error).message });
					}
				}}
			/>
		</ComposerDock>
		{#if diff}<DiffSheet session={id} onClose={() => (diff = false)} />{/if}
		{#if agentsOpen}<AgentsPanel doc={doc} onClose={() => (agentsOpen = false)} />{/if}
	</div>
{/if}
