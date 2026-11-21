// The session's changes, file by file with added and removed counts; each file opens to its patch.
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { SessionDiff } from "../../shared/api.ts";
import { api, describeFailure } from "../api.ts";
import { Icon } from "./Icons.tsx";

function Patch(props: { patch: string }): JSX.Element {
	return (
		<pre class="patch">
			{props.patch.split("\n").map((line, index) => (
				<span key={index} class={line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : ""}>
					{line}
					{"\n"}
				</span>
			))}
		</pre>
	);
}

export function DiffSheet(props: { session: number; onClose: () => void }): JSX.Element {
	const [diff, setDiff] = useState<SessionDiff | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	useEffect(() => {
		api.diff(props.session).then(setDiff, (failure: unknown) => setError(describeFailure(failure).message));
	}, [props.session]);
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => event.key === "Escape" && props.onClose();
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [props.onClose]);
	const added = diff?.files.reduce((sum, file) => sum + file.added, 0) ?? 0;
	const removed = diff?.files.reduce((sum, file) => sum + file.removed, 0) ?? 0;
	return (
		<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="diff-title">
			<header class="sheet-header">
				<h2 id="diff-title">Changes</h2>
				<button type="button" class="icon-button" aria-label="Close" onClick={props.onClose}>
					<Icon name="close" />
				</button>
			</header>
			<div class="sheet-body">
				{error !== undefined ? <p class="error-text">{error}</p> : null}
				{diff === undefined && error === undefined ? <p class="empty">Loading…</p> : null}
				{diff !== undefined ? (
					<>
						<p class="diff-summary">
							{diff.files.length} file{diff.files.length === 1 ? "" : "s"} changed against {diff.base}
							<span class="add"> +{added}</span>
							<span class="del"> −{removed}</span>
							{diff.uncommitted > 0 ? <span class="warn"> · {diff.uncommitted} uncommitted, not included</span> : null}
						</p>
						{diff.files.length === 0 ? <p class="empty">No committed changes yet.</p> : null}
						{diff.files.map((file) => (
							<details class="diff-file" key={file.path}>
								<summary>
									<span class="diff-path">{file.from === undefined ? file.path : `${file.from} → ${file.path}`}</span>
									<span class="diff-counts">
										{file.binary ? (
											"binary"
										) : (
											<>
												<span class="add">+{file.added}</span> <span class="del">−{file.removed}</span>
											</>
										)}
									</span>
								</summary>
								{file.binary ? <p class="empty">A binary file.</p> : <Patch patch={file.patch} />}
								{file.truncated ? <p class="empty">The rest of this file's changes are too long to show here.</p> : null}
							</details>
						))}
					</>
				) : null}
			</div>
		</div>
	);
}
