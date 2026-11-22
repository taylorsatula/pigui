// The colour scheme, chosen per device. System follows the OS between Light and Dark (paper and ink, by day and by
// lamplight); Terminal is a dark, monospace theme in ANSI colours. A chosen theme is `data-theme` on <html>, which the tokens in app.css key on.

export const THEMES = ["system", "light", "dark", "terminal"] as const;
export type Theme = (typeof THEMES)[number];

const KEY = "picloud.theme";

/** Each theme's page colour (its --bg in app.css), for the browser's bars. */
const BAR: Record<Exclude<Theme, "system">, string> = { light: "#fcfbf8", dark: "#181714", terminal: "#0a0a0a" };

/** The theme chosen on this device, or System when none was or storage is unavailable (as in some private modes). */
export function storedTheme(): Theme {
	try {
		const stored = localStorage.getItem(KEY);
		return THEMES.find((theme) => theme === stored) ?? "system";
	} catch {
		return "system";
	}
}

export function applyTheme(theme: Theme): void {
	const root = document.documentElement;
	if (theme === "system") delete root.dataset.theme;
	else root.dataset.theme = theme;
	// index.html has one theme-color per system scheme, so System's bars follow the OS; a chosen theme fills both.
	for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
		meta.content = BAR[theme === "system" ? (meta.media.includes("dark") ? "dark" : "light") : theme];
	}
}

/** For the frame of a change of theme nothing transitions, so everything changes colour at once (see app.css). */
export function holdTransitions(): void {
	const root = document.documentElement;
	root.classList.add("theme-changing");
	requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-changing")));
}

export function chooseTheme(theme: Theme): void {
	holdTransitions();
	applyTheme(theme);
	try {
		localStorage.setItem(KEY, theme);
	} catch {
		// Storage can be unavailable (private browsing); the theme then holds until the page is reloaded.
	}
}
