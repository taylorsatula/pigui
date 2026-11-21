import type { UsageState } from "@earendil-works/pi-durable";

/** A session's spend in US dollars: every model response and tool result Durable recorded in `pi.usage`. */
export function spentOf(usage: Readonly<UsageState> | undefined): number {
	if (usage === undefined) return 0;
	let total = 0;
	for (const bucket of [usage.models, usage.tools]) {
		for (const entry of Object.values(bucket)) total += entry.cost.total;
	}
	return total;
}

export function formatDollars(amount: number): string {
	return amount < 0.01 && amount > 0 ? "<$0.01" : `$${amount.toFixed(2)}`;
}
