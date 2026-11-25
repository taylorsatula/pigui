// The agent's prose as Markdown, shared by Markdown.svelte and Inline.svelte. The model's text is untrusted, so the
// HTML marked produces is sanitized by DOMPurify before it reaches the page, and links open outside the app.
// marked and DOMPurify leave the critical path: they load on first render, cached thereafter.
const SANITIZE = { FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "img"], FORBID_ATTR: ["style"] };

type Libs = {
	marked: typeof import("marked").marked;
	DOMPurify: typeof import("dompurify").default;
};

let libs: Promise<Libs> | undefined;

function load(): Promise<Libs> {
	if (!libs) {
		libs = Promise.all([import("marked"), import("dompurify")]).then(([markedModule, dompurifyModule]) => {
			const DOMPurify = dompurifyModule.default;
			markedModule.marked.setOptions({ gfm: true, breaks: true });
			DOMPurify.addHook("afterSanitizeAttributes", (node) => {
				if (node.tagName === "A") {
					node.setAttribute("target", "_blank");
					node.setAttribute("rel", "noopener noreferrer");
				}
			});
			return { marked: markedModule.marked, DOMPurify };
		});
	}
	return libs;
}

// Identical text renders identically; during streaming the same text recurs between tokens' renders, and a long session re-renders it on every update.
const CACHE_MAX = 200;
const cache = new Map<string, string>();

export async function renderMarkdown(text: string): Promise<string> {
	const hit = cache.get(text);
	if (hit !== undefined) return hit;
	const { marked, DOMPurify } = await load();
	const rendered = DOMPurify.sanitize(marked.parse(text, { async: false }), SANITIZE);
	if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
	cache.set(text, rendered);
	return rendered;
}

export async function renderInline(text: string): Promise<string> {
	const { marked, DOMPurify } = await load();
	return DOMPurify.sanitize(marked.parseInline(text, { async: false }), SANITIZE);
}
