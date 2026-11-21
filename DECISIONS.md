# Design decisions

Each entry says what was chosen, what else was considered, and why. They are written for whoever maintains picloud
next; when a decision changes, change its entry.

## Architecture

**One process, one Harness, one SQLite storage; a session is a Durable conversation.** `startApp()` opens a single Pi
Durable Harness over `picloud.sqlite` and serves HTTP from the same process. Each session is an ownerless conversation
with its own working directory (`workspaces/<id>`), model, turn limit and compaction settings in its `pi.agent`
document; the root conversation is never used for chat and owns the daily maintenance task. *Alternatives:* a Harness
(and storage) per session would isolate sessions but break "one writable process per storage" as soon as anything
looked across them (the drawer, notifications, maintenance), and would multiply open SQLite files; a separate worker
process per run would rebuild what Durable already does (scheduling, recovery, live state). One Harness gives one
commit line, so every decision that spans sessions is atomic.

**The server runs its TypeScript directly** with Node's type stripping (Node ≥ 22.19, which the runbook requires), so
there is no server build step and no compiled JavaScript to keep in step with sources. The code is restricted to
erasable syntax (`erasableSyntaxOnly`), and imports name `.ts` files. *Alternative:* `tsc` to `dist/` — one more
artifact to forget to rebuild, for no runtime benefit.

**Module boundaries.** `src/shared` holds every shape both sides use (API payload schemas, documents, the live
protocol, reference syntax). `src/server/agent` is everything picloud adds to Pi (tools, prompt, spend cap, handoff) and
knows nothing of HTTP. `sessions.ts` owns the session lifecycle and every action the person takes; `supervisor.ts` owns
what happens when a run ends; `delivery.ts` owns pushes, pull requests and the diff; `notify.ts` and `webpush.ts` own
notifications; `maintenance.ts` owns cleanup and backups; `http.ts` is only the boundary. Each talks to the others
through small typed interfaces (`AgentServices`, `SessionsDeps`, `RepoHost`, `PushSender`).

## Data model

**Everything picloud remembers is a Durable document, changed in the same commits as the agent's own state.**

- `picloud.session` (conversation scope): the repository, branches, setup state, workflow, plan and progress, the
  pending card, the report, delivery state, spend cap, the run picloud started (`activeRun`), how the last run ended
  (`outcome`), the person's words, notification keys already used, recent request IDs, and the handoff notes.
- `picloud.index` (session scope, one per Harness): one drawer row per session, plus the last repository and recent
  session-creation request IDs.
- `picloud.repo-memory` (session-scoped family keyed by repository): what reports learned about building and testing.
- `picloud.push-subscriptions` (session scope).

The drawer row is a *projection* of the session document (`sessionRow()` in `src/shared/session.ts`), recomputed by
`editSession()` in every commit that changes the session, so it cannot drift. *Alternatives:* a separate SQLite table
or JSON files would be a second store with its own consistency problems; a single session-scoped document holding all
sessions in full would make every keystroke-sized change to one session rewrite a document every phone watches; scanning
every conversation to build the drawer would mean watching N documents. A session-scope document is one singleton per
Harness, which is exactly what the index needs.

The run's own state (streaming text, running tools, usage, inbox, run failure) stays in Durable's built-in documents;
picloud never copies it.

## API and live-update protocol

**HTTP with JSON bodies validated by pi-schema at the boundary.** Request schemas live in `src/shared/api.ts`; the
server compiles them and the client types its calls from them, so there is one definition of each shape. Every request
that changes something carries a client-chosen request ID; the server records handled IDs in the session document in
the same commit as the change (and creation IDs in the index), so a retried send never acts twice. The client keeps the
ID with the draft until the server answers.

**One newline-delimited JSON stream per open app** (`GET /api/live?session=&from=`). It carries the drawer index and,
when a session is open, that session's picloud document and Durable conversation view. Each source sends its value
once, then the Chord operations of later commits, straight from Durable's watches; the phone applies them with
`@earendil-works/chord/delta` and keeps the transcript in Durable's own `ConversationTranscript`, which loads older
entries on demand and fills gaps. On reconnect the phone asks for the window starting after the newest entry it has
(`transcript.resume`), so a reconnect costs only what was missed. *Alternatives:* WebSockets add a protocol and a
dependency for no gain on a one-way feed; `EventSource` cannot change its URL between reconnects, and the `from` cursor
must change; polling contradicts "live updates come from watches". A watchdog (no data for 2.5 ping intervals)
reconnects through half-dead mobile connections. The app closes the stream when it goes to the background, which is
also how the server knows whether the person is looking (presence, used to suppress notifications).

## Agent tools and prompt

Six tools, in `src/server/agent`:

- `ask_single_choice` and `ask_multiple_choice`: several questions per card; the single-choice one requires a
  recommended option (shown first and pre-selected), and every question accepts free text. Two tools rather than one
  with a mode flag, because the model chooses a tool more reliably than a parameter, and each schema can say exactly
  what it needs (recommendation required vs. absent).
- `submit_plan`: title, summary, steps; waits for approval or feedback. Approval moves the workflow to `implementing`;
  feedback comes back verbatim and the model revises.
- `update_progress`: step numbers done.
- `file_report`: summary, changes, verification, notes, and `learned` (which replaces the repository's memory). It
  checks the workspace itself: refused with uncommitted changes, refused when the branch is behind `origin/<base>` after
  a fetch. A successful report ends the run (`terminate`), so no tokens are spent on a sign-off.
- `recall_history`: search or read the full history, including what compaction removed from view.

The prompt (`prompt.ts`) is picloud's own preamble (running remotely, the person usually away, how to work: answer
simple things directly, explore → ask once → plan → approval → work to completion, verify, commit but never push or
switch branches, merge the base before reporting, report honestly), then sections that change rarely: the session
(repository, branch, base, workflow and plan progress), the project's instructions through Pi's
`loadProjectContextFiles` rendered as Pi renders them, Pi's skills list through `loadSkills`/`formatSkillsForPrompt`,
and repo memory. Durable re-sends only changed sections, so prompt caching stays warm.

**Waiting is a parked tool.** A question or plan tool commits its card (and its notification) to the session
document, then returns `{ sleep: { signals: [picloud.card-answer] } }`; the call holds no process. The person's answer
is delivered with `tx.signal()` in the same commit that clears the card and records their words, so the answer and the
state change cannot separate. A rerun of the tool before its park was stored finds its card (keyed by call ID) and
neither shows a second card nor notifies again; the card's revision and time are memoized for the same reason.

## When a run ends: the supervisor and continuation

Durable settles the submission that started a run when the run ends. The supervisor observes committed submissions
(`observeCommits`) and, for a session whose `activeRun` just settled, makes one commit that decides what follows and
clears `activeRun`. That single commit makes each decision exactly once, and a reconcile of every session at startup
catches a run that ended while nothing was watching. It handles:

- an answer during implementation without a report → an automatic continuation (a `picloud.nudge` input, shown as such
  in the transcript), at most three times since the plan was approved or the person last spoke; then "stopped without a
  report" and a notification;
- an answer outside implementation → "replied" and a notification;
- a run ended by a failed compaction (`model_error`, "Compaction failed…") → a Durable `continue`, at most three times;
- any other failure → "failed" with the reason, a notification and a Continue button; a stop → "stopped", no
  notification.

*Alternatives considered:* `onYield` hook tasks keep the run alive across a continuation, but Durable then appends a
plain `pi.user` message the phone cannot tell from the person's own words, and no hook sees failed runs, so a second
mechanism would be needed anyway; a monitor task per run parked on `SubmissionSettled` would be durable too, but needs
the submission to be made from inside the task, which makes steering (an immediate submit in the HTTP commit) awkward.
One observer plus one idempotent reconcile covers every way a run ends.

**Bounds.** The turn limit is Durable's `maxTurns` per run (`PICLOUD_MAX_TURNS`). The spend cap is an `afterTools`
hook: once the session's spend (from `pi.usage`) reaches its cap, a task ends the run after that round, before the next
model request, records "budget reached" and notifies. *Alternative:* aborting the conversation from outside would race
the run and could cut a tool call in half. Raising the cap submits a `continue` that resumes from the round's tool
results. New runs are refused while over the cap.

## Compaction handoff

picloud supplies the summary through `hook(CompactionTask, { beforeCompact })`, so the built-in summarizer only runs if
picloud's hook fails. Thresholds are set per session from its model's context window. How each principle is met:

1. **Ground truth over memory.** The repository section (branch, HEAD, ahead/behind of the base, uncommitted files,
   the session's commits and changed files), the plan with its progress, and the session's workflow state are
   recomputed by code from the workspace and the session document at every compaction. The model never writes them.
2. **The person's words are never paraphrased.** Every task, answer, approval and message is stored verbatim in the
   session document as it happens and rendered verbatim in every handoff.
3. **Accumulate; don't re-summarize.** The model-written notes (resume point, findings, failures, open items) are
   stored in the session document. At each compaction the model sees the stored notes as JSON plus only the newly
   compacted entries (the previous summary is excluded) and returns an *update*: a new resume point, items to add,
   item IDs to resolve. Code merges it; unresolved items persist until resolved.
4. **Lead with the resume point.** The handoff opens with what was in progress, the latest result and the exact next
   action, then the instructions for acting on it.
5. **Keep negative knowledge.** "Tried and failed" is its own accumulated list.
6. **Point, don't paste.** Long tool results are cut in what the summarizer reads, with the entry number to recall;
   the handoff lists the compacted tool calls with where their results are, and the repository lists point to
   `git log` and `git diff --stat` rather than reproducing them.
7. **Make loss recoverable.** `recall_history` searches and reads every stored entry, and the handoff says it exists.
8. **Verify before trusting.** "Before you act" tells the agent to run `git status`/`git log`, re-read files before
   editing, and not redo finished steps or re-ask answered questions.
9. **Never strand the run.** The model-written notes are memoized on the compaction task before the summary is
   returned, so a restart mid-compaction reuses them (a test counts the summarizer calls). A failed or unparseable
   summarization keeps the previous notes, reconstructs a resume point from the last entries, and still returns a full
   handoff. A run that ends on a compaction error is continued automatically by the supervisor.
10. **Degrade in a fixed order.** The handoff has a budget; over it, it sheds oldest-first, in this order: history
    pointers, the changed-file list, the commit list, findings, failed attempts, open items, each with a note of what
    was left out. It never sheds the resume point, the person's words, the plan, the session state, the repository
    state or the instructions.
11. **Size relative to the model.** Compaction thresholds (reserve 15%, keep 25%, background 10%) and the handoff
    budget (10%) are proportions of the session's model's context window.

The phone shows each compaction as a collapsed "Context compacted" row that opens to the handoff. Compaction never
touches the workflow state.

## References in messages

`@path` and `#skill` follow one rule in `src/shared/references.ts`, used by both the composer's picker and the server:
a sigil starts a reference only at the start of the text or after whitespace or an opening bracket or quote, so
`me@example.com` and `a#b` stay text, and `#123` is an issue number. A file reference brings the file's contents (up to
64 KB), or a pointer for a directory, a larger file or a binary file; a path that leaves the workspace or enters `.git`
is ignored. A skill reference invokes the skill exactly as the Pi CLI's `/skill:` does (`<skill name location>` block,
frontmatter stripped, "References are relative to"), found with Pi's `loadSkills`. Unknown references stay plain text.
The person's text is stored as typed in the entry's data; the added context goes into the model's message ahead of the
text, and the transcript shows it as compact chips. On the New session view the pickers read the chosen branch through
the repository host before anything is cloned.

Attachments are uploaded first (photos shrunk on the phone to 2048 px JPEG), then saved under
`.picloud/attachments/` in the workspace, which setup adds to `.git/info/exclude` so they can never be committed.
Images also reach the model, fitted to its limits by Durable's `fitImage`, when the model accepts images.

## Delivery and the diff

Only the server pushes, and only when the person taps: `git push` without force to the session's branch, and for a
pull request, `gh pr list --head` first so an existing one is reused, otherwise `gh pr create` with the report as its
body. A push rejected because the remote moved is reported as such, with the next step (ask Pi to merge the remote
branch). Delivery is refused while a run is active. The diff is measured from where the session's own work began: the
fork point with the base when the base has been merged in, otherwise the commit the session started from, so neither
the base's later commits nor a continued branch's earlier commits show as the session's.

## Notifications

Notifications are enqueued in the commit that creates the need, keyed (`card:<call>`, `report:<call>`, `run:<sub>`,
`budget:<task>`), and delivered by a background Durable task, so a restart between the commit and the send still sends,
and a rerun of the code that enqueues never sends twice. The send itself is at-least-once (a crash after sending and
before committing sends again); the notification's tag (one per session) and the push Topic header make a repeat
replace the first on the phone. A session the person is viewing is not notified. Web Push is implemented on
`node:crypto` (RFC 8291 encryption, RFC 8292 VAPID), verified against the RFC's test vector. *Alternative:* the
`web-push` package — about ten transitive dependencies for roughly 80 lines of standard cryptography.

## Cleanup and backups

One Durable task in the root conversation sleeps a day between rounds: it backs up the database with SQLite's online
backup (`node:sqlite` `backup()`, 14 kept), removes stale uploads, and removes the workspace of a session archived more
than seven days ago only when git shows nothing uncommitted, HEAD on the session's branch at origin (or already in its
base), and no other local branch with commits origin lacks. *Alternatives:* systemd timers would need a second process
opening the database and a `sqlite3` package; a sleeping Durable task costs nothing while it waits, survives restarts,
and is covered by the same tests.

## The phone app

**Preact with TSX, bundled by esbuild.** The UI has real state (a streamed transcript, cards, pickers, a drawer), and
a 10 KB virtual-DOM library keeps it declarative; esbuild is a single binary that bundles TypeScript with no
configuration, which the runbook's "no heavy bundler pipeline" allows. Markdown is `marked` with `DOMPurify`, both
dependency-free. The service worker caches the app shell (network first, cache when offline) and never caches the API.

How the Human Interface Guidelines shaped it:

- **Clarity:** the composer's placeholder says what sending will do now ("Answer in your own words…", "Steer Pi while
  it works…"); tool activity is one plain sentence ("Ran 2 commands, edited 1 file"); failures name the problem and
  offer the next step (Continue, Raise to $X and continue, Retry setup).
- **Deference:** content first — status and spend are a quiet line under the title; thinking, tool calls and handoffs
  are collapsed until asked for; the agent's prose is ordinary text, the person's words are bubbles.
- **Sensible defaults:** the last repository, a new branch from its default branch, recommended options pre-selected
  so accepting them is one tap.
- **Familiar navigation:** a ☰ drawer (and an edge swipe) on phones, a persistent sidebar on wide screens; the drawer
  groups sessions as "Needs you", "Working", "Done", and a dot on ☰ means another session needs you.
- **Feedback and forgiveness:** archive is immediate with an Undo toast instead of a confirmation dialog; drafts are
  saved as they are typed.
- **Accessibility:** the system font at the person's text size (`-apple-system-body`), system-like colours in light and
  dark with sufficient contrast, 44 pt targets (checked by an end-to-end test), safe areas, the keyboard resizing the
  layout (`interactive-widget=resizes-content`), reduced motion respected, and roles, labels and live regions for
  screen readers.

## Fake mode

The scripted model is Pi's faux provider with one response factory queued per request, so it never runs dry and every
response is a function of that request's messages: concurrent sessions cannot steal each other's script. The step a
conversation is at is read from the ID of its newest tool call, which survives compaction because the kept tail always
ends with it; directives in the task select variations. Its tokens are priced, because the faux provider reports zero
cost and the spend cap must be testable. The GitHub stand-in implements the same `RepoHost` interface as `gh`, with
bare repositories for clone and push (so delivery runs real git) and a JSON file of pull requests. *Alternative:* a
fake `gh` executable on `PATH` would exercise the real argument building but couple tests to a shell script and to
`gh`'s output formats.

## Tests

Automated tests use `node:test` (no test framework dependency) against the real server and real Durable SQLite
storage, and wait on Durable watches instead of sleeping. Crash timing is tested with explicit fault seams (`faults` in
`AppOptions`) that hold code at the exact point a crash matters (after a card's commit, after the handoff notes are
memoized) until the Harness closes; this is deterministic where killing a process at a random moment is not.

## The installer

A bash script, because it has to run on a machine that does not have Node yet. Every change goes through two helpers
(`run`, `write_file`) that print instead of acting in `--dry-run`, every step checks before it changes anything, and
the configuration file keeps existing values unless an option replaces them, so re-running upgrades in place. It ends
by listing the steps only a person can do. The systemd unit uses `RestartPreventExitStatus=78` so a missing Pi
sign-in waits for a person instead of restarting in a loop.

## Dependencies

Pinned exactly, with the lockfile committed: the five `@earendil-works/*` packages at 1.6.0; `preact`, `marked` and
`dompurify` for the client; `esbuild`, `typescript`, `@types/node` and `@playwright/test` (matching the installed
Chromium) for building and testing. Apart from the `@earendil-works/*` versions the runbook fixes, each version was at
least two weeks old when it was chosen.
