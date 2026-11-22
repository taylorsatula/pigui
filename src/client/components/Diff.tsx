// The session's changes, file by file with added and removed counts; each file opens to its patch. Shown as a sheet
// that rises over the session and closes with Done, Escape, a tap on the dimmed page, or a swipe down.
import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { SessionDiff } from "../../shared/api.ts";
import { api, describeFailure } from "../api.ts";
import { exitMs, useSwipeDown } from "../motion.ts";
import { Icon } from "./Icons.tsx";

function Patch(props: { patch: string }): JSX.Element {
	return (
		<pre class="patch">
			<code>
				{props.patch.replace(/\n$/, "").split("\n").map((line, index) => (
					<span key={index} class={line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : ""}>
						{line}
						{"\n"}
					</span>
				))}
			</code>
		</pre>
	);
}

function Counts(props: { added: number; removed: number }): JSX.Element {
	return (
		<span class="diff-counts">
			<span class={`add ${props.added === 0 ? "zero" : ""}`}>+{props.added}</span> <span class={`del ${props.removed === 0 ? "zero" : ""}`}>−{props.removed}</span>
		</span>
	);
}

export function DiffSheet(props: { session: number; onClose: () => void }): JSX.Element {
	const [diff, setDiff] = useState<SessionDiff | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const [closing, setClosing] = useState(false);
	const sheet = useRef<HTMLDivElement>(null);
	const scrim = useRef<HTMLDivElement>(null);
	const header = useRef<HTMLElement>(null);
	const body = useRef<HTMLDivElement>(null);
	const close = () => setClosing(true);

	useEffect(() => {
		api.diff(props.session).then(setDiff, (failure: unknown) => setError(describeFailure(failure).message));
	}, [props.session]);
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => event.key === "Escape" && setClosing(true);
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
	// Leave the page once the sheet has slid away.
	useEffect(() => {
		if (!closing) return;
		const timer = setTimeout(props.onClose, exitMs());
		return () => clearTimeout(timer);
	}, [closing, props.onClose]);
	// Focus moves into the sheet, and back to whatever opened it when it goes.
	useLayoutEffect(() => {
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
		sheet.current?.focus({ preventScroll: true });
		return () => opener?.focus({ preventScroll: true });
	}, []);
	useSwipeDown({
		element: sheet,
		// From the top bar always; from the content only when it is scrolled to its top, so it can still scroll.
		canStart: (target) => (target instanceof Node && header.current?.contains(target) === true) || (body.current?.scrollTop ?? 0) <= 0,
		distance: (height) => height * 0.25,
		velocity: 0.4,
		onDismiss: close,
		onProgress: (shown) => {
			const element = scrim.current;
			if (element === null) return;
			element.classList.toggle("dragging", shown !== undefined);
			element.style.opacity = shown === undefined ? "" : String(shown);
		},
	});

	const added = diff?.files.reduce((sum, file) => sum + file.added, 0) ?? 0;
	const removed = diff?.files.reduce((sum, file) => sum + file.removed, 0) ?? 0;
	return (
		<>
			<div ref={scrim} class={`sheet-scrim ${closing ? "closing" : ""}`} onClick={close} aria-hidden="true" />
			<div ref={sheet} class={`sheet ${closing ? "closing" : ""}`} role="dialog" aria-modal="true" aria-labelledby="diff-title" tabIndex={-1}>
				<header ref={header} class="sheet-header">
					<span class="grabber" aria-hidden="true" />
					<h2 id="diff-title">Changes</h2>
					<button type="button" class="link done" onClick={close}>
						Done
					</button>
				</header>
				<div ref={body} class="sheet-body">
					{error !== undefined ? <p class="error-text">{error}</p> : null}
					{diff === undefined && error === undefined ? (
						<p class="sheet-status">
							<span class="spinner" aria-hidden="true" /> Loading…
						</p>
					) : null}
					{diff !== undefined ? (
						<>
							<p class="diff-summary">
								<span>
									{diff.files.length} file{diff.files.length === 1 ? "" : "s"} changed against {diff.base}
								</span>
								{diff.files.length > 0 ? <Counts added={added} removed={removed} /> : null}
							</p>
							{diff.uncommitted > 0 ? <p class="diff-note warn">{diff.uncommitted} uncommitted, not included</p> : null}
							{diff.files.length === 0 ? <p class="sheet-status">No committed changes yet.</p> : null}
							{diff.files.map((file) => (
								<details class="diff-file" key={file.path}>
									<summary>
										<Icon name="chevron" size={16} />
										<span class="diff-path">{file.from === undefined ? file.path : `${file.from} → ${file.path}`}</span>
										{file.binary ? <span class="diff-counts">binary</span> : <Counts added={file.added} removed={file.removed} />}
									</summary>
									{file.binary ? <p class="diff-note">A binary file.</p> : <Patch patch={file.patch} />}
									{file.truncated ? <p class="diff-note">The rest of this file's changes are too long to show here.</p> : null}
								</details>
							))}
						</>
					) : null}
				</div>
			</div>
		</>
	);
}
