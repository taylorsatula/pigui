// Full HTML page shell shared by every route: plain global stylesheets, native <dialog> overlays, top-layer popover
// toast container, screensaver slot, and a single native ES module entry point (/js/app.js). Zero bundler.
import { escapeHtml, type Html, html, raw } from "../html.ts";

export type PageFrameOptions = {
	title: string;
	page: "new" | "session" | "agent" | "not-found";
	body: Html;
	vapidPublicKey: string;
	speech: boolean;
	onPrem: boolean;
	home?: string;
	sessionId?: number;
	agentId?: number;
	running?: boolean;
	workflow?: string;
};

export function renderPage(opts: PageFrameOptions): string {
	const dataAttrs = [
		`data-page="${escapeHtml(opts.page)}"`,
		`data-vapid="${escapeHtml(opts.vapidPublicKey)}"`,
		`data-speech="${opts.speech ? "true" : "false"}"`,
		`data-onprem="${opts.onPrem ? "true" : "false"}"`,
		opts.home !== undefined ? `data-home="${escapeHtml(opts.home)}"` : "",
		opts.sessionId !== undefined ? `data-session-id="${opts.sessionId}"` : "",
		opts.agentId !== undefined ? `data-agent-id="${opts.agentId}"` : "",
		opts.running !== undefined ? `data-running="${opts.running ? "true" : "false"}"` : "",
		opts.workflow !== undefined ? `data-workflow="${escapeHtml(opts.workflow)}"` : "",
	]
		.filter((part) => part !== "")
		.join(" ");

	const doc = html`<!doctype html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<meta name="theme-color" content="#fcfbf8" media="(prefers-color-scheme: light)" />
		<meta name="theme-color" content="#010405" media="(prefers-color-scheme: dark)" />
		<meta name="apple-mobile-web-app-capable" content="yes" />
		<meta name="mobile-web-app-capable" content="yes" />
		<meta name="apple-mobile-web-app-status-bar-style" content="default" />
		<meta name="apple-mobile-web-app-title" content="pigui" />
		<title>${opts.title}</title>
		<link rel="manifest" href="/manifest.webmanifest" />
		<link rel="icon" href="/icons/icon-192.png" />
		<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
		<link rel="stylesheet" href="/css/app.css" />
		<link rel="modulepreload" href="/vendor/idiomorph.esm.js" />
		<link rel="modulepreload" href="/shared/references.js" />
		<link rel="modulepreload" href="/js/app.js" />
		<link rel="modulepreload" href="/js/api.js" />
		<link rel="modulepreload" href="/js/composer.js" />
		<link rel="modulepreload" href="/js/dates.js" />
		<link rel="modulepreload" href="/js/dialogs.js" />
		<link rel="modulepreload" href="/js/events.js" />
		<link rel="modulepreload" href="/js/transcript.js" />
		<link rel="modulepreload" href="/js/toast.js" />
	</head>
	<body ${raw(dataAttrs)}>
		<div class="app">
			<main class="main">${opts.body}</main>
		</div>
		<dialog id="session-picker" class="session-picker" aria-label="Sessions"></dialog>
		<dialog id="agents-panel" class="agents-panel" aria-label="Agents"></dialog>
		<dialog id="diff-sheet" class="sheet" aria-labelledby="diff-title"></dialog>
		<dialog id="start-sheet" class="sheet" aria-labelledby="start-sheet-title"></dialog>
		<div id="toast-host" popover="manual" aria-live="polite"></div>
		<div id="screensaver-host" aria-hidden="true"></div>
		<script type="module" src="/js/app.js"></script>
	</body>
</html>`;
	return doc.value;
}
