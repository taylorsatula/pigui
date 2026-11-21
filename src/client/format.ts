// Plain-language wording for what the agent did, so collapsed activity reads like a sentence.

type Args = Record<string, unknown>;

function firstLine(text: unknown, max = 60): string {
	const line = String(text ?? "").split("\n")[0]?.trim() ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** One call, as a short phrase: "Ran npm test", "Edited src/app.ts". */
export function describeCall(name: string, args: Args): string {
	switch (name) {
		case "bash":
			return `Ran ${firstLine(args.command)}`;
		case "read":
			return `Read ${String(args.path ?? "a file")}`;
		case "write":
			return `Wrote ${String(args.path ?? "a file")}`;
		case "edit":
			return `Edited ${String(args.path ?? "a file")}`;
		case "update_progress": {
			const steps = Array.isArray(args.completed) ? args.completed.join(", ") : "";
			return `Marked step${steps.includes(",") ? "s" : ""} ${steps} done`;
		}
		case "recall_history":
			return args.entry !== undefined ? `Looked up history entry ${String(args.entry)}` : `Searched history for “${firstLine(args.query, 40)}”`;
		default:
			return name.replace(/_/g, " ");
	}
}

const NOUNS: Record<string, [string, string, string]> = {
	bash: ["Ran", "command", "commands"],
	read: ["Read", "file", "files"],
	write: ["Wrote", "file", "files"],
	edit: ["Edited", "file", "files"],
	update_progress: ["Updated", "progress", "progress"],
	recall_history: ["Searched", "history", "history"],
};

/** A group of calls in one line: "Ran 2 commands, edited 1 file". */
export function describeGroup(names: readonly string[]): string {
	const counts = new Map<string, number>();
	for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
	const parts = [...counts].map(([name, count]) => {
		const noun = NOUNS[name];
		if (noun === undefined) return `${name.replace(/_/g, " ")}${count > 1 ? ` ×${count}` : ""}`;
		if (noun[1] === noun[2]) return `${noun[0]} ${noun[1]}`;
		return `${noun[0]} ${count} ${count === 1 ? noun[1] : noun[2]}`;
	});
	const sentence = parts.join(", ").toLowerCase();
	return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

export function timeAgo(at: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.round((now - at) / 1000));
	if (seconds < 60) return "now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}
