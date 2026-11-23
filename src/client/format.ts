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
		case "write_handoff":
			return "Wrote a handoff note";
		case "recall_history":
			return args.entry !== undefined ? `Looked up history entry ${String(args.entry)}` : `Searched history for “${firstLine(args.query, 40)}”`;
		case "surface_memories":
			return `Searched memory: “${firstLine(args.query, 40)}”`;
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
	surface_memories: ["Searched", "memory", "memory"],
	write_handoff: ["Wrote", "handoff note", "handoff notes"],
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

/** The date set between a session's entries where it runs into a new day: "Sunday, November 22". */
export function dayHeading(at: number): string {
	return new Date(at).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

/**
 * When a session last changed, as a file browser lists it: "Today at 8:00 PM", "Yesterday at 9:12 AM", "Nov 14 at
 * 8:00 PM", and with its year once it is from another.
 */
export function listingDate(at: number, now = Date.now()): string {
	const date = new Date(at);
	const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
	if (sameDay(at, now)) return `Today at ${time}`;
	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	if (sameDay(at, yesterday.getTime())) return `Yesterday at ${time}`;
	if (date.getFullYear() !== new Date(now).getFullYear()) return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
	return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${time}`;
}

/** Whether two times fall on the same local day. */
export function sameDay(a: number, b: number): boolean {
	return new Date(a).toDateString() === new Date(b).toDateString();
}

/** A directory as the person reads it: the home directory, and anything under it, starting with `~`. */
export function shortDir(dir: string, home: string | undefined): string {
	if (home === undefined || home === "/") return dir;
	if (dir === home) return "~";
	return dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir;
}
