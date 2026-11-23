// One session: its title over one line of record (status, repository, branch, spend), any problem with its next step,
// the transcript, and the composer, whose placeholder says what sending will do right now.
import type { LiveState, UsageState } from "@earendil-works/pi-durable";
import type { JSX } from "preact";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { runFailureText, type SessionDoc, sessionRow } from "../../shared/session.ts";
import { formatDollars, sessionSpent } from "../../shared/spend.ts";
import { api, describeFailure } from "../api.ts";
import { shortDir } from "../format.ts";
import { stopReading } from "../speech.ts";
import { showToast, useStore } from "../store.ts";
import { buildBlocks } from "../transcript.ts";
import { pinToEnd } from "../viewport.ts";
import { AgentsButton, AgentsPanel } from "./Agents.tsx";
import type { CardActions, DeliveryActions } from "./Cards.tsx";
import { Composer, ComposerDock } from "./Composer.tsx";
import { DiffSheet } from "./Diff.tsx";
import { SessionsButton } from "./Sessions.tsx";
import { Icon } from "./Icons.tsx";
import { Transcript } from "./Transcript.tsx";

function placeholderFor(doc: SessionDoc, running: boolean): string {
	if (doc.setup.status === "preparing") return "Setting up the workspace…";
	if (doc.card?.kind === "questions") return "Answer in your own words…";
	if (doc.card?.kind === "plan") return "Ask for changes to the plan…";
	if (running) return "Steer Pi while it works…";
	if (doc.outcome?.kind === "budget") return "Raise the budget to continue…";
	if (doc.report !== undefined && doc.workflow === "reported") return "Ask for more changes…";
	return "Write to Pi…";
}

/** Spend in the warning colour from 80 % of the cap, and the error colour at it. */
function spendTone(spent: number, cap: number | undefined): string {
	if (cap === undefined || cap <= 0) return "";
	return spent >= cap ? "over" : spent >= cap * 0.8 ? "near" : "";
}

function Banner(props: { doc: SessionDoc; spent: number; running: boolean; onAction: (work: () => Promise<unknown>) => void }): JSX.Element | null {
	const { doc } = props;
	if (doc.setup.status === "failed") {
		return (
			<div class="banner error" role="alert">
				<p>
					<strong>Setup failed.</strong> {doc.setup.error}
				</p>
				<button type="button" class="primary" onClick={() => props.onAction(() => api.retrySetup(doc.id))}>
					Retry setup
				</button>
			</div>
		);
	}
	if (props.running || doc.outcome === undefined) return null;
	switch (doc.outcome.kind) {
		case "failed":
			return (
				<div class="banner error" role="alert">
					<p>
						<strong>{runFailureText(doc.outcome.reason)}.</strong> {doc.outcome.detail ?? ""}
					</p>
					<button type="button" class="primary" onClick={() => props.onAction(() => api.continue(doc.id))}>
						Continue
					</button>
				</div>
			);
		case "budget": {
			const raised = Math.max((doc.cap ?? 0) * 2, Math.ceil(props.spent) + 1);
			return (
				<div class="banner warn" role="alert">
					<p>
						<strong>Budget reached.</strong> {formatDollars(props.spent)} spent of {formatDollars(doc.cap ?? 0)}.
					</p>
					<button type="button" class="primary" onClick={() => props.onAction(() => api.budget(doc.id, raised))}>
						Raise to {formatDollars(raised)} and continue
					</button>
				</div>
			);
		}
		case "no-report":
			return (
				<div class="banner warn" role="alert">
					<p>
						<strong>Pi stopped without a report.</strong> It was continued automatically and still did not finish.
					</p>
					<button type="button" class="primary" onClick={() => props.onAction(() => api.continue(doc.id))}>
						Continue
					</button>
				</div>
			);
		case "stopped":
			return (
				<div class="banner" role="status">
					<p>Stopped.</p>
					<button type="button" class="secondary" onClick={() => props.onAction(() => api.continue(doc.id))}>
						Continue
					</button>
				</div>
			);
		case "waiting-agents":
		case "replied":
		case "reported":
			return null;
	}
}

export function SessionView(props: { id: number }): JSX.Element {
	const session = useStore((state) => state.session);
	const view = useStore((state) => state.view);
	const missing = useStore((state) => state.missing);
	const home = useStore((state) => state.bootstrap?.onPrem?.home);
	const agents = useStore((state) => state.agents);
	const [focus, setFocus] = useState(0);
	const [diff, setDiff] = useState(false);
	const [agentsOpen, setAgentsOpen] = useState(false);
	const doc = session?.id === props.id ? session : undefined;
	const live = view?.docs["pi.live"] as LiveState | undefined;
	// Durable's run, and picloud's until the supervisor has handled its end: in the commit between, a run that ends in
	// an automatic continuation would otherwise read as stopped for a moment.
	const running = live?.run !== undefined || doc?.activeRun !== undefined;
	const blocks = useMemo(() => buildBlocks(view, doc, running), [view, doc, running]);
	// A reading belongs to the session on screen: leaving it stops the reading, while locking the phone does not.
	useEffect(() => () => stopReading(), []);
	// The whole session's: its own agent's, and every agent it started.
	const spent = sessionSpent(
		view?.docs["pi.usage"] as UsageState | undefined,
		(doc?.agents ?? []).map((agent) => agents[agent.id]?.["pi.usage"]),
	);

	const act = useCallback((work: () => Promise<unknown>) => {
		work().catch((error: unknown) => {
			const failure = describeFailure(error);
			showToast({ message: failure.hint === undefined ? failure.message : `${failure.message} ${failure.hint}` });
		});
	}, []);
	const cards: CardActions = useMemo(
		() => ({
			answer: async (cardId, answer) => {
				try {
					await api.answer(props.id, cardId, answer);
				} catch (error) {
					showToast({ message: describeFailure(error).message });
				}
			},
			focusComposer: () => setFocus((value) => value + 1),
		}),
		[props.id],
	);
	const delivery: DeliveryActions = useMemo(
		() => ({
			deliver: async (action) => {
				try {
					const result = await api.deliver(props.id, action);
					showToast({ message: result.pr === undefined ? "Pushed." : result.pr.created ? `Opened PR #${result.pr.number}.` : `Updated PR #${result.pr.number}.` });
				} catch (error) {
					const failure = describeFailure(error);
					showToast({ message: failure.hint === undefined ? failure.message : `${failure.message} ${failure.hint}` }, 10_000);
				}
			},
			showDiff: () => setDiff(true),
			focusComposer: () => setFocus((value) => value + 1),
		}),
		[props.id],
	);

	if (missing) {
		return (
			<div class="session">
				<header class="topbar">
					<SessionsButton />
					<h1 class="title">Not found</h1>
				</header>
				<p class="empty">This session does not exist.</p>
			</div>
		);
	}
	if (doc === undefined) {
		return (
			<div class="session">
				<header class="topbar">
					<SessionsButton />
					<h1 class="title">Loading…</h1>
				</header>
			</div>
		);
	}
	const row = sessionRow(doc);
	return (
		<div class="session">
			<div class="pinned">
				<header class="topbar">
					<SessionsButton />
					<div class="title-block">
						<h1 class="title">{doc.title}</h1>
						{/* Status leads, as a word: marked when it is the person's turn. */}
						<p class="subtitle" role="status">
							<span class={`session-status ${row.tone}`}>{row.label}</span>
							<span class="where">{doc.place === "local" ? shortDir(doc.dir, home) : `${doc.repo} · ${doc.branch}`}</span>
							{/* Models with no price per request (a subscription's, such as lunaroute's) always read $0.00, which
							    says nothing; the spend shows once a model has charged something. */}
							{spent > 0 ? (
								<span class={`spend ${spendTone(spent, doc.cap)}`}>
									{formatDollars(spent)}
									{doc.cap === undefined ? "" : ` of ${formatDollars(doc.cap)}`}
								</span>
							) : null}
						</p>
					</div>
					{/* A local session works in place, with no branch to compare: there is no diff to view. */}
					{doc.place === "repo" ? (
						<button type="button" class="icon-button" aria-label="View changes" disabled={doc.setup.status !== "ready"} onClick={() => setDiff(true)}>
							<Icon name="diff" />
						</button>
					) : null}
					<AgentsButton doc={doc} open={agentsOpen} onToggle={() => setAgentsOpen((open) => !open)} />
				</header>
			</div>
			<Transcript blocks={blocks} session={doc} running={running} cards={cards} delivery={delivery} />
			<ComposerDock>
				<Banner doc={doc} spent={spent} running={running} onAction={act} />
				<Composer
					draftKey={`session:${props.id}`}
					placeholder={placeholderFor(doc, running)}
					running={running}
					disabled={doc.setup.status !== "ready" || doc.cleanedAt !== undefined}
					focusToken={focus}
					autoFocus
					files={async () => (await api.sessionFiles(props.id)).files}
					skills={() => api.sessionSkills(props.id)}
					onSend={async (text, attachments, requestId) => {
						pinToEnd();
						await api.send(props.id, requestId, text, attachments);
					}}
					onStop={async () => {
						try {
							await api.stop(props.id);
						} catch (error) {
							showToast({ message: describeFailure(error).message });
						}
					}}
				/>
			</ComposerDock>
			{diff ? <DiffSheet session={props.id} onClose={() => setDiff(false)} /> : null}
			{agentsOpen ? <AgentsPanel doc={doc} onClose={() => setAgentsOpen(false)} /> : null}
		</div>
	);
}
