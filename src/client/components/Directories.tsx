// Where a local session can start (pigui OnPrem), offered under the Directory field: every directory the person
// starred, then the five most recently worked in that are not starred. The recent ones are read from the sessions
// themselves, so there is no second record of them; the stars are kept in the index document, so a star made at the
// computer is there on the phone. Choosing one fills the field.
import type { JSX } from "preact";
import type { SessionRow } from "../../shared/session.ts";
import { api, describeFailure } from "../api.ts";
import { shortDir, timeAgo } from "../format.ts";
import { showToast, useStore } from "../store.ts";
import { Icon } from "./Icons.tsx";

const RECENT = 5;

/** When a session last worked in each directory on this computer. */
function lastWorked(rows: readonly SessionRow[]): Map<string, number> {
	const at = new Map<string, number>();
	for (const row of rows) if (row.place === "local") at.set(row.dir, Math.max(at.get(row.dir) ?? 0, row.updatedAt));
	return at;
}

/** Whether what the person typed names `dir`: as stored, or as the app shows it, a trailing slash aside. */
function names(typed: string, dir: string, home: string): boolean {
	const given = typed.trim().replace(/(.)\/+$/, "$1");
	return given === dir || given === shortDir(dir, home);
}

/** A star that adds a directory to the starred ones, or takes it off; the index's watch shows the change. */
function StarButton(props: { dir: string; label: string; starred: boolean; disabled?: boolean }): JSX.Element {
	const toggle = async () => {
		try {
			await api.star(props.dir, !props.starred);
		} catch (error) {
			showToast({ message: describeFailure(error).message });
		}
	};
	return (
		<button type="button" class="icon-button dir-star" aria-label={props.label} aria-pressed={props.starred} disabled={props.disabled} onClick={() => void toggle()}>
			<Icon name="star" size={18} />
		</button>
	);
}

/** The Directory field, with a star for the directory typed in it. */
export function DirectoryField(props: { dir: string; home: string; onInput: (dir: string) => void }): JSX.Element {
	const index = useStore((state) => state.index);
	const starred = (index?.starred ?? []).some((dir) => names(props.dir, dir, props.home));
	return (
		<div class="field">
			<label for="directory">Directory</label>
			<div class="field-row">
				<input
					id="directory"
					type="text"
					value={props.dir}
					autocapitalize="off"
					autocorrect="off"
					spellcheck={false}
					onInput={(event) => props.onInput((event.target as HTMLInputElement).value)}
				/>
				<StarButton dir={props.dir} label="Star this directory" starred={starred} disabled={props.dir.trim() === ""} />
			</div>
		</div>
	);
}

export function Directories(props: { dir: string; home: string; onChoose: (dir: string) => void }): JSX.Element | null {
	const index = useStore((state) => state.index);
	const shown = (dir: string) => shortDir(dir, props.home);
	const starred = [...(index?.starred ?? [])].sort((a, b) => shown(a).localeCompare(shown(b)));
	const worked = lastWorked(Object.values(index?.rows ?? {}));
	const recent = [...worked]
		.filter(([dir]) => !starred.includes(dir))
		.sort((a, b) => b[1] - a[1])
		.slice(0, RECENT)
		.map(([dir]) => dir);
	if (starred.length === 0 && recent.length === 0) return null;

	const group = (title: string, dirs: string[], isStarred: boolean) =>
		dirs.length === 0 ? null : (
			<section class="dir-group" aria-label={title}>
				<h2 class="dir-heading">{title}</h2>
				<ul class="dir-list">
					{dirs.map((dir, at) => {
						const chosen = names(props.dir, dir, props.home);
						const when = worked.get(dir);
						return (
							<li key={dir} class={`dir-row ${chosen ? "chosen" : ""} ${at % 2 === 1 ? "striped" : ""}`}>
								<button type="button" class="dir-choose" aria-current={chosen ? "true" : undefined} onClick={() => props.onChoose(shown(dir))}>
									<span class="folder-mark">
										<Icon name="folder" size={16} />
									</span>
									<span class="dir-path">{shown(dir)}</span>
									{when === undefined ? null : (
										<time class="dir-when" dateTime={new Date(when).toISOString()}>
											{timeAgo(when)}
										</time>
									)}
								</button>
								<StarButton dir={dir} label={`Star ${shown(dir)}`} starred={isStarred} />
							</li>
						);
					})}
				</ul>
			</section>
		);

	return (
		<div class="directories">
			{group("Starred", starred, true)}
			{group("Recent", recent, false)}
		</div>
	);
}
