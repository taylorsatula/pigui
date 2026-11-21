// `@file` and `#skill` references in message text. The composer uses `activeTrigger` to open a picker, the server uses
// `findReferences` to expand what was sent; both follow the same rule so a reference the picker inserted is the one the
// agent receives.

export type ReferenceKind = "file" | "skill";

export type Reference = {
	kind: ReferenceKind;
	/** The path or skill name, without its sigil. */
	value: string;
	/** Offsets of the whole token, sigil included. */
	start: number;
	end: number;
};

const SIGIL: Record<string, ReferenceKind> = { "@": "file", "#": "skill" };
const FILE_CHARS = /[A-Za-z0-9._\-/+]/;
const SKILL_CHARS = /[A-Za-z0-9_\-:.]/;
// Punctuation that ends a sentence, not a path: "see @README.md." refers to README.md.
const TRAILING = /[.,;:!?)\]}'"]+$/;

/**
 * A sigil starts a reference only at the start of the text or after whitespace or an opening bracket or quote, so
 * `me@example.com` and `a#b` stay plain text.
 */
function startsToken(text: string, index: number): boolean {
	if (index === 0) return true;
	return /[\s([{"']/.test(text[index - 1] ?? "");
}

function scan(text: string, from: number, kind: ReferenceKind): number {
	const chars = kind === "file" ? FILE_CHARS : SKILL_CHARS;
	let end = from;
	while (end < text.length && chars.test(text[end] ?? "")) end++;
	return end;
}

/** Every reference in `text`, in order. `#123` is an issue number, not a skill. */
export function findReferences(text: string): Reference[] {
	const found: Reference[] = [];
	for (let index = 0; index < text.length; index++) {
		const kind = SIGIL[text[index] ?? ""];
		if (kind === undefined || !startsToken(text, index)) continue;
		const end = scan(text, index + 1, kind);
		const raw = text.slice(index + 1, end);
		const value = raw.replace(TRAILING, "");
		if (value.length > 0 && !(kind === "skill" && /^\d+$/.test(value))) {
			found.push({ kind, value, start: index, end: index + 1 + value.length });
		}
		index = Math.max(index, end - 1);
	}
	return found;
}

export type Trigger = {
	kind: ReferenceKind;
	/** What has been typed after the sigil so far. */
	query: string;
	/** Offset of the sigil. */
	start: number;
};

/** The reference being typed at `caret`, if any: what the composer's picker narrows by. */
export function activeTrigger(text: string, caret: number): Trigger | undefined {
	let index = caret;
	while (index > 0) {
		const char = text[index - 1] ?? "";
		const kind = SIGIL[char];
		if (kind !== undefined) {
			const start = index - 1;
			if (!startsToken(text, start)) return undefined;
			const query = text.slice(index, caret);
			if (scan(query, 0, kind) !== query.length) return undefined;
			if (kind === "skill" && /^\d+$/.test(query)) return undefined;
			return { kind, query, start };
		}
		if (/\s/.test(char)) return undefined;
		index--;
	}
	return undefined;
}

/** Replace the trigger with the chosen reference and a trailing space; returns the new text and caret. */
export function insertReference(text: string, trigger: Trigger, caret: number, value: string): { text: string; caret: number } {
	const sigil = trigger.kind === "file" ? "@" : "#";
	const before = text.slice(0, trigger.start);
	const after = text.slice(caret);
	const inserted = `${sigil}${value}${after.startsWith(" ") ? "" : " "}`;
	return { text: before + inserted + after, caret: before.length + inserted.length };
}

/** Candidates whose name contains every character of `query` in order, best matches first. */
export function narrow(candidates: readonly string[], query: string, limit: number): string[] {
	const needle = query.toLowerCase();
	const scored: { value: string; score: number }[] = [];
	for (const value of candidates) {
		const score = matchScore(value.toLowerCase(), needle);
		if (score !== undefined) scored.push({ value, score });
	}
	scored.sort((a, b) => a.score - b.score || a.value.length - b.value.length || a.value.localeCompare(b.value));
	return scored.slice(0, limit).map((entry) => entry.value);
}

/** Lower is better: a substring match beats a scattered one, and a match in the file name beats one in its folder. */
function matchScore(value: string, needle: string): number | undefined {
	if (needle.length === 0) return 0;
	const base = value.slice(value.lastIndexOf("/") + 1);
	if (base.startsWith(needle)) return 0;
	if (base.includes(needle)) return 1;
	if (value.includes(needle)) return 2;
	let position = 0;
	for (const char of needle) {
		position = value.indexOf(char, position);
		if (position === -1) return undefined;
		position++;
	}
	return 3;
}
