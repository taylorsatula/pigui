// Line icons drawn inline, so they follow the text colour in every theme and need no requests. Drawn at a pen's
// weight, a little finer than the system's, to sit beside the serif.
import type { JSX } from "preact";

const paths = {
	menu: "M4 7h16M4 12h16M4 17h16",
	plus: "M12 5v14M5 12h14",
	send: "M5 12h14M13 6l6 6-6 6",
	stop: "M8 8h8v8H8z",
	clip: "M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9",
	chevron: "M9 6l6 6-6 6",
	check: "M5 12.5l4.5 4.5L19 7.5",
	close: "M6 6l12 12M18 6L6 18",
	minus: "M6 12h12",
	// A plus over a minus, centred on the icon's middle as the others are, and as wide as their lighter parts.
	diff: "M12 4.5v9M7 9h10M7 19.5h10",
	archive: "M4 7h16v13H4zM3 3h18v4H3zM10 11h4",
	// The archive box with an arrow out of it: back among the sessions under way.
	restore: "M4 7h16v13H4zM3 3h18v4H3zM12 17v-6M9.5 13.5L12 11l2.5 2.5",
	folder: "M3 6.5h6.5l2 2H21V19H3z",
	star: "M12 3.5l2.6 5.3 5.9.9-4.25 4.15 1 5.85L12 16.9l-5.25 2.8 1-5.85L3.5 9.7l5.9-.9z",
	bell: "M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0",
	speaker: "M4 9.5h3l5-4v13l-5-4H4zM16 9a4.5 4.5 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11",
	back: "M15 6l-6 6 6 6",
	// Two figures, one ahead of the other: the agents a session's agent started.
	agents: "M9 11.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3.5 19a5.5 5.5 0 0 1 11 0M15.5 5.8a3 3 0 0 1 0 5.4M17.5 14a5.5 5.5 0 0 1 3 5",
} as const;

type IconName = keyof typeof paths;

export function Icon(props: { name: IconName; size?: number; label?: string }): JSX.Element {
	const size = props.size ?? 22;
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.75"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden={props.label === undefined ? "true" : undefined}
			aria-label={props.label}
			role={props.label === undefined ? undefined : "img"}
			class="icon"
		>
			<path d={paths[props.name]} />
		</svg>
	);
}
