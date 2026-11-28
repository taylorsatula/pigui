// Inline SVG line icons matching the publication aesthetic; zero network requests, follows currentColor in all themes.
import { escapeHtml, type Html, raw } from "./html.ts";

const PATHS = {
	menu: "M4 7h16M4 12h16M4 17h16",
	plus: "M12 5v14M5 12h14",
	send: "M5 12h14M13 6l6 6-6 6",
	clip: "M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9",
	chevron: "M9 6l6 6-6 6",
	check: "M5 12.5l4.5 4.5L19 7.5",
	close: "M6 6l12 12M18 6L6 18",
	minus: "M6 12h12",
	stop: "M8 8h8v8H8z",
	diff: "M12 4.5v9M7 9h10M7 19.5h10",
	archive: "M4 7h16v13H4zM3 3h18v4H3zM10 11h4",
	restore: "M4 7h16v13H4zM3 3h18v4H3zM12 17v-6M9.5 13.5L12 11l2.5 2.5",
	folder: "M3 6.5h6.5l2 2H21V19H3z",
	monitor: "M4 5.5h16v11H4zM9 20h6M12 16.5V20",
	repo: "M6 4.5h12.5v13H7.5A1.5 1.5 0 0 0 6 19zM6 19a1.5 1.5 0 0 0 1.5 1.5h11v-3M9.5 8h5",
	branch: "M5 5a2 2 0 1 1 4 0 2 2 0 1 1-4 0M5 19a2 2 0 1 1 4 0 2 2 0 1 1-4 0M7 7v10M15 8a2 2 0 1 1 4 0 2 2 0 1 1-4 0M17 10c0 5-3.8 5.8-7.4 6.2",
	star: "M12 3.5l2.6 5.3 5.9.9-4.25 4.15 1 5.85L12 16.9l-5.25 2.8 1-5.85L3.5 9.7l5.9-.9z",
	pin: "M9.5 3.5h5M10.7 3.5l-.9 7.2L6.7 14.4c-.3.8.3 1.6 1.1 1.6h8.4c.8 0 1.4-.8 1.1-1.6l-3.1-3.7-.9-7.2M12 16v4.5",
	bell: "M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0",
	speaker: "M4 9.5h3l5-4v13l-5-4H4zM16 9a4.5 4.5 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11",
	back: "M15 6l-6 6 6 6",
	agents: "M9 11.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3.5 19a5.5 5.5 0 0 1 11 0M15.5 5.8a3 3 0 0 1 0 5.4M17.5 14a5.5 5.5 0 0 1 3 5",
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName, size = 22, label?: string): Html {
	const aria = label === undefined ? ' aria-hidden="true"' : ` aria-label="${escapeHtml(label)}" role="img"`;
	return raw(
		`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"${aria} class="icon"><path d="${PATHS[name]}"></path></svg>`,
	);
}
