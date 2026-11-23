import type { UsageState } from "@earendil-works/pi-durable";

/** A conversation's spend in US dollars: every model response and tool result Durable recorded in its `pi.usage`. */
export function spentOf(usage: Readonly<UsageState> | undefined): number {
	if (usage === undefined) return 0;
	let total = 0;
	for (const bucket of [usage.models, usage.tools]) {
		for (const entry of Object.values(bucket)) total += entry.cost.total;
	}
	return total;
}

/** A whole session's spend: its own conversation's and each of its agents', every agent a conversation of its own. */
export function sessionSpent(own: Readonly<UsageState> | undefined, agents: Iterable<Readonly<UsageState> | undefined>): number {
	let total = spentOf(own);
	for (const usage of agents) total += spentOf(usage);
	return total;
}

export function formatDollars(amount: number): string {
	return amount < 0.01 && amount > 0 ? "<$0.01" : `$${amount.toFixed(2)}`;
}
