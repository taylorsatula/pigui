// The agent's prose as Markdown. The model's text is untrusted, so the HTML marked produces is sanitized by DOMPurify
// before it reaches the page, and links open outside the app.
import DOMPurify from "dompurify";
import { marked } from "marked";
import type { JSX } from "preact";
import { useMemo } from "preact/hooks";

marked.setOptions({ gfm: true, breaks: true });

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
	if (node.tagName === "A") {
		node.setAttribute("target", "_blank");
		node.setAttribute("rel", "noopener noreferrer");
	}
});

const SANITIZE = { FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "img"], FORBID_ATTR: ["style"] };

function renderMarkdown(text: string): string {
	return DOMPurify.sanitize(marked.parse(text, { async: false }), SANITIZE);
}

export function Markdown(props: { text: string; class?: string }): JSX.Element {
	const html = useMemo(() => renderMarkdown(props.text), [props.text]);
	return <div class={`markdown ${props.class ?? ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** One line of the agent's text, such as an item of a plan or report: its inline Markdown (code, emphasis, links) only. */
export function Inline(props: { text: string; class?: string }): JSX.Element {
	const html = useMemo(() => DOMPurify.sanitize(marked.parseInline(props.text, { async: false }), SANITIZE), [props.text]);
	return <span class={`inline ${props.class ?? ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
