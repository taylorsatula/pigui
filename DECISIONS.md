# Design decisions

Each entry says what was chosen, the alternatives considered, and why. Written for whoever maintains pigui next;
when a decision changes, change its entry. This file records the cleanroom reimplementation's choices against
[MANIFEST.md](MANIFEST.md), the specification it was built to; behaviors match the reference unless an entry says
otherwise.

## The reimplementation itself

**Gray-box cleanroom.** The implementation was written fresh against MANIFEST.md (an exhaustive audit of the reference
produced first), with the reference consulted for behavior, never for verbiage. Where code comes out similar, that is
sanctioned by the owner; where it could be better at the seams, it was made better. The agent and skill definitions
(`agents/*.md`, `skills/*/SKILL.md`) and `src/client/app.css` are byte-identical to the reference, deliberately: the
owner required the bundled prompts and the phone UI to match exactly.

**One branch, one PR (eventually).** All work lands on this branch; RUNBOOK-OPEN.md is untouched, as its definition of
done demands.

**UI parity is the hard requirement.** app.css keeps the reference's values and structure whole; the components are
near-verbatim ports. The person's rule: the UI must be identical even where the code is simplified.

## Architecture

**One process, one Harness, one SQLite storage; a session is a Durable conversation.** `startApp()` opens a single
Pi Durable Harness over `pigui.sqlite` and serves HTTP from the same process. A session is an ownerless conversation
with its own working directory and `pi.agent`; several run at once. *Alternatives:* a Harness per session breaks "one
writable process per storage" as soon as anything looks across sessions; a worker process per run rebuilds what
Durable already does.

**The server runs its TypeScript directly** (Node ≥ 22.19, type stripping); no server build. Erasable syntax only.

**Module boundaries.** `src/shared` holds every shape both sides use. `src/server/agent` is everything pigui adds to
Pi and knows nothing of HTTP. `sessions.ts` owns the lifecycle, `supervisor.ts` the run-end, `delivery.ts` the
push/PR/diff, `notify.ts`/`webpush.ts` the notifications, `maintenance.ts` the cleanup and backups, `http.ts` the
boundary. The app talks through small typed interfaces (`AgentServices`, `SessionsDeps`, `RepoHost`, `PushSender`).

**What changed at the seams.** `docs.ts` was split into `documents.ts` (tokens and commit helpers, one responsibility)
and the pieces it mixed in; `sessionFor` lives in `documents.ts` and no longer imports the subagents' extension module.
Notifications reach the rest of the server through a small port (`Notifications` in `agent/services.ts`) rather than
the concrete class, so tools and the supervisor depend on the interface, not the pipeline. `callers.ts` parses a
`/proc/net/tcp{,6}` row with an unparseable uid as *unidentifiable* and refuses it (the reference admitted it as a
stranger, which on a server admits it — wrong direction for the trust model). `config.ts` treats any spelling of zero
dollars (`0`, `0.0`, whitespace) as no spend cap.

**Cleanups adopted from the reference.** A later pass took the reference's better shapes where they cost nothing.
`Delivery` and `Maintenance` take only what they use (`harness`/`host`/`workspace`/`now`/`log`, and explicit
`databaseFile`/`backupDir`/`uploadsDir`/`workspace`/`scratch`) instead of the whole `AgentServices` bag or a `dataDir`
they re-derive paths from. A repository's git identity, `.git/info/exclude`, attachments directory and `startCommit`
are prepared in the `branch` setup step, and `startCommit` lands in the same commit that advances the step to `start`,
so a crash between the two cannot leave the step ahead of the record. The plan-approval flip to `implementing` happens
once, in the answer commit; the tool's resume path no longer repeats it. Dead client exports (`clearDraft`,
`setPickerOpen`, `shrinkPhoto`'s unused dimensions) are gone, and `navigate` takes a `Route` rather than a hash string.
The installer tests hide a program through one shared helper (`test/path.ts`) that symlinks the rest of its directory
into the stub bin, so hiding docker no longer hides bash on a merged-/usr machine.

## Data model

**Everything pigui remembers is a Durable document**, committed with the agent's own state:

- `pigui.session` (conversation): where the session works (`place`: repository or local directory), setup state,
  workflow, plan and progress, the pending card, the report, spend cap, `activeRun`, outcome, `continuations`, the
  person's words verbatim (deliberately unbounded — compaction carries them into every checkpoint and never sheds
  them, so a very long session's checkpoint can exceed its budget; the words are the record, and `recall_history`
  is the recovery path), notification keys used, recent request IDs, and what the next compaction needs (working
  state, count, handoff request time).
- `pigui.index` (session): one drawer row per session, plus last repo, OnPrem's starred directories and creation
  request IDs; rows are a projection recomputed in the same commits and at startup.
- `pigui.repo-memory` (session family): what reports learned about building and testing a repository.
- `pigui.memory` (session): long-term memory rows + embedder state.
- `pigui.push-subscriptions` (session).
- `pigui.agent` (conversation): binds an agent's conversation to its session and current run.

The run's live state stays in Durable's documents; pigui never copies it. The drawer row is derived by one function
(`sessionRow`) so the title bar and the picker agree on every status and tone.

## API and live-update protocol

**HTTP with pi-schema-validated bodies** from `src/shared/api.ts`; one definition of each shape for both sides.
Every mutating request carries a client-chosen request ID, recorded in the same commit as the change, so a retried
send never acts twice.

**One NDJSON stream per app** (`GET /api/live`): the index, the open session's document and Durable view, and each of
its agents' `pi.live`/`pi.usage`/`pi.agent`, each source a Durable watch delivering a value once and then Chord
operations, applied in the browser with `chord/delta`. Reconnect asks for the window after the newest entry the phone
has (`from`), so catching up costs only what was missed. Pings every 20 s; a watchdog at 2.5 pings reconnects through
half-dead mobile connections; closing the app backgrounds the stream, which is also how presence-based notification
suppression knows the person is not looking. History pages older entries on demand.

## Agent tools and prompt

Seven tools (plus `surface_memories` when memory is on, plus Pi's coding tools and the subagent tools):
`ask_single_choice`/`ask_multiple_choice` (several questions per card; recommendation required and pre-selected for
single choice; free text always), `submit_plan` (structured plan: goal, end state, decisions, steps with files,
verification, out of scope, risks, citations — every part stated out loud, or the schema refuses it),
`update_progress`, `file_report` (structured report set against the plan, refusing while agents run or with
uncommitted changes or a stale base), `recall_history`, `write_handoff`. The prompt carries the preamble
(remote-work rules: a reply without a tool call ends the turn and its opening words are the notification; cards are
the only way to wait; every change ends with `file_report`; the person is usually away), the session facts, the
project's instructions and skills through Pi's own loaders, and repo memory.

**Waiting is a parked tool.** The card commits before the tool parks on `pigui.card-answer`; the answer is signalled
in the same commit that clears the card, and a rerun finds its card and neither re-shows nor re-notifies.

**No per-run turn limit for sessions** (only subagents carry `maxTurns`); the spend cap is an `afterTools` hook over
the whole session plus its agents. On reaching it the budget task records the outcome, notifies once, stops every
agent, then ends the round's run. Raising the cap resumes from the round's tool results.

**A report's memory part degrading is not a refusal.** When embeddings fail, the report is filed anyway with a note —
the work matters more than the memory (§Long-term memory). A surfaced-but-unrated memory still refuses the report,
naming each id, because that rule keeps the store honest.

## When a run ends: the supervisor and continuation

One observer (`observeCommits`) plus one idempotent startup reconcile, serialized per session, decides each run's end
exactly once. An unfinished plan in `implementing` is re-nudged at most three times since approval or the person's
last word; after that, "Stopped without a report" and a notification. Outside implementation a reply records
`replied` and notifies. Failures notify with a Continue button and are not retried (Durable retries model and
summary requests); a stop never notifies; `budget` and `waiting-agents` outcomes never notify. The wording for every
failure reason lives once in `shared/session.ts`.

## Compaction handoff

**pigui compacts the context itself, led by the agent's own handoff note; Durable's compaction is the backstop.**
After each tool round, pigui measures the window as Durable does (usage of the round's request plus estimates of its
results); past 60% (15% below Durable's own 75% background threshold), it steers the agent to `write_handoff`; the
next round's child task runs the compaction: a summarizer (the session's model, or `PIGUI_COMPACTION_MODEL`) writes a
checkpoint and chooses the cut over `cappedBounds`, code checks every choice (cut must be one of the valid cuts kept,
the note survives, at most the 25% cap — moved to the nearest later valid cut when over), writes the checkpoint as the
model message of a `pigui.compaction` marker entry, and steers the resume turn. The summarizer's reply is memoized on
the task, so a restart mid-compaction never re-calls the model. How each principle of §A4.10 is met:

1. **Ground truth over memory.** Repository state (branch, HEAD, ahead/behind of the base, commits, changed files,
   uncommitted files), the plan with progress, workflow state and files read/modified are recomputed by code at every
   compaction (`facts.ts`) and placed in the checkpoint unchanged.
2. **The person's words are never paraphrased.** Stored verbatim in `doc.words` and rendered verbatim in every
   checkpoint.
3. **Accumulate; don't re-summarize.** The summarizer's working state is kept in the session document and evolves;
   the previous checkpoint is not among the entries it re-reads.
4. **Lead with the resume point.** The agent's own note stays verbatim right before the resume turn.
5. **Keep negative knowledge.** DECISIONS AND RATIONALE, COMMANDS/TESTS/FAILURES carry them forward.
6. **Point, don't paste.** Long results are cut to head+tail with an entry pointer; condensed results keep call id
   and name, stored entry unchanged, `recall_history` reads the original.
7. **Make loss recoverable.** `recall_history` searches and reads everything; the checkpoint says so and names the
   cut.
8. **Verify before trusting.** "Before you act" tells the agent to `git status`/`git log` and not redo or re-ask.
9. **Never strand the run.** Memoized reply puts a restart on the safe side; a failed summarizer yields the previous
   working state + fresh facts + a "not updated" note; compaction errors do not end the run.
10. **Degrade in a fixed order.** The code-owned facts have a 10% budget shedding files read → files modified →
    changed files → commits; the person's words, plan, session/repo state and working state never shed.
11. **Size relative to the model.** 15% reserve, 25% keep-recent, 10% background, 60% trigger, 25% retention cap,
    10% code-owned budget — all proportions of the session model's window.

The person sees each compaction as one collapsed "Context compacted" row opening to the checkpoint. Compaction never
touches workflow state.

## Long-term memory

Long-term memory lives in one Durable document (`pigui.memory`), recorded and graded by `file_report` rather than a
second call the model skips. Vectors stored base64, searched in memory (fine to a few
thousand rows). Embedders: LEAF on the machine (q8 mdbr-leaf-ir queries, arctic document side, floor 0.28), or an
OpenAI-compatible `/embeddings` endpoint signed by Pi's provider key (`emb-qwen3`, floor 0.44), or a hashing fake in
fake mode; `PIGUI_MEMORY_EMBED_URL` forces an endpoint; re-embedding a store re-makes every vector in batches of 128.
Ranking: cosine + clamped score influence (0.05/row, ±0.25 cap), best eight, per-model floor. Search happens at the
natural moments (once the machinery can be named, on uncovered machinery, on a surprise). Writes apply inside the
report's commit under a rerun guard; the report is refused while a surfaced memory is unrated, naming each; a failed
embedding still files the report with a note. Off is said on the phone in the session picker, with the reason.

## References in messages

One rule (`shared/references.ts`) used by the picker and the server: a sigil starts a reference at text start or after
whitespace or an opening bracket/quote, never inside ordinary text; `#123` stays an issue number. A file reference
brings contents (≤64 KB) or a pointer (too large, binary, a directory); a path leaving the workspace or `.git` is
ignored; unknown references stay plain text. A skill reference invokes the skill as the Pi CLI's `/skill:` does
(frontmatter stripped, `<skill name location>` block, baseDir note). The person's text is stored as typed; the added
context goes ahead of it; the transcript shows compact chips. On New session, the pickers read the chosen branch
through the repository host before anything is cloned.

## Notifications

Enqueued in the commit that creates the need, keyed (`card:<taskId>`, `report:<taskId>`, `run:<id>`, `budget:<cap>`),
delivered by a background Durable task (a restart between commit and send still sends); deduped by `doc.notified`
(200 keys); at-least-once sends are made to look like one by the per-session notification `tag` and the push `Topic`
header. Suppressed while the person views the session. Web Push is `node:crypto` (RFC 8291 encryption, RFC 8292
VAPID), no `web-push` dependency; VAPID keys are created on first start at `<data>/vapid.json` with mode 0600.

## Cleanup and backups

One Durable task in the root conversation sleeps a day between rounds: SQLite online backup (`node:sqlite`) with 14
kept, stale uploads pruned, and the workspace of a session archived 7+ days ago removed only when git shows nothing
uncommitted, HEAD is an ancestor of the origin branch or base, and no local branch has commits origin lacks. Only
pigui's own directories are ever removed; a local session's directory never is.

## The phone app

**Svelte 5 + Vite, no SvelteKit** (supersedes the Preact + esbuild choice, 2026-11-24). The web UI was rebuilt from the
ground up on the `svelte-rewrite` branch; the Preact client was deleted and the 27 Playwright specs are the behavioral
contract. Runes only (`$state`, `$derived`, `$effect`, `$props`); no Svelte 4 syntax; `svelte-check` clean. No component
`<style>` blocks: `app.css` (partials under `src/client/css/`, bundled by Vite) is the only stylesheet. `marked` +
`DOMPurify` stay, lazy-loaded. *Alternatives:* Preact + signals was the runner-up, the smallest delta from the deleted
code, but the rewrite exists to fix the update model (per-token full re-renders, O(n) derivation), and signals carry
the same component model forward. Solid has comparable fine-grained reactivity with a smaller ecosystem and JSX again.
SvelteKit adds a server framework and SSR for an authenticated single-user SPA behind Tailscale that needs neither.
Vanilla JS and Astro are the wrong shape for a live streaming UI.

HIG mapping: clarity (placeholder says what
sending will do; one-sentence tool summaries; named failures with next steps), deference (content first; detail folded
until asked; status and spend as one quiet line), sensible defaults (last repo, new branch from the default,
recommended options pre-selected), familiar navigation (☰, Finder-style picker), feedback and forgiveness (archive with
Undo, drafts never lost, Undo navigates back), accessibility (Dynamic Type via body-fraction type sizes, light/dark
token sets, 44 pt targets, safe areas, reduced motion, keyboard resizes the layout, ARIA roles and live regions).

**The look.** Source Serif 4 / IBM Plex Sans / IBM Plex Mono, three faces with one job each; warm ink on a near-white
page (`#fcfbf8`/`#1b1915`); dark is a page all but black (`#010405`) with bright cool ink (`#e2ecea`) and dimmed
informational colours; yellow reserved for the person's turn. One hue per meaning (cyan working, yellow you, green
done, orange warn, red error, blue GitHub). app.css declares one small set of values (spacing 2…24 px, three radii,
type as fractions of Body, three motion durations, two curves) and is maintained as the reference's, byte for byte.
Type scale follows Dynamic Type; the send key is a 44 pt target around a 32 pt ink key.

**Wide screens** get the same app laid out for the width: full-width bars, 760 px reading column, the sheet becomes a
centred dialog. **Sheets** follow the finger (velocity from its last 100 ms, projected with iOS's scroll
deceleration); reduced motion keeps fades and drops movement; no theme picker (dark follows the device).

## Fake mode

The scripted model is Pi's faux provider, one response factory queued per request; a conversation's step is read from
the newest scripted tool-call id (handoff notes and recall don't move it), which survives compaction because the
scripted summarizer cuts at or before it. Directives in the task steer variations (`[chat]`, `[no-report]`, `[long]`
to fill the window, `[memory]`, `[agents]`). Tokens are priced so the cap is testable. The GitHub stand-in implements
`RepoHost` with bare repositories (real git push/fetch) and a `pulls.json` file that survives restarts.
`PIGUI_FAKE_TOKENS_PER_SECOND` paces the stream; the model's `contextWindow` is settable per test (26.5k tuned the
compaction suite at this repo's long path; see Tests). Nothing touches the network.

## Tests

`node:test` against the real server in fake mode (`startApp`), real Durable storage, no mocks; waits on Durable
watches. Crash timing uses explicit fault seams (`AppOptions.faults`) instead of process kills. 19 files port the
reference's matrix; the deploy/install files exercise the scripts' dry-run paths. Two adjustments of note, both
recorded: (1) `ONE_COMPACTION` grew from 26.5k to 28k because the skills list renders each skill's absolute location,
so an install path ~170 bytes longer than the reference's tips the scripted scenario's last rounds over the trigger —
the same re-tuning the reference did when it added the skills list; (2) one timing-sensitive subagent test now waits
for the background answer's entry to appear instead of reading immediately (the row commit and the entry are one
commit; the poll merely catches the watch up). Nothing was weakened.

## The installer

A bash decision tree (`install.sh`): container or not, this computer or remote, then the flags; four paths (local
sandboxed in Docker, local full as the person, remote sandboxed via a systemd service, remote full with credentials
copied over SSH). Every step through two helpers prints or acts; re-running upgrades in place; config keeps existing
values unless replaced; `--dry-run` changes nothing and lists everything; ends with the human-only steps. The systemd
unit uses `RestartPreventExitStatus=78 2`. `deploy/install.sh` (Debian 13/Ubuntu 24.04, root), `deploy/onprem.sh`
(shim), `deploy/lib.sh` (shared helpers), `deploy/models.sh` (pinned, sha256-verified model downloads), `deploy/trim.sh`
(mask what a pigui-only machine never uses, add swap, cap the journal) are its parts, and they are byte-ports of the
reference's, with the ref updated to `main` — the installer is machine tooling, not application code.

**`PIGUI_MODELS_UNLOAD` is validated in one place per side, over one shared schema.** `deploy/lib.sh`'s `unload_valid`
is the single bash definition, sourced by both installers; the server's `parseModelsUnload` mirrors it exactly (decimal
digits, 1–1440, `never` or unset to keep the models loaded, leading zeros allowed), and the held-model test pins the
server's acceptance set. The installers previously rejected a leading-zero value the server accepted, and the server
accepted hex and scientific spellings the installers rejected; both now refuse anything outside the schema.

## Running in Docker

Two containers: Tailscale (kernel-mode serve from the official image, its auth key used once, `NET_ADMIN`/`NET_RAW`,
no ports published) and pigui (ubuntu:noble, Node copied from the official image, all capabilities dropped, read-only
root with only its data/home volumes and a size-capped /tmp, unprivileged user, setuid bits stripped). pigui shares
Tailscale's network namespace; `tailscale serve` is the only way in. Speech and LEAF are build-time switches; models
come pinned and checksummed.

## Session isolation

(For servers. OnPrem deliberately has none of it.) Two GitHub tokens — pigui's read-write (its own process, on a tap)
and the agent's read-only (its commands, `GH_TOKEN`/`GITHUB_TOKEN`). An allowlisted command environment (no pigui
settings), Landlock around every command and file-tool path (the file tools confined by realpath in-process, with the
documented check-then-use race), `/proc` hidden from file tools, pigui's API refusing its own user by kernel socket
table. `PIGUI_SANDBOX=off` is the way out for kernels without Landlock; real mode otherwise refuses to start there.

## Reading replies aloud

A tap asks the session's model for a speakable rewrite (one call, thinking off, streamed sentence by sentence, spend
counted like the summarizer's), cut to ≤200-char segments; Kokoro-82M q8 synthesizes on CPU (voice `af_heart`,
one-at-a-time queue, silence trimmed to 50/200 ms, WAV from our own 16-bit encoder), held as `PIGUI_MODELS_UNLOAD`
says; the phone keeps one unlocked HTMLAudioElement and reads ahead. The reading continues with the screen locked.
`PIGUI_SPEECH=off` leaves it out of the build and the app says the speaker is absent.

## Slash commands: not built

Pi Durable has no command concept; each would need its own adapter against Pi's interactive-mode internals. Prompt
templates could appear in the composer the way skills do; they have no inner menus, so they were left out.

## PiGUI OnPrem

One switch (`PIGUI_ONPREM`, default off, port 2025) rather than per-protection flags: the sandbox, the agent's
read-only token and the caller check are all wrong on the person's own computer in the same way, so one switch changes
them and a contradictory setting (`PIGUI_SANDBOX=on`, `PIGUI_AGENT_GH_TOKEN`) is a configuration error naming why.
Local sessions beside repository sessions; a session's place is a discriminated union; directories resolved at create;
stars live in the index document and recents are derived from the rows; a bounded breadth-first walk powers the
picker; the request gate refuses other sites' pages in both modes; Host and caller checks turn around on Linux
(own user and root allowed, others refused; macOS checks nothing — any user of the Mac can reach it, documented);
remote OnPrem may sit on the tailnet behind the same login allowlist and hosts check.

## Subagents

A Durable task per run (`pigui.agent`) owned by the dispatching call or the agent's conversation; queueing is the
session's agent tasks themselves, oldest waiting runs first (`maxInFlight`, default 4); the foreground waits on the
call (stopping the parent stops the call, its task and the agent); the background submits the answer to the parent as
a message in the commit that ends it; steering submits with `whenBusy: "steer"`; resuming starts a new run on the
same conversation; definitions load from four roots (bundled → person's own → workspace → project), read at every use,
with refused definitions removed rather than silently falling back. Agents never get the session tools or the
subagents extension — they cannot ask, plan, report, or start agents; their commands run in the session's directory
under the session's sandbox; their spend counts toward the session cap.

## Dependencies

Pinned exactly with the lockfile committed: the five `@earendil-works/*` at 1.6.0; `svelte` 5, `marked`, `dompurify`;
`vite`, `@sveltejs/vite-plugin-svelte`, `svelte-check`, `typescript` 6.0.3 (svelte-check imports the TypeScript 6 API;
TypeScript 7's native compiler exposes no JS API as of svelte-check 4.7.8), `esbuild` (the service worker only, until
the cutover), `@types/node`, `@playwright/test`; dev fonts from Fontsource; optional `kokoro-js` and
`@huggingface/transformers`. `npm audit` reports `sharp` (via `@huggingface/transformers`) with no fix available; it is
an optional dependency only reached by the on-device models, and builds with `PIGUI_SPEECH=off` prune it.

## A build note: the Landlock launcher

`src/sandbox/pigui-sandbox.c` compiles where `cc` exists (`npm run build` skips it elsewhere, where pigui falls back
to a launcher on PATH). It was compiled and exercised at ABI 8 with the system `cc` (write/echo confined, reads
refused); an earlier pass on a machine without a system C compiler used a pip-installed `ziglang` at ABI 6.

## The 2026-11 issue repairs

**The bundled agent definitions no longer match the reference byte for byte.** The owner approved changing the convention
so agent answers render as headed Markdown sections instead of a dense `STATUS:`-labelled blob. The report blocks in
`agents/implementer.md`, `agents/scout.md` and `agents/verifier.md` now instruct one `## ` Markdown section per field
(`## STATUS`, then the rest in order); the input-contract blocks are unchanged. The renderer splits answers that still
arrive with bare `LABEL:` lines into labelled sections (`ReportBody.svelte`), so legacy-shaped answers keep rendering well.
*Alternative rejected:* rely on the UI renderer alone and leave the definitions identical; it would leave the prompt asking
for an answer shape no Markdown renderer can head.

**Subagents dispatch in the background by default.** `Agent` now returns at once unless the caller passes `run_in_background: false`, and the tool description and `<subagents>` guidance say so. The parameter keeps its name with an inverted default: renaming to `run_in_foreground` would break the fake model, the tests and any saved prompts for no behavioural gain. This is a behaviour change for saved prompts that relied on the old foreground default. Pushing a *running* foreground agent to background is deliberately not implemented: Durable fixes ownership at dispatch and has no re-own or early-release primitive, so it needs either a design pass (a release task the park waits on beside the agent task) or an upstream Durable ask; the person deferred it.

**The screensaver is a plain `<img>` lower right, gated on `workflow === "implementing"` alone, dismissed by any input.** After five idle minutes (a capture-phase watch on pointer/key/touch/wheel/scroll re-arming a one-shot timer, `idle.ts`), only in a session whose plan is approved and not yet reported, `girl.gif` (bundled at `src/client/public/girl.gif`, 500x500, lower right) appears above every sheet and toast. "Actively in implementation mode" was read from the first-class `SessionDoc.workflow` field rather than from a run under way: the flag is simpler and survives between runs. Reduced motion suppresses it entirely; a hidden tab never shows it; any input dismisses it and re-arms the wait. If the asset is missing the screensaver disables itself instead of showing a broken image. *Alternatives rejected:* an in-motion run-state condition (stricter than the words, and flickers between runs); a CSS/canvas character (the person supplied `girl.gif` and will upload it); remote footage (CSP forbids it, and the rights question is the person's).

**Svelte 5 stays; the lag was in the per-update hot path, not the framework.** The transcript rebuilt and re-cloned every block per `view-ops` message (~10 Hz during streaming), re-stringified call args per token, re-parsed Markdown per token and forced synchronous layout per update. The repairs: one-entry memo on `buildBlocks` keyed on the three inputs, `at` stamped in place, `live` flips without re-cloning, call args stringified through a `WeakMap`, Markdown renders throttled to ~100 ms with a by-text cache, `followEnd` batched into one rAF per frame, `aria-live` dropped from the log, and the sticky bars use an opaque `--bar` with no `backdrop-filter` (a 10% alpha difference nobody can see, a filter nobody needed). *Rejected:* a rewrite; nothing in the measurements pointed at the framework.

## Fresh-machine testing, and install parity (issue #15)

Both ways a fresh checkout fails were environmental, and both now fail clearly instead of confusingly. `npm test` runs a
`pretest` guard (`scripts/check-install.ts`) that refuses with "node_modules is missing — run `npm ci` first" when
`node_modules/@earendil-works` is absent, instead of 16 of 45 test files dying with `ERR_MODULE_NOT_FOUND`. `npm run e2e`
now has a Playwright `globalSetup` (`e2e/global-setup.ts`) that launches Chromium once and, on the missing-system-libraries
signature (`error while loading shared libraries` / `libnspr4` / exit 127), throws one error naming `npx playwright
install --with-deps chromium` instead of 27 identical spec deaths; the Dockerfile stays the runtime image and does not
run the tests. A GitHub Actions workflow for e2e was considered and left out at the owner's direction. The `install.sh` OnPrem paths (as root, and the remote-full SSH path) now
install `ripgrep unzip build-essential`, matching the Docker image and `deploy/install.sh`, so the agent has the same
tools wherever pigui is installed; the OnPrem paths still compile the Landlock launcher without complaint only where a
C toolchain exists. *Alternatives rejected:* guarding inside the test helpers (fails after the runner starts, per file);
detecting the signature in the worker fixture (the launch happens inside Playwright, not the fixture); adding e2e to the
Docker image (it is the runtime image, not a test environment).

**No viewport-fit=cover.** The iOS status bar (standalone or Safari) is a glass material that blurs the web content beneath it, and its halo reaches past `env(safe-area-inset-top)`, softening the first line of the title bar (observed as a blur over the top line on the session screen). Removing `viewport-fit=cover` keeps the web view below the status bar; the strip it reserves is filled from `theme-color`, which matches `--bg` in both colour schemes, so the seam is invisible. *Alternatives rejected:* a taller topbar inset (device-dependent halo size; guessed clearance); `apple-mobile-web-app-status-bar-style: black` (opaque black in light mode). Trade-off accepted by the person: content no longer bleeds under the notch/Dynamic Island, including the landscape side strips; `env(safe-area-inset-*)` now resolves to 0 and stays in the CSS as a no-op.

**The shell follows the visual viewport, offset and height.** iOS does not resize the layout for the software keyboard; it shrinks and pans the visual viewport, so a shell sized only from `visualViewport.height` stays pinned to the layout top and leaves a void above the keyboard (observed: composer flung to the top edge on keyboard open). `watchViewport` publishes `--viewport-offset` alongside `--viewport-height` and `.app` takes `margin-top: var(--viewport-offset, 0px)`; `visualViewport` scroll events republish both as iOS pans, so the shell exactly covers the visible strip. Margin, not transform, because transforms would make it the containing block for the fixed toasts, sheets and picker.

**The app is a fixed-height shell; the transcript is the only scroller.** The top and composer bars were `position: sticky` against a document-level scroll, and on iOS the hamburger and send button were intermittently unhittable until the phone was rotated. WebKit keeps the layout viewport and the visual viewport separate, and when the keyboard opens or the dynamic toolbar collapses, the visual viewport shrinks or pans while sticky bars stay anchored to the layout viewport; WebKit then hit-tests viewport-anchored geometry against stale values until a relayout is forced, which a rotation happens to do. The structural fix removes the desync instead of nudging it: `.app` is sized from the `--viewport-height` that `watchViewport` publishes (the `visualViewport` height, falling back to `100dvh`), `.session` clips, the transcript (or the new-session form) scrolls internally, and the bars are plain flex children with no positioning anchor. All scroll math in `viewport.ts` goes through the registered transcript element rather than `window`; the at-end scroll listener is a document capture listener, as scroll does not bubble. *Alternatives rejected:* `position: fixed` bars (equally visual-viewport-anchored on iOS, same stale-geometry class); forcing a relayout on visual-viewport events (a workaround the hit-test path does not reliably honour); keeping `sticky` and document scroll. Not verified on a physical iPhone from this machine; the invariant (nothing viewport-anchored) is what carries the fix.

## Harness diagnostics never render raw

pi-durable stores its tool-result diagnostics as a trailing `<harness>…</harness>` text block, and pi-ai's validation errors embed the entire arguments payload after `Received arguments:`. Neither is ever shown to the person: `splitResult` (src/client/transcript.ts) cuts harness sections out of every text block they appear in, and the diagnostics are never shown to the person, not even behind a tap. Instead the server logs them: a `pigui-diagnostics` extension (src/server/agent/toolDiagnostics.ts) hooks the generation task's `afterTools` and writes one `tool.diagnostics` line per diagnostic found on the committed tool-result entries (`data.diagnostics`), with pi-ai's `Received arguments:` payload cut and the message capped at 500 chars; it is installed in the shared registry and not excluded for agents, so agent tool calls are logged too. Failed card tools (`file_report`, `submit_plan`, `ask_*`) show a one-line human notice built from the first error line, never the payload; a failed call that never parked a card shows a short note rather than silence. The arguments payload stays only in the stored Durable entry.
