// Composable server-side HTML renderers for every transcript block, card, tool call, unified diff patch, and structured
// agent report. Every rendered block carries a stable data-block-key for surgical SSE updates without full redraws.
import type { SpeechKind } from "../../../shared/api.ts";
import {
	planOf,
	type AgentResultData,
	type CardAnswer,
	type MessageEntryData,
	type Plan,
	type PlanCard,
	type QuestionCard,
	type Report,
	type ReportMemory,
	type SessionDoc,
} from "../../../shared/session.ts";
import {
	CHECK_ICON,
	describeCall,
	describeGroup,
	grading,
	initialSelection,
	OUTCOME,
	planProse,
	reportProse,
	dayHeading,
	sameDay,
} from "../format.ts";
import { classes, type Html, html, joinHtml } from "../html.ts";
import { icon } from "../icons.ts";
import { renderInline, renderMarkdown } from "../markdown.ts";
import type { Block, CallView, WorkItem } from "../transcript.ts";

export type BlockRenderContext = {
	session?: SessionDoc;
	running: boolean;
	speech: boolean;
};

const TAIL_LINES = 4;
const PREVIEW_LINES = 3;
const REPORT_LABEL = /^([A-Z][A-Z0-9][A-Z0-9 ._/&()-]{0,40}):[ \t]*(.*)$/;

function renderInlineSpan(text: string, extraClass = ""): Html {
	return html`<span class="${classes("inline", extraClass)}">${renderInline(text)}</span>`;
}

function renderMarkdownDiv(text: string, extraClass = ""): Html {
	return html`<div class="${classes("markdown", extraClass)}">${renderMarkdown(text)}</div>`;
}

function renderCursor(): Html {
	return html`<span class="cursor" role="img" aria-label="running"></span>`;
}

export function renderPatch(text: string): Html {
	const lines = text.replace(/\n$/, "").split("\n");
	return html`<pre class="patch"><code>${lines.map((line) => {
		const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : "";
		return cls === "" ? html`<span>${line}${"\n"}</span>` : html`<span class="${cls}">${line}${"\n"}</span>`;
	})}</code></pre>`;
}

function renderPaths(paths: readonly string[]): Html {
	if (paths.length === 0) return html``;
	return html`<span class="paths">${paths.join("  ")}</span>`;
}

function renderPart(title: string, count: number, content: Html): Html {
	if (count <= 0) return html``;
	return html`<section class="part" aria-label="${title}"><h4 class="part-title">${title}</h4>${content}</section>`;
}

function renderLines(lines: readonly string[], caution = false): Html {
	return html`<ul class="${classes("items dashed", caution && "caution")}">
		${lines.map((line) => html`<li>${renderInlineSpan(line)}</li>`)}
	</ul>`;
}

function renderReportBody(text: string, extraClass = ""): Html {
	const sections: Array<{ label?: string; body: string }> = [];
	let current: { label?: string; body: string } = { body: "" };
	for (const line of text.split("\n")) {
		const match = REPORT_LABEL.exec(line);
		if (match) {
			if (current.label !== undefined || current.body.trim() !== "") sections.push(current);
			current = { label: match[1] ?? "", body: match[2] ?? "" };
			continue;
		}
		current.body += (current.body === "" ? "" : "\n") + line;
	}
	sections.push(current);
	const labelled = sections.filter((section) => section.label !== undefined);
	if (labelled.length < 2) return renderMarkdownDiv(text, extraClass);
	return html`<div class="${classes("report", extraClass)}">
		${sections.map((section) => {
			if (section.label !== undefined) {
				const trimmed = section.body.trim();
				return html`<div class="report-section">
					<div class="report-label">${section.label}</div>
					${trimmed !== "" ? renderMarkdownDiv(trimmed) : html``}
				</div>`;
			}
			const trimmed = section.body.trim();
			return trimmed !== "" ? renderMarkdownDiv(trimmed) : html``;
		})}
	</div>`;
}

function renderSpeakButton(id: string, sessionId: number | undefined, markdown: string, speech: boolean, kind: SpeechKind = "reply"): Html {
	if (!speech || sessionId === undefined) return html``;
	return html`<button
		type="button"
		class="icon-button speak idle"
		aria-label="Read aloud"
		data-action="speak"
		data-speak-id="${id}"
		data-speak-session="${sessionId}"
		data-speak-kind="${kind}"
		data-speak-text="${markdown}"
	>${icon("speaker", 20)}</button>`;
}

function renderPerson(data: MessageEntryData): Html {
	const hasChips = data.references.length + data.attachments.length > 0;
	return html`<p class="said">${data.text}</p>${
		hasChips
			? html`<div class="context-chips" aria-label="Added to the message">
					${data.references.map(
						(reference) =>
							html`<span class="chip" title="${reference.note ?? ""}">${reference.kind === "file" ? "@" : "#"}${reference.value}${reference.status === "pointer" ? ` (${reference.note ?? "pointer"})` : ""}</span>`,
					)}
					${data.attachments.map((attachment) => html`<span class="chip">${icon("clip", 14)} ${attachment.name}</span>`)}
				</div>`
			: html``
	}`;
}

function renderQueued(data: MessageEntryData, sessionId: number | undefined, submission: number): Html {
	return html`${renderPerson(data)}<div class="queued-row">
		<span class="queued-note">Queued — Pi will read this when its current step ends</span>
		${
			sessionId !== undefined
				? html`<button type="button" class="link queued-cancel" data-action="cancel-queued" data-session="${sessionId}" data-submission="${submission}">Cancel</button>`
				: html``
		}
	</div>`;
}

function renderAgentResult(data: AgentResultData): Html {
	const preview = data.text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.slice(0, PREVIEW_LINES)
		.join("\n");
	return html`<details class="${classes("agent-result", data.status)}">
		<summary>
			<span class="agent-result-head">
				${icon("chevron", 14)}
				<span class="agent-type">${data.type}</span>
				<span class="agent-description">${data.description}</span>
				<span class="agent-ended">${data.status === "done" ? "answered" : "failed"}</span>
			</span>
			<span class="agent-preview">${preview}</span>
		</summary>
		${renderReportBody(data.text, "agent")}
	</details>`;
}

function tail(output: string | undefined): { lines: string; earlier: number } {
	const all = (output ?? "").trimEnd().split("\n");
	if (all.length === 1 && all[0] === "") return { lines: "", earlier: 0 };
	return { lines: all.slice(-TAIL_LINES).join("\n"), earlier: Math.max(0, all.length - TAIL_LINES) };
}

function renderCallDetail(call: CallView, live: boolean): Html {
	const isBash = call.name === "bash";
	const isAgent = call.name === "Agent";
	const isEdit = call.name === "edit" && call.diff !== undefined;
	const isWrite = call.name === "write" && typeof call.args.content === "string";
	const input = isBash ? String(call.args.command ?? "") : JSON.stringify(call.args, null, 2);
	const shown = live && (isBash || call.status === "failed") ? tail(call.output) : { lines: "", earlier: 0 };

	const detail = html`<details id="call-${call.id}" class="${classes("call", call.status)}">
		<summary>
			${!live ? icon("chevron", 14) : html``}
			${
				live && isBash
					? html`<span class="call-command"><span class="prompt">$ </span>${input}</span>`
					: html`<span class="call-summary">${describeCall(call.name, call.args)}</span>`
			}
			${call.status === "failed" ? html`<span class="failed-tag">failed</span>` : html``}
			${call.status === "running" ? renderCursor() : html``}
		</summary>
		<div class="call-body">
			${
				isAgent
					? html`<div class="io-label">Prompt</div>${renderMarkdownDiv(String(call.args.prompt ?? ""), "prompt-prose")}`
					: isEdit
						? html`<div class="io-label">Change</div>${renderPatch(call.diff ?? "")}`
						: isWrite
							? html`<div class="io-label">File</div><pre class="io file-content">${String(call.args.content)}</pre>`
							: isBash
								? html`<div class="io-label">Input</div><pre class="io">${input}</pre>`
								: html``
			}
			${
				call.output !== undefined
					? html`<div class="io-label">${isAgent ? "Answer" : "Output"}</div>${
							isAgent ? renderReportBody(call.output) : html`<pre class="io">${call.output === "" ? "(no output)" : call.output}</pre>`
						}`
					: html``
			}
			${
				!isBash
					? html`<details id="call-raw-${call.id}" class="raw"><summary>Raw input</summary><pre class="io">${input}</pre></details>`
					: html``
			}
		</div>
	</details>`;

	if (!live) return detail;
	return html`<div class="${classes("live-call", call.status)}">
		${detail}
		${
			shown.lines !== ""
				? html`<pre class="tail">${shown.earlier > 0 ? html`<span class="earlier">… ${shown.earlier} earlier line${shown.earlier === 1 ? "" : "s"}${"\n"}</span>` : html``}${shown.lines}</pre>`
				: html``
		}
	</div>`;
}

function renderWork(items: readonly WorkItem[], live: boolean): Html {
	if (live) {
		return html`<div class="work live">
			${items.map((item) =>
				item.kind === "thinking"
					? html`<p class="thought">${item.text}${item.streaming ? renderCursor() : html``}</p>`
					: renderCallDetail(item.call, true),
			)}
		</div>`;
	}
	const calls = items.flatMap((item) => (item.kind === "call" ? [item.call] : []));
	const failed = calls.filter((call) => call.status === "failed").length;
	return html`<details class="work">
		<summary>
			${icon("chevron", 14)}
			<span class="work-summary">${calls.length > 0 ? describeGroup(calls.map((call) => call.name)) : "Thought"}</span>
			${failed > 0 ? html`<span class="failed-tag">${failed} failed</span>` : html``}
		</summary>
		<div class="timeline">
			${items.map((item) =>
				item.kind === "thinking" ? html`<p class="thought">${item.text}</p>` : renderCallDetail(item.call, false),
			)}
		</div>
	</details>`;
}

function renderQuestionsCard(card: QuestionCard, answer: CardAnswer | undefined, pending: boolean, sessionId: number | undefined): Html {
	const defaults = pending ? initialSelection(card) : {};
	const chosenFor = (questionId: string): string[] => {
		if (pending) return defaults[questionId] ?? [];
		if (answer?.kind !== "questions") return [];
		return answer.answers.find((item) => item.questionId === questionId)?.selected ?? [];
	};

	return html`<section
		class="${classes("card questions", pending && "waiting")}"
		aria-label="${pending ? "Questions waiting for your answer" : "Answered questions"}"
		data-card-kind="questions"
		data-card-id="${card.id}"
		data-session="${sessionId ?? ""}"
	>
		<header class="card-title">
			${pending ? html`<span class="mark">${card.questions.length > 1 ? `${card.questions.length} questions for you` : "A question for you"}</span>` : "Questions"}
		</header>
		<form data-questions-form="${card.id}">
			${card.questions.map((question) => {
				const name = `${card.id}-${question.id}`;
				const chosen = chosenFor(question.id);
				const given = answer?.kind === "questions" ? answer.answers.find((item) => item.questionId === question.id)?.text : undefined;
				return html`<fieldset class="question" data-question-id="${question.id}" data-multiple="${question.multiple ? "true" : "false"}"${!pending ? html` disabled` : html``}>
					<legend>${question.prompt}</legend>
					${question.options.map((option) => {
						const isChosen = chosen.includes(option.id);
						return html`<label class="${classes("option", isChosen && "chosen")}">
							<input type="${question.multiple ? "checkbox" : "radio"}" name="${name}" value="${option.id}"${isChosen ? html` checked` : html``} />
							<span class="option-text">
								<span class="option-label">
									${option.label}
									${option.id === question.recommended ? html`<span class="recommended">Recommended</span>` : html``}
								</span>
								${option.description !== undefined ? html`<span class="option-description">${option.description}</span>` : html``}
							</span>
						</label>`;
					})}
					${
						pending
							? html`<button type="button" class="link" data-action="show-freeform" data-question-id="${question.id}">Answer in your own words</button>
								<textarea
									class="note"
									rows="2"
									placeholder="Your own answer"
									aria-label="Your own answer to: ${question.prompt}"
									data-freeform-for="${question.id}"
									hidden
								></textarea>`
							: given !== undefined
								? html`<p class="given">“${given}”</p>`
								: html``
					}
				</fieldset>`;
			})}
			${answer?.kind === "text" ? html`<p class="given">You replied: “${answer.text}”</p>` : html``}
			${
				pending
					? html`<div class="card-actions"><button type="submit" class="primary">Send answers</button></div>`
					: html``
			}
		</form>
	</section>`;
}

function renderEndState(plan: Plan): Html {
	return renderPart(
		"Done when",
		plan.endState.length,
		html`<ul class="items targets">
			${plan.endState.map(
				(condition) => html`<li><span class="marker" aria-hidden="true"><span class="ring"></span></span>${renderInlineSpan(condition)}</li>`,
			)}
		</ul>`,
	);
}

function renderDecisions(plan: Plan): Html {
	return renderPart(
		"Decided for you",
		plan.decisions.length,
		html`<ul class="items decisions">
			${plan.decisions.map(
				(decision) => html`<li>${renderInlineSpan(decision.choice, "item-main")}${renderInlineSpan(decision.reason, "item-detail")}</li>`,
			)}
		</ul>`,
	);
}

function renderSteps(plan: Plan, done: readonly string[], working: boolean): Html {
	const current = working ? plan.steps.find((step) => !done.includes(step.id))?.id : undefined;
	return renderPart(
		"Steps",
		plan.steps.length,
		html`<ol class="steps">
			${plan.steps.map((step, index) => {
				const isDone = done.includes(step.id);
				const isCurrent = step.id === current;
				return html`<li class="${classes(isDone && "done", isCurrent && "current")}"${isCurrent ? html` aria-current="step"` : html``}>
					<span class="box">${isDone ? icon("check", 14, `Step ${index + 1}, done`) : String(index + 1)}</span>
					<span class="item-text">${renderInlineSpan(step.text)}${renderPaths(step.files)}</span>
				</li>`;
			})}
		</ol>`,
	);
}

function renderPlanRest(plan: Plan): Html {
	return joinHtml([
		renderPart(
			"Verified by",
			plan.verification.length,
			html`<ul class="items dashed commands">${plan.verification.map((cmd) => html`<li>${renderInlineSpan(cmd)}</li>`)}</ul>`,
		),
		renderPart("Not doing", plan.outOfScope.length, renderLines(plan.outOfScope)),
		renderPart("Risks", plan.risks.length, renderLines(plan.risks, true)),
		plan.citations.length > 0
			? html`<details class="part sources">
					<summary>${icon("chevron", 14)}${plan.citations.length === 1 ? "1 source" : `${plan.citations.length} sources`} read for this plan</summary>
					<ul class="items">
						${plan.citations.map(
							(citation) =>
								html`<li><span class="item-text"><span class="paths ref">${citation.ref}</span>${renderInlineSpan(citation.note, "item-detail")}</span></li>`,
						)}
					</ul>
				</details>`
			: html``,
	]);
}

function renderPlanCard(card: PlanCard, answer: CardAnswer | undefined, pending: boolean, ctx: BlockRenderContext): Html {
	const plan = planOf(card.plan);
	const working = ctx.running && ctx.session?.card === undefined;
	const done = ctx.session?.plan?.revision === card.revision && ctx.session.plan.approved ? ctx.session.plan.done : [];
	const status =
		answer?.kind === "approve"
			? "Approved"
			: answer?.kind === "revise" || answer?.kind === "text"
				? "Changes requested"
				: pending
					? "Waiting for your approval"
					: undefined;
	const feedback = answer?.kind === "revise" ? answer.feedback : answer?.kind === "text" ? answer.text : undefined;

	return html`<section class="${classes("card plan", pending && "waiting")}" aria-label="Plan: ${plan.title}" data-card-kind="plan" data-card-id="${card.id}">
		<header class="card-title">
			<span>Plan${card.revision > 1 ? `, revision ${card.revision}` : ""}</span>
			${status !== undefined ? html`<span class="${classes("verdict", answer?.kind === "approve" ? "good" : pending ? "mark" : "warn")}">${status}</span>` : html``}
			${renderSpeakButton(`plan:${card.id}`, ctx.session?.id, planProse(card.plan), ctx.speech, "plan")}
		</header>
		<h3>${plan.title}</h3>
		<p class="goal">${renderInlineSpan(plan.goal)}</p>
		${
			pending
				? joinHtml([renderEndState(plan), renderDecisions(plan), renderSteps(plan, done, false), renderPlanRest(plan)])
				: joinHtml([
						renderSteps(plan, done, working),
						html`<details class="part more">
							<summary>${icon("chevron", 14)}The rest of the plan</summary>
							${renderEndState(plan)}${renderDecisions(plan)}${renderPlanRest(plan)}
						</details>`,
					])
		}
		${feedback !== undefined ? html`<p class="given">You asked: “${feedback}”</p>` : html``}
		${
			pending && ctx.session !== undefined
				? html`<div class="card-actions">
						<button type="button" class="primary" data-action="approve-plan" data-session="${ctx.session.id}" data-card-id="${card.id}">Approve</button>
						<button type="button" class="secondary" data-action="focus-composer">Request changes</button>
					</div>`
				: html``
		}
	</section>`;
}

function renderRemembered(memory: ReportMemory): Html {
	const graded = grading(memory);
	const written = [...memory.created.map((item) => ({ ...item, edited: false })), ...memory.edited.map((item) => ({ ...item, edited: true }))];
	return renderPart(
		"Remembered",
		written.length + (graded === "" ? 0 : 1),
		joinHtml([
			written.length > 0
				? html`<ul class="items dashed">
						${written.map(
							(item) =>
								html`<li><span class="item-text">${renderInlineSpan(item.text)}${item.edited ? html`<span class="item-detail">Corrected</span>` : html``}</span></li>`,
						)}
					</ul>`
				: html``,
			graded !== "" ? html`<p class="item-detail grading">${graded}</p>` : html``,
		]),
	);
}

function renderReportCard(report: Report, latest: boolean, ctx: BlockRenderContext): Html {
	const local = ctx.session?.place === "local";
	const delivery = ctx.session?.place === "repo" ? ctx.session.delivery : undefined;
	const pushed = report.commit !== undefined && delivery?.pushed?.commit === report.commit;
	const outcome = OUTCOME[report.outcome];

	return html`<section class="card report" aria-label="Report">
		<header class="card-title">
			<span>Report</span>
			${report.commit !== undefined ? html`<span class="commit">${report.commit.slice(0, 7)}</span>` : html``}
			<span class="${classes("verdict", outcome.tone)}">${outcome.label}</span>
			${pushed ? html`<span class="verdict good">Pushed</span>` : html``}
			${renderSpeakButton(`report:${report.commit ?? "local"}:${report.filedAt}`, ctx.session?.id, reportProse(report), ctx.speech, "reply")}
		</header>
		<p class="lede">${renderInlineSpan(report.headline)}</p>
		${report.summary !== "" ? renderMarkdownDiv(report.summary) : html``}
		${renderPart(
			"Done when",
			report.endState.length,
			html`<ul class="items results">
				${report.endState.map(
					(check) => html`<li class="${check.met ? "met" : "unmet"}">
						<span class="marker">${icon(check.met ? "check" : "close", 16, check.met ? "Met" : "Not met")}</span>
						<span class="item-text">${renderInlineSpan(check.criterion)}${renderInlineSpan(check.evidence, "item-detail")}</span>
					</li>`,
				)}
			</ul>`,
		)}
		${renderPart(
			"Changes",
			report.changes.length,
			html`<ul class="items dashed">
				${report.changes.map(
					(change) => html`<li><span class="item-text">${renderInlineSpan(change.change)}${renderPaths(change.files)}</span></li>`,
				)}
			</ul>`,
		)}
		${renderPart(
			"Checks",
			report.checks.length,
			html`<ul class="items results">
				${report.checks.map(
					(check) => html`<li class="${check.result === "passed" ? "met" : check.result === "failed" ? "unmet" : "skipped"}">
						<span class="marker">${icon(CHECK_ICON[check.result], 16, check.result === "not run" ? "Not run" : check.result === "passed" ? "Passed" : "Failed")}</span>
						<span class="item-text">
							<span class="paths command">${check.command}</span>
							${check.detail !== "" ? renderInlineSpan(check.detail, "item-detail") : html``}
						</span>
					</li>`,
				)}
			</ul>`,
		)}
		${renderPart("Changed from the plan", report.deviations.length, renderLines(report.deviations, true))}
		${renderPart("Notes", report.notes.length, renderLines(report.notes))}
		${report.memory !== undefined ? renderRemembered(report.memory) : html``}
		${
			report.learned.trim() !== ""
				? html`<details class="part more">
						<summary>${icon("chevron", 14)}${local ? "What Pi learned about this computer" : "What Pi learned about this repository"}</summary>
						${renderMarkdownDiv(report.learned)}
					</details>`
				: html``
		}
		${
			latest && local
				? html`<div class="card-actions"><button type="button" class="link wide" data-action="focus-composer">Keep working</button></div>`
				: latest && ctx.session !== undefined
					? html`<div class="card-actions">
							${
								delivery?.pr === undefined
									? html`<button type="button" class="primary wide deliver" data-action="deliver" data-deliver="pr" data-session="${ctx.session.id}"${ctx.running ? html` disabled` : html``}>Open pull request</button>
										<button type="button" class="secondary" data-action="open-diff" data-session="${ctx.session.id}">View changes</button>
										<button type="button" class="secondary deliver" data-action="deliver" data-deliver="push" data-session="${ctx.session.id}"${ctx.running ? html` disabled` : html``}>${pushed ? "Push again" : "Push branch"}</button>`
									: pushed
										? html`<a class="button primary wide deliver" href="${delivery.pr.url}" target="_blank" rel="noopener noreferrer">View PR #${delivery.pr.number}</a>
											<button type="button" class="secondary" data-action="open-diff" data-session="${ctx.session.id}">View changes</button>`
										: html`<button type="button" class="primary wide deliver" data-action="deliver" data-deliver="pr" data-session="${ctx.session.id}"${ctx.running ? html` disabled` : html``}>Update PR #${delivery.pr.number}</button>
											<button type="button" class="secondary" data-action="open-diff" data-session="${ctx.session.id}">View changes</button>
											<a class="button secondary deliver" href="${delivery.pr.url}" target="_blank" rel="noopener noreferrer">View PR #${delivery.pr.number}</a>`
							}
							<button type="button" class="link wide" data-action="focus-composer">Keep working</button>
						</div>`
					: html``
		}
		${latest && delivery?.error !== undefined ? html`<p class="error-text" role="alert">${delivery.error.message}</p>` : html``}
	</section>`;
}

export function renderBlockInner(block: Block, ctx: BlockRenderContext): Html {
	switch (block.kind) {
		case "earlier":
			return html`<button type="button" class="link" data-action="load-earlier" data-before="${block.before}">Load earlier messages</button>`;
		case "person":
			return renderPerson(block.data);
		case "queued":
			return renderQueued(block.data, ctx.session?.id, block.submission);
		case "nudge":
			return html`<p class="system-note">Continuing automatically (${block.data.attempt} of ${block.data.limit}): no report yet.</p>`;
		case "agent-result":
			return renderAgentResult(block.data);
		case "agent-stopped":
			return html`<p class="system-note">Agent ${block.data.type} (${block.data.description}) was stopped.</p>`;
		case "text":
			return renderMarkdownDiv(block.text, classes("agent", block.streaming && "streaming"));
		case "speak":
			return renderSpeakButton(block.key, ctx.session?.id, block.text, ctx.speech, "reply");
		case "work":
			return renderWork(block.items, block.live);
		case "questions":
			return ctx.session !== undefined ? renderQuestionsCard(block.card, block.answer, block.pending, ctx.session.id) : html``;
		case "plan":
			return ctx.session !== undefined ? renderPlanCard(block.card, block.answer, block.pending, ctx) : html``;
		case "report":
			return ctx.session !== undefined ? renderReportCard(block.report, block.latest, ctx) : html``;
		case "compaction":
			return html`<details class="compaction">
				<summary>
					${icon("chevron", 14)}
					Context compacted · ${block.retained === undefined ? "see what was carried forward" : `kept ${block.retained} message${block.retained === 1 ? "" : "s"}`}
				</summary>
				${renderMarkdownDiv(block.summary)}
			</details>`;
		case "notice":
			return html`<p class="${classes("system-note", block.tone)}">${block.text}</p>`;
	}
}

export function renderBlock(block: Block, ctx: BlockRenderContext, historical = false): Html {
	const inner = renderBlockInner(block, ctx);
	return html`<div class="${classes("entry", `is-${block.kind}`)}" data-block-key="${block.key}" data-block-kind="${block.kind}"${block.at !== undefined ? html` data-at="${block.at}"` : html``}${historical ? html` data-historical="true"` : html``}>${inner}</div>`;
}

export function renderDayHeading(forKey: string, at: number): Html {
	return html`<h2 class="day" data-day-for="${forKey}" data-at="${at}">${dayHeading(at)}</h2>`;
}

export function renderTranscriptRows(blocks: readonly Block[], ctx: BlockRenderContext, historical = false): Html {
	const out: Html[] = [];
	let day: number | undefined;
	for (const block of blocks) {
		if (block.at !== undefined) {
			if (day !== undefined && !sameDay(day, block.at)) out.push(renderDayHeading(block.key, block.at));
			day = block.at;
		}
		out.push(renderBlock(block, ctx, historical));
	}
	return joinHtml(out);
}
