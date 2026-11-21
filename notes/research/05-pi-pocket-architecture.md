# Pi Pocket architecture evaluation

Subject: `/home/user/refs/pi-pocket` (v0.30.1, 2,776 commits, 2026-10-03 to 2026-11-21, about 85% by one author).
Pinned to Pi packages 1.6.0 (`package.json`). Line numbers are `file:line` in the pi-pocket tree. Line counts are
`wc -l` (physical lines, Prettier at 100 columns, one statement per line, blank lines everywhere), so they overstate
size compared with a dense codebase. Where I say "about" the number is rounded or estimated.

Method note: judged from code. Where docs (`docs/architecture.md`, `docs/features.md`) were useful I say so. The
README's claims were not relied on.

---

## 0. Verdict in six lines

1. Pi Pocket is a real, deep **Pi Durable host**, not a wrapper. One process, one SQLite file, one `Harness`, one
   conversation per session, and the server is a projection layer that turns Durable's committed views into
   per-tab SSE events. That core is sound.
2. It does **not** use `pi-coding-agent`'s session, tool or extension system. It uses `pi-coding-agent` only as a
   config, model-auth, skills and settings library (`ModelRuntime`, `SettingsManager`, `loadProjectContextFiles`,
   `SessionManager.listAll` for import). Tools come from Durable (`createCodingTools`), and everything else is
   Pocket's own extension system built on Durable's `defineExtension`.
3. The product is about **15 times larger than the "phone to agent" core needs**. Of about 200k lines of source, a
   core of roughly 35k to 45k lines does the job. The rest is a design-system toolchain, a chat relay, an extension
   gallery, a self-updater, a desktop launcher, PiP (a resident assistant) and more. All of it is on one server and
   mostly inside the same `PocketApp` object graph.
4. The architecture is **disciplined at the seams** (documented ordering invariants, `PocketHost` boundary for
   extensions, stored document kinds frozen, 90k lines of tests) and **weak in cohesion at the centre**: a 4,000-line
   `PocketApp` class, 53 modules holding a reference to it, and `app.ts` and `store.js` as de facto namespaces.
5. Out of the box there is **no approval gate**. Lancet Guard is a separate npm package from the user's Pi install
   and its Pocket module is off by default (`reload.ts:80-87`). A fresh install runs bash, write and edit with no
   check, for anyone who can steer.
6. Approvals and human waits are not Durable parks. They hold a hook invocation on an in-memory promise
   (`host.ts:352-377`, `extensions/guard.ts:46-77`) and re-ask after a restart, which is the one place the app
   works against the grain of what Durable offers.

---

## 1. Layer map

### 1.1 Size by subsystem (physical lines)

| Subsystem | Path | Lines | What it does |
|---|---|---|---|
| Server top level | `src/server/*.ts` (121 files) | 57,046 | App object, commands, rooms, projection, config, auth, stores |
| Built-in extensions | `src/server/extensions/` | 33,974 | 25 modules (`.ts`) plus their browser parts (`.js`, `.css`) |
| Design toolchain (core) | `src/server/design/` | 26,198 | Token model, DTCG, Figma `.fig` parsing, linter, doc-site generator, pptx export |
| Design extension UI | `src/server/extensions/design/` | 15,245 | Canvas, comments, system view (JS and CSS) |
| Relay extension | `src/server/extensions/pocket-relay/` | 6,609 | Discord, Slack, Telegram, Matrix, RSS, HTTP connectors |
| HTTP | `src/server/http/` | 6,755 | Routes, SSE and long-poll, assets, artifact inspect |
| Browser | `src/server/browser/` + `browser.ts` | 2,772 + 435 | Headless Chromium over CDP, one page per session |
| Gallery | `src/server/gallery/` + `gallery.ts` | 2,806 + 1,617 | Extension and theme marketplace |
| Themes | `themes/` + `themes.ts` | 797 + 1,209 | Theme loading and validation |
| Launcher | `src/launcher/` | 2,876 | Interactive access chooser, Cloudflare and Tailscale tunnels, desktop wrapper |
| Web client JS | `web/*.js` | 44,122 | Preact+htm, no build step |
| Web sheets | `web/sheets/*.js` | 12,565 | Modal sheets (settings, gallery, providers, etc.) |
| Web CSS | `web/style.css` | 21,994 | One stylesheet |
| Tests | `test/` (258 files) | 90,619 | Node test runner |
| Docs | `docs/*.md` | 1,961 lines in the top level (plus `docs-site/`, `site/`) | Maps and guides for self-editing |

Rough totals: server TS and JS about 135k, web about 79k (incl. CSS), tests 90k, marketing site about 12k
(`site/`, not counted above).

### 1.2 Core to "run a coding agent session from a phone"

Roughly 35k to 45k lines of server plus 25k to 30k of web. Evidence for what is core:

- `src/server/app.ts` (4,446): the App object. Opens the Harness (`app.ts:1039`), recovers state, observes commits,
  owns clients, access checks and rooms.
- `src/server/commands.ts` (3,044): every user action (create, rename, send, steer, queue, interrupt, fork, resend,
  compact, reset, model, plan, goal). `Commands.submit` at `commands.ts:796`.
- `src/server/room.ts` (1,445) and `projection.ts` (1,175): one live view per conversation, projected to per-tab
  JSON (`room.ts:419`, `projection.ts:547`).
- `src/server/http/*` (6,755), `http.ts` (249), `auth.ts` (233), `config.ts` (538): HTTP server, SSE and poll,
  sign-in, invites and roles (owner, guest, viewer: `config.ts:44`).
- `src/server/docs.ts` (1,090): 41 Durable document kinds (chat, authors, subagents, plan, pins, spend...).
- `src/server/host.ts` (976): `PocketHost`, the extension boundary, plus `Approvals`.
- `src/server/reload.ts` (1,239) and `extension-*.ts`: extension loader with hot reload. Core only because most
  features are extensions.
- Models and providers: `models.ts`, `providers.ts`, `custom-providers.ts`, `model-*.ts`, `project-model.ts`
  (about 2.4k).
- Files, git, changes, worktrees, branches, transcripts, push and alerts (about 4k).
- Built-in extensions that are on by default and part of the "agent experience": `prompt.ts`, `plan.ts`,
  `subagents.ts`, `background.ts`, `codemode.ts`, `tool-search.ts`, `ask.ts`, `artifacts.ts`, `memory.ts`,
  `goals.ts`, `schedules.ts`, `browser.ts` (about 8k lines).
- Web: `app.js`, `store.js` (3,383), `transcript.js` (4,222), `composer.js` (3,077), `sessions.js` (3,082),
  `live.js`, `diff.js`, `ui.js`, `files*.js`, the sheets for model, session, people, providers.

### 1.3 Peripheral (feature creep relative to the phone-to-agent brief)

| Feature | Lines (approx.) | Evidence |
|---|---|---|
| Design system (tokens, Figma `.fig` import, linter, docs-site generator, pptx) | 41k server and web | `src/server/design/` 26,198 plus `extensions/design/` 15,245. 70+ files, e.g. `scan-fig-kiwi.ts`, `lint-page-*.ts`, `docsite-*.ts`. Tests: `design-*.test.ts` 8k+ |
| Relay (chat service connectors) | 6.6k | `extensions/pocket-relay/`; off by default (`reload.ts:85`) |
| PiP (resident assistant that starts and watches sessions) | about 4.5k | `pip.ts` 1,821, `pip-compact.ts` 607, `extensions/pip.ts` 786, `web/pip.js` 1,567, `pip-window.js` |
| Gallery (marketplace for extensions and themes) | about 4.4k | `gallery.ts`, `gallery/*`, `web/sheets/gallery.js` 2,338 |
| Self-update (npm and git switching with rollback) | about 3.6k | `updates.ts` 1,514, `update-state.ts` 963, `npm-update.ts`, `npm-install.ts`, `extensions/updates*` |
| Launcher and tunnels | 2.9k | `src/launcher/main.ts` 1,303 plus `access.ts`, `serve.ts`, `desktop.ts` |
| Limit gate, spend, cache keeper, timing | about 3.8k | `limit-gate.ts` 1,530, `limits.ts` 574, `spend.ts` 533, `cache-keeper.ts` 606, `timing.ts` |
| Agent Teams and linked sessions | about 2k | `linked-sessions.ts` 1,473, `extensions/agent-teams.ts` 552; off by default |
| Watches (PR and repo watchers, webhooks) | about 3k | `watches.ts` 1,116, `repo-watches.ts` 842, `hooks.ts` 686, `extensions/triggers.ts` |
| Themes | about 2k | `themes.ts` 1,209 plus web themes |
| Background process supervision | 3.1k | `background.ts` 1,685, `processes.ts` 1,419 (cross-platform pid and start-time identity, Windows job objects) |
| Multi-user "Ask someone", reactions, avatars | about 1.5k | `extensions/ask-someone*`, `collab.ts`, `avatars.ts` |

Several of these (design, relay, gallery) are loaded as extensions and can be turned off. They are still inside the
same repo and `PocketApp`, and they ship in the same package. The design toolchain alone (41k) is larger than the
whole session-running core.

---

## 2. How Pocket uses Pi Durable

### 2.1 Where each Durable concept is wired

| Concept | Where | Notes |
|---|---|---|
| Harness open | `app.ts:1039` (`Harness.open(storage, {...}, context)`), sole call site | Storage is `openNodeSqliteStorage(join(dataDir, "pocket.sqlite"))` (`app.ts:1037`) |
| Models | `app.ts:854-862`, `ModelRuntime.create()` from pi-coding-agent | Wrapped five times (see 2.3) |
| Registry | `app.ts:871` `createRegistry()`; `registry.install(await codingTools())` at `:873`; `pocket-core` extension at `:875-897`; other extensions installed by `ExtensionLoader` (`reload.ts`) | 51 `defineExtension` uses across 22 files |
| Coding tools | `app.ts:4429-4445`: `createCodingTools({images: createNodePhotonImages()})`, falls back to `CodingTools` | Durable's read, write, edit, bash (`pi/packages/durable/src/tools/index.ts:32-37`) |
| Settings | `app.ts:1521-1569` `#harnessSettings()`: `restartLimit: Infinity`, extensions, stream, compaction, retry, steeringMode, followUpMode, mapped lazily from Pi's `SettingsManager` | Live getters, so Pi settings edits apply with no reload |
| Env | `app.ts:1046` `env: ({conversationId, cwd}) => this.#wrapped(...)`; `#wrapped` `:1696`, `#env` `:1704` | Local `NodeExecutionEnv`, or a workspace provider by URI scheme (`:1708-1716`), wrapped for secret hiding and a quiet-output limit |
| Conversation creation | `app.harness.createConversation` at `commands.ts:459`, `:518`, `:2955`; init hook `app.ts:1047-1052` adds three app docs | One root conversation per session; forks via resend and branch |
| Submit | 29 `.submit(` calls in 16 files; main path `commands.ts:1015`; with admission in the same commit as note entries (`docs/architecture.md`, the `turn-notes.ts` paragraph) | Uses `requestId` for idempotency (`commands.ts:299`, `:2233`) |
| Watch | `room.ts:419` `conversation.watch(context)`; `harness.observeCommits` at `app.ts:1065` | Rooms follow the committed view. `observeCommits` drives the in-memory mirrors in `#committed` |
| Documents | 155 `.snapshot(` calls, 208 `.commit(` calls; 41 document kinds in `docs.ts` | Heavy use. This is the app's real database |
| Tasks | 26 `defineTask` hits in 11 files | `shell.ts:81`, `resend.ts:59,127`, `watches.ts:254`, `repo-watches.ts:193`, `schedules.ts:193`, `background.ts:299`, `pip.ts:232`, `extension-commands.ts:103`, `commands.ts:367`, subagents (4 tasks) |
| Hooks | `hook(ToolTask, ...)` in `app.ts:887` (secret scrubbing in `afterTool`), `guard.ts` (`beforeTool`), `plan.ts` | Hook usage is idiomatic |
| Resume | `app.ts:1118` `harness.resume()` after recovery | `restartLimit: Infinity` so a phase waiting for hours is never "parked" by repeated restarts |
| Abort | 43 `.abort(` uses; `stopToolCall` `app.ts:~1760` aborts one tool task by id | Plus a custom interrupt task (`resend.ts:127`) |
| Compaction | `compaction.ts` (157 lines) is only a settings adapter from Pi's `compaction.*` and `modelOverrides` to Durable's policy; `pip-compact.ts` (607) customizes PiP's `beforeCompact` hook | Durable owns the algorithm |
| Retry | `retry: settings.getRetrySettings()` into Harness settings (`app.ts:1553`) | Durable owns retries; Pocket adds quota waiting outside it (below) |
| Steer/queue | Durable `steeringMode`, `followUpMode` (`app.ts:1558-1564`) set to `"all"` | Pocket adds a "held" queue on top (`HeldDoc`, `commands.ts:~1337` `#hold`) |
| Signals, parks | `grep` finds **no** `defineSignal`, no `{kind:"sleep"|"wait"}` park, no `readSignal` | The one capability Pocket skips, see 2.4 |
| Sleep | Schedules and watches use `sleepUntil` checkpoints (`docs/architecture.md`) | Correct use of durable timers |
| Replay safety | `replay: "safe"` on 5+ tools (`artifacts.ts:716`, `ask.ts:58`, `triggers.ts:60`, `schedules.ts:115`, `agent-teams.ts:307`); 18 `api.memo` uses | Careful use of idempotency |
| Telemetry | none found | `HarnessOptions.telemetry` unused |

Public Durable API surface touched, in order of use: `Harness`, `Conversation`, `Tx`, `defineExtension`, `defineTool`,
`defineTask`, `hook(ToolTask)`, `section` (prompt), `AgentDoc`, `LiveDoc`, `InboxDoc`, `UsageDoc`, `ProviderDoc`,
`createRegistry`, `configure`, `observeCommits`, `scanConversations`, `ExecutionEnv`, tool-search, codemode.

### 2.2 pi-coding-agent versus Durable: which "agent" is used

Only Durable's agent. Grep for pi-coding-agent imports in `src/` returns library-style use:

- `app.ts:21`: `getAgentDir`, `ModelRuntime`, `resolveModelScopeWithDiagnostics`, `SettingsManager`, `Skill`.
- `extensions/prompt.ts:10`: `getDocsPath`, `loadProjectContextFiles`, `Skill` (for the system prompt).
- `skills.ts:28-41` and `prompts.ts:7-15`: copy Pi's skill and prompt-template resolution because "the package does not
  export" those internals ("check them when updating Pi", `skills.ts:28`). A duplicated-logic risk.
- `pi-sessions.ts:31,603`: `SessionManager.listAll`, for **importing and exporting** Pi CLI JSONL sessions
  (`commands.ts` imports `writePiSession`).
- `lancet.ts:13`: `getAgentDir`, to find the guard package.
- `model-images.ts:9`: `resizeImage`, `formatDimensionNote`.
- `extensions/plan.ts:9`: type `ToolAnnotations`.

No `AgentSession`, no `createAgentSession`, no pi-coding-agent `ExtensionAPI`, no `registerTool`, no pi tools. As
`lancet.ts:3-4` says, "Pi Pocket runs its tools outside Pi, so Pi's extensions do not see them", so Pi CLI extensions
cannot run here. Pocket therefore built its own extension system (25 built-in, drop-ins, gallery, hot reload), and had
to load the guard by reaching into another package's `src/` with `jiti` (`lancet.ts:76-110`). That is the price of
choosing Durable's runtime over the Pi coding agent.

Pi and Pocket share state through files only: `~/.pi/agent/settings.json`, `auth.json`, `trust.json`, skills,
AGENTS.md, and `~/.pi/lancet-guard.json`.

### 2.3 Wrapping the model layer (outside Durable)

`app.ts:854-868` stacks five wrappers on `models`: `cacheKeeper.installPayloadObserver`, `installRequestShaping`
(`app.ts:4390`, which re-wraps `streamSimple` to run extension payload shapers), `measureModelStreams` (`timing.ts`),
`limits.install` (`limit-gate.ts`, 1,530 lines), and `cacheKeeper.install`. The order matters and is commented line by
line ("Innermost", "Outside the timing wrapper", "Outermost"). These are monkey patches on `Models.streamSimple`.
They work and are documented, but they are the most fragile coupling to Pi: any change to `streamSimple` in pi-ai
breaks four subsystems. `limit-gate.ts` implements "wait for a quota to clear inside the stream" so Durable sees one
slow request. That is a genuine feature Durable lacks (its retries are bounded), at a cost of about 2.1k lines.

### 2.4 Duplication or reimplementation of Durable features

Honest scoring, with line counts where the concern is real.

| Capability | Durable provides | Pocket | Verdict |
|---|---|---|---|
| Session storage | SQLite and JSONL | Uses SQLite only. `pi-sessions.ts` (766) is import and export to Pi CLI JSONL | Not duplicated. Interop |
| Queueing and steer | `pi.inbox`, steer, follow-up | Delegates, adds `HeldDoc` (stop holds queued messages), `interruptTask`, `ResendTask`, `inbox.ts` (235) for external deliveries | Extension of Durable, not a copy |
| Streaming | `watch()` and `observeCommits` | Rooms project commits and live deltas (`projection.ts:788` `liveMessageDelta`) | Uses Durable; the projection is the product |
| Retry | Durable retry settings | Adds the limit gate for quota waits (about 2.1k) | Additive |
| Compaction | Durable policy and algorithm | 157-line settings adapter; PiP gets a custom summarizer (607) | Not duplicated |
| Subagents | Primitives only: owned conversations, `submit` with `notify`, README examples 21 to 22 | `extensions/subagents.ts` 1,876 plus `room.ts` peeks, `subagent-runs.ts`, `stall-facts.ts` | Header says "after Pi Durable's example 23" (`subagents.ts:2`). Durable ships no subagent tool, so this is a product build, but it is a large one. The module is the biggest extension, with 4 durable tasks (anchor, reporter, courier, stall-watch) |
| Approvals | `beforeTool` can return `{sleep:{signals}}` to park for a person (README 785-801) | `Approvals` class (about 100 lines, `host.ts:352-420`) with an in-memory promise inside `beforeTool` (`guard.ts:46-77`). Memo stores the answer, a restart re-asks | **Diverges from Durable's model**. Docs say "In memory on purpose" (`host.ts:350`) because the hook runs before the intent is stored. The parked variant would survive restarts without asking twice and release the invocation. Not a duplicate, a choice against the grain |
| Background commands | bash tool only, no background | `background.ts` + `processes.ts` (3.1k), `shell.ts` (369) | Not in Durable. Heavy bespoke code: pid + start-time identity, Windows job objects via PowerShell |
| Watches and timers | `sleep`, timers | 4 near-identical `WatchInput/WatchState` task definitions in `watches.ts:254`, `repo-watches.ts:193`, `background.ts:299`, `pip.ts:232` | Uses Durable properly, but the poll-and-report-with-backoff pattern is copied 4 times (see 4.4) |
| Registry and hooks | Core | `reload.ts` loader (1,239) adds file hot reload, per-module enable, tool-name collision rules (`reload.ts:907-915`) | Reasonable extension layer |
| Env | `ExecutionEnv` | Wraps it for secret scrubbing and quiet limits (`hidden.ts`, `deadline.ts`) | Uses the seam |
| Tool search and codemode | `pi-durable/tool-search`, `pi-codemode` | Thin extensions (`tool-search.ts`, `codemode.ts` 564) | Reuses |
| Usage and cost | `UsageDoc` | `spend.ts` (533), `conversation-usage.ts` (235) for budgets | Additive |

Net: little outright reimplementation. The deliberate near-duplicates are (a) the skill and prompt-template loaders
copied from pi-coding-agent internals (`skills.ts`, `prompts.ts`), (b) hand-built subagents following the README
example, and (c) the in-memory approval hold. Where Pocket is most heavily bespoke is **process supervision and
the quota gate**, both features Durable does not have.

---

## 3. Process model and live updates

### 3.1 Processes

- **One server process** (`src/server/main.ts`, `node --experimental-strip-types`-style plain TS). One `PocketApp`,
  one `Harness`, one SQLite file. All sessions, subagents and PiP are conversations in that Harness. No sharding
  and no worker pool for agent work.
- **Launcher** (`bin/pi-pocket.js`, `src/launcher/main.ts`): a parent process that spawns the server and restarts it
  on exit code 75 (the app's "restart server" action) or after a crash. It also owns the Cloudflare or Tailscale
  tunnel so the address survives server restarts (`main.ts:1-8` in both). `takeLock` (`lock.ts`) guards one server
  per data dir.
- **Child processes and threads**: one `worker_threads` Worker for HEIC conversion (`heic.ts:97`), a worker for design
  scans (`design/scan-worker.ts`), Photon images in Durable's own worker, headless Chromium via CDP
  (`browser/cdp.ts:204`), shell and background commands as detached process groups (`processes.ts`), and `gh` and
  `git` subprocesses.
- Because Durable allows one writer per storage, there is no multi-process story. Read-only secondary opens are not
  used.

### 3.2 Session mapping

- Session = root conversation (the Harness' `root()` is **not** used for sessions; `createConversation` per session at
  `commands.ts:459`). The session index is a global document, `SessionsDoc`, read with `harness.snapshot(SessionsDoc,
  context)` (`app.ts:1139`).
- Subagents: a conversation owned by a task of the parent (`subagents.ts` anchor tasks), listed in `SubagentsDoc`. PiP is one
  long-lived conversation selected by extension name (`app.ts:1535-1541`).
- In-memory mirrors rebuilt at start by `#recover` (`app.ts:1131-1195`, 65 lines): `#busy`, `#failed`, `#agents`,
  `#compacting`, chat, subagents, background, authors. Then kept current by `#committed` (`app.ts:~1197`, 108
  lines) from `observeCommits`.

### 3.3 Live updates to the browser

- Transport: **Server-Sent Events** at `/api/events` with a **long-poll fallback** `/api/poll` (`http/events.ts`,
  `web/store.js:2210`, `:2492`), for connections that buffer streams. SSE frames are `event: <name>\ndata: <json>`
  (`events.ts:164`), pings every 15 s (`:179`).
- Back-pressure and cutoff rules are explicit and thoughtful (`events.ts:19-36`): 8 MB or 5,000 events behind is
  tolerated while the tab keeps taking; 30 s stalled or 128 MB behind cuts the tab, which reconnects and gets a full
  view.
- Message shapes: about 28 distinct event names (hello, view, changed, notice, missing, status, notes, chat, presence,
  peek, models, subagents, sessions, users, themes, system, ext, pip, pipview, reload, switched, auth, answered,
  drafted, browser, comments, memory, folder-favorites...). The key one is `view` (`room.ts:952`): `{full, conversation,
  entries, order, live, agent, stats, clients, viewers, approvals, ...fields}`. Entries are display-ready projections
  (`ClientEntry`, `projection.ts:49`), big strings clipped (`projection.ts:1-4`), clipped parts fetched on demand.
  Per-tab diffing: `sentFields` JSON-compares each field against what that tab already got (`room.ts:~930`), plus a
  `have` cursor so a reconnect sends only missing entries, plus `client.protocol` versioning (`room.ts:~935`).
- Streaming text: `liveMessageDelta(sent, blocks)` (`projection.ts:788`) sends block deltas for the in-flight
  assistant message.
- Writes go over ordinary HTTP POST routes in `http/*` (about 14 route files). There is no RPC protocol and no
  WebSocket. Mutations check roles through `requireSee/Steer/Driver` (`docs/architecture.md`).
- The client (`web/store.js`) merges events into a single `store.state` and re-renders components through
  `store.subscribe` (`store.js:269-400`). It keeps a disk cache (`session-cache.js`) so a revisited session shows
  at once.

This is one of the best parts of the project: a well-reasoned, defensively built projection protocol that leans on
Durable's guarantee ("nothing is shown before its commit is stored").

---

## 4. Design quality

### 4.1 Separation of concerns: good seams, bad centre

Good:

- `docs/architecture.md` states the data ownership rule (Durable owns lasting truth, memory is a cache rebuilt by
  `#recover`), the construction-order rule (parts must not read `harness` in constructors), and which state is
  deliberately volatile. This is unusual discipline for a project this size.
- `PocketHost` (`host.ts`) is a real interface boundary. Extensions never see `PocketApp`
  (`docs/architecture.md`). `app.ts:~905-990` builds it from about 50 closures, which is long but explicit.
- `docs.ts` makes document kinds a frozen contract ("Do not rename them", `AGENTS.md`).
- Types: `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `erasableSyntaxOnly` (`tsconfig.json`). Zero
  `@ts-ignore`, `@ts-expect-error`, or `eslint-disable`.

Bad:

- **`PocketApp` is a god object.** `app.ts:379-4390` is one class of about 4,000 lines with about 135 methods and
  about 70 fields. Methods over 90 lines include `get build()` (299 lines per my span scan, likely a getter with
  inlined data), `#open` (294), `#documentCommitted` (176), `close` (135), `#committed` (108), `sessions` (90). It
  mixes access control, session lifecycle, room management, push, approvals, extension hosting, workspace
  providers, config setters (`setDefaultModel` 72 lines), user management, and artifact overview.
- **53 modules import `PocketApp`** (`grep -rl PocketApp src`). The "parts" (Commands, Collab, Alerts, Providers,
  Schedules, Background, Goals, Shell, Spend, Memory, Gallery, Updates, ...) each take the whole app, so the
  dependency graph is a star around `app.ts`, not a layering. `docs/architecture.md` lists what "stays on
  PocketApp" as a convention, but nothing enforces it.
- `commands.ts` (3,044) is a single `Commands` class (starts `:341`). `submit` is 194 lines, `#interrupt` 151,
  `configure` 138, `#fork` 129, `resend` 115. Each is long, with comments saying why, but the control flow inside is
  deep.
- `src/server/*.ts` is one flat directory of 121 files. Names like `when.ts`, `fence.ts`, `hidden.ts`, `deadline.ts`,
  `lancet.ts`, `omarchy.ts` (theme import for one Linux desktop, 114 lines) sit beside the core with no grouping.
- Extension files are imported by core as concrete modules, and the converse: `extensions/subagents.ts` imports
  `../docs.ts`, `../room`-adjacent helpers (`stall-facts`, `subagent-runs`). Features that are "extensions" still
  have a half in the core directory (e.g. PiP is `pip.ts` in core and `extensions/pip.ts`).

### 4.2 Web client

- Buildless ES modules with an importmap, Preact 11 and htm (`web/index.html:100`, `package.json:66,72`). No bundler,
  no minification step, no type checking: `grep @ts-check web/*.js` finds 0 of 78 files. For a 44k-line client, that
  is the weakest quality gate in the project. JSDoc comments are descriptive, not typed. Type tests (`types/pocket.d.ts`,
  3,266 lines) cover the extension API surface only.
- `web/transcript.js` (4,222): one `Transcript()` component of 653 lines, `ToolStep` 368, `ActivityGroup` 226,
  `UserMessage` 184, `LiveLine` 168, `ApprovalCard` 157, `AskCard` 150, `outcome()` 142. Rendering, tool-call
  summarization, approval and ask UIs, and live-line state share one module and one export (`Transcript`). It reads
  coherent but is not decomposable without effort.
- `web/store.js` (3,383): `store` (state, `:269`), `actions` (`:2888`, about 500 lines of API calls and
  mutations), `drafts` (`:3380`), plus connection handling for both SSE and polling (`:2210-2500`). One mutable
  global `state` object with `set(patch)` and `subscribe` (`:383-400`) and **no selectors**, so a patch re-renders every subscriber. There are 122 exports
  in the file's neighbourhood and 59 top-level exports. This is a global store by design (documented in line 1).
- CSS: one 21,994-line `web/style.css`. No scoping, no component CSS. Theme variables aside, this is the single
  most likely place for regressions.
- Positive: `web/sheets/*` split off modal sheets cleanly (25 files), `session-cache.js`, `back.js` (route and
  gesture handling), and `live.js` are focused. `design-system-ui.test.ts` (2,818) and `mobile-ui.test.ts` (2,078)
  suggest UI is actually tested, using DOM-ish checks rather than a real browser (not verified).

### 4.3 Error handling

- Pattern: catch, `describe(error)`, `#log` or `notice(...)`, and continue. `app.ts:1005-1032` wraps each drop-in
  folder setup step in its own try/catch with a distinct log line. Server-wide notices are routed by role
  (`app.ts:1737-1757`). Message text is user-readable, which suits a self-hosted tool.
- Counts: 268 `catch (` and 233 `catch {` (swallowing) in `src/`. 75 are empty or arrow-empty (`catch {}`, `=> {}`)
  such as `.then(..., () => {})`. Many are justified (best-effort cleanup, comments say why), but it is a lot of
  silent failure surface: for example `app.ts:1083` and `:1104` swallow `scheduled` room errors with `() => {}`.
- Typed errors: `HttpError` (`errors.ts`) and a single `describe()`. `onReport` from the Harness is turned into a
  warning notice (`app.ts:1055`), so Durable's failure reports reach the owner. Good.
- `BACKGROUND_CONTEXT` is used in 24 files (79 references): HTTP request cancellation never propagates into
  Durable calls. Fine for durable work (cancelling a wait must not cancel work), but it also means a hung
  provider call is bounded only by Pocket's own deadlines.

### 4.4 Type safety

- Source `: any` / `as any` / `<any>`: 7 in `src/`. `as unknown as` casts: 115 (14 in `app.ts` alone), e.g.
  `const conversationId = id as unknown as ConversationId` (`app.ts:~1093`), and `return {...} as HarnessSettings`
  (`app.ts:1569`) which silences a getter-shaped settings object. Branded IDs are cast from numbers throughout. The
  casts cluster at the Durable boundary (IDs, documents, settings), so they are a symptom of Durable's branded
  types plus Pocket's mixed `string`/`number` keys (`this.#sessions[String(id)]`, `Number(conversationId)` in many
  places).
- `JsonValue` and `copyJson` from chord are used. Documents have typed definitions. Types are shared with the web
  only through hand-written `.d.ts` (`types/pocket.d.ts`) and by importing `web/text-hash.js` from the server
  (`room.ts:~83`).
- The web layer has no static types (see 4.2). Server to client message shapes (`ClientEntry` etc.) are TS types on
  the server but untyped on the client, so a mismatch is found at runtime.

### 4.5 Copy-paste and dead code

- Four hand-rolled durable polling tasks with the same skeleton (`WatchInput`, `WatchState`, backoff, "tell Pi
  once", cap per hour): `watches.ts:254`, `repo-watches.ts:193`, `background.ts:299`, `pip.ts:232`. A shared "poll,
  report, back off" helper would cut maybe 800 to 1,000 lines. Not verified line by line.
- Same-named helpers redefined per file: `textOf` (5 definitions: `extensions/subagents.ts:80`, `pip.ts:178`,
  `pi-sessions.ts:141`, `gallery/files.ts:37` (different meaning)), `oneLine` (4), `snippet` (2).
- Pi-internals copied: `skills.ts` and `prompts.ts` re-implement pi-coding-agent internals "which the package does
  not export" (`skills.ts:28`, `prompts.ts:7`), so upgrades of pi-coding-agent can silently diverge.
- Dead or legacy: `artifact_inline` kept in `BUILT_IN_TOOLS` though "Not a tool since 0.28.0" (`reload.ts:130`),
  `protocol < 2` compatibility branch in `room.ts:~935`, `extension-document-compat.ts`, `extension-pi-ai-compat.ts`
  and a resolve-hook shim (`extension-document-imports.ts`, 157). These are conscious back-compat layers, not rot,
  but they add up to about 350 lines. `noUnusedLocals` prevents local dead code; exports are not checked (no
  `knip`-style audit found). 281 files were deleted over the history, so churn is high.
- Very few TODO/FIXME (2). The comment style is explanatory prose ("why"), which is a strength and makes the code
  readable despite its size.
- Release velocity: 1,723 commits in the last four weeks (since 2026-10-25), about 60 per day. Pocket tracks
  Durable's breaking changes closely (docs/architecture.md carries three data-folder migration warnings in
  four minor versions: Durable 1.4, 1.5, 1.6). Rolling back is not supported after a Durable bump. That is the
  real cost of building on an experimental runtime.

### 4.6 What is well done

- Durable truth, memory as a rebuildable cache, and the documented ordering invariants.
- Idempotence everywhere it matters: request IDs, `replay: "safe"`, memoized approval answers, "a start is reserved
  before its process starts" for background commands (`docs/features.md`), resend as a fork plus a task in one
  commit (`resend.ts:1-5`).
- Security posture is explicit and honest (`SECURITY.md`): owner token hashing, invites with TTL, socket mode with
  folder ownership checks, secrets scrubbed from tool results via the `afterTool` hook (`app.ts:887-896`) and from
  shell env (`hidden.ts`), artifact sandboxing, strict CSP. It says plainly that "anyone who can steer can do what
  you can".
- Test mass: 258 files and 90,619 lines of tests (about 0.45 line of test per line of source), including
  crash-resume style tests for tasks (`background.test.ts` 1,543, `linked-sessions.test.ts` 1,102).
- Mobile-first reality: push notifications (`push.ts`), PWA, gestures (`gestures.js`, `back.js`), peek tiles, long-poll
  fallback for proxies that buffer, disk session cache, resumable `have` cursor.
- The self-editing workflow (`AGENTS.md`, hot-reloaded `web/**` and `extensions/*.ts`) is novel and coherent with
  the buildless design.

---

## 5. Out-of-the-box agent experience

### 5.1 Prompt

`extensions/prompt.ts` is `REQUIRED` (always on, `reload.ts:78`). The prompt is assembled from sections:
a preamble ("You are Pi, a coding agent in Pi Pocket, a durable, multiplayer web app... after a server restart, you
continue where you left off. A tool call cut off by a restart that was not safe to repeat comes back as
interrupted", `prompt.ts:~20`), guidelines (short replies for small screens, use read not cat, **verify before
claiming done**, embed images, "A guard may ask a human to approve risky commands; if a call is blocked, do not try
to get around the block", the `[via PiP]` language rule with an ASD-STE100 clause that is very long for a default
prompt), then a docs pointer (`prompt.ts:~35`, repo `docs/index.md` and Pi's docs), AGENTS.md and CLAUDE-style
context files (`loadProjectContextFiles`, `prompt.ts:~110`), Pi skills (`formatSkills`, `prompt.ts:~46`) and the
working directory. Sections re-render before each request and only changed sections are re-sent (Durable `section`).
Each extension adds its own sections (plan, codemode, memory, subagents).

### 5.2 Default tools

On by default, from `reload.ts:80-87` (everything built-in except the OFF list): `read`, `write`, `edit`, `bash`
(Durable), then `artifact`, `browser` (needs Chromium on the server), `subagent`, `schedule`, `background`,
`codemode`, `tool_search`, `memory`, `ask`, `sessions` and friends (PiP-only, selected by name,
`app.ts:1535-1541`), goals, triggers, updates, design, diagrams. Off by default: **`guard.ts`**, `agent-teams.ts`,
`anthropic-subscription.ts`, `session-tags.ts`, `ask-someone.ts`, `pocket-relay.ts`. About 40 tool names are
reserved so drop-ins cannot shadow them (`reload.ts:124-`). That is a large tool surface for a default agent; `tool_search`
and `codemode` exist to keep the prompt small.

### 5.3 Permission and approval model

- **Roles** (`config.ts:44`): owner (everything), guest (steer Pi, which can run commands), viewer (read and chat).
  Approvals can be restricted to "others" via `approvals: ApprovalRule` (`config.ts:110`).
- **Lancet Guard** (`lancet.ts`, `extensions/guard.ts`): *not Pocket's own*. `lancet.ts:3-4` says it is "borrowed from
  the user's Pi install": it searches `PI_POCKET_LANCET_DIR`, `~/.pi/agent/npm/node_modules/specpi-lancet-guard`, or a
  git checkout of `TannerMidd/SpecPi` (`lancet.ts:100-113`), loads its `gate.ts`, rules and classifier with `jiti`,
  and calls `judgeCommand` and `judgePath`. It judges `bash`, `background`, `write`, `edit` only (`lancet.ts:105-106`).
  Verdicts: allow, block (returned to the model as an error result: `guard.ts:43-47`), or ask (card to everyone
  steering the session; answer memoized). The guard's own settings file (`~/.pi/lancet-guard.json`) must say
  `enabled: true` (`lancet.ts:282`), **and** the Pocket module must be switched on (off by default). A classifier
  model (about 109 MB) must be downloaded by the owner, else a guard that is on "blocks the bash calls its local
  rules leave open" (`docs/features.md`, Lancet Guard paragraph).
- Core secret protection (`secrets.ts`) is checked **only while the guard module is on** ("while the Lancet Guard
  module is on... blocks a call that would read config.json..."), so with the default config even that is off.
  Values are still hidden from transcripts (`app.ts:887`).
- **Plan mode** (`extensions/plan.ts`, 348): a `beforeTool` allowlist. Always allowed: read, artifact,
  design_preview, tool_search, codemode, subagent, ask. Bash is allowed only for a hand-written read-only grammar
  (`GIT_READS`, `refuses()` option matching, args checks) with no redirects, globs or substitution. Browser limited to
  look-only verbs. Plan approval sends `PLAN_APPROVED` through `Commands.submit` (`commands.ts:2233`). Comment says
  it "is not a security boundary".
- **Limit gate** (`limit-gate.ts`): despite the name, not a permission mechanism. It is a quota-wait gate (rate and
  usage limits, one canary request at a time, give up past `limitWaitHours`, default 6).
- Budgets per user (`config.ts:~60 budget`), spend checks in `spend.ts`; stops only after the request that crosses
  the limit (`SECURITY.md`).
- Net effect on a fresh install: **no approval step, no sandbox**. Anyone with a guest invite can run any command as
  the server's OS user. `SECURITY.md` is blunt about this, but the experience is "trust the link".

### 5.4 What a fresh user must configure to do coding work in a repo

1. Node 22.19+ and `npm install -g`/`npx` or the desktop installer (README).
2. **A model provider**. Pocket reads Pi's `auth.json` and models (`ModelRuntime.create()`, `app.ts:854`). README: "Sign in
   to a provider with Pi first (`pi`, then `/login`), or later from the app's Providers sheet". So either install
   and run Pi once, or use the in-app Providers sheet (`providers.ts` 474, `custom-providers.ts` 1,002). With no
   sign-in, `signInNeeded` (`app.ts:4152`) makes the model picker say so.
3. A **repository folder**: `--cwd DIR` (default `process.cwd()`, `main.ts:43`). New sessions start in that
   folder; per-session folders can be changed in the app (`commands.ts configure`), worktrees optional.
4. **Access mode** via the launcher (local, LAN, Cloudflare quick tunnel, Tailscale), which prints a sign-in link and a QR
   code. The link is the owner key. The Cloudflare tunnel downloads `cloudflared` on demand
   (`launcher/access.ts`).
5. Optional: **Chromium** for the browser tool; `gh` for PR watches; `specpi-lancet-guard` plus its model download
   plus turning on two switches (Pi's and Pocket's) for any approval gating.
6. Project trust: skills and prompts from a project's `.pi/` only load if the project is trusted in Pi's
   `trust.json` (`prompt.ts:~105`, `app.ts:~3722`).

Once 1 to 3 are done the agent works immediately: Durable's read/write/edit/bash, a system prompt tuned for phones,
AGENTS.md pickup, subagents, plan mode (a per-session toggle). There is no onboarding wizard in the server for model
choice beyond the pickers, and `defaultModel` falls back to "the last one picked" (`config.ts:102-103`).

---

## 6. Summary assessment

| Dimension | Rating | One-line reason |
|---|---|---|
| Use of Durable | strong | Deep, correct use of documents, tasks, hooks, replay-safety. Only parks and signals unused |
| Separation of concerns | mixed | Good extension boundary (`PocketHost`) and written invariants. `PocketApp` star topology and a flat 121-file directory |
| Cohesion of largest files | weak to mixed | `app.ts`, `commands.ts`, `transcript.js`, `store.js`, `style.css` each hold many reasons to change |
| Type safety | server good, client none | Strict TS, 0 ts-ignores, 115 `as unknown as`; 0 of 78 web files type-checked |
| Error handling | pragmatic | Consistent describe-and-notice, 75 silent catches, no typed error taxonomy beyond `HttpError` |
| Scope discipline | poor | Design toolchain (41k) and relay, gallery, updater, launcher dwarf "run a session from a phone" |
| Default safety | weak | Guard off, external dependency, not packaged. Honest in SECURITY.md |
| Tests | strong | 90k lines, 258 files, crash and resume covered |
| Maintainability risk | high | Rides an experimental runtime with three data-folder migrations in four minor versions and about 60 commits a day, single author |

For a team evaluating this as a base for a cloud "agent from the phone" product, the reusable parts are the
Harness wiring (`app.ts:871-1118`), the commit-to-room-to-SSE projection (`room.ts`, `projection.ts`,
`http/events.ts`, `web/live.js`), the `PocketHost` extension boundary, and the idempotent-task patterns. Everything
under `design/`, `gallery/`, `pocket-relay/`, `updates` and the launcher can be dropped. The things to fix before
reuse are: split `PocketApp` into ports (access, rooms, session registry, lifecycle), replace the in-memory approval
hold with a Durable park plus signal, give the web client a type layer (`// @ts-check` plus generated protocol
types), and bring the approval and secret-file guard into core rather than behind an external package.

### Unverified or approximate

- Line counts of "peripheral" groupings are rounded sums of the files named.
- The method-length scan for `app.ts` used a regex; "`get build()` 299 lines" probably includes the lines up to the next
  matching method signature (it may contain an embedded asset or a long literal), so treat as approximate.
- The estimate of savings from a shared polling-task helper is a guess, not measured.
- I did not run the app or tests.
