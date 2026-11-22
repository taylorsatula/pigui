// Starting a session: a repository (the last one used), a branch choice (a new branch from the default branch unless
// changed), then the composer. File and skill pickers read the chosen branch before anything is cloned.
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { BranchList, RepoSummary } from "../../shared/api.ts";
import { api, describeFailure } from "../api.ts";
import { navigate, useStore } from "../store.ts";
import { Composer, ComposerDock } from "./Composer.tsx";
import { DrawerButton } from "./Drawer.tsx";

export function NewSession(): JSX.Element {
	const bootstrap = useStore((state) => state.bootstrap);
	const [repos, setRepos] = useState<RepoSummary[] | undefined>(undefined);
	const [repo, setRepo] = useState<string | undefined>(undefined);
	const [branches, setBranches] = useState<BranchList | undefined>(undefined);
	const [mode, setMode] = useState<"new" | "continue">("new");
	const [base, setBase] = useState<string>("");
	const [branch, setBranch] = useState<string>("");
	const [error, setError] = useState<string | undefined>(undefined);

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
	const ready = repo !== undefined && branches !== undefined && ref !== "";

	return (
		<div class="session new-session">
			<header class="topbar">
				<DrawerButton />
				<h1 class="title">New session</h1>
			</header>
			<div class="setup-form">
				<p class="intro">Choose a repository and a branch, then describe the task. Pi asks what it needs to know, writes a plan, and waits for your approval before it builds.</p>
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
			</div>
			<ComposerDock>
				<Composer
					draftKey="new"
					placeholder="Describe the task…"
					running={false}
					disabled={!ready}
					focusToken={0}
					files={async () => (repo === undefined ? [] : (await api.repoFiles(repo, ref)).files)}
					skills={() => (repo === undefined ? Promise.resolve([]) : api.repoSkills(repo, ref))}
					onSend={async (text, attachments, requestId) => {
						if (repo === undefined) return;
						const start = mode === "new" ? { kind: "new" as const, base } : { kind: "continue" as const, branch };
						const { id } = await api.create({ requestId, repo, start, text, attachments });
						navigate({ kind: "session", id });
					}}
				/>
			</ComposerDock>
		</div>
	);
}
