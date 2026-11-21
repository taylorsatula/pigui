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

export function renderMarkdown(text: string): string {
	return DOMPurify.sanitize(marked.parse(text, { async: false }), {
		FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "img"],
		FORBID_ATTR: ["style"],
	});
}

export function Markdown(props: { text: string; class?: string }): JSX.Element {
	const html = useMemo(() => renderMarkdown(props.text), [props.text]);
	return <div class={`markdown ${props.class ?? ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
