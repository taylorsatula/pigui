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
  (`outcome`), the person's words, notification keys already used, recent request IDs, and what the next compaction
  needs (the summarizer's latest working state, the checkpoint count, a pending handoff request).
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

Seven tools, in `src/server/agent`:

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
- `write_handoff`: a short first-person note, only when picloud asks for one before it compacts the context (see
  "Compaction handoff").

The prompt (`prompt.ts`) is picloud's own preamble, then sections that change rarely: the session
(repository, branch, base, workflow and plan progress), the project's instructions through Pi's
`loadProjectContextFiles` rendered as Pi renders them, Pi's skills list through `loadSkills`/`formatSkillsForPrompt`,
and repo memory. Durable re-sends only changed sections, so prompt caching stays warm.

**The preamble is written from primitives, for unattended runs.** It was rewritten by first listing every fact the
agent needs and every rule the server depends on, each marked as stated, stated badly or missing, and then writing
from that list rather than editing sentences. It is organised around the moments of a run:
- **How a turn ends.** A reply's opening is the notification. Cards are the only way to wait. A report card is the only
  way to deliver, so every change to the repository ends with one, small ones included; before this, a one-line fix
  could end without a Push button.
- **Which path a request needs:** reply, small change and report, or plan.
- **Before the plan.** Explore until you can name the files. Ask only what the repository cannot tell you and only the
  person can decide, all on one card. State the decisions you made in the plan, so approving it approves them.
- **After approval.** Run the tests first, stay in scope, and settle open points yourself. If blocked, file the report
  instead of asking.
- **Verifying.** Never weaken a check to make it pass.
- **Git and this machine.** Commits are added, never rewritten. Nothing changes on GitHub. The shell is
  non-interactive. Touch only your own workspace. These rules beat a repository's own instructions.

Tool descriptions carry only how to fill each field: the report summary's first line is both the notification and the
pull request title. The session section states only this session's facts and its current state; two of its states
had been wrong.

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

**picloud compacts the context itself, led by the agent's own handoff note.** After every tool round, an `afterTools`
hook (`compaction.ts`) measures the context the way Durable does: the usage of the request that made the round's calls,
plus estimates of its results. Past 60% of the model's window it asks for a hook task whose terminal commit steers the
agent: "Your context window is about to be compacted. Call write_handoff now…". The agent answers with `write_handoff`,
a first-person note of about 300 words on what it is doing, what it just learned, its exact next step and what it is
unsure of. At the end of that round the hook asks for picloud's compaction task, which runs as the generation's child
before the round ends. The summarizer writes a checkpoint and chooses the cut. The task's first commit admits a write
whose entry is a head marker (`picloud.compaction`): its `head` is the cut, its model message is the checkpoint, and its
`edits` replace the tool results the summarizer condensed. The task's terminal commit admits a resume steer. Writes are
placed before steers at the round's boundary, so the next request sees the checkpoint, then the kept runway ending with
the note's call and result, verbatim, then "The context window has just been compacted. Please resume with what you
were doing." Both steers are inputs of their own kind (`picloud.compaction-note`). The model sees a user message, the
phone shows a quiet note, and neither is recorded in `doc.words`. If the agent ignores the request, the hook compacts
at the end of its next round anyway, without a note. There is one request per cycle (`handoff.requestedAt` in the
session document), and none in a round the spend cap ends, because a steer queued there would start a run of its own.
The 60% trigger sits 15% of the window below Durable's background threshold, which is 75% with picloud's settings. That
leaves room for one round of large output (a bash result is capped at 50 KB, about 12k tokens) and for the handoff
round, so on a real window the cycle runs before Durable's own compaction. A round that already lands past 75% is left
to Durable.

**Why picloud runs it, and Durable's compaction as the backstop.** Durable's `beforeCompact` hook can supply the
summary but not the cut: Durable chooses its cut itself (`selectCut`) and places the hook's summary there. A marker
placed after that summary can move the context's start, with two limits: the cut can only be Durable's or later, within
the cap; and after a blocking compaction the generation continues at once from Durable's cut, so the summarizer's cut
applies from the next turn. Compacting from `afterTools` has neither limit, and the agent writes its handoff while its
context is still whole. Durable's compaction stays on as a rare backstop: its `beforeCompact` hook writes the same
checkpoint within those limits, with no handoff and no resume turn. *Alternatives:* summaries from the hook alone (the
previous design, with model-written JSON notes that code merged) left the cut to Durable's token count; a reset handoff
(`control.handoff`) would drop the verbatim runway.

**The checkpoint follows mirastyle-compaction.** Its section structure, cut strategy and summarizer prompt (the hurdle
race and its runway, the evidence rules) are ported from the owner's mirastyle-compaction extension for the terminal Pi
agent, adapted to Durable's entries. The summarizer is the session's model, or `PICLOUD_COMPACTION_MODEL` while Pi can
sign in to that model, and writes at most 12k tokens or the model's own limit. It is given the previous working state,
picloud's facts, the agent's note, the newly compacted entries tagged by ID, kind and role, and the kept range, with
each kept entry marked `valid_cutpoint` by Durable's own rule: never a tool result, never between a call and its
result. It returns a cut with one sentence of reasoning, optional one-line notes for kept tool results to condense, and
eight sections: STATE AT COMPACTION BOUNDARY, EVIDENCE TIERS, CODE REFERENCES, DECISIONS AND RATIONALE, COMMANDS, TESTS,
AND FAILURES, WORK QUEUE, OPEN THREADS, COMPACTED HISTORY SYNOPSIS. Code checks every choice (`cut.ts`). The cut must be
one of the valid cuts it was shown, keep the note's call and result, and keep at most the cap (25% of the window). A cut
over the cap moves to the nearest later valid cut within it. Anything else falls back: to the earliest cut within the
cap in picloud's compaction, to Durable's cut in the backstop. Whenever the summarizer's cut is not used, a note in the
checkpoint says why. Only tool results are condensed, never the person's messages or the note's result. A condensed
result keeps its call ID and name, so the pair stays intact, and the stored entry is unchanged, so `recall_history`
still reads the original. How each principle of the runbook is met:

1. **Ground truth over memory.** The repository section (branch, HEAD, ahead/behind of the base, uncommitted files,
   the session's commits and changed files), the plan with its progress, the session's workflow state and the files read
   and modified through the file tools are recomputed by code (`facts.ts`) at every compaction. They are given to the
   summarizer as facts not to restate, and placed in the checkpoint unchanged.
2. **The person's words are never paraphrased.** Every task, answer, approval and message is stored verbatim in the
   session document as it happens and rendered verbatim in every checkpoint.
3. **Accumulate; don't re-summarize.** The summarizer's working state is kept in the session document. At each
   compaction the summarizer is given it as frozen state, with only the entries compacted since (the previous checkpoint
   is not among them), and writes a complete successor: it keeps what still holds, corrects what newer entries
   contradict, and keeps open threads until they are resolved. Code-owned facts are never summarized at all.
4. **Lead with the resume point.** The agent's own note on where it stands and its exact next step stays verbatim,
   right before the resume turn. The working state starts with STATE AT COMPACTION BOUNDARY, and its WORK QUEUE names
   the next exact steps.
5. **Keep negative knowledge.** COMMANDS, TESTS, AND FAILURES holds current failures; DECISIONS AND RATIONALE holds
   what was ruled out.
6. **Point, don't paste.** Long results are cut to their head and tail in what the summarizer reads, with the entry
   number to recall. Condensed results become a one-line note with that pointer. The repository lists point to
   `git log` and `git diff --stat`.
7. **Make loss recoverable.** `recall_history` searches and reads every stored entry. The checkpoint says it exists
   and names the cut and the range it covered.
8. **Verify before trusting.** "Before you act" tells the agent to run `git status` and `git log`, re-read files before
   editing, and not redo finished steps or re-ask answered questions. The header says the checkpoint is historical: the
   files on disk and later messages win.
9. **Never strand the run.** The summarizer's reply is memoized on the compaction task (`api.memo`) before anything is
   placed, so a rerun after a restart never calls it again; a test counts the calls. The marker and the resume turn have
   fixed request IDs, and each is admitted in its own commit: Durable allows one admission per commit. If the summarizer
   errors, returns no checkpoint or has no model, the fallback cut is used and the previous working state is carried
   forward with fresh facts and a "not updated at this compaction" note. A run that ends on a compaction error is
   continued automatically by the supervisor.
10. **Degrade in a fixed order.** The code-owned part has a budget. Over it, lists are shed oldest first, in this order:
    files read, files modified, the changed-file list, the commit list, each with a note of what was left out. The
    person's words, the plan, the session and repository state, the instructions and the working state are never shed;
    the working state is bounded by the summarizer's output limit instead.
11. **Size relative to the model.** Durable's thresholds (reserve 15%, background 10%), the handoff trigger (60%), the
    cap on what is kept (25%) and the code-owned budget (10%) are proportions of the session model's context window. The
    summarizer's input is at most 60% of its own model's window.

**A marker only ever moves the context forward.** Durable places a queued write whose `head` lies before the active
range as `stale` and never appends it (`isStale` in its inbox). A marker whose cut another compaction has already
passed therefore never lands, and cannot bring back entries that compaction hid. Only the newest head marker is ever in
view, so two checkpoints never are. A test holds Durable's background compaction after its summarizer while its
blocking one completes, then checks that neither the held marker nor Durable's summary for it is placed. The backstop
also declines when the context has already moved past Durable's own cut, and when its own marker already landed before a
restart.

The phone shows each compaction as one collapsed "Context compacted" row that opens to the checkpoint and says how many
messages were kept. When the backstop's marker supersedes Durable's summary of the same compaction, the row shows the
marker's checkpoint in the summary's place. Compaction never touches the workflow state.

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

**One small set of values, declared once at the top of `app.css`.** Spacing comes from 2/4/8/12/16/24 px, radii from
four tokens, type from Apple's text styles expressed as fractions of Body (so Dynamic Type scales all of it), colour
from semantic tokens with a dark set, and motion from three durations (160 ms press, 200 ms exit, 400 ms present) and
two curves (a strong ease-out, and the iOS sheet curve). The alternative, values chosen per element, is what the first
pass had, and it showed as nine type sizes and eleven spacings. Motion follows frequency: sending, picking a file,
opening a disclosure and switching the send/stop button are not animated; presses respond at once (filled buttons
scale to 0.97, text and icon buttons dim, rows highlight); the sheet, drawer and toast enter on `--present` and leave
on `--quick`, with CSS transitions so a gesture can interrupt them. Reduced motion keeps the fades and drops the
movement.

**A wide screen gets the same app, laid out for its width.** It has no extra features, only a layout for the
space:
- From 900 px the drawer becomes a persistent sidebar.
- Every band of a page runs the full width of its pane: title bar, status line, transcript, composer bar, setup
  form. So the bars and their hairlines meet the pane's edges, while the content keeps to a centred 760 px reading
  column. This is padding computed from the pane width, so no wrapper elements are needed.
- Without the menu button, the title lines up with the content.
- Toasts centre on the conversation, not on the window.
- The diff sheet becomes a centred dialog, as iPad and Mac present sheets. It fades and grows slightly into place
  rather than rising from the bottom edge, and is wider for patches.
- The grabber appears only when the device has touch, since only touch can drag the sheet.

**Sheets, the drawer and toasts follow the finger and dismiss the ways people expect.** The diff is a bottom sheet with
a grabber and Done; it also closes with Escape, a tap on the dimmed page, or a drag down from its bar (or from its
content when it rests at the top). A released drag settles where its momentum would carry it, projected with iOS's
scroll deceleration as Apple's "Designing Fluid Interfaces" describes, so a short flick and a long slow drag are judged
by one rule; the finger's speed is read over its last 100 ms, so a finger that stopped before lifting is not a flick. The drawer drags open from the left edge and shut from
anywhere, and closes with Escape. A toast rises just above the composer, can be
swiped down, and its clock stops while a finger is on it or the app is in the background. The gestures are one small
hook each (`src/client/motion.ts`, `useDrawerDrag`) on touch events, which hand the remaining motion to the
stylesheet's transitions; a gesture library would bring more than these three need.

**The page follows the transcript's end, in one place.** `src/client/viewport.ts` keeps the end in view while the
person is at the bottom (new content, a taller composer, a banner, the keyboard resizing the viewport), stops when they
scroll up, re-pins when they send, and keeps the reading position by hand when earlier messages load, since Safari has
no scroll anchoring. It publishes the visible viewport's height for things that must fit above the keyboard. The page
keeps scrolling as a document rather than inside a fixed app shell: that keeps iOS's tap-the-status-bar-to-top and
toolbar collapse, and relies on `interactive-widget=resizes-content`, which Chrome and Firefox on Android honour.
Safari support is reported for 27.1 but not confirmed here; on older iOS the keyboard overlays the page, so the title
bar scrolls out of view while typing. A fixed shell sized from `visualViewport` would avoid that at the cost of the two
iOS behaviours above, and of moving every scroll path onto an inner element.

## Fake mode

The scripted model is Pi's faux provider with one response factory queued per request, so it never runs dry and every
response is a function of that request's messages: concurrent sessions cannot steal each other's script. The step a
conversation is at is read from the ID of its newest scripted tool call (handoff notes and recall lookups aside), which
survives compaction because the scripted summarizer always cuts at or before it; directives in the task select
variations, and the scripted summarizer answers picloud's prompt in its format, with directives of its own. Its tokens are priced, because the faux provider reports zero
cost and the spend cap must be testable. The GitHub stand-in implements the same `RepoHost` interface as `gh`, with
bare repositories for clone and push (so delivery runs real git) and a JSON file of pull requests. *Alternative:* a
fake `gh` executable on `PATH` would exercise the real argument building but couple tests to a shell script and to
`gh`'s output formats.

## Tests

Automated tests use `node:test` (no test framework dependency) against the real server and real Durable SQLite
storage, and wait on Durable watches instead of sleeping. Crash timing is tested with explicit fault seams (`faults` in
`AppOptions`) that hold code at the exact point a crash matters (after a card's commit, after the summarizer's reply is
memoized) until the Harness closes; this is deterministic where killing a process at a random moment is not.

## The installer

A bash script, because it has to run on a machine that does not have Node yet. Every change goes through two helpers
(`run`, `write_file`) that print instead of acting in `--dry-run`, every step checks before it changes anything, and
the configuration file keeps existing values unless an option replaces them, so re-running upgrades in place. It ends
by listing the steps only a person can do. The systemd unit uses `RestartPreventExitStatus=78` so a missing Pi
sign-in waits for a person instead of restarting in a loop.

## Running in Docker

**Two containers: Tailscale as a sidecar, picloud sharing its network.** picloud keeps listening on loopback only,
and `tailscale serve` is the only way in, as on the installer path. So the security model does not change, and the
`Tailscale-User-Login` header still comes only from Tailscale. The alternative, publishing a port on the host, would
put picloud on the droplet's public interface. Tailscale uses its documented setup for serving from a container:
kernel networking with `/dev/net/tun`, a serve file applied at start, and the auth key used once.

**Configuration lives in one `.env` that compose reads.** Each value goes only to the container that needs it: the
auth key to Tailscale, `GH_TOKEN` and the `PICLOUD_*` settings to picloud. GitHub access uses `GH_TOKEN`, which `gh`
reads and which git reaches through gh's credential helper (configured system-wide in the image). That is the same
access the service user's `gh` login gives under the installer. Pi's sign-in stays interactive (`docker compose run
--rm picloud pi`), because it often uses Pi's own subscription login, and writing Pi's configuration ourselves would
take that over from Pi.

**The image is Ubuntu 24.04, with Node copied from the official Node image.**
- Ubuntu 24.04 is what the installer targets, so the agent's tools are the same on either path.
- `gh` comes from Ubuntu's own archive rather than a third-party apt repository.
- Copying Node pins it exactly (22.23.4), which NodeSource's 22.x channel would not.
- A build stage installs everything and builds the phone app; the runtime stage keeps production dependencies only.
- Base images are pinned by exact tag. Ubuntu packages follow the pinned snapshot's archive.

**Both containers run with least privilege.**
- **picloud**
  - runs as an unprivileged user;
  - has every Linux capability dropped and `no-new-privileges` set;
  - has the setuid and setgid bits stripped from the image;
  - has a read-only root filesystem, writing only to the `data` volume, its `home` volume and a size-capped `/tmp`.

  The agent still builds and runs code: the volumes and `/tmp` allow it to execute programs, and npm and the like keep
  their caches in the home volume. That is why the volume is now the whole home directory and not just `~/.pi`. A
  process limit (1024) contains a runaway test.
- **Tailscale** keeps only `NET_ADMIN` and `NET_RAW`, the two capabilities its tunnel and firewall rules need, on a
  read-only root.

Userspace networking would drop even those two, and the tun device too. But Tailscale's own documentation
contradicts itself on whether serve works in that mode, so the documented kernel-mode setup stays until it has been
tried on a real tailnet. `GH_TOKEN` stays an environment variable, because gh and git read it from there. It is
visible to whoever can run `docker inspect`, which on the host already means root.

**Not signed in is left to Docker's restart backoff.** systemd's `RestartPreventExitStatus=78` has no Docker
equivalent. A wrapper script that waits for a person would sit between the init process and picloud, and break the
clean shutdown on stop. Docker's growing restart delay keeps the loop cheap, and every attempt logs the instructions.

**Trimming the host is its own script, for either way of deploying.** `deploy/trim.sh` masks a fixed list of
services that a machine running only picloud never uses, adds swap and caps the journal. It shares the installer's
dry-run helpers, through `deploy/lib.sh`.
- **Masked, not disabled.** Several of these services (packagekit, fwupd, udisks2, ModemManager) start on demand over
  D-Bus, and disabling a service does not stop that.
- **Kept on purpose:**
  - SSH, networking, DNS and time sync;
  - cron, AppArmor and security updates;
  - cloud-init and the provider's agents, which resizing, the web console and backups depend on.
- **What it buys.** The masked services hold on the order of 100 MB on a stock Ubuntu image. The swap file matters more
  for the agent's test runs: a spike past memory slows them down instead of getting them killed.

## Slash commands: not built

Pi Durable has no command concept; its extensions contribute tools, hooks, tasks, prompt sections and documents. Pi's
slash commands belong to the terminal agent:
- built-ins such as `/model`, `/tree` and `/login`, implemented inside its interactive mode;
- extension commands, whose handlers drive an `AgentSession` and draw their menus through `ExtensionUIContext`,
  including arbitrary terminal UI components;
- prompt templates.

picloud runs Durable conversations, not an `AgentSession`. So no generic way exists to enumerate these commands,
run them, and render their inner menus in the web app; each would need its own adapter. The one generic piece is
prompt templates: markdown files with a description and an argument hint, loaded and expanded by Pi's own functions.
They could appear in the composer the way skills do with `#`, but they have no inner menus, so they were left for a
decision of their own.

## Dependencies

Pinned exactly, with the lockfile committed: the five `@earendil-works/*` packages at 1.6.0; `preact`, `marked` and
`dompurify` for the client; `esbuild`, `typescript`, `@types/node` and `@playwright/test` (matching the installed
Chromium) for building and testing. Apart from the `@earendil-works/*` versions the runbook fixes, each version was at
least two weeks old when it was chosen.
