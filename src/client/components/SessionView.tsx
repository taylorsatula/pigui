// One session: a quiet header with status, progress and spend, any problem with its next step, the transcript, and the
// composer, whose placeholder says what sending will do right now.
import type { LiveState, UsageState } from "@earendil-works/pi-durable";
import type { JSX } from "preact";
import { useCallback, useMemo, useState } from "preact/hooks";
import { type SessionDoc, sessionRow } from "../../shared/session.ts";
import { formatDollars, spentOf } from "../../shared/spend.ts";
import { api, describeFailure } from "../api.ts";
import { navigate, showToast, useStore } from "../store.ts";
import { buildBlocks } from "../transcript.ts";
import type { CardActions, DeliveryActions } from "./Cards.tsx";
import { Composer } from "./Composer.tsx";
import { DiffSheet } from "./Diff.tsx";
import { DrawerButton } from "./Drawer.tsx";
import { Icon } from "./Icons.tsx";
import { Transcript } from "./Transcript.tsx";

function placeholderFor(doc: SessionDoc, running: boolean): string {
	if (doc.setup.status === "preparing") return "Setting up the workspace…";
	if (doc.card?.kind === "questions") return "Answer in your own words…";
	if (doc.card?.kind === "plan") return "Ask for changes to the plan…";
	if (running) return "Steer Pi while it works…";
	if (doc.outcome?.kind === "budget") return "Raise the budget to continue…";
	if (doc.report !== undefined && doc.workflow === "reported") return "Ask for more changes…";
	return "Message Pi…";
}

const FAILURES: Record<string, string> = {
	model_error: "The model returned an error",
	no_model: "No model is available on the server",
	turn_limit: "The run reached its turn limit",
	interrupted: "The server kept stopping while the model answered",
	restart_limit: "The run kept crashing the server",
	nothing_to_answer: "There was nothing to continue",
};

function Banner(props: { doc: SessionDoc; spent: number; running: boolean; onAction: (work: () => Promise<unknown>) => void }): JSX.Element | null {
	const { doc } = props;
	if (doc.setup.status === "failed") {
		return (
			<div class="banner error" role="alert">
				<p>
					<strong>Setup failed.</strong> {doc.setup.error}
				</p>
				<button type="button" class="primary small" onClick={() => props.onAction(() => api.retrySetup(doc.id))}>
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
						<strong>{FAILURES[doc.outcome.reason] ?? "The run stopped"}.</strong> {doc.outcome.detail ?? ""}
					</p>
					<button type="button" class="primary small" onClick={() => props.onAction(() => api.continue(doc.id))}>
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
					<button type="button" class="primary small" onClick={() => props.onAction(() => api.budget(doc.id, raised))}>
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
					<button type="button" class="primary small" onClick={() => props.onAction(() => api.continue(doc.id))}>
						Continue
					</button>
				</div>
			);
		case "stopped":
			return (
				<div class="banner" role="status">
					<p>Stopped.</p>
					<button type="button" class="secondary small" onClick={() => props.onAction(() => api.continue(doc.id))}>
						Continue
					</button>
				</div>
			);
		case "replied":
		case "reported":
			return null;
	}
}

export function SessionView(props: { id: number }): JSX.Element {
	const session = useStore((state) => state.session);
	const view = useStore((state) => state.view);
	const missing = useStore((state) => state.missing);
	const [focus, setFocus] = useState(0);
	const [diff, setDiff] = useState(false);
	const doc = session?.id === props.id ? session : undefined;
	const blocks = useMemo(() => buildBlocks(view, doc), [view, doc]);
	const live = view?.docs["pi.live"] as LiveState | undefined;
	const running = live?.run !== undefined || doc?.activeRun !== undefined;
	const spent = spentOf(view?.docs["pi.usage"] as UsageState | undefined);

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

	const archive = () =>
		act(async () => {
			await api.archive(props.id, true);
			navigate({ kind: "new" });
			showToast({
				message: "Session archived.",
				action: {
					label: "Undo",
					run: () => {
						void api.archive(props.id, false).then(() => navigate({ kind: "session", id: props.id }));
					},
				},
			});
		});

	if (missing) {
		return (
			<div class="session">
				<header class="topbar">
					<DrawerButton />
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
					<DrawerButton />
					<h1 class="title">Loading…</h1>
				</header>
			</div>
		);
	}
	const row = sessionRow(doc);
	const progress = doc.plan?.approved === true ? { done: doc.plan.done.length, total: doc.plan.steps.length } : undefined;
	return (
		<div class="session">
			<header class="topbar">
				<DrawerButton />
				<div class="title-block">
					<h1 class="title">{doc.title}</h1>
					<p class="subtitle">
						<span>{doc.repo}</span>
						<span class="branch">
							<Icon name="branch" size={14} /> {doc.branch}
						</span>
					</p>
				</div>
				<button type="button" class="icon-button" aria-label="View changes" disabled={doc.setup.status !== "ready"} onClick={() => setDiff(true)}>
					<span class="diff-icon" aria-hidden="true">±</span>
				</button>
				<button type="button" class="icon-button" aria-label="Archive session" onClick={archive}>
					<Icon name="archive" />
				</button>
			</header>
			<div class="status-line" role="status">
				<span class={`status-pill ${row.group}`}>{row.label}</span>
				{progress === undefined ? null : (
					<span class="progress" aria-label={`${progress.done} of ${progress.total} steps done`}>
						<span class="progress-bar" style={{ width: `${(100 * progress.done) / Math.max(1, progress.total)}%` }} />
					</span>
				)}
				<span class="spend">
					{formatDollars(spent)}
					{doc.cap === undefined ? "" : ` of ${formatDollars(doc.cap)}`}
				</span>
			</div>
			<Banner doc={doc} spent={spent} running={running} onAction={act} />
			<Transcript blocks={blocks} session={doc} running={running} cards={cards} delivery={delivery} />
			<div class="composer-dock">
				<Composer
					draftKey={`session:${props.id}`}
					placeholder={placeholderFor(doc, running)}
					running={running}
					disabled={doc.setup.status !== "ready" || doc.cleanedAt !== undefined}
					focusToken={focus}
					files={async () => (await api.sessionFiles(props.id)).files}
					skills={() => api.sessionSkills(props.id)}
					onSend={async (text, attachments, requestId) => {
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
			</div>
			{diff ? <DiffSheet session={props.id} onClose={() => setDiff(false)} /> : null}
		</div>
	);
}
