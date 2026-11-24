// Composer drafts, per session, in the browser's storage: a draft survives a reload, a crash of the app, and switching
// sessions. A draft being sent keeps its request ID, so a send retried after a reload is the same send.

export type Draft = {
	text: string;
	/** Uploaded attachments waiting to be sent. */
	attachments: { id: string; name: string; image: boolean }[];
	/** Set while a send is in flight. */
	requestId?: string;
};

const KEY = "pigui.drafts";
const EMPTY: Draft = { text: "", attachments: [] };

function readAll(): Record<string, Draft> {
	try {
		return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, Draft>;
	} catch {
		return {};
	}
}

export function loadDraft(key: string): Draft {
	return readAll()[key] ?? EMPTY;
}

export function saveDraft(key: string, draft: Draft): void {
	try {
		const all = readAll();
		if (draft.text === "" && draft.attachments.length === 0 && draft.requestId === undefined) delete all[key];
		else all[key] = draft;
		localStorage.setItem(KEY, JSON.stringify(all));
	} catch {
		// Storage can be unavailable (private browsing); the draft then lives only in memory.
	}
}

/** Drop the draft (after its send succeeded); the request ID goes with it, since the server answered. */
export function clearDraft(key: string): void {
	saveDraft(key, EMPTY);
}
