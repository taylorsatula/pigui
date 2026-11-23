# Design decisions

Each entry says what was chosen, what else was considered, and why. They are written for whoever maintains picloud
next; when a decision changes, change its entry.

## Architecture

**One process, one Harness, one SQLite storage; a session is a Durable conversation.** `startApp()` opens a single Pi
Durable Harness over `picloud.sqlite` and serves HTTP from the same process. Each session is an ownerless conversation
with its own working directory (`workspaces/<id>`, or in OnPrem a directory the person chose), model and compaction
settings in its `pi.agent` document; the root conversation is never used for chat and owns the daily maintenance task. *Alternatives:* a Harness
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

- `picloud.session` (conversation scope): where the session works (`place`: a repository with its branches and
  delivery state, or a local directory), setup state, workflow, plan and progress, the pending card, the report, spend
  cap, the run under way (`activeRun`), how the last run ended
  (`outcome`), the person's words, notification keys already used, recent request IDs, and what the next compaction
  needs (the summarizer's latest working state, the checkpoint count, a pending handoff request).
- `picloud.index` (session scope, one per Harness): one drawer row per session, plus the last repository and recent
  session-creation request IDs.
- `picloud.repo-memory` (session-scoped family keyed by repository, and one member, `this computer`, for every local
  session): what reports learned about building and testing.
- `picloud.memory` (session scope): long-term memory, when it is on (see "Long-term memory").
- `picloud.push-subscriptions` (session scope).

The drawer row is a *projection* of the session document (`sessionRow()` in `src/shared/session.ts`), recomputed by
`editSession()` in every commit that changes the session, and for every session when picloud starts, so it cannot
drift and rows an earlier version wrote take the current shape. *Alternatives:* a separate SQLite table
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

Seven tools, in `src/server/agent`, and an eighth, `surface_memories`, while long-term memory is on (see "Long-term
memory"):

- `ask_single_choice` and `ask_multiple_choice`: several questions per card; the single-choice one requires a
  recommended option (shown first and pre-selected), and every question accepts free text. Two tools rather than one
  with a mode flag, because the model chooses a tool more reliably than a parameter, and each schema can say exactly
  what it needs (recommendation required vs. absent).
- `submit_plan`: a structured plan (below); waits for approval or feedback. Approval moves the workflow to
  `implementing`; feedback comes back verbatim and the model revises.
- `update_progress`: step numbers done.
- `file_report`: a structured report (below), and `learned` (which replaces the repository's memory). In a
  repository session it checks the clone itself: refused with uncommitted changes, refused when the branch is behind
  `origin/<base>` after a fetch; a local session, with nothing to deliver, is not checked. A successful report ends the run (`terminate`), so no tokens are spent on a sign-off. While long-term memory
  is on, it also takes a required `memory` part.
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
- **Long-term memory**, while it is on: one search once the work's machinery can be named, more only for machinery
  that search missed or for a surprise, and the report records and grades.
- **Git and this machine.** Commits are added, never rewritten. Nothing changes on GitHub. The shell is
  non-interactive. Touch only your own workspace. These rules beat a repository's own instructions.

Tool descriptions carry only how to fill each field: the report's headline is both the notification and the pull
request title. The session section states only this session's facts and its current state; two of its states
had been wrong.

**Plans and reports are structured, part by part.** A plan written as a paragraph and a list of steps read as a wall
of text on a phone, and left out what a reviewer most needs: what "done" means, what the agent decided without asking,
and what it read. So `submit_plan` takes the parts a reviewer checks, each a list of one-line items: a `goal` (one to
three sentences), an `endState` (conditions a reviewer could check, not activities), `decisions` (choice and reason;
approving the plan approves them), `steps` with the `files` each touches, `verification` (the commands it will run),
`outOfScope`, `risks`, and `citations` (a path, `path:line` or URL, and what it shows). Every part is required; a list
may be empty only where its description allows, so the model states each part out loud rather than leaving it out.
`file_report` mirrors it, so the card can set what was asked beside what was done: a `headline` (the notification and
the pull request title), a short `summary`, an `outcome` (`complete`, `partial`, `blocked`), each end-state condition
restated with `met` and its `evidence`, `changes` with their files, `checks` (the exact command, `passed`, `failed` or
`not run`, and what it showed), `deviations` from the plan, and `notes`. The agent sees the plan's end state again in
the session section while it works and in checkpoints, since its report must answer it. The same structure renders
three ways: the card, the pull request's description (a GitHub task list for the end state), and what is read aloud.
The shapes live once, in `src/shared/session.ts`, and extending one means adding a field there, to the tool's
parameters and to the card. Plans and reports filed before this keep their older shape in storage; `planOf` and
`reportOf` read either as the current one, where they are rendered or summarised. *Alternatives:* Markdown with
required headings is what models drift from, and a card cannot tell an empty section from a forgotten one; asking for
structure in the prompt alone is advice, where a schema is enforced.

**Waiting is a parked tool.** A question or plan tool commits its card (and its notification) to the session
document, then returns `{ sleep: { signals: [picloud.card-answer] } }`; the call holds no process. The person's answer
is delivered with `tx.signal()` in the same commit that clears the card and records their words, so the answer and the
state change cannot separate. A rerun of the tool before its park was stored finds its card (keyed by call ID) and
neither shows a second card nor notifies again; the card's revision and time are memoized for the same reason.

## Long-term memory

**The pi-durable-memory extension's memory, rebuilt on Durable and recorded by the report.** Pi keeps what no file
states (a host's state, a harness's behaviour, a measurement that cannot be repeated) and finds it again in later
sessions, in any repository, by embedding similarity. The original's directive for writing a memory (its eleven rules
and four worked examples, directive v3), its ranking (a cosine floor of 0.44, the best eight, ratings moving the rank
by at most 0.25) and the text of a search result are ported verbatim (`src/server/memory`), changing only wording that
named its tool or its `checkpoint` op. What differs, and why:
- **A Durable document** (`picloud.memory`) instead of the original's own SQLite file: changes commit with the report
  that makes them, and restarts and backups cover memory like everything else. Vectors are stored as base64 and
  searched in memory, as the original did; fine up to a few thousand memories.
- **Pi's credentials.** pi-ai has no embeddings API, so picloud posts to the original's OpenAI-compatible endpoint
  itself, signed with the key Pi resolves for `PICLOUD_MEMORY_PROVIDER` (a provider in its models.json) or stores for it
  (auth.json). With neither and no explicit URL, memory is off and nothing of it reaches the agent. A re-embedding,
  after a model change or golden-vector drift, goes in batches of 128 rather than one request a large store outgrows.
- **Recorded and graded in the report.** The original returned instructions from a `checkpoint` call and asked for a
  second call to record, which models skip. Filing a report is the finalization picloud's agent already does
  reliably, part by part, so `memory` is a required part of `file_report` (`create`, `helpful`, `edit`, `delete`, each
  required, each may be empty), applied in the report's own commit inside its rerun guard. The ids a search showed are
  kept on the session (`memoryShown`), so the report is refused while one is unrated, naming each with its text even
  after a compaction. A failed embedding still files the report, with a note: the work matters more.
- **Fewer, later searches.** The original asked for a search before the first state-changing action, again on every
  pivot to another subsystem, file or mechanism, and for every task. That searched too early, before the model could
  name the machinery, so the query matched nothing and it searched again; and too often, on every file. picloud's flow
  has natural moments instead: once the files and commands are known, before asking or planning; when the work reaches
  machinery that search did not cover; and when something behaves unexpectedly, with the error text. The search
  result's "surface again on every new subsystem" line is replaced to match.
- **Not ported:** encryption at rest and the read-only global store (one person, one store, in a data directory only
  the service user reads), the refinement pass with its byline and legacy migration (no older rows exist), release
  notes, the settings menu, `/durable-memory` and its config.json (configuration is environment variables, as for the
  rest of picloud), and the `checkpoint` op, which the report replaces. Repo memory (`learned`) stays apart: a short
  build-and-test note read into every session on its repository, not a searched store.

*Alternatives:* installing the extension unchanged would keep a second store outside Durable's commits, its own key
and settings, and the checkpoint call models skip; a store per repository would lose what holds across repositories,
such as a host's state; reading the surfaced ids back from the transcript would miss those a compaction removed. Fake
mode embeds by hashing words into counts, seeded by the model's name, so tests search and re-embed without a network.
The compaction tests run with memory off, because their context windows are calibrated to the prompt without it.

**LEAF on the server, as a build-time switch (`PICLOUD_MEMORY_LOCAL`, default off).** Memory without a key or a
network: [mdbr-leaf-ir-asym](https://huggingface.co/MongoDB/mdbr-leaf-ir-asym), run through transformers.js on the CPU,
8-bit. The asymmetric model is packaged from two others whose weights it repeats byte for byte, so picloud loads their
ONNX exports: `MongoDB/mdbr-leaf-ir` (23M parameters, with the query prompt) for searches, and
`Snowflake/snowflake-arctic-embed-m-v1.5`, the space LEAF was distilled into, for memories, which are embedded once and
searched many times. Each export ends in the model's own pooling, projection and normalisation, so a vector is its
`sentence_embedding` output as it stands. The embedder is told which side a text is on (`query` or `document`); the
endpoint ignores it. Measured here: half a second to load, 23 ms a search, 29 ms a memory, about 300 MB resident,
loaded as the server starts and kept, as Kokoro is. Three choices in it:
- **One text per forward pass.** The 8-bit exports quantize activations with one scale per tensor, taken over the whole
  batch with its padding, so a memory embedded beside others came out at cosine 0.990 to itself embedded alone. Stored
  vectors must reproduce (the golden check depends on it), so every text runs alone; re-embedding a thousand memories
  takes about 30 seconds, once.
- **A floor per model.** The cosine floor moved from the store onto the embedder: 0.44 for `emb-qwen3`, as the original
  measured, and 0.28 for LEAF, measured with the original's method on 14 memories written to its rules, each with a
  distill sharing no content word, and its 12 off-topic queries. LEAF's ranges overlap (off-topic peak 0.275, weakest
  matches 0.263 and 0.286), so the floor sits just above the off-topic peak, since its job is to keep off-topic work
  from surfacing anything: 13 of 14 targets clear it, 12 rank first. Thin; to re-measure on a real store.
- **Which embedder.** An explicit `PICLOUD_MEMORY_EMBED_URL` wins, then LEAF where it is built in, then the provider's
  endpoint with Pi's key. Building LEAF in is a choice made for this server, so it comes before a key that may be there
  for other reasons. Off by default, so an existing setup keeps `emb-qwen3`, the better-measured model; speech stays on
  by default because it has no alternative.

`deploy/models.sh DIR [speech] [memory]` replaces the speech model's own script: one download loop and checksum list
for both, and it removes the model of a feature not named, because picloud turns a feature on wherever it finds its
model, so a model left from an earlier install would overrule the switch. The optional packages are pruned only when
both switches are off, since they run both models; with speech off and LEAF on, `kokoro-js` stays (about 33 MB),
unused without its model.

**Memory off is said in the sidebar.** A server without an embedder runs, without memory, and the sessions look the
same, so nothing else would show that it is off. `Bootstrap.memory` carries `{ on: true, model }` or `{ on: false, reason }`, the
reason naming the cause and how to turn memory on, and the sidebar shows it in the banner's warning style, outside the
scrolling list, for as long as memory is off. Not a toast or a dismissible banner: it is a standing condition of the
server, not an event.

## When a run ends: the supervisor and continuation

Durable settles the submission that started a run when the run ends. The supervisor observes committed submissions
(`observeCommits`) and, for a session whose `activeRun` just settled, makes one commit that decides what follows and
clears `activeRun`. That single commit makes each decision exactly once, and a reconcile of every session at startup
catches a run that ended while nothing was watching. It handles:

- an answer during implementation without a report → an automatic continuation (a `picloud.nudge` input, shown as such
  in the transcript), at most three times since the plan was approved or the person last spoke; then "stopped without a
  report" and a notification;
- an answer outside implementation → "replied" and a notification;
- a run that ended as Durable started the next with a message queued behind it (one sent while the answer was being
  written, too late to steer) → nothing for the ended run: the next run becomes `activeRun`, and its end is the one
  told. Read from `pi.live.run` in the same commit;
- any failure → "failed" with the reason, a notification and a Continue button; a stop → "stopped", no notification.
  Failures are not retried here: Durable retries model requests and its own summaries under `settings.retry`, and
  picloud's checkpoint carries the previous working state forward when its summarizer fails, so what still ends a run
  would fail again. An earlier version continued a run ended by a failed compaction up to three times on its own,
  which only delayed the person's Continue.

`activeRun` is picloud's copy of Durable's run, kept because the sidebar reads session documents alone and the
supervisor needs one submission to watch per run. The open session counts a run as going while either Durable's
`pi.live.run` or `activeRun` says so: they start in the same commit, and `activeRun` outlasts the run by the one commit
before the supervisor decides, so a run that ends in an automatic continuation never reads as stopped in between. The
wording for each failure reason lives once, in `src/shared/session.ts`, for the banner and the notification alike.

**Durable's settings as they come.** picloud sets none in real mode, so a change to Durable's defaults (three
retries with backoff, failed runs keeping the inputs queued behind them) reaches it; fake mode shortens the retries so
a scripted failure ends its run at once.

*Alternatives considered:* `onYield` hook tasks keep the run alive across a continuation, but Durable then appends a
plain `pi.user` message the phone cannot tell from the person's own words, and no hook sees failed runs, so a second
mechanism would be needed anyway; a monitor task per run parked on `SubmissionSettled` would be durable too, but needs
the submission to be made from inside the task, which makes steering (an immediate submit in the HTTP commit) awkward.
One observer plus one idempotent reconcile covers every way a run ends.

**Bounds.** A run takes as many tool rounds as its work needs: picloud sets no `maxTurns`, and Durable handles
failed tool calls itself. A fixed count (150 at first) cut real runs short for no reason a person could act on, and
sessions created with it lose it when picloud starts. The spend cap is an `afterTools`
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
base), and no other local branch with commits origin lacks. It removes only picloud's own directories of a session,
its workspace and scratch, never a local session's chosen directory, and never a directory that holds one. *Alternatives:* systemd timers would need a second process
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
- **Deference:** content first — status and spend are one line under the title; finished work, handoffs and
  checkpoints are folded until asked for; the agent's prose is set to be read, the person's words in the serif above
  it.
- **Sensible defaults:** the last repository, a new branch from its default branch, recommended options pre-selected
  so accepting them is one tap.
- **Familiar navigation:** a ☰ drawer (and an edge swipe) on phones, a persistent sidebar on wide screens; the drawer
  lists the sessions under way, and a dot on ☰ means another session needs you.
- **Feedback and forgiveness:** archive is immediate with an Undo toast instead of a confirmation dialog; drafts are
  saved as they are typed.
- **Accessibility:** type at the person's text size (`-apple-system-body`, which every size is a fraction of), light
  and dark colours with sufficient contrast, 44 pt targets (checked by an end-to-end test), safe areas, the keyboard resizing the
  layout (`interactive-widget=resizes-content`), reduced motion respected, and roles, labels and live regions for
  screen readers.

**The look: serif to name and act, sans to read.** The first look followed the guidelines and nothing else, and read
as every chat app averaged: blue bubbles, a "Message…" pill, grey pills for status, the system sans at two sizes,
everything at one radius and one spacing. It was replaced by a point of view, borrowed from print rather than from
apps, with three faces and one job each. Source Serif 4 sets what names or does something, at Body size or larger
only: session titles, question text, plan titles, the report's summary, buttons and links, and the person's own words,
so each instruction heads the reply under it. IBM Plex Sans sets what is read: the agent's prose, options, fields. The
agent's prose is technical, full of paths and identifiers, and a sans beside its own monospace sibling keeps those
lines even where a serif body would switch texture at every `code` span. IBM Plex Mono sets the record: small labels,
status, tool lines, paths, commits, sums. Weights are light (380 for reading, 480 for titles and buttons) and a step
lighter on dark paper, where light text spreads; heavier weights read as smudged. A faint halo in the text's own
colour (`text-shadow: 0 0 1px` at 22 %) fills out the thin strokes on paper; on dark it would only spread them, so it
is off there. Status is a word, not a pill. Only two rules cross the transcript: ink over a report and yellow over
whatever waits for the person; options, plan steps and answered cards are separated by space, not lines. Colour is
warm ink on a page just warmer than white (a paper tone was tried and read as dim). The alert colours sit near their
full saturation (yellow `#ffd400`, red `#d70015`, orange `#c45000`, green `#008038`), each still at least 4.5:1 as text
on the page, so they read as signals against a quiet page. Dark is for working with the screen turned low at night
without losing one's eyes to the room: a page all but black (`#010405`), so an OLED screen leaves nearly every pixel off, with the faintest trace of an abyssal blue-green and panels lifted from it by only a breath; bright
cool ink (`#e2ecea`, 17:1), and the colours that only inform (done, working, delivered, a warning) toned down to about
37 % luminance, at least 6.7:1; the person's yellow and the failure red keep their full colour, since they are the
ones that must be seen. Whatever is filled with ink (the main action, the send and stop keys, a selected segment, a toast) takes a good step under it (`--accent-fill`, 9.4:1 with its label), since a full-width button or a toast is the largest light area on the page; text and links keep the bright ink.
*Before:* cream on warm graphite (`#181714`), with every colour as vivid as by day; it lit the room. The main action is filled with ink, others are outlined in it, links are underlined. The fonts
are pinned dev dependencies (`@fontsource-variable/source-serif-4`, `@fontsource-variable/ibm-plex-sans`,
`@fontsource/ibm-plex-mono`) whose Latin files `scripts/build.ts` copies into the app with their licences (about 250
KB, precached by the service worker), so they work offline and the CSP needs no font host. *Alternatives:* serif prose
with a sans for the interface read well but made every technical line switch between serif and monospace. A logbook
(times in a ruled margin, date headings, a ledger's double rule, a highlighter drawn across) read as a costume: the
props announced the idea instead of the type carrying it, and the margin cost a phone fifty pixels of every line. A
newspaper layout made the waiting moment loud but everything else too graphic for something read every day; the system
sans with a stronger accent kept the hollowness, which came from the defaults, not the colour.

**One hue per meaning, wherever that meaning shows.** Colour says what something is, never how important it is:
cyan is the agent at work on its own (the status word and its cursor, the step it is on, the edge of the running call,
a reply being read aloud); the yellow is the person's turn (a waiting card, "Question waiting", "Report ready", the
badge on the menu); green is done (finished steps, met conditions, passed checks, "Pushed"); orange is a warning
(budget near or reached, partly done, risks and departures from the plan); red is an error (a failed run or call,
an unmet condition, a failed check); blue is what reaches GitHub (Open or Update pull request, Push branch, View PR).
Everything else is ink or pencil. Yellow is never a warning and orange never the person's turn, since people read
yellow as caution only where it sits beside orange and red, and here it never does. Each status carries its tone from
one place (`StatusTone`, set where `sessionRow` labels the session), so the title bar and the sidebar always agree.
*Before:* "Working" was ink, so work under way read
like any other status, and buttons that push to GitHub looked like buttons that only show something.

**The sidebar is a listing of what is under way, nothing more.** In coding work it is a utility: it shows what the
other active sessions are doing. Each session is one line: a dot in its status's colour (cyan working, yellow its
turn, orange a warning, red an error, an empty ring for nothing going on), its title, and how long since it changed,
newest first. The title is the plan's once there is one, a few words where the session's own title is the first line
of its task. Sessions that are done, archived, or untouched for twelve hours fold into an Inactive section, since
most are never returned to. *Before:* rows of two lines (title, then a status pill and the repository) grouped under
"Needs you", "Working" and "Done", a theme picker and a connection line, which read as a chat app's history and
showed nothing to act on.

**The turn under way shows whole.** Durable's live view sends the newest 50 entries and drops older ones as a run
grows, so opening a session in the middle of a long turn, or reconnecting, left its start behind "Load earlier
messages". While the agent works, the phone loads what the window left out of the current turn on its own (earlier
pages until the turn's start, and any gap inside it) and keeps following the end; older turns stay behind the button.

**Work is watched while it happens and folded once it is done.** Everything the agent does between two pieces of its
prose is one stretch of work: its thinking and its tool calls, in the order they happened. While the turn runs (from
the person's last message or answered card, until the run ends or parks on a card) nothing hides it, as Pi's own
terminal shows a run: the thinking reads inline in a quiet italic as it streams, and each call is a tinted block headed
by what it runs (`$ command`, or "Edited src/x.ts") with the last four lines of a command's output, or of any failure,
under it and a count of the lines before them. When the turn ends, each stretch folds to one line ("Ran 12 commands,
wrote 8 files · 1 failed") that opens on a tap to the same sequence, each call one line that opens to its full input
and output. *Before:* calls gathered into one group until the agent wrote prose, but thinking did not end a group, so
a long run showed one line of calls followed by a column of separate "Thought" rows, out of order and with nothing to
watch while it worked; a first fix kept the running stretch inside an open disclosure, which only added chrome to
read around.

**A plan and a report are reviewed part by part.** Each part sits under a small label, each item is one line, and what
supports it (a decision's reason, a condition's evidence, a step's files, a check's output) is set smaller beneath it.
A plan waiting for approval shows every part except its sources, which open on a tap; once answered, it shows its goal
and its steps ticking off, and the rest opens on a tap. A report shows its outcome by the title (Complete, Partly done,
Blocked), its headline, each end-state condition ticked or crossed with its evidence, the changes with their files, the
checks with their results, and where the work departed from the plan. Parts with nothing in them are left out.

**One small set of values, declared once at the top of `app.css`.** Spacing comes from 2/4/8/12/16/24 px, radii from
four tokens, type from Apple's text styles expressed as fractions of Body (so Dynamic Type scales all of it), colour
from semantic tokens with a dark set, and motion from three durations (160 ms press, 200 ms exit, 400 ms present) and
two curves (a strong ease-out, and the iOS sheet curve). The alternative, values chosen per element, is what the first
pass had, and it showed as nine type sizes and eleven spacings. Motion follows frequency: sending, picking a file,
opening a disclosure and switching the send/stop button are not animated; presses respond at once (filled buttons
scale to 0.97, text and icon buttons dim, rows highlight); the sheet, drawer and toast enter on `--present` and leave
on `--quick`, with CSS transitions so a gesture can interrupt them. Reduced motion keeps the fades and drops the
movement.

**Light and dark follow the device; there is no theme picker.** Dark is one block of the same tokens under
`prefers-color-scheme: dark`, so every colour is a value per meaning and nothing is restyled per theme. *Before:* a
picker in the drawer chose System, Light, Dark or a Terminal theme (ANSI neon, monospace, square). It was removed as
offering nothing to act on in a tool that is opened to check on work, and the Terminal theme went with it, since
nothing could choose it any more; with them went the blocking boot script that applied a stored choice before the
first paint. The Terminal theme is in the history if it is wanted back somewhere else.

**A wide screen gets the same app, laid out for its width.** It has no extra features, only a layout for the
space:
- From 900 px the drawer becomes a sidebar. It can be put away (and brought back with the ☰ button), and stays put
  away on that device across visits.
- Every band of a page runs the full width of its pane: title bar, transcript, composer bar, setup form. So the bars and their hairlines meet the pane's edges, while the content keeps to a centred 760 px reading
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

**Return sends where there is a keyboard.** With a mouse or trackpad (`(hover: hover) and (pointer: fine)`), Return
sends, Shift+Return writes a new line, Return with the `@` or `#` picker open takes its first match rather than
sending half a reference, and a session's field takes focus when it opens or can be typed in again. On a touch
keyboard Return still writes a new line and nothing takes focus by itself. *Alternative:* Return sends everywhere,
as asked. A touch keyboard's Return is the only way to write a new line there, the send button sits beside it, and
focusing the field as a session opens would raise the keyboard over half the conversation, which is there to be read.
The pointer, not the screen width, decides, so an iPad with a trackpad behaves like a laptop. ⌘/Ctrl+Return sends on
both. Return never sends while an input method is composing.

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

A bash script, because it has to run on a machine that does not have Node yet. (OnPrem's own installer is described
under "PiCloud OnPrem".) Every change goes through two helpers
(`run`, `write_file`) that print instead of acting in `--dry-run`, every step checks before it changes anything, and
the configuration file keeps existing values unless an option replaces them, so re-running upgrades in place. It ends
by listing the steps only a person can do. The systemd unit uses `RestartPreventExitStatus=78` so a missing Pi
sign-in waits for a person instead of restarting in a loop, and does the same for exit code 2: a configuration that
is incomplete, such as a missing agent token, or a kernel the sandbox cannot work on.

## Running in Docker

**Two containers: Tailscale as a sidecar, picloud sharing its network.** picloud keeps listening on loopback only,
and `tailscale serve` is the only way in, as on the installer path. So the security model does not change, and the
`Tailscale-User-Login` header still comes only from Tailscale. The alternative, publishing a port on the host, would
put picloud on the droplet's public interface. Tailscale uses its documented setup for serving from a container:
kernel networking with `/dev/net/tun`, a serve file applied at start, and the auth key used once.

**Configuration lives in one `.env` that compose reads.** Each value goes only to the container that needs it: the
auth key to Tailscale, `GH_TOKEN` and the `PICLOUD_*` settings to picloud. picloud's GitHub access uses `GH_TOKEN`,
which `gh` reads and which git reaches through gh's credential helper (configured system-wide in the image). That is
the same access the service user's `gh` login gives under the installer. Agent commands get `AGENT_GH_TOKEN` instead
(see "Session isolation"). Pi's sign-in stays interactive (`docker compose run
--rm picloud pi`), because it often uses Pi's own subscription login, and writing Pi's configuration ourselves would
take that over from Pi.

**The image is Ubuntu 24.04, with Node copied from the official Node image.**
- Ubuntu 24.04 is one of the installer's targets, so the agent's tools are the same on either path. The recommended
  host is Debian 13, but the sandbox is the host kernel's Landlock, so the image's userland need not follow.
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

  The agent still builds and runs code: the volumes allow it to execute programs. The home volume was made the whole
  home directory, not just `~/.pi`, for the caches of npm and the like; since session isolation those live in each
  session's own home on the `data` volume, and the home volume keeps Pi's sign-in. A process limit (1024) contains a
  runaway test.
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

## Session isolation

(All of this is for a server. PiCloud OnPrem deliberately has none of it; see "PiCloud OnPrem".)

**Each session's agent is isolated from picloud and from other sessions, in three layers.** This departs from the
runbook's A7, where the agent shared the service user's credentials, at the owner's request.

**Two GitHub tokens.**
- **picloud's own** (Contents and Pull requests read and write, Metadata read) lists, clones, pushes and opens pull
  requests. All of that runs in picloud's process, never sandboxed: `host.ts`, `sessions.ts` and `delivery.ts`.
- **The agent's** is read-only (Contents and Metadata read). Agent commands get it as `GH_TOKEN` and `GITHUB_TOKEN`.
  gh reads it, and git through gh's credential helper, which the image and now also the installer configure
  system-wide, because agent commands have a home of their own.

So "nothing reaches GitHub without the person's tap" holds at the credential level, not only as an instruction.
Real mode refuses to start without the agent's token. Under the installer, picloud's token stays in the service
user's gh login, and the env file holding the agent's token is root's alone (0600), since systemd reads it as root.

**An allowlisted environment.** Durable spawns a command with picloud's whole environment unless told otherwise, so
the session's environment passes `inheritEnv: false` with an explicit set:
- PATH, the locale, TZ, TERM, the user and shell names;
- proxies and the CA files they need;
- the no-prompt git variables;
- a `HOME`, `TMPDIR` and `GH_CONFIG_DIR` of the session's own, under `<data>/sandbox/<id>`;
- the agent's token.

No `PICLOUD_*` setting, provider key or picloud token gets through. `PI_CODING_AGENT_DIR` used to be passed so that a
`pi` the agent ran would find picloud's configuration. That configuration (sign-in, models) is now deliberately out of
reach, and the prompt names skills by absolute path, so nothing agent-side needs it. The scratch directory is made
whenever a session's environment is built rather than at setup, so sessions from before this change get one on their
next command. Maintenance removes it with the workspace.

**Landlock around every command and file operation.** `picloud-sandbox` is under 200 lines of C with no
dependencies. It restricts itself, then runs the command, with these grants:
- **read-write:** the workspace, the scratch directory and `/dev`;
- **read and execute:** `/usr`, `/bin`, `/sbin`, `/lib*`, `/etc`, `/proc`, `/sys`, and also
  - the real directory behind `/etc/resolv.conf`;
  - the Node.js running picloud (under `/usr` in both deployments, but anywhere on a developer's machine);
  - the CA files the environment names;
  - Pi's `skills` directory;
  - in fake mode, the stand-in remote.

Everything else is out of reach: other workspaces, the database, push keys, uploads, backups, picloud's home and code,
and the shared `/tmp`. The launcher handles every right the kernel's ABI knows, best effort, as the kernel's own
sample does. From ABI 6 it also scopes signals and abstract unix sockets. Landlock already forbids ptrace and reading
`/proc/<pid>` across domains, so a command can neither read picloud's process nor, from ABI 6, signal it. Paths that
do not exist, or that the user cannot open, are skipped.

The file tools run in picloud's own process, where Landlock cannot apply. So the session's environment checks every
path against the same grants, without `/proc`, which there is picloud's own:
- it resolves real paths, following a planted or dangling symlink to where it leads;
- it refuses writes to read-only grants;
- it returns Durable's normal `FileError`, saying what was refused and where files may go.

A check-then-use race remains. A command running at the same moment could swap a checked directory for a symlink
before the tool opens it. Closing it would need `openat2` with `RESOLVE_BENEATH`, which Node does not offer.

The sandboxed environment passes Durable's own `ExecutionEnv` conformance suite but for one case: an argv `exec`
whose program does not exist ends with the launcher's exit code 127 rather than a `spawn_error`, since the launcher
is what starts. picloud's tools only ever pass command strings.

**What it costs.**
- **Background processes:** each command is its own Landlock domain, so from ABI 6 a command cannot signal a
  process an earlier command started. The prompt tells the agent to stop a background server in the command that
  starts it.
- **Toolchains** must live under a granted path, in practice `/usr`. One in the service user's home, such as
  rustup's, is out of reach.
- **Caches:** they are per session now, so each session downloads its own npm packages.
- **`/tmp`:** a program that hard-codes it fails, since `TMPDIR` points into the scratch directory.

**picloud's own API refuses its own user.** TCP is not restricted, so a command can reach picloud's HTTP API on
loopback and send the `Tailscale-User-Login` header itself; it would approve its own plan or tap Deliver with
picloud's write token, which defeats the token split. So in real mode, picloud looks up the client end of each
connection in the kernel's socket table (`/proc/net/tcp`, `src/server/callers.ts`) and refuses it when it belongs to
picloud's own user, as every agent command does. `tailscale serve` connects as root, in both deployments. A
connection whose owner cannot be found is refused too. Fake mode leaves this off, since tests connect as picloud's own
user.

**What stays open.**
- **The tailnet and metadata.** Commands reach every host the machine reaches: other tailnet devices (limited only by
  Tailscale's access controls) and a cloud provider's metadata service. They can also reach tailscaled's local
  socket, because Landlock does not restrict connecting to a named unix socket.
- **TCP in general**, including sending the workspace anywhere. Builds need registries.
- **The race above**, and `/dev/shm`, which every session can write through `/dev`.
- **Root.** As root, Landlock still let a confined command read another process's `/proc/<pid>/environ` (seen on
  Linux 6.18), though not its memory. picloud runs as its own unprivileged user in both deployments, and there it
  cannot; the test of it skips as root.
- **Below ABI 6** (Ubuntu 24.04's 6.8 kernel has ABI 4), commands can signal picloud's and other sessions'
  processes. picloud warns at startup.

**Why no VMs or per-session containers.** A microVM or a container per session would isolate more: its own kernel or
namespaces, and network policy. But it needs KVM or a container runtime with privileges picloud does not have. The
Docker deployment drops every capability and sets no-new-privileges, Docker's default seccomp profile blocks the user
namespaces bubblewrap would need, and a typical droplet has no nested virtualization. Landlock needs no privilege,
works unchanged inside the hardened container, adds under a millisecond per command, and is one small launcher
rather than an orchestration layer.

**Debian 13 is the recommended host.** Its 6.12 kernel has Landlock ABI 6, so signals and abstract sockets are
scoped. Ubuntu 24.04's 6.8 kernel stops at ABI 4. The installer supports both, choosing Tailscale's apt source from
`/etc/os-release`. The Docker image keeps its Ubuntu 24.04 userland, because Landlock is the host kernel's.

**`PICLOUD_SANDBOX=off` is the way out for a kernel without Landlock.** Real mode otherwise refuses to start there,
with exit code 2 and what to do. The allowlisted environment and the agent's token apply either way. Fake mode uses
the sandbox wherever it works, so the tests exercise it on any machine that has it.

## Reading replies aloud

**A speakable script, written by the session's own model after the tap.** Raw Markdown never reaches the voice: the
phone sends a reply's Markdown (or, for the report card, Markdown made of what the card shows), and one model call
rewrites it for the ear (`src/server/speech/script.ts`). Rules could not do it: "/" is "slash" in a path, "or" in
and/or and "per" in km/h, `SQL` is letters or "sequel", and a code block needs describing rather than reading. It runs
only on a tap, so unheard replies cost nothing, with reasoning off or as low as `clampThinkingLevel` allows. Its cost
goes into `pi.usage` through `countSpend`, the helper the summarizer's checkpoint now shares, so the session's spend
and cap see it exactly as they see the summarizer's. `countSpend` follows Durable's own `recordUsage`, which is not
exported, counter for counter (tokens, cache reads and writes, reasoning, and each part of the cost), so the ledger
reads the same whichever call made the spend. Nothing checks the cap before the call: it is small, and a
person asked for it. The phone keeps each complete script in memory, so hearing a reply again costs no second call.

**Streamed a sentence at a time, in segments of at most 200 characters.** The script comes back as newline-delimited
JSON, the live stream's framing (`openLines` on the server, `lines` on the phone), a segment per line as soon as its
sentence is written, then `done` or `error`; the phone caches only a script that reached `done`. The limit is
Kokoro's: kokoro-js truncates its input to the tokenizer's 512 tokens, two of them markers, and the voice has 510
style vectors. Those tokens are phonemes, measured at 1.1 to 1.4 per character of prose and 2.5 for letters read one
by one ("A P I"), so 200 characters always fit. Each sentence is its own segment, and a sentence too long by itself is
cut at its last comma, semicolon or colon that fits. *Alternative:* paragraphs packed into 200-character segments, as
first built. On two vCPU a full segment takes about 7 seconds to synthesize and a sentence about 3, and the first
paragraph had to be written in full first, so sentences start the reading several seconds sooner; the phone fetching
three segments ahead keeps the synthesizer busy, so it pulls ahead of playback and a long sentence after a short one
leaves no gap.

**Kokoro in picloud's own process, loaded at startup and kept, one synthesis at a time.** `kokoroSynthesizer` starts
loading the model when the server starts (0.7 s on two vCPU, logged as `speech.ready`), and keeps it: about 600 MB
resident. *Alternative:* load on first use and release after five idle minutes, as first built, to give the memory
back to the agent's builds. Readings are minutes apart, so nearly every one began with a load, and on a busy server,
whose page cache had dropped the model's file, that load ran well past its 0.7 s, all of it before the first word.
The first synthesis after a load runs at the same speed as the next (measured), so no warm-up reading is spent. A
failed load is logged (`speech.load`) and tried again by the next reading. ONNX Runtime runs on its own threads, so
the event loop stalled at most 180 ms during a synthesis; a worker process would add a protocol for no gain. Requests
queue, since two vCPU have no room for two at once. The WAV is picloud's own 16-bit PCM encoder (`src/shared/wav.ts`,
also used by the phone): transformers.js's `toWav` writes 32-bit float, twice the bytes.

**A sentence's pause, not Kokoro's padding.** Kokoro pads each reading with about 0.3 s of silence before it and 0.5 s
after (measured on `af_heart`; the same at any threshold from 0.002 to 0.01 of full scale), which is right for one
utterance and wrong for sentences played one after another: each was followed by most of a second of nothing, plus
the phone's swap to the next segment, and the reading sounded halting. The synthesizer trims each segment to 50 ms
before its first sample above 0.005 and 200 ms after its last, so the pause between sentences is that, plus the swap.

**The phone waits once rather than stammering.** At 0.6 of real time the synthesizer pulls ahead of playback, except
after a short first sentence: "What changed." plays for a second while the next sentence takes three to synthesize,
so the reading paused for two seconds after its first words. When nothing is playing and a segment arrives, the phone
plays it unless the segment being fetched is expected to arrive after what is ready has played, expected from how
long the segments so far took per character; then it waits for that one. The wait moves to the start, where it reads
as preparing, and the reading then runs on. An end-to-end test delays each segment's audio as Kokoro would and checks
that no gap between segments reaches 250 ms; the earlier phone left 1.3 s after the first sentence. The rewrite's own
time to its first sentence, the other part of the wait before the first words, is logged as `firstMs` on
`speech.script`.

**The voice comes from the kokoro-js package.** In Node, kokoro-js 1.2.1 reads `voices/<name>.bin` from its own
package directory with `fs`; its Hugging Face URL is the browser's path only. That `af_heart.bin` is byte-identical
(sha256 `d583ccff…`) to the one at the pinned model revision, and the lockfile pins the package by integrity. Fetching
it again would bake in a second copy nothing reads, and making kokoro-js read another would mean patching it, so
`deploy/models.sh` fetches the configuration, the tokenizer and the q8 weights only.

**Offline and read-only at run time.** transformers.js is told to load local files only, from `models/` beside the
sources (`env.allowRemoteModels = false`), once for the process in `src/server/transformers.ts`, which speech and local
memory share. Its file cache stays on (`env.useFSCache = true`) because that is what makes it hand ONNX Runtime a path
rather than bytes, and a model with external weights, as LEAF's query model has, loads only from a path. It writes
nothing: the cache stores only what came over the network, and a local file arrives as a `FileResponse`, which it
skips, so the container's read-only root is never written. Kokoro was checked to read aloud with the setting changed.
The image's model was checked to synthesize under `--network none` with compose's hardening. The models come from
pinned Hugging Face commits, each file checked against its sha256, by one script (`deploy/models.sh`) that the
Dockerfile and the installer both run.

**A build-time switch, `PICLOUD_SPEECH`.** `kokoro-js` and `@huggingface/transformers` (whose `env` picloud sets) are
optional dependencies, pinned exactly. picloud reads aloud when `kokoro-js` resolves and the weights are in place, or
in fake mode; `Bootstrap.speech` tells the phone, and otherwise both endpoints answer 404 with why.
- **Off** prunes optional dependencies (`npm prune --omit=optional`). That is safe: Pi's packages declare no optional
  dependencies, and the lockfile's only other optional runtime package is `@types/trusted-types`, type declarations.
  esbuild's platform binary is optional too, but a development dependency that the build has finished with. The off
  image was listed: no speech package and no model (npm leaves empty `@huggingface` and `@img` scope directories, as
  it does for the development scopes it prunes).
- **`.npmrc` sets `onnxruntime-node-install-cuda=skip`.** Otherwise onnxruntime-node's install script downloads CUDA
  binaries from GitHub on Linux x64, and when that fails npm drops the whole optional tree without an error. The image
  build and the installer also stop if `kokoro-js` is missing with speech on.
- **Size.** Speech adds 451 MB of packages and the 92 MB model to the image unpacked, and 223 MB to what a pull
  downloads. Two-thirds of onnxruntime-node is binaries for other platforms; trimming them by hand was left out as
  fragile.

**Playback that survives a locked screen.** iOS plays media only from a tap, and the audio arrives several awaits
later, so the phone (`src/client/speech.ts`) keeps one `HTMLAudioElement`, unlocks it inside the tap by playing a
tenth of a second of silence, and plays each segment on it from a fetched blob. Up to three segments are fetched
ahead of the one playing, so `ended` swaps the source and plays with no await in between, which is what keeps reading going in
the background. Web Audio was ruled out because the silent switch mutes it. The Content Security Policy gains
`media-src 'self' blob:`. Leaving a session stops its reading, since its stop button would be out of reach; locking
the phone does not.

**What a reply is, and where the speaker goes.** A reply is the agent's text in one turn: consecutive text blocks,
read as one with the work between them left out. Any other block (the person's message, a
card, a notice, a compaction) ends it, and the newest reply ends when the run does, so no speaker appears while text
may still come. The speaker sits after the reply's last text. On the report card it ends the title row and reads the
headline, summary, departures from the plan and notes, the prose a person reads first; the record under it (the end
state, changes, checks, what Pi learned) is not read.

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

## PiCloud OnPrem

**Native install, not a container.** OnPrem exists to give a session the person's full access to their own computer:
their directories, toolchains, credentials and local services. A container cannot: on macOS it is a Linux VM that
cannot run the person's macOS toolchain or reach their keychain, and on Linux it still sees only the image's tools and
whatever is mounted into it, which is a sandbox by another name. So picloud runs as the person, from a checkout in
`~/.picloud/app`, under a service of their own user. *Alternative:* the Docker setup with the home directory mounted
in, which gives files without tools, and tools of the wrong system.

**One switch, `PICLOUD_ONPREM`, rather than separate de-restriction flags.** Each protection on a server that keeps the
agent from the person's own access exists because the server is shared with an agent the person does not watch: the
sandbox, the read-only agent token with its scratch home, and the caller check that refuses picloud's own user. On the
person's own computer each of them is wrong in the same way at the same moment, so one switch changes all of them, and
a setting that would promise one of them back (`PICLOUD_SANDBOX=on`, `PICLOUD_AGENT_GH_TOKEN`) is a configuration
error naming why, rather than silently ignored. Who may reach picloud is a separate question, and OnPrem answers it as
a server does where Tailscale is involved: see below. It defaults to off, and its port to 2025, so nothing
changes for a server. *Alternative:* a flag per protection, which multiplies the combinations to test and document,
most of them meaningless (a sandbox without a scratch home).

**Local sessions beside repository sessions, and the working directory split from picloud's workspace.** A session's
`place` is a discriminant in the shared shapes: `repo` (repository, start, branch, base, start commit, delivery) or
`local` (an absolute directory), in `SessionDoc`, its drawer row, the create body and nothing else; sessions stored
before it are marked `repo` once, at startup, in the commit that already recomputes the drawer. The directory is
resolved when the session is created (`~` expanded, which must exist and be a directory), and becomes the Durable
conversation's `cwd`. `workspace(id)` stays picloud's own: a repository session's clone, and for every session the
attachments, which a local session's agent is given by absolute path. Every agent-facing use (the cwd, the prompt's
session section, project context, skills, `@` references and the `@` listing) goes through one function,
`workingDir(doc)`; everything picloud owns (clone, attachments, scratch, maintenance) through `workspace(id)` and
`scratch(id)`. Setup skips the clone and the branch; delivery and the diff answer 409; the report checks no git
state and records no commit; the compaction checkpoint states the directory instead of a repository; long-term repo
memory has one key for the computer. A local session has its own prompt rules instead of the git ones: the person's
full access to the whole filesystem from that directory, other sessions on the same computer, and asking with a card
before anything destructive or irreversible the task did not name. A local session is only OnPrem's; a server refuses
one with 403, since it would bypass every protection there. The `@` listing is a breadth-first walk bounded by entries
and time, skipping dot-entries, dependencies, macOS's `Library`, the kernel's and devices' trees and network mounts
(Linux's from its mount table), so `/` stays fast. *Alternatives:* faking a repository name for the home directory,
which every repository code path would then have to recognise; `workspace(id)` pointing at the chosen directory, which
would hand maintenance's `rm -rf` the person's own directory.

**The request gate refuses other sites' pages, in both modes.** `json()` parsed any body whatever its content type,
so a page on any site could send a `text/plain` POST, which needs no CORS preflight, and picloud acted on it: on a
server, any page the phone opened could answer a card or start a run; in OnPrem it would run commands on the person's
computer. Every request that is not GET or HEAD is now refused when `Sec-Fetch-Site` is present and not `same-origin`
(`same-site` is refused too: another port on localhost is the same site), or when `Origin` is present and its host is
neither the request's `Host` nor the `X-Forwarded-Host` a proxy adds; a cross-site page can set neither of those two
without a preflight picloud never allows. Requests with neither header come from programs, not browsers; the caller
check, or in OnPrem the person's own access, already covers those. *Alternatives:* requiring `application/json`, which
a no-cors request cannot send, but which a future upload or form would silently reopen; a CSRF token, which needs a
session or cookie picloud does not have.

**In OnPrem, the Host is checked and the caller check is turned around.** Bound to loopback, OnPrem is still reachable
by DNS rebinding: a page whose name resolves to 127.0.0.1 is same-origin with picloud as far as the browser knows, and
could read it and pass the origin gate. So OnPrem answers only requests whose `Host` is `localhost`, `127.0.0.1` or
`[::1]` at its own port, or a name in `PICLOUD_ALLOWED_HOSTS`. On a server the caller check refuses picloud's own
user, because the agent runs as that user and shares loopback; in OnPrem the person's browser is that user, so on
Linux the same socket-table lookup (`clientOwner`) allows picloud's own user and root, which is how `tailscale serve`
arrives and which could read everything picloud holds anyway, and refuses other users of a shared machine. macOS has
no such table, so OnPrem there checks no caller, and the README says any user of the Mac can reach it.
*Alternative:* a login or token for OnPrem, which the person would have to carry into every browser and which guards
nothing against programs that already run as them.

**OnPrem may be put on the tailnet too.** A computer running OnPrem, a laptop or a server somewhere, can be the one the
phone drives: `tailscale serve` puts it on the tailnet with TLS and identity, as it does a server, and nothing about
that is less safe than a server. *Before:* OnPrem refused `PICLOUD_ALLOWED_LOGINS` and answered localhost only, which
ruled that out for no gain. Now the tailnet names it is served under are listed in `PICLOUD_ALLOWED_HOSTS` (a name no
one else's DNS can point at the computer, so the rebinding check holds; the installer's `--tailscale on` finds the
MagicDNS name and runs `tailscale serve --bg --https=443`, refusing to take over a name already serving something
else, and never `funnel`). What comes through Tailscale, addressed to such a name or carrying the
`Tailscale-User-Login` header `tailscale serve` adds (should a proxy name picloud by localhost), is held to
`PICLOUD_ALLOWED_LOGINS` as on a server; the computer's own browser at localhost carries no login and needs none.
*Alternatives:* trusting the login header wherever it appears, which a rebound page on the computer could send
itself; asking Tailscale for the name at every start, which ties startup to a CLI that macOS does not put on PATH.

**The installer remembers its choices.** Each install writes its flags to `~/.picloud/onprem.conf`, read as plain
values (never sourced) before the flags given, so the bare one-liner updates picloud as it is. Without it, an update
would quietly turn Tailscale off, drop the local memory model, or move the port.

**The OnPrem installer: a user service with the login shell's PATH, from a checkout it fetches itself.** Piped from
curl, the script has no directory of its own, so it first clones picloud (or finds the installed copy) and runs the
installer of the version it is installing, which fetches `--ref` and refuses to overwrite local changes in the app. It
shares `deploy/lib.sh`'s dry-run helpers (now portable to macOS's `stat`), the model switches and pruning of the
server installer, and `deploy/models.sh` (now with `shasum` where there is no `sha256sum`). The service is the user's
own, so nothing needs sudo: a LaunchAgent (RunAtLoad, KeepAlive, logs in `~/.picloud/logs`) on macOS, a systemd user
unit on Linux, which keeps the server unit's `RestartPreventExitStatus=78 2`. launchd and systemd start services with
almost no environment, so the PATH the person's login shell builds is captured at install time and written into the
service, behind the directory of the `node` that installs it, which then runs it by absolute path; re-running
captures both again. Pi's sign-in is checked with picloud's own `loadPiModels`, run from the installed app, rather than
by reading Pi's files. *Alternatives:* a wrapper that sources the login shell at every start, which would run the
person's shell profile, prompts and all, under launchd; Homebrew services or a `.app`, each one more thing to package
for one platform only.

## Dependencies

Pinned exactly, with the lockfile committed: the five `@earendil-works/*` packages at 1.6.0; `preact`, `marked` and
`dompurify` for the client; `esbuild`, `typescript`, `@types/node` and `@playwright/test` (matching the installed
Chromium) for building and testing. Apart from the `@earendil-works/*` versions the runbook fixes, each version was at
least two weeks old when it was chosen. Reading aloud adds two optional dependencies, `kokoro-js` 1.2.1 and
`@huggingface/transformers` 3.8.1 (the version kokoro-js's range resolved to), which a build can leave out. The two
faces are dev dependencies, `@fontsource-variable/source-serif-4` 5.3.1, `@fontsource-variable/ibm-plex-sans` 5.3.0
and `@fontsource/ibm-plex-mono` 5.3.0: the build copies their files, so nothing of them is needed at runtime.
