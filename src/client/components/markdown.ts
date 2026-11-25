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

export async function renderMarkdown(text: string): Promise<string> {
	const { marked, DOMPurify } = await load();
	return DOMPurify.sanitize(marked.parse(text, { async: false }), SANITIZE);
}

export async function renderInline(text: string): Promise<string> {
	const { marked, DOMPurify } = await load();
	return DOMPurify.sanitize(marked.parseInline(text, { async: false }), SANITIZE);
}
