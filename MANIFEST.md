# PiGUI — functional manifest

An exhaustive inventory of what the application **does**, produced by a full inspection of the reference
implementation. The reference is `origin/claude/kind-fermat-2nkpv5` @ `652293b` ("feat(subagents): load agents and
skills from the Pi CLI's own directories", 2026-11-23), held locally as branch `scratch/kind-fermat-2nkpv5` and as a
disposable worktree at `/tmp/pigui-reference` during the inspection. Nothing in the working tree was built from or
copied from that code; this document is the specification for the reimplementation.

Method: seven scoped read-only passes (server HTTP shell; agent subsystem; memory/speech/subagents/sandbox;
sessions/git/delivery/notify/live; client PWA; shared/SW/fake mode; tests/deploy), plus a full read of README.md,
DECISIONS.md, AGENTS.md, package.json, .env.example, index.html and the shared modules. Where the passes disagreed
or a fact mattered, it was re-checked against the tree. Facts carry `file:line` references into the reference tree.

What this is: a list of behaviors and surfaces the reimplementation must reproduce shot-for-shot — every feature,
screen, route, tool, document, notification, error path and rendering rule. What this is not: a design proposal.
Sequencing and architecture choices for the rewrite come later.

---

## 1. What PiGUI is

A self-hosted harness for the Pi coding agent, driven from any browser (phone-first PWA), for long-horizon,
zero-shot work. One person, one server. The primary flow:

> pick a repository → describe the task → answer the questions → approve the plan → the agent works → report → push or PR

Deliberately small: no plugin system, no settings screen, no theme engine, no model picker, no multi-repo sessions,
no multiplayer, no voice input, no file browser, no CI watching, no scheduled tasks, no design tools, no self-editing.
Every feature serves the loop above. Desktop and mobile are the same app; only layout and pointer density differ
(wide screens get persistent columns and larger pointer targets; phones get 44 pt touch targets).

Optional, first-class features beyond the loop: long-term memory across sessions, reading replies aloud (Kokoro TTS),
out-of-the-box subagents (scout/implementer/verifier/thought-partner), and OnPrem mode (run as the person on their
own computer with full access). Deployment paths: Docker (Tailscale sidecar), a systemd installer for servers, or
the OnPrem installer.

## 2. Architecture at a glance

- **One process, one process image.** The server (`src/server`) runs TypeScript directly on Node ≥ 22.19 (type
  stripping, no server build). It opens one Pi Durable `Harness` over one SQLite file (`pigui.sqlite`) and serves
  HTTP from the same process. A session is an ownerless Durable **conversation**; several run at once.
- **Module boundaries.** `src/shared` — every shape both sides use (API schemas, documents, live protocol,
  reference syntax, spend, wav). `src/server/agent` — everything pigui adds to Pi (tools, prompt, budget,
  compaction/handoff); knows nothing of HTTP. `sessions.ts` — session lifecycle and every action the person takes.
  `supervisor.ts` — what happens when a run ends. `delivery.ts` — push/PR/diff. `notify.ts`/`webpush.ts` — push
  notifications. `maintenance.ts` — cleanup and backups. `http.ts` — HTTP boundary only. `app.ts` — composition.
  Talks through small typed interfaces (`AgentServices`, `SessionsDeps`, `RepoHost`, `PushSender`).
- **Pi Durable owns the agent loop** (persistence, retries, compaction, crash recovery, live views). Pi owns models
  and credentials. picloud/pigui contains no provider code. GitHub access goes through `gh` and `git` shell-outs.
- **Everything pigui remembers is a Durable document** committed with the agent's own state; the drawer,
  notifications and maintenance read only these documents. No second store.
- **Client:** Preact + `marked` + `DOMPurify`, esbuild (no heavier toolchain). Serif/sans/mono three-face system.

## 3. Sessions and workspaces (A4.1)

### 3.1 Creation
- `POST /api/sessions` with `CreateSessionBody` (`shared/api.ts:18`): either `{place:"repo", repo:"owner/name",
  start:{kind:"new",base} | {kind:"continue",branch}}` or `{place:"local", dir}` (OnPrem only), plus `requestId`,
  `text` (the task), `attachments[]`.
- Creation dedupes by `requestId` recorded in `pigui.index.created` (sessions.ts:258–303); a retry returns the
  same session; `{id}` is returned.
- A fresh `SessionDoc` is committed with `setup: {status:"preparing", step:"clone"|"start"}` and a Durable
  background task `pigui.setup` (v1) is created for the new conversation.

### 3.2 Setup (clone → branch → start)
- Durable task `pigui.setup` with checkpoint `{phase}`; phases in order: `clone` → `branch` → `start`
  (sessions.ts:94-107, 194-205).
- **clone**: `git clone --branch <ref>` into `<dir>.cloning`, then renamed into place (`git.ts:29-34`). `ref` is
  `start.base` (new branch) or `start.branch` (continue). Skipped when the directory is already a repository
  (re-entrant; survives a restart mid-setup, `sessions.ts:136-148`).
- **branch**: reuse `switch --quiet <branch>` if it exists, else `switch -c`; new branches are named
  `pi/<slug>-<id>`; continue keeps the chosen branch (`sessions.ts:68-75, 148-151, 252`).
- **start**: workspace gets git identity (`Pi <pi@pigui.invalid>`), `/.pigui/` appended to `.git/info/exclude`,
  `startCommit = head()` recorded, then the first message is submitted with fixed requestId `pigui:task`
  (`sessions.ts:152-165, 179`).
- Setup failure records `setup: {status:"failed", step, error}` and `attentionAt`; recovery is manual via
  `POST /:id/retry-setup`, which only acts on failed setups (`sessions.ts:314-325`).
- A shutdown during setup re-throws rather than failing the step (`sessions.ts:196`), and phases are re-entrant,
  so a crashed setup completes after restart (asserted in `test/restart.test.ts`).

### 3.3 States
`SessionDoc` (`shared/session.ts`) carries: `setup` (preparing|ready|failed → step+error), `workflow`
(`open` | `implementing` | `reported`), `activeRun {submission, startedAt}`, `outcome` (8 kinds, see §6.4),
`continuations`, `archived`, `cleanedAt`, `seenAt`, `attentionAt`, `pendingTask`, `card`, `report`, `plan`,
`words[]`, `notified[]`, `requests[]`, `agents[]`, `handoff`, `memoryShown`, `createdAt`, `updatedAt`, `cap`.

Repository place: `{place:"repo", repo, start, branch, base, startCommit?, delivery}`. Local place (OnPrem):
`{place:"local", dir}`. Sessions stored before local sessions are repo sessions (back-filled at startup).

### 3.4 Concurrency
- Several sessions run at once; each is its own conversation with its own run.
- One commit per person action; retried sends answered from `handledRequest`/`rememberRequest` (memory of the last
  100 request IDs per session, `docs.ts:150-157`).
- Live runs: messages while a run is active are submitted with `whenBusy:"steer", whenIdle:"reject"` (a busy
  continue is `409 Pi is already working`).
- Supervisor serializes per-session reconciles through a promise queue (`supervisor.ts:41, 71-78`).

### 3.5 Repo memory
`pigui.repo-memory` (session-scope, keyed per repo, or `this computer` for local sessions): the `learned` note
from each report, read into every later session's prompt on that repository (`report.ts:137-140`).

## 4. Workspaces and isolation

- Session working directory: `workspaces/<id>` for repo sessions; the chosen absolute directory for local sessions.
- Every session gets a scratch dir `<data>/sandbox/<id>` with `home` (its HOME), `tmp` and `gh`. It is created when
  the environment is built, not at setup, so old sessions get one on their next command; maintenance removes it with
  the workspace.
- Attachments are saved under `.pigui/attachments/` in the workspace (excluded from git via `.git/info/exclude`);
  a local session's attachments are given to the agent by absolute path.
- OnPrem sessions work in place, unconfined, as the person, with their environment (minus `PIGUI_*`).

### 4.1 Landlock sandbox (servers)
- `pigui-sandbox` — a C launcher (<200 lines, `src/sandbox/pigui-sandbox.c`), built by `npm run build` into
  `dist/bin`, restricts itself then execs the command. Grants: read-write the workspace, the scratch dir and
  `/dev`; read+execute `/usr /bin /sbin /lib* /etc /sys`, `/proc` (commands only), the real `/etc/resolv.conf`
  target, the Node prefix, CA files, Pi's and pigui's skills directories, and (fake mode) the stand-in remote.
  From ABI 6 it scopes signals and abstract unix sockets. Real mode refuses to start without a usable launcher;
  `PIGUI_SANDBOX=off` is the way out (`PIGUI_ONPREM` forces it off). Ubuntu 24.04 kernels (ABI 4) print a startup
  warning: commands can signal pigui there.
- The file tools run in pigui's own process, so Landlock cannot apply; `Grants.confine` checks each path by realpath
  against the same grants (refusing symlink escapes) and returns Durable's `permission_denied` FileError. A
  check-then-use race remains and is documented.
- Durable spawns commands with `inheritEnv: false`; the environment is a whitelist: PATH, locale, TZ, TERM, user and
  shell names, proxies and CA files, no-prompt git vars, the session's own `HOME`/`TMPDIR`/`GH_CONFIG_DIR`, and the
  agent's read-only `GH_TOKEN`/`GITHUB_TOKEN`. No other `PIGUI_*` or Pi credential is present.
- pigui's own HTTP API refuses connections from pigui's own user (kernel socket table via `/proc/net/tcp{,6}`,
  `callers.ts`), so an agent command cannot approve its own plan or tap Deliver. Connections that cannot be
  identified are refused. Fake mode disables this. OnPrem inverts it: own user and root allowed, other users refused
  (macOS: no table, no check, documented).
- **Two GitHub tokens.** pigui's own (Contents/PR read-write, Metadata read) is used only in pigui's process when
  the person taps; agent commands get a read-only token. "Nothing reaches GitHub without a tap" holds at the
  credential level. Real mode refuses to start without the agent token.

## 5. The agent environment and workflow (A4.2)

### 5.1 What Pi is told (prompt, `prompt.ts`)
- pigui's own preamble (repo vs local variants), then sections that change rarely: `session` (place, branch, base,
  workflow with plan progress), `repo_memory`, `project_context` (Pi's `loadProjectContextFiles`, rendered as Pi
  renders them), `skills` (Pi's `loadSkills`/`formatSkillsForPrompt`). Durable re-sends only changed sections.
- Key rules the preamble carries: a reply without a tool call ends the turn; the reply's opening words are the
  notification; cards are the only way to wait (never sleep or poll); every change ends with `file_report` (the card
  is the only delivery path); which of three paths a request needs (reply / small change + report / plan); explore
  before planning and name the files; search memory once the machinery is known; one card gathers all questions;
  decide the rest yourself and state it in the plan; after approval, run the tests first, work to completion without
  asking, stay in scope, settle open points yourself, no scope creep; prove with project checks, never weaken one;
  git rules (commit as you go, never push/rebase, fetch+merge the base before reporting, no terminal, attachments
  are never committed); the person is usually away.
- Tool descriptions carry only how to fill each field. The report's headline is both notification and PR title.

### 5.2 Tools (8, plus Pi's coding tools and the subagent tools)
From `agent/extension.ts`. One line each; all schemas enforced by pi-schema:

1. `ask_single_choice` — `{questions:[{question, options[2-6]{label,description?}, recommended}]}`, 1–8 items per
   card; radio choice, free text always accepted; recommended option is required (shown first, pre-selected).
2. `ask_multiple_choice` — same, `options[2-10]`, no `recommended`, `multiple:true`.
3. `submit_plan` — structured plan (§5.4); waits for approval or revision feedback; approval flips workflow to
   `implementing`; revision returns the feedback verbatim.
4. `update_progress` — `{completed:int≥1, note?}`; writes `doc.plan.done`; fails without an approved plan.
5. `file_report` — structured report (§5.5), `executionMode:"sequential"`; refuses while any agent is queued or
   running; in a repo session refuses with uncommitted changes or a base behind `origin/<base>`; on success files
   the report, sets `workflow:"reported"`, writes repo memory, notifies (`report:<taskId>`), and ends the run
   (`terminate`).
6. `surface_memories` — `{query}` 1–2000 chars; only registered when long-term memory is on.
7. `recall_history` — `{query?, entry?}`; searches or reads the full entry history (max 8 matches, 20 000 chars per
   entry), including what compaction removed.
8. `write_handoff` — `{text}` 1–2000 chars; only meaningful when pigui asks for one before compacting.

Plus Pi's coding tools (read, write, edit, bash via `@earendil-works/pi-durable/tools`), `Agent` and
`steer_subagent` (§5.7), and the session's own controls.

### 5.3 Waiting
Waiting tools park on a durable signal: the card tool commits its card (and notification) in one commit, then
returns `{sleep: {signals: [CardAnswerSignal.key(ANSWER_KEY)]}}`. The person's answer is signalled in the same commit
that clears the card and records their words. A rerun of the tool before its park was stored finds its card (keyed by
call ID) and neither re-shows nor re-notifies. Notifications enqueue keyed (`card:<taskId>`, `report:<taskId>`,
`run:<id>`, `budget:<cap>`) and are deduped against `doc.notified` (200 keys kept).

### 5.4 The plan shape (`Plan`, shared/session.ts)
`{title, goal (1–3 sentences), endState[1–8], decisions[≤10]{choice,reason}, steps[1–20]{text, files[≤30]},
verification[1–10], outOfScope[≤10], risks[≤10], citations[≤20]{ref,note}}`. Every part required; lists may be empty
only where the tool's description allows. Stored plans may be of the legacy shape; `planOf()` upgrades on read.
Approval state lives on `PlanState = StoredPlan & {revision, approved, done[]}`.

### 5.5 The report shape (`Report`, shared/session.ts)
`{headline, summary, outcome: "complete"|"partial"|"blocked", endState[≤8]{criterion, met, evidence},
changes[≤30]{change, files[]}, checks[≤15]{command, result: "passed"|"failed"|"not run", detail},
deviations[≤10], notes[≤10], learned, memory?}` and, when filed, `commit?` and `filedAt`. `reportOf()` upgrades the
legacy shape. `memory` (only when memory is on): `{create[], helpful[], edit[], delete[], helpful:number,
unhelpful:number}` (see §9).

### 5.6 Unattended continuation and bounds
- No per-run `maxTurns` for sessions (set to `null`; sessions created with an earlier limit lose it at startup).
- The supervisor re-nudges a run that ended in `implementing` without a report, at most **3 times** since the plan
  was approved or the person last spoke (`MAX_CONTINUATIONS = 3`); after that it records `no-report` and notifies
  "Stopped without a report". Outside implementation, a reply records `replied` and notifies.
- Spend cap: `PIGUI_SPEND_CAP` → `doc.cap`; checked after every tool round over the session plus its agents; on
  reaching it, `BudgetStop` records `outcome:{kind:"budget"}`, notifies ("Budget reached", once), stops every agent,
  and terminates the run. Raising the cap (`POST /:id/budget`, `raiseBudget`) submits a `continue` that resumes from
  the round's tool results. New runs are refused while over the cap. `$0.00` spend is hidden (unpriced models);
  priced models show it from the first reply.
- Failures are not retried by the supervisor (Durable retries model requests and its own summaries under
  `settings.retry`); they notify with a Continue button. A stop records `stopped` with no notification.
- `activeRun {submission, startedAt}` is pigui's copy of the run, kept because the picker reads only session
  documents; the open session counts a run as going while either Durable's `pi.live.run` or `activeRun` says so.

### 5.7 Subagents
- Bundled agents (`agents/*.md`, pi-subagents frontmatter): `implementer`, `scout`, `verifier`, `thought-partner`.
  Definitions are Markdown in four roots, lowest precedence first: bundled → the person's own Pi CLI agents dir →
  session `.agents/agents` → session `.pi/agents`. Higher shadows lower; a refused definition removes the name;
  `~/.pi/agent/agents/.disabled` hides a name. Definitions are read at each use (edits apply with no restart).
  Allowed fields: `name, description, tools, model, thinking, max_turns, prompt_mode (only `replace`), extensions
  (only false), skills (true|false), color, display_name`; anything else refuses the agent with the field named. A
  tool pigui lacks is left out and logged once, named in the agent's list line; an agent with no usable tools is
  refused. Without `tools`, all of pigui's coding tools.
- `Agent` tool (`subagent_type`, `description`, `prompt`, `run_in_background`, `resume`) and `steer_subagent`
  (`agent_id`, `message`). Each run is a Durable task `pigui.agent` (versioned) in the session conversation; the
  agent's conversation is owned by its first run's task; the id is stable across resumes.
- Foreground (default): the call parks (`wait`/`allSettled`); stopping the parent stops the call, its task and the
  agent's run. Background: a task the agent's conversation owns, which on completion submits the answer to the
  parent as an input (`AGENT_RESULT_ENTRY`, starts the next run when idle). Steering submits with
  `whenBusy:"steer"`; resume starts a new run on the same conversation; stopping is `abortTask()` and writes
  `AGENT_STOPPED_ENTRY` (read at the parent's next boundary; stops no run).
- Queueing: on start, a run reads the session's agent tasks (`scanTasks`); the oldest waiting runs fill the free
  places (`maxInFlight`, default 4, from `subagent-settings.json`); others wait on the runs ahead of them
  (`policy:"any"`). A waiting run wakes when any of the runs it waits on ends. Settings file unreadable → `Agent`
  returns the error; a waiting run with nothing left to wait on ends `failed` with the file's error (resumable after
  the file is fixed).
- Agents get `pigui-project` (project instructions + spend-cap hook) and, unless `skills:false`, `pigui-skills`;
  never pigui's session tools or `pigui-subagents` — agents cannot ask/plan/report and start no agents. Their
  commands run in the session's directory under the session's sandbox; their spend counts toward the session cap.
- The `agents[]` rows of the session document are a view (session/task/status/type/background/runs/timestamps)
  written in the same commit as each state change; authoritative state is Durable's tasks. The phone watches each
  agent's `pi.live`/`pi.usage`/`pi.agent` from the moment the row appears.
- Stop stops agents first, then the session run. Archiving stops agents too. The report is refused while an agent is
  queued/running. A run that ends with agents still at work records `waiting-agents` ("Waiting on agents", working
  tone) and notifies no one; the first answering agent starts the next run.

### 5.8 Skills
Bundled skills (`skills/*/SKILL.md`, Pi's layout, loaded by Pi's `loadSkills`): `dispatching-scouts`,
`dispatching-implementers`, `dispatching-verifiers`, `subagent-orchestration`, `git-workflow`, `pr-writing`. They sit
beside Pi's own and the project's skills, available in the prompt, the `#` picker and `#skill` references. The
sandbox grants them read access.

## 6. Delivery and the diff (A4.4)

### 6.1 Who pushes
Only the server, only when the person taps. `POST /api/sessions/:id/deliver` with `{action: "push"|"pr"}`; the agent
never pushes and holds no write credential.

### 6.2 Delivery refusals and errors
- Refused while a run is active: `409 Pi is still working, so there is nothing final to deliver yet.`
- `409` for a local session, for a setup not ready / no `startCommit`, and for a concurrent delivery (per-session
  busy flag).
- Push is `git push --porcelain --set-upstream origin HEAD:refs/heads/<branch>`, never forced. Rejected because the
  remote moved → `PushRejected` → `409` with the merge-the-remote advice. Anything else → `502`.
  `delivery.error {message, at}` is recorded either way (shown with `role="alert"` on the report card).

### 6.3 PR flow
`action:"pr"` reuses an open PR found by `gh pr list --head <branch>` (`{..., created:false}`), else creates one
with `gh pr create` — title = `report.headline.slice(0,120) || doc.title`, body = the report rendered as markdown
with a GitHub task list for the end state — (`{created:true}`). On success: `delivery.pushed = {commit, at}`,
`delivery.pr = {number, url}`, `delivery.error` deleted. `GET /api/sessions/:id/diff` renders the diff for review.

### 6.4 The diff
Measured from where the session's own work began: the fork point with the base when the base was merged in,
otherwise the commit the session started from — so neither the base's later commits nor a continued branch's earlier
commits appear. `SessionDiff = {base, files[], uncommitted}`; `DiffFile = {path, from?, status:
"added"|"modified"|"deleted"|"renamed", added, removed, binary, patch, truncated}` (binary/too large → pointer, not
content; uncommitted working-tree changes are reported as a count, never part of a delivery).

### 6.5 Outcomes (the `Outcome` union, shared/session.ts)
`replied | reported | stopped | failed {reason, detail?} | budget | no-report | waiting-agents`. Each failure reason
maps to one plain sentence (`RUN_FAILURES`, e.g. `model_error` → "The model returned an error") used by the banner
and the notification alike.

## 7. Talking to Pi from the phone (A4.3)

### 7.1 Steering and routing
`POST /api/sessions/:id/messages` with `{requestId, text, attachments[]}` routes to exactly one of:
- **a waiting card** — the text answers it (`route:"card"`), recorded as the card's answer;
- **a running run** — steered via Durable `whenBusy:"steer"` (`route:"steer"`);
- **otherwise** — a new run is started (`route:"run"`). A busy continue returns `409 Pi is already working.`
Typed text while a card waits always answers the card (fewest taps possible; free text always possible).

### 7.2 Answering cards
`POST /:id/answer` with `{requestId, cardId, answer}` where `answer` is one of:
`{kind:"questions", answers:[{questionId, selected[], text?}]}`, `{kind:"text", text}` (one reply for the whole card),
`{kind:"approve"}`, `{kind:"revise", feedback}`. Approving a plan flips `workflow` to `implementing` and records the
approval as one of the person's words (verbatim) used by compaction checkpoints.

### 7.3 Stop and continue
`POST /:id/stop` stops the run (and stops agents first). `POST /:id/continue` continues a failed or stopped run.
`POST /:id/retry-setup` retries a failed setup. `POST /:id/budget` raises the cap and continues.

### 7.4 Attachments
Upload first (`POST /api/uploads`, raw bytes + `x-filename`, ≤ 25 MB total; JSON bodies ≤ 1 MB), then reference their
ids. Photos over 2048 px or 1.5 MB are re-encoded on the phone (JPEG q0.85). Images reach the model when it accepts
images (fitted by Durable's `fitImage`); other files land in `.pigui/attachments/` (never committed).

### 7.5 Idempotency
Every mutating request carries a client-chosen `requestId` (8–100 chars). The server records handled IDs (and creation
IDs in the index) in the same commit as the change; a retried send never acts twice. The client keeps the ID with the
draft until the server answers.

## 8. Live state on the phone (A4.5)

### 8.1 The stream
One NDJSON stream per app: `GET /api/live?session=&agent=&from=` (`application/x-ndjson`, `no-store`,
`X-Accel-Buffering: no`). Messages (`shared/stream.ts`): `index`/`index-ops`, `session`/`session-ops`,
`view`/`view-ops`, `agent-doc`/`agent-doc-ops` (for each of the session's agents: `pi.live`, `pi.usage`, `pi.agent`),
`missing`, and a `ping` every 20 s (`PING_INTERVAL_MS = 20_000`). The client treats 2.5 pings without data as a dead
stream and reconnects with backoff `min(15 s, 500 ms · 2^retry)`.

### 8.2 Sources and catch-up
Every source is a Durable watch (not re-fetching): `watchDoc(SessionIndexToken)`, `watchDoc(SessionDocToken, id)`,
one `watchDoc` per agent for its `pi.live`/`pi.usage`/`pi.agent`, and `conversation.watch({from})` for the view. Each
source sends its value once, then Chord operations applied in the browser with `@earendil-works/chord/delta`. On
reconnect the phone asks for the window starting after the newest entry it has (`transcript.resume.from`), so a
reconnect costs only what was missed — never a reload of the whole history. The stream ends when any watch closes, so
the phone reconnects; closing the tab to background ends the stream, which is also how the server knows the person is
not looking (presence, §11).

### 8.3 History
`GET /api/sessions/:id/entries` — `min`, `max`, `limit` (default 50, cap 200), `order`, `agent?` — pages older
entries. The client shows "Load earlier messages" and "Load missed messages"; while a turn runs it auto-fills what the
live window dropped and follows the end; older turns stay behind the button. The transcript is Durable's own
`ConversationTranscript`, fed by the view stream.

### 8.4 Freshness policy on the phone
While a turn runs, nothing hides: thinking reads inline (quiet italic), each call is a tinted block headed by what it
runs with the last 4 output lines (or of the failure) and a count of the lines before them. When the turn ends, the
stretch folds to one line ("Ran 12 commands, wrote 8 files · 1 failed") that opens to the same sequence; each call is a
`<details>` opened to full input/output. Failures show while folded (`role="alert"` for delivery errors and failure
text). The page follows the transcript's end in one place (`viewport.ts`): it keeps the end in view while the person
is at the bottom (new content, taller composer, banner, keyboard), stops when they scroll up, re-pins on send, and
keeps the reading position by hand when earlier messages load (Safari has no scroll anchoring).

## 9. Long-term memory (optional)

- **Store:** one global Durable document, `pigui.memory` (session scope): rows keyed by 4 random hex bytes, each
  `{text, emb (base64 f32), score, sessions[], createdAt, updatedAt}`, plus `embedder?`, `golden?` and `directive`.
  Fine up to a few thousand memories (brute-force cosine, noted unverified beyond that).
- **Embedders:** three interchangeable, each with a per-model cosine floor — LEAF asymmetric on-CPU ONNX
  (`MongoDB/mdbr-leaf-ir` query side, `Snowflake/snowflake-arctic-embed-m-v1.5` document side; floor 0.28; ~23 ms a
  search, ~300 MB resident), an OpenAI-compatible HTTP `/embeddings` endpoint using the key Pi resolves for
  `PIGUI_MEMORY_PROVIDER` (default `lunaroute`, model `emb-qwen3`, floor 0.44, batches of 128, 30 s timeout), or a
  hashing fake (256 dims) for tests and fake mode. `PIGUI_MEMORY_EMBED_URL` forces an endpoint. LEAF is built in only
  when `PIGUI_MEMORY_LOCAL=on` at image/install time.
- **Ranking:** cosine similarity + clamped score influence (`SCORE_WEIGHT` 0.05, capped at `SCORE_INFLUENCE_CAP`
  0.25), best eight, floor rejects the rest. A memory's id→text and a provenance chain are kept.
- **Writing:** only through `file_report`'s required `memory` part (`create/helpful/edit/delete`), applied in the
  report's own commit under a rerun guard; helpful/unhelpful move `score` by ±0.5 (`VOTE_STEP`). A failed embedding
  still files the report, with a note. The report is **refused** while any surfaced id is unrated, naming each —
  surfaced ids are kept on the session (`memoryShown`), so compaction cannot hide one.
- **Searching:** only the `surface_memories` tool, at agent-chosen moments: once once the work's machinery can be
  named (before asking or planning), when work reaches machinery a search did not cover, and when something behaves
  unexpectedly (with the error text).
- **Re-embedding:** a lazy pass compares the stored embedder name and a golden-vector cosine (≥ 0.999); a mismatch
  re-embeds in batches of 128.
- **What the agent sees:** `renderSurface` text — id, similarity, helpfulness, provenance chain, plus a repeated `⟁`
  banner demanding ratings and creates; the 11 create rules and 5 worked examples (`DIRECTIVE_VERSION = 3`) port
  pi-durable-memory's directive.
- **Off is said on the phone:** `Bootstrap.memory = {on:true, model} | {on:false, reason}`; the session picker's
  status bar shows the reason in warning style whenever memory is off (a standing condition, not a toast).
- **Not ported:** encryption at rest, a read-only global store, the refinement pass, `/durable-memory` config.
- **Repo memory stays apart** (§3.5): short `learned` notes, not a searched store.

## 10. Repo memory

The `learned` field of every report replaces the repository's memory (`pigui.repo-memory`, session-scope, keyed by
repository or `this computer`). It is read into every session on that repository, alongside the project's
instructions. Nothing else writes it.

## 11. Notifications (A4.6)

Four enqueue sites, each keyed: `card:<taskId>` (a question or plan is waiting), `report:<taskId>` (a report is
ready), `run:<recordId>` ("Pi replied" / "Stopped without a report" / "Run failed <reason>"), `budget:<cap>` ("Budget
reached"). Kept against `doc.notified` (200 keys) so each wait notifies exactly once, even across reruns.

- **Suppression:** no notice when another run is already queued; none when the outcome is already `budget` or
  `reported`; none for `aborted` or `waiting-agents`; and none while the person is viewing the session
  (`presence.viewing`, checked at send time; `notify.suppressed` logged).
- **Delivery:** a background Durable task sends, so a restart between the commit and the send still sends; a crash
  after send but before commit resends, and the phone's notification `tag` (one per session) plus the push `Topic`
  header make a repeat replace the first. Payload `{title: "<session title> — <notice title>", body, url:
  "/#/s/<id>", tag: "session-<id>"}`; `Urgency: high`, `TTL 86400`. Endpoints returning 404/410 are dropped from
  `pigui.push-subscriptions`.
- **Web Push** is implemented on `node:crypto` (RFC 8291 encryption, RFC 8292 VAPID), verified against the RFC's
  test vector — no `web-push` dependency. VAPID keys are created on first start and stored in `<data>/vapid.json`.
- **Tapping** a notification opens that session: an open window is focused with `{type:"open", url}` posted; otherwise
  a window is opened (`sw.ts`).
- The phone enables notifications from a tap (the picker's footer button): permission request →
  `pushManager.subscribe` → `POST /api/push/subscribe`. On boot, if permission is already granted, the subscription
  is refreshed.

## 12. Compaction and long sessions (A4.10)

PiGUI compacts the context itself, led by the agent's own handoff note; Pi Durable's compaction stays on as a
backstop. All sizes are proportions of the session model's context window.

### 12.1 Trigger and cycle
Durable thresholds: `reserveTokens = 15%`, `keepRecentTokens = 25%`, `backgroundTokens = 10%` of the window
(`compaction.ts:31-38`). PiGUI's own cycle: after every tool round an `afterTools` hook measures the context (the
usage of the request that made the round's calls, plus estimates of its results). Past **60%** of the window
(`HANDOFF_TRIGGER = 0.6`) it steers the agent: "Your context window is about to be compacted. Call write_handoff
now…" (≤ 2000 chars, "Make no other tool call this turn"). It skips a round already past Durable's background
threshold, a round that already has a pending handoff request, and a round the spend cap ends. If the agent ignores
the steer, the next round's hook compacts anyway, without a note.

### 12.2 The compaction task and the checkpoint
The next round's `pigui.compact` task (a child of the generation, before the round ends):
1. `cappedBounds(cap = keepRecentTokens, keep = the handoff call)` (`cut.ts:78-92`) — every valid cut the
   summarizer may choose, marked `valid_cutpoint` by Durable's own rule.
2. The summarizer (the session's model, or `PIGUI_COMPACTION_MODEL` while Pi can sign into it) gets the previous
   working state, pigui's facts, the agent's note, the newly compacted entries tagged by ID/kind/role, and the kept
   range; it writes ≤ 12k tokens (or the model's own limit) and returns a cut with one sentence of reasoning, optional
   one-line notes for kept tool results to condense, and **eight sections**: STATE AT COMPACTION BOUNDARY, EVIDENCE
   TIERS, CODE REFERENCES, DECISIONS AND RATIONALE, COMMANDS, TESTS, AND FAILURES, WORK QUEUE, OPEN THREADS,
   COMPACTED HISTORY SYNOPSIS.
3. Code checks every choice (`cut.ts`): the cut must be one of the valid cuts it was shown, must keep the note's
   call and result, and keeps at most the cap (25%). A cut over the cap moves to the nearest later valid cut within
   it. Anything else falls back — earliest cut within the cap in pigui's compaction, Durable's cut in the backstop —
   and the checkpoint says why whenever a chosen cut is not used.
4. The task's first commit admits a write whose entry is a head marker (`pigui.compaction`): `head` is the cut, the
   checkpoint is its model message, `edits` replace the condensed tool results. Its terminal commit admits a resume
   steer — both as `pigui.compaction-note` inputs, each admitted in its own commit. The model sees a user message,
   the phone shows a quiet note, neither is recorded in `doc.words`.
5. The summarizer's reply is memoized on the task (`api.memo`) before anything is placed, so a rerun after a restart
   never re-calls the model. Marker and resume steer have fixed request IDs.
6. Only tool results are condensed, never the person's messages or the note's result; a condensed result keeps its
   call ID and name, so the pair stays intact, and the stored entry is unchanged (`recall_history` still reads it).
7. The checkpoint text budget is **10%** of the window; over it, lists are shed oldest-first in this order: files
   read → files modified → changed files → commits, each with an omitted-count note. The person's words, the plan,
   the session and repository state, the instructions and the working state are never shed (the working state is
   bounded by the summarizer's output limit instead).
8. A failed summarization (error, no reply, no model) still yields a usable handoff: the fallback cut is used and the
   previous working state is carried forward with fresh facts and a "not updated at this compaction" note.
9. "The context window has just been compacted. Please resume…" ends the cycle. The 60% trigger sits 15% of the
   window below Durable's background threshold (75% with pigui's settings), leaving room for one large round and the
   handoff round; a round already past 75% is left to Durable.

### 12.3 The checkpoint's sections (in order)
"Before you act" (git status/log, re-read files, not redo, not re-ask), "The person's words, verbatim, oldest first",
"Plan" (+ done/when), "Session", "Where you work"/"Repository, computed at compaction" (branch, ahead/behind of the
base, uncommitted files, the session's commits and changed files, recomputed by code via `facts.ts`), "Files you read
and modified", "Working state, written at compaction" (the summarizer's body, verbatim), "Recovery" (the cut entry id;
that `recall_history` exists and covers the range). The header says it is historical: the files on disk and later
messages win.

### 12.4 The backstop and the marker
Durable's own compaction remains on; its `beforeCompact` hook writes the same checkpoint within Durable's limits (no
note, no resume turn). A marker only ever moves the context forward — Durable places a stale `head` marker as stale
and never appends it. The backstop declines when the context has moved past Durable's own cut, and when its own
marker already landed before a restart.

### 12.5 What the person sees
Each compaction is one collapsed "Context compacted" row in the transcript that opens to the checkpoint and says how
many messages were kept (when the backstop's marker supersedes Durable's summary of the same compaction, the row
shows the marker's checkpoint in the summary's place). Compaction never touches the workflow state.

### 12.6 Verbatim and recovery guarantees
Every task, answer, approval and message is stored verbatim in `doc.words` as it happens and rendered verbatim in
every checkpoint. The summarizer's working state is kept in `doc.handoff.body` and evolves — never summarized from
scratch. Unresolved items persist until resolved. `recall_history` searches and reads every stored entry
(8 matches, 20 000 chars each). A run that ends on a compaction error ends as a failure: the person taps Continue. The supervisor does not retry failures — Durable retries model requests and its own summaries under `settings.retry`, and the checkpoint carries the previous working state forward when a summarizer fails — so whatever still ends a run would fail again (DECISIONS.md, “When a run ends”).

## 13. References in messages (A4.9)

One rule in `shared/references.ts`, used by the composer's picker and the server's expander:
- A sigil starts a reference only at the start of the text, or after whitespace or an opening bracket/quote —
  `me@example.com` and `a#b` are plain text; `#123` is an issue number.
- `@` → file reference: brings the file's contents up to 64 KB, or a pointer for a directory, a larger file or a
  binary file; a path leaving the workspace or entering `.git` is ignored. On OnPrem, `~` and absolute paths work.
- `#` → skill reference: invokes the skill exactly as the Pi CLI's `/skill:` does — a `<skill name location>` block
  with frontmatter stripped and "References are relative to {baseDir}" — resolved via Pi's `loadSkills`. Unknown
  references stay plain text.
- `activeTrigger` narrows the picker at the caret; `narrow` subsequence-scores candidates, 8 shown.
- The person's text is stored as typed in the entry's data; the added context goes into the model's message ahead of
  the text; the transcript shows it as compact chips (`MessageEntryData.references` with status
  `included`/`pointer`/`skill`).
- On New session, the pickers read the chosen repo/branch through the repository host before anything is cloned.

## 14. The PWA (A5)

### 14.1 Shell
Installable PWA: `manifest.webmanifest` (standalone, portrait-any, theme `#fcfbf8`), icons 192/512/maskable/apple
touch; `index.html` with `viewport-fit=cover`, `interactive-widget=resizes-content`, `color-scheme: light dark`;
`theme-color` per color scheme; `apple-mobile-web-app-capable`. `start_url` `/`, display standalone.

### 14.2 Service worker (`src/sw/sw.ts`)
- Cache `pigui-shell-${BUILD_ID}`: precaches `/`, `/app.js`, `/app.css`, the manifest, icons and the font files;
  `install` → `skipWaiting`; `activate` → deletes other caches → `clients.claim`.
- `fetch`: network-first for same-origin GETs that are not `/api/*` (never caches the API); re-caches only SHELL
  keys; offline → cached shell; an uncached miss is `Response.error()`. No dedicated offline page.
- `push`: parses `{title, body, url, tag}` (default: pigui/""/"/"/"pigui"), shows the notification with
  `tag`, icon/badge `/icons/icon-192.png`, `data:{url}`.
- `notificationclick`: closes; focuses the first window with `{type:"open", url}` posted, else `openWindow(url)`.

### 14.3 Routes (hash)
`#/` → New session; `#/s/:id` → session view; `#/s/:id/agent/:n` → agent viewer (report cards suppressed).
Routing is a hash regex in `store.ts`; unknown → new.

### 14.4 Views and components
- **Session picker (☰)** (Sessions.tsx): a dialog over the page (dimmed 0.6, blurred 3 px), laid out as macOS Finder
  list view: sortable column headers (Name/Where/Modified/Status, newest first default), striped rows, a status-coloured
  dot where Finder puts an icon (cyan working, yellow its turn, orange warning, red error, empty ring idle), "Today at
  …" dates, the open session filled in ink as the selection, arrow-key navigation, 44 pt rows on phone; done/archived/
  12-hour-stale sessions sit in an **Inactive** folder (disclosure triangle, open when the open session is in it).
  Archive/Restore per line (an Archive button beside each line's link; restoring from the Inactive folder). Archiving
  the open session navigates to New session with an Undo toast. A status bar counts them and holds the memory-off
  notice and "Turn on notifications". Escape, Close, or a tap outside closes it. Focus returns properly for screen
  readers.
- **New session** (NewSession.tsx): repository choice (default last used) + branch choice (default: a new branch from
  the repo's default branch), the composer; OnPrem adds a directory field with starred directories and recents.
- **Session view** (SessionView.tsx): title bar (title, one-line status with spend "$<n>" once above zero), the
  transcript, the composer; the report card carries Push/Open PR/View PR/Keep working buttons; failure banners with a
  next step (Continue, Raise to $X and continue, Retry setup).
- **Agents panel** (Agents.tsx): button with a count, a panel listing agents with a Stop button each; a running row
  shows the tool the agent is on and the last line it printed (or "thinking"/"writing").
- **Diff sheet** (Diff.tsx): grouped by file, added/removed counts, unified patch; binary/too-large files listed
  without content; uncommitted count noted separately; bottom sheet with grabber, Escape/backdrop/drag-to-close with
  iOS-style momentum; on wide screens a centred dialog.
- **Transcript** (Transcript.tsx): the agent's prose as sanitized markdown (marked + DOMPurify); thinking inline
  (quiet italic) while running, folded when done; work stretches as above; cards (questions/plan/report) inline;
  history paging; compaction rows; agent-result notes.
- **Composer** (Composer.tsx): an input pill with an attach button and a circular 44 pt send button that becomes
  Stop while a run is active and nothing is typed; `@`/`#` pickers (8 subsequence-matched candidates; Return takes the
  first match on keyboard devices; Escape closes); a placeholder that says what sending will do now ("Answer in your
  own words…", "Steer Pi while it works…"); drafts saved as typed (localStorage `pigui.drafts`, per key, with
  attachments and the in-flight requestId); Return sends with pointer keyboards (`(hover:hover) and (pointer:fine)`),
  Shift+Return newlines, ⌘/Ctrl+Return always, never while composing an IME; photos resized (≤ 2048 px, JPEG q0.85).
- **Speak** (Speak.tsx/speech.ts): a speaker under each reply (agent's text in one turn, consecutive blocks read as
  one); on the report card it reads headline, summary, departures and notes. Tap → the session's model rewrites the
  reply to a speakable script (streamed NDJSON, `SPEECH_SEGMENT_CHARS = 200` per segment, sentence-split, thinking
  off), Kokoro-82M (q8) synthesizes on-CPU (voice `af_heart`, one at a time, segments trimmed of padding silence),
  played through one unlocked `HTMLAudioElement`, fetched up to 3 segments ahead; audio unlocks inside the tap
  (iOS). Locking the phone does not stop it; leaving the session does.
- **Toasts**: archive/undo etc.; rise above the composer, swipe-down to dismiss, clock stops while a finger is on it
  or the app is backgrounded.

### 14.5 Visual system (the look)
Three faces, one job each: Source Serif 4 (names and acts: titles, question text, plan titles, report summary,
buttons, the person's words — never below Body size), IBM Plex Sans (read: agent prose, options, fields), IBM Plex
Mono (the record: labels, status, tool lines, paths, commits, sums). Weights light (380 read; 480 titles), a step
lighter on dark. A faint text-coloured halo on light only. Status is a word, not a pill; one hue per meaning (cyan
working, yellow the person's turn, green done, orange warning, red error, blue what reaches GitHub; everything else
ink/pencil). Warm near-white page (`#fcfbf8`), ink `#1b1915`; dark is a page all but black (`#010405`) with bright
cool ink (`#e2ecea`) and toned-down informational colours (≥ 6.7:1), full yellow/red kept. Filled ink for the main
action (`--accent-fill`, 9.4:1 label). Spacing 2/4/6/8/12/16/24 px; radii `--radius-s` 3px / `--radius-l` 12px /
`--radius-full`; type sizes as fractions of Body (Dynamic Type); motion: press 160 ms, quick 200 ms, present 400 ms;
`--ease-out` and the iOS sheet curve; no animation for frequent actions; reduced motion keeps fades, drops movement.
Nothing scrolls horizontally; safe areas respected; dark via one `prefers-color-scheme` token block; system font is
NOT used (three pinned Fontsource faces are bundled).

### 14.6 HIG mapping (as documented)
Clarity (placeholder says what sending does; plain-sentence tool summaries; named failures with next steps) ·
Deference (content first; detail folded until asked; status one line) · Sensible defaults (last repo, new branch from
default, recommended options pre-selected) · Familiar navigation (☰, Finder-style picker) · Feedback and forgiveness
(immediate archive + Undo; drafts never lost) · Accessibility (Dynamic Type, 44 pt targets, light/dark contrast,
safe areas, reduced motion, roles/labels/live regions, keyboard resizes the layout).

## 15. Maintenance, cleanup and backups (A4.7)

One Durable task in the root conversation sleeps a day between rounds (`pigui.maintenance` v1); `ensureScheduled`
keeps exactly one non-terminal sweep task at startup. A sweep:
1. backs up `pigui.sqlite` with SQLite's online backup (`node:sqlite` `backup()`), keeping 14 `pigui-YYYY-MM-DD.sqlite`
   files, in `<data>/backups`;
2. prunes stale uploads (older than 1 day);
3. removes pigui's own directories of a session archived for **7 days** or more, only when (a) for a repository
   session: the workspace has no uncommitted changes, no commits origin lacks on the session's branch (HEAD is an
   ancestor of `origin/<branch>` or `origin/<base>`), and `unpushedCount` is zero; (b) never a local session's chosen
   directory, nor any directory that holds one; (c) removes only the workspace, the scratch dir and attachments' pigui
   record. **Cleanup never deletes unpushed work.** The session gets `cleanedAt`.

## 16. Configuration (A4.8)

Environment variables read by the server (`config.ts`):

| Variable | Default | Notes |
|---|---|---|
| `PIGUI_FAKE` | off | `1`/`true`; full fake mode (§18) |
| `PIGUI_ONPREM` | off | OnPrem mode (§17.3) |
| `PIGUI_DATA_DIR` | — | **required**; startup exits 2 without it |
| `PIGUI_HOST` | `127.0.0.1` | must be loopback; non-loopback refuses to start |
| `PIGUI_PORT` | `2025` (OnPrem) / `8787` | |
| `PIGUI_PUSH_SUBJECT` | `mailto:pigui@localhost` | Web Push subject |
| `PIGUI_ALLOWED_LOGINS` | empty | comma-separated, lowercased; empty allows the whole tailnet |
| `PIGUI_SPEND_CAP` | none | US dollars; `0`/empty = none |
| `PIGUI_COMPACTION_MODEL` | none | `provider/modelId`; must be signable by Pi |
| `PIGUI_AGENT_GH_TOKEN` | — | required in real mode (agent's read-only GitHub token) |
| `PIGUI_SANDBOX` | on | `off` for kernels without Landlock |
| `PIGUI_MEMORY_PROVIDER` | `lunaroute` | Pi provider whose key signs embeddings |
| `PIGUI_MEMORY_EMBED_MODEL` | `emb-qwen3` | |
| `PIGUI_MEMORY_EMBED_URL` | none | explicit OpenAI-compatible URL; wins over everything |
| `PIGUI_ALLOWED_HOSTS` | none | OnPrem only: extra host names answered |
| `PIGUI_MODELS_UNLOAD` | `never` | `never` or 1–1440 minutes (idle unload for Kokoro/LEAF) |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi's config location (fake mode: a temp dir) |

Not read by the server, build-time only: `PIGUI_SPEECH`, `PIGUI_MEMORY_LOCAL` (Dockerfile/installer). Compose-only:
`PIGUI_TS_HOSTNAME`, `TS_AUTHKEY`, `GH_TOKEN`, `AGENT_GH_TOKEN`. Sandbox grants read `NODE_EXTRA_CA_CERTS`/
`SSL_CERT_FILE` to pass CA files. `PIGUI_FAKE_TOKENS_PER_SECOND` (default 60) times the fake model;
`PIGUI_FAKE_MEMORY=off` turns memory off in fake mode. Docker `.env` (`.env.example`) documents 15 variables; the
server installer writes `/etc/pigui/pigui.env` (0600) with `PIGUI_DATA_DIR/_HOST/_PORT/_AGENT_GH_TOKEN`.

Startup exits: `2` for config errors (including a sandbox that cannot run, when `PIGUI_SANDBOX=on` in real mode);
`78` when Pi is not signed in (message tells the operator how to `pi` → `/login`); `1` otherwise. systemd uses
`RestartPreventExitStatus=78 2` so a missing sign-in waits for a person instead of restarting in a loop.
Shutdown: SIGTERM/SIGINT → supervisor stop → HTTP close + `closeAllConnections()` → harness close → exit 0 (or 1 on
failure).

## 17. Deployment (A6)

### 17.1 One decision tree: `install.sh` (repo root)
Three questions decide four paths: (1) container or not, (2) this computer or a remote server, (3) the flags.
- **local/sandboxed** — Docker on this machine: check Docker; write `.env` from `.env.example` (fill `GH_TOKEN`,
  `AGENT_GH_TOKEN`, `PIGUI_SPEECH`, `PIGUI_MEMORY_LOCAL`, `PIGUI_MODELS_UNLOAD`); `docker compose build && up -d`.
- **local/full (OnPrem)** — as the person, unconfined, from a checkout in `~/.pigui/app`; a user service (LaunchAgent
  on macOS, systemd user unit on Linux) with the login shell's PATH captured at install time; fetches `--ref`
  itself; refuses to overwrite local changes; memory/model choices remembered in `~/.pigui/onprem.conf`.
- **remote/sandboxed** — over SSH as root: clones to `/root/pigui-src`, writes `/root/github-token` and
  `/root/agent-github-token` (0600), runs `deploy/install.sh` there. Requires an installed SSH key (BatchMode).
- **remote/full** — OnPrem over SSH as a user it creates; copies this computer's credentials (`gh` token piped, never
  printed; Pi config: `--pi-config overlap` shares `~/.pi/agent`, `standalone` copies a minimal settings+empty
  auth into `~/.pigui/pi-agent` and points `PI_CODING_AGENT_DIR` at it so nothing overlaps the person's own Pi).

Non-interactive inputs: flags or env for every part (`PIGUI_WHERE`, `PIGUI_REMOTE`, `PIGUI_HOW`, `PIGUI_REF`,
`PIGUI_SPEECH`, `PIGUI_MEMORY_LOCAL`, `PIGUI_PORT`, `PIGUI_TAILSCALE`, …); otherwise saved `install.conf` /
`onprem.conf`, otherwise defaults. `--dry-run` prints `[dry run]` for every step and changes nothing. `--uninstall`
keeps `~/.pigui/data` and logs. Re-running upgrades in place; steps check before changing.

### 17.2 Server installer (`deploy/install.sh`, Debian 13 / Ubuntu 24.04, root)
Check machine → apt packages → Node 22 → gh → Tailscale → create `pigui` system user (no sudo) → dirs
`/opt/pigui`, `/var/lib/pigui/{backups}`, `/etc/pigui` → global pi 1.6.0 → rsync app → `npm ci` + `npm run build` →
Landlock ABI check → `deploy/models.sh` (fetch pinned, sha256-verified model files; prunes the unused model) →
write `/etc/pigui/pigui.env` (0600) → `gh auth login` for the service user + system git credential helper → write
`pigui.service` (RestartPreventExitStatus 78 2) → daemon-reload + enable → Pi sign-in check → start → `tailscale up`
+ `tailscale serve` → status; ends by listing the human-only steps (§B2 of the runbook). Shared helpers in
`deploy/lib.sh` (`run`, `write_file`, dry-run). `deploy/trim.sh` masks services a pigui-only machine never uses
(keeps SSH, networking, DNS/time sync, cron, AppArmor, security updates, cloud-init), adds swap, caps the journal.
`deploy/onprem.sh` is a shim for `install.sh --local-full`.

### 17.3 Docker
Two containers: `tailscale/tailscale:v1.104.4` (NET_ADMIN/NET_RAW, read-only, kernel-mode serve with `/dev/net/tun`;
never funnel) and `pigui` sharing its network namespace — pigui listens on loopback only; nothing is published.
pigui: ubuntu:noble base (Node 22.23.4 copied from the official image), builds the app in a build stage, drops all
capabilities, `no-new-privileges`, read-only root (writes only its `data` and `home` volumes and a size-capped
`/tmp`), unprivileged user, setuid bits stripped, process limit 1024. Pi sign-in stays interactive
(`docker compose run --rm pigui pi`). Speech/LEAF are build-time switches (`PIGUI_SPEECH`, `PIGUI_MEMORY_LOCAL`); the
models come from pinned Hugging Face revisions, sha256-verified, offline at run time.

### 17.4 Security model (documented in README)
Anyone who can reach pigui can make Pi run commands as the service user — the tailnet (plus the optional
`PIGUI_ALLOWED_LOGINS`) is the boundary; there is no application login. The agent shares the service user with the Pi
and GitHub credentials; "never push" is an instruction backed by the token split (read-only agent token; pigui's
token used only on a tap) and the caller check. Mitigations: fine-grained GitHub token limited to chosen repos,
branch protection on default branches, service user without sudo, delivery only on a tap. OnPrem: deliberately
unconfined as the person, on their own computer; refuse remote local sessions on servers (403).

## 18. Fake mode and testing (A8)

### 18.1 Fake mode
`PIGUI_FAKE=1` runs the complete product with no credentials: pi-ai's faux provider (`pigui-fake`/`scripted`) with one
queued response factory per request, so every response is a function of its request's messages (concurrent sessions
cannot collide). Responses are priced so the spend cap is testable. `PIGUI_FAKE_TOKENS_PER_SECOND` (default 60) paces
it; the model's `contextWindow` is settable (`ONE_COMPACTION = 26_500`, `SEVERAL_COMPACTIONS = 21_500`,
`BACKGROUND_THEN_BLOCKING = 35_500`) to force compaction deterministically.

**Scripted scenario** (`src/server/fake/model.ts`): explore (`bash ls/cat AGENTS.md`) → ask 2 questions →
`submit_plan` (structured) → write `src/shout.ts` → progress 1 → write test → progress 2 → commit
(`git add`/`git commit`) → progress 3 → `file_report`. Follow-ups (edit+commit+report), plan revisions, and variants
(`[spin]`/`[probe]`/recall/handoff/delegation/summarize/speech). A plain chat reply is produced when the task reads
as prose not ending in `?` and without `[chat]`. The scripted summarizer answers pigui's checkpoint prompt in its
format, with directives of its own; the script step is read from the newest scripted tool-call id, which survives
compaction.

**Local GitHub stand-in** (`src/server/fake/github.ts`, `LocalGitHub`): bare repositories under
`<data>/fake-github/repos/<owner>/<name>.git` (seeded once from `fake/fixtures.ts`: `demo/greeter`, `demo/notes`, two
branches each), real git for clone/push; pull requests in a `<root>/pulls.json` file (atomic rename), URLs
`https://github.invalid/...`; implements the same `RepoHost` interface as `gh`, restart-safe. Selected by config
(`fake` → `LocalGitHub`, else `GhHost`). Fake speech synthesizer emits a 24 kHz sine per character (0.02 s each);
fake memory embeds by hashing words (256 dims). Tests and e2e never touch the network.

### 18.2 Automated tests (`node:test`, real Durable storage, no mocking Durable)
19 files, ~152 tests. Each asserts behavior through public interfaces (`test/helpers.ts` starts the real server in
fake mode on a free port over a temp data dir; `TestServer.restart()` closes and reopens on the same data dir; waits
on Durable watches, not sleeps; crash timing via explicit fault seams in `AppOptions.faults`).

| File | Covers |
|---|---|
| access.test.ts | allowlist, caller-identity socket-table check, loopback-only bind, Origin/Host/rebinding, exit 78 without sign-in |
| compaction.test.ts | handoff at trigger; cut/runway/resume ordering; condense vs recall; restart mid-compaction; summarizer failure; backstop; over-cap fallback; successive compactions verbatim |
| delivery.test.ts | commit on branch; push; PR create/reuse/update; refused while Pi works; "remote moved"; diff limited to session changes |
| deploy.test.ts | install scripts syntax + dry-run step listings, model switches, uninstall keeps data |
| embeddings.test.ts | batches of 128; index-ordered vectors; endpoint errors; provider key; LEAF relevance floor; stability |
| held-model.test.ts | load-forever vs idle unload; in-use pinning; retry after failure; `PIGUI_MODELS_UNLOAD` validation |
| install.test.ts | installer flags/help/SSH-key/remote paths |
| lifecycle.test.ts | zero-shot task → PR opened; repo memory carried into the next prompt |
| maintenance.test.ts | archived-workspace cleanup, unpushed protection, local dirs untouched, unarchive, backups |
| memory.test.ts | report records memory; next session surfaces/rates it; unrated refusal; re-embed on model rename; failure paths |
| notifications.test.ts | one per wait across reruns; suppressed for the focused session; RFC 8291 encryption |
| onprem.test.ts | local sessions in `~`, no clone, unconfined own env, `@` by `~`/absolute, starred dirs, servers refuse local |
| references.test.ts | `@`/`#` syntax, emails/issue numbers stay text, picker narrowing, inlining, pointers, uncommitted attachments |
| restart.test.ts | question survives a full restart and completes; mid-setup restart; failed setup shows reason + retries |
| sandbox.test.ts | agent token vs pigui env; per-session home/tmp; cross-workspace/DB/Pi-auth denial; symlink/proc escapes |
| speech.test.ts | streamed script + cost, WAV format, 400/404 boundaries, no-speech build |
| stored.test.ts | legacy plan/report shapes; pre-local session reopens as repo |
| subagents.test.ts | foreground/background, steering/resume/stop, queueing, restart-safe delivery, report gating, spend, definitions |
| workflow.test.ts | plan revision; bounded continuation; report refuses uncommitted; model failure + continue; routing; idempotent retry; budget |

### 18.3 End-to-end (Playwright, chromium 390×844, isMobile/hasTouch, workers 3)
`agents.spec.ts` (agents panel, stop, folded background answer) · `app.spec.ts` (picker/attention, archive-undo,
wide-screen columns + key nav, pickers, Return/Shift+Return) · `flow.spec.ts` (full tap flow to PR, folded stretches,
reload mid-turn, typing answers, memory line, diff) · `memory.spec.ts` (memory-off notice) · `onprem.spec.ts` (local
session end-to-end) · `platform.spec.ts` (no horizontal scroll at 375 px, 44 pt targets, bundled fonts, dark mode
without console errors, catch-up after server restart) · `speech.spec.ts` / `speech-pacing.spec.ts` (speaker
prepare/play/idle; the wait-once rule after a short first sentence).

## 19. HTTP API surface

All routes under `/api`; JSON bodies validated by pi-schema; mutating requests need a `requestId`.

| Route | Purpose |
|---|---|
| `GET /api/bootstrap` | fake flag, VAPID public key, speech/memory status, last repo, OnPrem home — for first paint |
| `GET /api/live?session=&agent=&from=` | NDJSON live stream (§8) |
| `POST /api/push/subscribe` | store a Web Push subscription |
| `POST /api/speech` | text → `audio/wav` (404 when speech is absent, with why) |
| `POST /api/uploads` | one attachment (≤ 25 MB; raw bytes, `x-filename`) |
| `POST /api/local/starred` | star/unstar a directory (OnPrem) |
| `GET /api/local/files?path=` | breadth-first directory listing for `@` (bounded: 5000 entries, 1500 ms) |
| `GET /api/local/skills?path=` | skills visible in a directory |
| `GET /api/repos` | list repos |
| `GET /api/repos/:owner/:name/branches` | default branch + branches |
| `GET /api/repos/:owner/:name/files?ref=` | tree listing for the `@` picker |
| `GET /api/repos/:owner/:name/skills?ref=` | global + project skills |
| `POST /api/sessions` | create (§3.1) |
| `GET /api/sessions/:id/files` | `@` listing of the session's workspace |
| `GET /api/sessions/:id/skills` | skills for the session |
| `GET /api/sessions/:id/diff` | per-file diff (§6.4) |
| `GET /api/sessions/:id/entries` | paged transcript (§8.3) |
| `POST /api/sessions/:id/speech-script` | streamed NDJSON `ScriptLine`s |
| `POST /api/sessions/:id/messages` | send a message (§7.1) |
| `POST /api/sessions/:id/answer` | answer a waiting card (§7.2) |
| `POST /api/sessions/:id/stop` | stop the run (agents first) |
| `POST /api/sessions/:id/continue` | continue a failed/stopped run |
| `POST /api/sessions/:id/budget` | raise the spend cap and continue |
| `POST /api/sessions/:id/deliver` | `{action:"push"\|"pr"}` (§6) |
| `POST /api/sessions/:id/archive` | `{archived:bool}` |
| `POST /api/sessions/:id/seen` | clear the attention marker |
| `POST /api/sessions/:id/retry-setup` | retry a failed setup |
| `POST /api/sessions/:id/agents/:agent/stop` | stop one agent |

Non-`/api` paths serve the static app (extensionless → `index.html`); other methods → 405. Errors: `{error, hint?}`,
400 bad JSON/validation (empty upload, missing `?ref=`), 403 (host check, caller check, allowlist, cross-site), 404,
405, 413 (body too large), 409 (busy/delivery/local), 502 (push failure), 500 otherwise with the hint "Try again; if
it keeps failing, check the server's journal." Request logging: `log.info("http", {method, path, status, ms})`, path
only, skipped for `/api/live`.

## 20. Durable documents (the data model)

| Document | Scope | Holds |
|---|---|---|
| `pigui.session` | conversation | everything in §3.3 (`SessionDoc`): place, setup, workflow, plan/progress, card, report, spend cap, `activeRun`, outcome, `continuations`, `words[]`, `notified[]`, `requests[]`, `handoff`, `memoryShown`, `pendingTask`, `agents[]`, `archived/cleanedAt/seenAt/attentionAt` |
| `pigui.index` | session (one per Harness) | one `SessionRow` per session (`sessionRow()`, recomputed on every commit and at startup), `lastRepo`, `starred?` (OnPrem), `created[]` (creation request IDs) |
| `pigui.repo-memory` | session family per repo (+ `this computer`) | the `learned` note reports write |
| `pigui.memory` | session | long-term memory rows + embedder/golden/directive (§9) |
| `pigui.push-subscriptions` | session | Web Push endpoints and keys |
| `pigui.agent` | conversation | an agent's session/env/task (points the agent conversation at its session) |

Entry kinds pigui places in the transcript, beside Durable's own `pi.*`: `pigui.message` (the person's words as
typed, with references/attachments chips), `pigui.nudge` (an automatic continuation, `{attempt, limit}`),
`pigui.compaction` (the checkpoint marker: `{task, durableCut?, selection:"model"|"capped"|"fallback", retained,
condensed}`), `pigui.compaction-note` (`{note:"handoff-request"|"resume"}`), `pigui.agent-result`
(`{agent, type, description, status, text}`), `pigui.agent-stopped` (`{agent, type, description}`). The run's live
state (streaming text, running tools, usage, inbox, run failure) stays in Durable's built-in documents and is never
copied. `sessionRow()` derives the drawer row (group/label/tone); `sessionSpent()` sums a session plus its agents.
`planOf`/`reportOf` upgrade legacy stored shapes on read. Status tones (`StatusTone`): working / attention / warn /
error / done / idle, one per meaning, shared by title bar and picker.

## 21. Bundled agents and skills

Bundled agents (`agents/*.md`): `implementer`, `scout`, `verifier`, `thought-partner` — the scout/implementer/verifier
triplet plus design pressure-testing; Pi CLI-compatible definitions, highest-level root is bundled (overridden by
the person's own, then the session's). Bundled skills (`skills/*/SKILL.md`): `subagent-orchestration`,
`dispatching-scouts`, `dispatching-implementers`, `dispatching-verifiers`, `git-workflow`, `pr-writing`.

## 22. Deliberately not built

Slash commands (Pi Durable has no command concept; each would need its own adapter) · prompt templates as composer
items · theme picker (removed; dark follows the device) ·
menu grouping under "Needs you / Working / Done" (removed; Finder-style folder now) · Terminal theme · the
`checkpoint` op and `/durable-memory` (report replaces both) · per-run `maxTurns` (removed; only subagents carry one)
· notifications for a focused session · in-memory promises, timers or pollers for waiting — waits are parked Durable tools only.

## 23. Known limits and gaps (from the inspection)

- Long-term memory is asserted correct only up to a few thousand rows; nothing in-tree measures beyond that.
- OnPrem has no caller check on macOS (no kernel socket table); any user of the Mac can reach it (documented in README).
- `setuid`-stripped image; `/dev/shm` writable by every session (`/dev` grant).
- The file tools have a check-then-use race (no `openat2`/`RESOLVE_BENEATH` in Node).
- Below Landlock ABI 6 (e.g. Ubuntu 24.04, ABI 4), agent commands can signal pigui and other sessions; startup warns.
- Background processes started by one command cannot signal another's successor; a background server must be stopped
  in the command that starts it (the prompt says so).
- Toolchains must live under a granted path (in practice `/usr`); per-session caches mean repeated npm downloads.
- pigui's own API refuses its user, but TCP is unrestricted: agent commands can reach tailnet devices, a cloud
  metadata service, and tailscaled's socket (builds need registries; documented).
- A waiting subagent looks again only when a run it waits on ends; raising `maxInFlight` while one waits can let a
  younger run start first (accepted; order among existing waiters is kept).
- Safari support reported for 27.1; on older iOS the keyboard may overlay the page.
- Memory's LEAF relevance floor (0.28) is thin — ranges overlap; to re-measure on a real store.
- `recall_history` pre-compaction details are the recovery path; there is no other.

## 24. Notes for the reimplementation (opportunities, not prescriptions)

The reference is high quality; the cleanroom rewrite should keep its behavior and rendering and take these
unifications/repairs where they pay:

1. **One definition of the session row.** Grouping/label/tone logic (`describe()`) lives inside `shared/session.ts`
   next to the types; keep it single-sourced (it already is) but make it pure and separately testable.
2. **Installer duplication.** `install.sh`, `deploy/install.sh`, `deploy/onprem.sh`, `deploy/lib.sh`, `deploy/trim.sh`
   and `deploy/models.sh` overlap (Node install, Tailscale, model switches, dry-run helpers). The reference already
   shared `lib.sh` and `models.sh`; keep that shape and push the remaining duplicated steps (apt deps, Node 22 install,
   Tailscale source choice) behind the same helpers.
3. **`PIGUI_MODELS_UNLOAD` is validated in three places** (install.sh, deploy/install.sh, server config). One schema
   shared by the installer's validator and the server's `readConfig` would remove the drift risk.
4. **`.env.example` is the Docker contract only**; the server installer writes a different set
   (`/etc/pigui/pigui.env`). The README must state both, or one file must drive both.
5. **`docs.ts` is a grab-bag** (document tokens, `editSession`, drawer projection, request memory). Splitting into `documents.ts` (tokens + checkpoint policy) and `session-doc.ts` (projection and
   mutation helpers) would match the module-boundary style everywhere else.
6. **Transcript group text** ("Ran N commands, edited M files") is built in two places (client folder and failed-tag
   rendering); one formatter shared by the folded line and the failure badge would keep them consistent.
7. **Notification wording** (`RUN_FAILURES`, banner vs notification) is already single-sourced; keep it that way —
   every new failure reason must be added once.
8. **`pigui.session` is one growing document.** `requests[]`, `notified[]`, `words[]` and `agents[]` all accumulate;
   a long session's document grows without bound. Consider bounded rotation (the reference already caps `requests` at
   100 and `notified` at 200) — `words[]` is deliberately unbounded (compaction carries it); that trade-off should be
   stated, not accidental.
9. **CRLF/whitespace and path normalization** for workspaces is implicit; the reimplementation should state it.
10. **Fake model is 687 lines of inline scenario.** A data-driven scenario table would make variants (`[spin]`,
    `[probe]`, ...) discoverable and testable piecemeal.

---

*Manifest complete. The reference tree stays untouched at `/tmp/pigui-reference` (worktree of
`scratch/kind-fermat-2nkpv5`) for spot checks during the reimplementation.*
