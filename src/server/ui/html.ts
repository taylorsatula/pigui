// Auto-escaping HTML tagged templates backed by the battle-tested escape-html package. Every interpolated value is
// escaped by default; only explicitly branded Html fragments pass through raw.
import escapeHtml from "escape-html";

export { escapeHtml };

const RAW_BRAND = Symbol("html.raw");

export type Html = { readonly [RAW_BRAND]: true; readonly value: string };

export type HtmlChild = Html | string | number | boolean | null | undefined | readonly HtmlChild[];

export function raw(value: string): Html {
	return { [RAW_BRAND]: true, value };
}

export function isHtml(value: unknown): value is Html {
	return typeof value === "object" && value !== null && RAW_BRAND in value;
}

function renderChild(child: HtmlChild): string {
	if (child === null || child === undefined || child === false || child === true) return "";
	if (isHtml(child)) return child.value;
	if (Array.isArray(child)) return child.map(renderChild).join("");
	return escapeHtml(String(child));
}

export function html(strings: TemplateStringsArray, ...values: HtmlChild[]): Html {
	let out = strings[0] ?? "";
	for (let i = 0; i < values.length; i++) {
		out += renderChild(values[i]);
		out += strings[i + 1] ?? "";
	}
	return raw(out);
}

export function joinHtml(items: readonly Html[], separator = ""): Html {
	return raw(items.map((item) => item.value).join(separator));
}

export function classes(...parts: ReadonlyArray<string | false | null | undefined>): string {
	return parts.filter((part): part is string => typeof part === "string" && part !== "").join(" ");
}
