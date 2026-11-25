<script lang="ts">
	// The transcript, set as a conversation is set in print: the person's words in the serif, the agent's in the sans, and a
	// date between them where a session runs into a new day. While the agent works, its work reads as Pi's own terminal
	// shows it: thinking inline as it comes, and each tool call as a block with the last lines it printed. When the turn
	// ends each stretch folds into one line, which opens on a tap, as each call does to its full input and output.
	// Failures show while folded.
	import type { SessionDoc } from "../../shared/session.ts";
	import { dayHeading, sameDay } from "../format.ts";
	import { live } from "../live.ts";
	import { turnStart, type Block } from "../transcript.ts";
	import { followEnd, keepPosition, pinToEnd, stopFollowing } from "../viewport.ts";
	import AgentResult from "./AgentResult.svelte";
	import { type CardActions, type DeliveryActions } from "./cards.ts";
	import Icon from "./Icons.svelte";
	import Markdown from "./Markdown.svelte";
	import Person from "./Person.svelte";
	import PlanCardView from "./PlanCardView.svelte";
	import QuestionsCard from "./QuestionsCard.svelte";
	import ReportCard from "./ReportCard.svelte";
	import Speak from "./Speak.svelte";
	import Work from "./Work.svelte";

	/** Absent where nothing can be answered or delivered, as in an agent's conversation. */
	let { blocks, session, running, cards, delivery }: { blocks: Block[]; session: SessionDoc | undefined; running: boolean; cards?: CardActions; delivery?: DeliveryActions } = $props();

	let loading = $state(false);
	// While earlier messages load, what was on screen stays where it is; the first message tells when they arrived.
	let anchor: { firstKey: string | undefined; restore: () => void } | undefined;
	let failedOn: Block[] | undefined;

	const firstKey = $derived(blocks.find((block) => block.kind !== "earlier" && block.kind !== "gap")?.key);

	$effect(() => {
		pinToEnd();
	});

	$effect(() => {
		// Read blocks so this re-runs as they change: the end stays in view while following, and the position is restored once earlier messages arrive.
		void blocks;
		const held = anchor;
		if (held === undefined) followEnd();
		else if (held.firstKey !== firstKey) {
			held.restore();
			anchor = undefined;
		}
	});

	// The turn under way shows whole: the live window holds only the newest entries, so while the agent works, what it
	// left out of the turn (its start, or a gap after a reconnect) loads on its own.
	// A load that failed is not retried until something new arrives.
	const working = $derived(running && session?.card === undefined);

	$effect(() => {
		if (!working || loading || failedOn === blocks) return;
		const start = turnStart(blocks);
		const gap = blocks.find((block, index): block is Extract<Block, { kind: "gap" }> => block.kind === "gap" && index > start);
		const current = blocks;
		const fail = () => {
			failedOn = current;
		};
		// Filled in place rather than as a tap would: the page keeps following the end, as it does while the agent works.
		if (gap !== undefined) void load(() => live.fillGap(gap.gap), "follow").catch(fail);
		else if (start === -1 && blocks[0]?.kind === "earlier") void load(() => live.loadEarlier(), "keep").catch(fail);
	});

	/** `keep`: what is on screen stays put. `release`: the page stops following the end. `follow`: it goes on following. */
	const load = async (work: () => Promise<void>, position: "keep" | "release" | "follow") => {
		loading = true;
		if (position === "keep") anchor = { firstKey, restore: keepPosition() };
		else if (position === "release") stopFollowing();
		try {
			await work();
		} finally {
			loading = false;
			// Nothing earlier arrived: let go of the anchor once the frame has rendered.
			requestAnimationFrame(() => {
				anchor = undefined;
			});
		}
	};

	// A date goes between entries where the day changes; a session that stays within one day shows none.
	const rows = $derived.by(() => {
		const out: Array<{ type: "day"; key: string; at: number } | { type: "block"; key: string; block: Block }> = [];
		let day: number | undefined;
		for (const block of blocks) {
			const at = block.at;
			if (at !== undefined) {
				if (day !== undefined && !sameDay(day, at)) out.push({ type: "day", key: `day:${block.key}`, at });
				day = at;
			}
			out.push({ type: "block", key: block.key, block });
		}
		return out;
	});
</script>

<div class="transcript" role="log">
	{#each rows as row (row.key)}
		{#if row.type === "day"}
			<h2 class="day">{dayHeading(row.at)}</h2>
		{:else}
			{@const block = row.block}
			<div class={`entry is-${block.kind}`}>
				{#if block.kind === "earlier"}
					<button type="button" class="link" disabled={loading} onclick={() => void load(() => live.loadEarlier(), "keep")}>
						{loading ? "Loading…" : "Load earlier messages"}
					</button>
				{:else if block.kind === "gap"}
					<button type="button" class="link" disabled={loading} onclick={() => void load(() => live.fillGap(block.gap), "release")}>
						Load missed messages
					</button>
				{:else if block.kind === "person"}
					<Person data={block.data} />
				{:else if block.kind === "nudge"}
					<p class="system-note">
						Continuing automatically ({block.data.attempt} of {block.data.limit}): no report yet.
					</p>
				{:else if block.kind === "agent-result"}
					<AgentResult data={block.data} />
				{:else if block.kind === "agent-stopped"}
					<p class="system-note">
						Agent {block.data.type} ({block.data.description}) was stopped.
					</p>
				{:else if block.kind === "text"}
					<Markdown text={block.text} class={`agent ${block.streaming ? "streaming" : ""}`} />
				{:else if block.kind === "speak"}
					{#if session !== undefined}<Speak id={block.key} session={session.id} markdown={block.text} />{/if}
				{:else if block.kind === "work"}
					<Work items={block.items} live={block.live} />
				{:else if block.kind === "questions"}
					{#if cards !== undefined}<QuestionsCard card={block.card} pending={block.pending} actions={cards} {...(block.answer === undefined ? {} : { answer: block.answer })} />{/if}
				{:else if block.kind === "plan"}
					{#if cards !== undefined}<PlanCardView card={block.card} pending={block.pending} running={running} actions={cards} session={session} {...(block.answer === undefined ? {} : { answer: block.answer })} />{/if}
				{:else if block.kind === "report"}
					{#if delivery !== undefined}<ReportCard report={block.report} latest={block.latest} running={running} actions={delivery} session={session} />{/if}
				{:else if block.kind === "compaction"}
					<details class="compaction">
						<summary>
							<Icon name="chevron" size={14} />
							Context compacted · {block.retained === undefined ? "see what was carried forward" : `kept ${block.retained} message${block.retained === 1 ? "" : "s"}`}
						</summary>
						<Markdown text={block.summary} />
					</details>
				{:else if block.kind === "notice"}
					<p class={`system-note ${block.tone}`}>{block.text}</p>
				{/if}
			</div>
		{/if}
	{/each}
</div>
