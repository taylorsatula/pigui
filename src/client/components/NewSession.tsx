// Starting a session. On a server: a repository (the last one used), a branch choice (a new branch from the default
// branch unless changed), then the composer. In picloud OnPrem, a directory on this computer comes first, the home
// directory unless changed, with the starred and recent directories under it to choose from, and a repository is the
// other choice where gh can list them. File and skill pickers read the chosen directory, or the chosen branch, before
// anything starts.
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { BranchList, RepoSummary } from "../../shared/api.ts";
import { api, describeFailure } from "../api.ts";
import { navigate, useStore } from "../store.ts";
import { Composer, ComposerDock } from "./Composer.tsx";
import { Directories, DirectoryField } from "./Directories.tsx";
import { SessionsButton } from "./Sessions.tsx";

export function NewSession(): JSX.Element {
	const bootstrap = useStore((state) => state.bootstrap);
	const home = bootstrap?.onPrem?.home;
	const onPrem = home !== undefined;
	const [place, setPlace] = useState<"local" | "repo">("local");
	const [dir, setDir] = useState("~");
	const [repos, setRepos] = useState<RepoSummary[] | undefined>(undefined);
	const [repo, setRepo] = useState<string | undefined>(undefined);
	const [branches, setBranches] = useState<BranchList | undefined>(undefined);
	const [mode, setMode] = useState<"new" | "continue">("new");
	const [base, setBase] = useState<string>("");
	const [branch, setBranch] = useState<string>("");
	const [error, setError] = useState<string | undefined>(undefined);
	// Until the server says it is OnPrem, the screen is a server's; only OnPrem has directories to choose.
	const local = onPrem && place === "local";

	useEffect(() => {
		api.repos().then(
			(list) => {
				setRepos(list);
				const preferred = list.find((item) => item.name === bootstrap?.lastRepo) ?? list[0];
				setRepo((current) => current ?? preferred?.name);
			},
			(failure: unknown) => setError(describeFailure(failure).message),
		);
	}, [bootstrap?.lastRepo]);

	useEffect(() => {
		if (repo === undefined) return;
		setBranches(undefined);
		api.branches(repo).then(
			(list) => {
				setBranches(list);
				setBase(list.defaultBranch);
				setBranch(list.branches.find((name) => name !== list.defaultBranch) ?? list.defaultBranch);
			},
			(failure: unknown) => setError(describeFailure(failure).message),
		);
	}, [repo]);

	const ref = mode === "new" ? base : branch;
	const ready = local ? dir.trim() !== "" : repo !== undefined && branches !== undefined && ref !== "";

	return (
		<div class="session new-session">
			<header class="topbar">
				<SessionsButton />
				<h1 class="title">New session</h1>
			</header>
			<div class="setup-form">
				<p class="intro">
					{onPrem
						? "Choose where Pi works: a directory on this computer, with your full access, or a repository on a branch of its own. Then describe the task. Pi asks what it needs to know, writes a plan, and waits for your approval before it builds."
						: "Choose a repository and a branch, then describe the task. Pi asks what it needs to know, writes a plan, and waits for your approval before it builds."}
				</p>
				{onPrem ? (
					<div class="segmented" role="radiogroup" aria-label="Where Pi works">
						<button type="button" role="radio" aria-checked={place === "local"} class={place === "local" ? "selected" : ""} onClick={() => setPlace("local")}>
							This computer
						</button>
						<button type="button" role="radio" aria-checked={place === "repo"} class={place === "repo" ? "selected" : ""} onClick={() => setPlace("repo")}>
							A repository
						</button>
					</div>
				) : null}
				{local && home !== undefined ? (
					<>
						<DirectoryField dir={dir} home={home} onInput={setDir} />
						<Directories dir={dir} home={home} onChoose={setDir} />
					</>
				) : (
					<>
						{/* Listing repositories needs gh on the server; when it fails, a local session still can start. */}
						{error !== undefined ? <p class="error-text" role="alert">{error}</p> : null}
						<label class="field">
							<span>Repository</span>
							<select value={repo ?? ""} disabled={repos === undefined} onChange={(event) => setRepo((event.target as HTMLSelectElement).value)}>
								{repos === undefined ? <option value="">Loading…</option> : null}
								{(repos ?? []).map((item) => (
									<option key={item.name} value={item.name}>
										{item.name}
									</option>
								))}
							</select>
						</label>
						<div class="segmented" role="radiogroup" aria-label="Branch">
							<button type="button" role="radio" aria-checked={mode === "new"} class={mode === "new" ? "selected" : ""} onClick={() => setMode("new")}>
								New branch
							</button>
							<button type="button" role="radio" aria-checked={mode === "continue"} class={mode === "continue" ? "selected" : ""} onClick={() => setMode("continue")}>
								Continue a branch
							</button>
						</div>
						<label class="field">
							<span>{mode === "new" ? "Start from" : "Branch to continue"}</span>
							<select
								value={ref}
								disabled={branches === undefined}
								onChange={(event) => {
									const value = (event.target as HTMLSelectElement).value;
									if (mode === "new") setBase(value);
									else setBranch(value);
								}}
							>
								{(branches?.branches ?? []).map((name) => (
									<option key={name} value={name}>
										{name}
										{name === branches?.defaultBranch ? " (default)" : ""}
									</option>
								))}
							</select>
						</label>
					</>
				)}
			</div>
			<ComposerDock>
				<Composer
					draftKey="new"
					placeholder="Describe the task…"
					running={false}
					disabled={!ready}
					focusToken={0}
					files={async () => (local ? (await api.localFiles(dir)).files : repo === undefined ? [] : (await api.repoFiles(repo, ref)).files)}
					skills={() => (local ? api.localSkills(dir) : repo === undefined ? Promise.resolve([]) : api.repoSkills(repo, ref))}
					onSend={async (text, attachments, requestId) => {
						if (local) {
							const { id } = await api.create({ requestId, place: "local", dir, text, attachments });
							navigate({ kind: "session", id });
							return;
						}
						if (repo === undefined) return;
						const start = mode === "new" ? { kind: "new" as const, base } : { kind: "continue" as const, branch };
						const { id } = await api.create({ requestId, place: "repo", repo, start, text, attachments });
						navigate({ kind: "session", id });
					}}
				/>
			</ComposerDock>
		</div>
	);
}
