// Synchronous server-side Markdown parsing (marked) and allowlist HTML sanitization (sanitize-html).
// Forbids raw scripts, styles, forms, inputs, images, inline style attributes, and unsafe URL schemes; forces every
// surviving link to open in a new tab with rel="noopener noreferrer".
import { Marked } from "marked";
import sanitizeHtml, { type IOptions } from "sanitize-html";
import { type Html, raw } from "./html.ts";

const CACHE_MAX = 400;
const blockCache = new Map<string, string>();

const marked = new Marked({ gfm: true, breaks: true });

const SANITIZE_OPTIONS: IOptions = {
	allowedTags: [
		"h1",
		"h2",
		"h3",
		"h4",
		"h5",
		"h6",
		"p",
		"br",
		"hr",
		"blockquote",
		"pre",
		"code",
		"ul",
		"ol",
		"li",
		"dl",
		"dt",
		"dd",
		"table",
		"thead",
		"tbody",
		"tfoot",
		"tr",
		"th",
		"td",
		"a",
		"strong",
		"b",
		"em",
		"i",
		"del",
		"s",
		"sub",
		"sup",
		"span",
		"div",
	],
	allowedAttributes: {
		a: ["href", "title", "target", "rel"],
		code: ["class"],
		th: ["align"],
		td: ["align"],
	},
	allowedClasses: {
		code: [/^language-[A-Za-z0-9_+-]+$/],
	},
	allowedSchemes: ["http", "https", "mailto"],
	allowProtocolRelative: false,
	transformTags: {
		a: (tagName, attribs) => {
			if (attribs.href === undefined || attribs.href === "") return { tagName, attribs: {} };
			return {
				tagName,
				attribs: {
					...attribs,
					target: "_blank",
					rel: "noopener noreferrer",
				},
			};
		},
	},
};

function clean(unsafeHtml: string): string {
	return sanitizeHtml(unsafeHtml, SANITIZE_OPTIONS);
}

/** Render block Markdown into sanitized HTML; cached by exact source string with FIFO eviction. */
export function renderMarkdown(text: string): Html {
	const cached = blockCache.get(text);
	if (cached !== undefined) return raw(cached);
	const rendered = clean(marked.parse(text, { async: false }));
	if (blockCache.size >= CACHE_MAX) {
		const oldest = blockCache.keys().next().value;
		if (oldest !== undefined) blockCache.delete(oldest);
	}
	blockCache.set(text, rendered);
	return raw(rendered);
}

/** Render inline Markdown (bold, italic, code, links) into sanitized HTML synchronously. */
export function renderInline(text: string): Html {
	return raw(clean(marked.parseInline(text, { async: false })));
}
