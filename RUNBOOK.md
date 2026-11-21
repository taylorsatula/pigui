# picloud: implementation runbook (v1)

**Read this first.** This document is the complete specification for building picloud v1. It is self-contained:
nothing outside this file is required.

- **Implement Part A to completion, autonomously.** Do not stop to ask questions.
- **Where this runbook is silent,** make the simplest choice consistent with §A2 (Scope rules), and record it in
  `DECISIONS.md` at the repository root, one line per decision: what and why.
- **Install what the build and tests need.** You have full command-line access to this machine. Install the tools
  the build and tests require (Node.js ≥ 22.19, npm packages, Playwright's Chromium with its system libraries) by
  whatever means the machine supports.
- **Part A must not change the machine's running services.** It must not:
  - install, run or change systemd units, Tailscale, users or `/var/lib/picloud`;
  - run `deploy/install.sh`;
  - bind port 8787.

  This machine may already be running picloud. Part A works inside the repository directory and temporary
  directories only, apart from installing build and test tools.
- **Part B is deployment.** Part A produces an automated installer (§A16). Running it, and the few steps that need
  a human (sign-ins, an admin console, the phone), happen only when someone deliberately deploys.

| | |
|---|---|
| Version | 1.0, frozen 2026-11-21 |
| Language | **TypeScript everywhere**: server, browser client, service worker, tests and end-to-end tests. Pi Durable and its packages are TypeScript, so sharing their types end to end keeps the integration seamless. |
| Platform | `@earendil-works/*` **1.6.0** from npm; Node.js ≥ 22.19; Ubuntu 24.04 for deployment |
| Network needed to build | npm registry, Playwright's browser download, and the OS package manager (for Chromium's system libraries). No model credentials and no GitHub access are needed: the definition of done runs entirely in fake mode. |

---

## Contents
**Part A: Build (implementer)**
- A1 Product definition
- A2 Scope rules
- A3 Glossary
- A4 Architecture
- A5 Dependencies (exact pins)
- A6 Pi Durable 1.6.0 API facts
- A7 Repository layout
- A8 Data model
- A9 Session lifecycle
- A10 The agent extension
- A11 Server behavior
- A12 HTTP API
- A13 Fake mode, tests and definition of done
- A14 PWA specification
- A15 Notifications
- A16 Deployment automation (`deploy/install.sh`)

**Part B: Deploy and operate**
- B1 Deploy with the installer
- B2 Steps that need a human
- B3 Phone
- B4 Operations
- B5 Upgrades
- B6 Troubleshooting

**Appendices:** C1 Security model · C2 Decision log · C3 Verification record

---

# Part A: Build

## A1. Product definition

picloud is a thin, self-hosted remote harness for the **Pi** coding agent. It runs on the owner's server (the
"droplet"). The owner uses it from a phone as an installed web app (PWA) over a private Tailscale network.

**Primary use: zero-shot work from a phone.**
1. Pick one of your GitHub repositories, and optionally a branch. Describe a task.
2. Pi explores the code and asks a few **multiple-choice questions**, which you answer by tapping.
3. Pi proposes a **plan**, and you approve it (or ask for revisions).
4. You put the phone away. Pi implements, verifies, commits, and ticks off plan steps as it goes.
5. You get a notification and a **final report**. From the report you choose **Push branch**, **Open PR**, or keep
   working by typing feedback.

**Interactive use must not be barred.** A question gets an answer. A small direct request is simply done. The
plan-first workflow is a default taught by the system prompt, not a lock enforced in code.

**Product properties that must hold:**
1. **Waiting costs nothing and survives restarts.** Every wait for the person (questions, plan approval) is a
   Durable tool park on a signal. It holds no process and survives server restarts and reboots.
2. **Unattended runs continue to a report.** A run that tries to stop before reporting is nudged to continue, up to
   3 times. Each run is also bounded by a turn limit and an optional spend budget.
3. **Nothing reaches GitHub without a tap.** Pushes and PRs happen only when the person taps a button. The agent
   commits locally and never pushes.
4. **The app is a simple chat interface.** It has an input pill, an attachment button and a send button. Tool calls
   and thinking are collapsed by default. Sessions are listed in a drawer. Typing `@` references a repository file,
   and typing `#` invokes a Pi skill, each through a picker that narrows as the person types.
5. **Long runs survive compaction.** When the context fills, picloud compacts it and the run continues on its own,
   carrying forward what the agent needs to resume correctly (§A10.5). A compaction never needs the person and never
   ends a run.

## A2. Scope rules

**Rule 1: delegate to established tools.** Do not build what these already provide.

| Concern | Provided by | picloud's share |
|---|---|---|
| Authentication, TLS, remote reachability | Tailscale (`tailscale serve`) | optional login allowlist |
| Model providers, sign-in, OAuth refresh, default model | Pi (`pi` CLI writes `~/.pi/agent/`) | load `ModelRuntime` + `SettingsManager` |
| Agent loop, coding tools, retries, compaction, crash recovery, persistence | Pi Durable | configuration |
| Project instructions (`AGENTS.md`/`CLAUDE.md`) and skills | Pi (`loadProjectContextFiles`, `loadSkills`) | prompt sections |
| Live state sync to the browser | Durable watches + Chord `delta` in the browser | an SSE relay |
| Repos, branches, clone, push, PRs, git credentials | `gh` + `git` | shell-outs behind one module |
| Push notifications | Web Push + the `web-push` package | send on a few events |
| Markdown | `marked` + `DOMPurify` | none |
| Supervision | systemd | unit files |

**Rule 2: non-goals.** Do not build any of these:
- multi-user or tenancy;
- a settings screen;
- a model picker;
- per-session containers;
- a built-in browser;
- extension or plugin systems;
- multiplayer or presence;
- self-editing;
- design or document tools;
- scheduled tasks;
- voice;
- a file browser;
- CI watching;
- sessions spanning multiple repos;
- a bundler (`tsc` is the only build tool).

**Rule 3: complete, correct and maintainable.** There is no size target. The implementation is judged on whether it
is complete, works correctly, and stays maintainable over time. Concretely:
- **Complete:** every behavior in Part A works, including the error paths and restart paths. A smaller
  implementation that skips behavior is worse, not better.
- **Clear boundaries:** each module has one responsibility (for example HTTP, sessions, GitHub, agent extension,
  monitor, notifications, maintenance) and talks to others through small typed interfaces. UI components are split
  by concern (navigation, transcript, cards, composer).
- **One definition of each shape:** API payloads, SSE events, document shapes and session states are defined once
  in shared TypeScript modules, and imported by both the server and the client.
- **Strict TypeScript:** no `any`, except at a documented library boundary with a comment saying why. Prefer types
  from `@earendil-works/*` over re-declaring them.
- **Errors handled where they enter:** validate inputs at the HTTP boundary, wrap shell-outs with clear messages,
  and never swallow an error silently.
- **Nothing speculative:** no dead code, no unused abstractions, no options nobody asked for, and nothing from the
  non-goals.
- **Behavioral tests:** tests exercise behavior through public interfaces, not internals.
- **Comments say why, not what.**

## A3. Glossary

| Term | Meaning |
|---|---|
| Pi | The coding-agent toolkit by earendil-works. The `pi` CLI is its terminal agent. |
| Pi Durable | `@earendil-works/pi-durable`, a library that runs agents durably. Every turn and tool call is committed before it is shown, and restarts resume work. |
| Harness | Durable's main object: one storage plus the machinery running agents on it. picloud opens exactly **one**. |
| Session | picloud's unit of work. Exactly one Durable **conversation** plus one git workspace. |
| Entry | Immutable transcript record (`pi.user`, `pi.assistant`, `pi.tool-result`, `pi.system`, `pi.reset`, `pi.compaction`). |
| Document (doc) | Typed JSON state changed atomically in commits. Built-in: `pi.live`, `pi.usage`, `pi.agent`, `pi.inbox`, `pi.provider`. |
| Park | A tool's `execute()` returns `{ sleep: { signals } }` instead of a result. The call holds no process, survives restarts, and reruns when the signal arrives. |
| Signal | A typed value delivered to a parked task: `harness.signal(taskId, token, key, value, ctx)`. |
| Watch | `conversation.watch()`: the conversation view, then each change as Chord ops. |
| Chord ops | JSON patch-like operations. Apply them with `applyImmutable(view, ops)` from `@earendil-works/chord/delta`, which also runs in browsers. |
| Steer | Input given to a busy conversation. It joins the running work after the current tool round. |
| Comparison ref | The remote ref a session's work is measured against (§A8.1). |

## A4. Architecture

```
 Phone PWA  ──HTTPS──▶  tailscale serve  ──HTTP 127.0.0.1:8787──▶  picloud (one Node process, user "picloud")
                                                                    ├ HTTP JSON API, 2 SSE streams, static PWA, /vendor
                                                                    ├ sessions: create/message/answer/stop/deliver/diff
                                                                    ├ github module: real (gh+git) | fake (local bare repos)
                                                                    ├ monitor: run end / failure / budget per active session
                                                                    ├ push: VAPID + subscriptions + sends
                                                                    ├ maintenance: daily workspace prune
                                                                    └ ONE Harness over ONE SQLite file
                                                                        models   = Pi ModelRuntime (or faux in fake mode)
                                                                        registry = CodingTools + pi-context + picloud
                                                                        env      = NodeExecutionEnv per workspace
 Workspaces: <PICLOUD_DATA>/work/<uuid>/  (one clone per session)
```

**Invariants:**
- **One process, one Harness, one SQLite file.** Durable does not support two writable processes on one storage.
- **State lives in Durable.** All picloud state is in Durable documents, so there is no second database. Session
  list changes are committed in the same commits as the agent's tool work.
- **Two GitHub writers, by design.** The server alone pushes and creates PRs. The agent may `git fetch` (it needs to
  for rebasing) but never pushes.

## A5. Dependencies (exact pins)

Pin exact versions (`.npmrc` with `save-exact=true`) and commit `package-lock.json`.

| Package | Version | Kind |
|---|---|---|
| `@earendil-works/pi-durable` | 1.6.0 | runtime |
| `@earendil-works/pi-ai` | 1.6.0 | runtime |
| `@earendil-works/pi-coding-agent` | 1.6.0 | runtime |
| `@earendil-works/chord` | 1.6.0 | runtime |
| `@earendil-works/pi-schema` | 1.6.0 | runtime |
| `web-push` | 4.0.0 | runtime. It ships no TypeScript types, so declare the few functions you use in a local `.d.ts`. |
| `preact` | 11.2.0 | runtime (browser; includes `preact/jsx-runtime` for TSX) |
| `marked` | 18.2.1 | runtime (browser) |
| `dompurify` | 3.4.18 | runtime (browser) |
| `typescript` | 5.9.3 | dev: typechecks everything and compiles the browser code |
| `@types/node` | 22.20.5 | dev |
| `@playwright/test` | 1.65.1 | dev: end-to-end tests, written in TypeScript |

**Language and tooling: TypeScript everywhere, with `tsc` as the only build tool**
- **Server** (`src/server`, `src/shared`): `.ts` files run directly by Node's built-in type stripping, with no build
  step.
  - Use only erasable syntax: no `enum`, `namespace` or parameter properties.
  - Import local files with the `.ts` extension.
  - tsconfig: `strict`, `noEmit`, `module` and `moduleResolution` set to `nodenext`, `target` es2023,
    `allowImportingTsExtensions`, `skipLibCheck`, `types: ["node"]`.
- **Browser client** (`src/client`, plus `src/shared`): TSX components using Preact's automatic JSX runtime.
  - Compiled by `tsc` to ES modules in `build/`, with no bundler.
  - tsconfig: `strict`, `module` esnext, `moduleResolution` bundler, `jsx` react-jsx, `jsxImportSource` preact,
    `rewriteRelativeImportExtensions: true` (so source imports use `.ts`/`.tsx` and output uses `.js`), `lib` es2022
    plus dom plus dom.iterable, `outDir` build.
  - Bare imports (`preact`, `marked`, `@earendil-works/chord/delta`, and so on) stay bare in the output and are
    resolved in the browser by the import map (§A14.8).
  - Shared types are imported with `import type`, so they are erased.
  - This pipeline was verified (§C3).
- **Service worker** (`src/sw/sw.ts`): its own tsconfig with `lib` webworker, compiled to `build/sw.js`, and served
  at `/sw.js`.
- **Tests:** `node:test` files in TypeScript, run by Node directly. **End-to-end:** `@playwright/test` specs in
  TypeScript.
- **Required npm scripts:**

  | Script | Does |
  |---|---|
  | `build` | compile the client and service worker |
  | `check` | typecheck every tsconfig: server, client, service worker, tests |
  | `start` | build, then run the server |
  | `dev:fake` | build, then run in fake mode |
  | `test` | unit and integration tests |
  | `e2e` | Playwright, which starts `dev:fake` itself |
- **Node version:** Node ≥ 22.19 is required. If the machine's Node is older, install a newer one first.

## A6. Pi Durable 1.6.0 API facts

**Warning: use the npm docs, not GitHub.** The GitHub main branch of `earendil-works/pi` contains **unreleased
breaking changes**, so its README and examples do not match 1.6.0. Read
`node_modules/@earendil-works/pi-durable/README.md` and the `.d.ts` files in `node_modules`. Never use GitHub main.
The 1.6.0 shapes:

| Concept | 1.6.0 shape (correct) | Main branch (wrong for 1.6.0) |
|---|---|---|
| Tool park | `return { sleep: { signals: [Token.key("k")], until?, checkpoint? } }` | `{ kind: "sleep", ... }` |
| Signal state | `{ value }`, `{ expired: true }` or `undefined`, tested with `"value" in state` | `state.kind === "value"` |
| `onYield` continue | `{ continue: "text" }` | `{ kind: "continue", continue }` |
| Admit inside a commit | `conversation.submit(tx, draft)` | `conversation.admit(tx, draft)` |

### A6.1 Import paths (all verified)

| From | Names |
|---|---|
| `@earendil-works/chord/context` | `BACKGROUND_CONTEXT` (the `Context` every async call takes) |
| `@earendil-works/chord/delta` | `applyImmutable` |
| `@earendil-works/pi-schema` | `obj`, `str`, `arr`, `opt`, `bool`, `int`, `oneOf` |
| `@earendil-works/pi-durable` | `Harness`, `createRegistry`, `defineExtension`, `defineTool`, `defineDoc`, `defineSignal`, `hook`, `section`, `GenerationTask`, `LiveDoc`, `UsageDoc` |
| `@earendil-works/pi-durable/env` | `ExecutionEnv` (type) |
| `@earendil-works/pi-durable/env/node` | `NodeExecutionEnv` |
| `@earendil-works/pi-durable/storage/sqlite/node` | `openNodeSqliteStorage(path)` |
| `@earendil-works/pi-durable/tools` | `CodingTools` (the extension providing `read`, `write`, `edit`, `bash`; it has **no** system prompt) |
| `@earendil-works/pi-coding-agent` | `ModelRuntime`, `SettingsManager`, `getAgentDir`, `loadProjectContextFiles`, `loadSkills`, `formatSkillsForPrompt` |
| `@earendil-works/pi-ai/models` | `createModels` (fake mode and tests) |
| `@earendil-works/pi-ai/providers/faux` | `fauxProvider`, `fauxAssistantMessage`, `fauxToolCall`, `fauxText`, `fauxThinking` |

### A6.2 Facts and signatures (1.6.0)

**Models**
- `await ModelRuntime.create()` builds Pi's configured `Models` from `~/.pi/agent/auth.json` and `models.json`,
  with OAuth refresh. It is accepted directly as Harness `models`, and it succeeds even with no credentials.
- Call `await models.settleCredentialWrites()` before exit.
- `models.getModel(provider, id)` returns a model whose `input` lists its modalities (`"text"`, `"image"`).
- `SettingsManager.create(cwd, getAgentDir())` gives the defaults through `getDefaultProvider()`,
  `getDefaultModel()` and `getDefaultThinkingLevel()`. Pass the thinking level through to the conversation's agent
  unchanged, and omit it when it is undefined.

**Opening the Harness**
- `await Harness.open(storage, { models, registry, env, onReport? }, ctx)`.
- `env` is `({ cwd }) => ExecutionEnv`. It is called at every tool call and every prompt build, so cache
  environments per cwd.
- `harness.resume()` continues work left unfinished by a crash or stop. `harness.close(ctx)` closes the Harness.

**Conversations**
- `harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider, modelId }, cwd, maxTurns, thinkingLevel? } }, ctx)`.
- `harness.conversation(id, ctx)` looks one up.
- **IDs are numbers at runtime** (branded types): conversation, entry and task IDs alike. Convert with `String()`
  for URLs and map keys, and with `Number()` on the way back.
- Methods:
  - `submit({ type: "input", content, requestId?, whenBusy?: "steer" | "followUp" | "reject" }, ctx)` returns a
    `Submission` with `.wait(ctx)`. `requestId` makes it idempotent.
  - `submit({ type: "continue" }, ctx)` restarts a failed or aborted run on the existing context.
  - `abort(ctx)`, `watch(ctx)`, `entries(query, limit, cursor, ctx)`.
- **Content:** a string, or `[{ type: "text", text }, { type: "image", data: <base64>, mimeType }]`.

**Transcript paging**
- `entries({ maxEntryId?, minEntryId?, order: "ascending" | "descending" }, limit, undefined, ctx)` returns
  `{ items: EntryRecord[] }`. `maxEntryId` is **inclusive**.

**Entry and message shapes**
- `EntryRecord` is `{ id, conversationId, kind, model?: Message[], data?, head? }`.
- `pi.user`: `model` is `[UserMessage { role: "user", content: string | (TextContent | ImageContent)[] }]`.
- `pi.assistant`: `model` is `[AssistantMessage { content: (TextContent | ThinkingContent | ToolCall)[], usage, stopReason }]`.
  - `TextContent` is `{ type: "text", text }`.
  - `ThinkingContent` is `{ type: "thinking", thinking }`.
  - `ToolCall` is `{ type: "toolCall", id, name, arguments }`.
- `pi.tool-result`: `model` is `[ToolResultMessage { toolCallId, toolName, content: (Text | Image)[], isError }]`.
- `pi.compaction`: `model` is `[UserMessage]` holding the summary.
- `pi.system` and `pi.reset` carry no displayable content.

**The watch view**
- `ConversationView` is `{ conversation, entries: EntryRecord[] (a window, newest last, about 50), before?, docs: Record<string, JsonObject> }`.
- `docs` includes `"pi.live"` and `"pi.usage"`.

**Live state (`pi.live`, `LiveState`)**
- `run?`: `{ taskId, inputs, turns, first? }`, present exactly while a run is active.
- `generation?`: `{ attempt, message? (streamed partial AssistantMessage), retry?: { at, error } }`.
- `tools?`: `[{ callId, name, status: "pending" | "running" | "sleeping" | "waiting" | "done", output?, taskId? }]`.
- `runFailure?`: `{ reason, detail?, ... }`. Verified reasons include `"aborted"` and `"model_error"`. Others:
  `no_model`, `interrupted`, `faulted`, `orphaned`, `restart_limit`, `turn_limit`, `nothing_to_answer`.

**Usage (`pi.usage`, `UsageState`)**
- `{ models: Record<"provider/model", Usage>, tools: Record<string, Usage> }`, with `Usage.cost.total` in USD. Costs
  are catalog estimates, unless the provider reports billed cost.

**Signals**
- Define with `defineSignal({ name, version, schema })`.
- Deliver with `harness.signal(taskId, Token, key, value, ctx)`, which returns `"delivered"`.
- Read inside a tool or hook with `api.readSignal(Token, key, ctx)`.

**Documents**
- Define with `defineDoc<T>({ kind, version, scope: "session", initial, checkpointWhen: () => false })`.
  `checkpointWhen` is **required**.
- Durable's scope `"session"` means **one singleton per Harness**. That is not a picloud session. All picloud
  documents use it; none are conversation-scoped.
- Write inside a commit with `(await tx.doc(Token)).field = …`. `tx.doc` creates the document on first use.
- The server writes with `harness.commit(async (tx) => { … }, ctx)`. Tools write with `api.commit(…)`.
- Read with `harness.snapshot(Token, ctx)`, or `api.snapshot(Token, ctx)` inside tools and hooks.
- Built-in conversation docs are read with `harness.snapshot(LiveDoc, conversationId, ctx)`.
- **Documents must be JSON:** never store `undefined`; omit the key.

**Observers**
- `harness.observeDoc(Token, { advance(call, ctx), end(end) }, ctx)` and
  `harness.observeConversation(id, { advance, end }, ctx)` return `{ value, detach() }`.
- `advance` receives `{ kind: "value", value, ops }` synchronously inside each commit. It must not await, throw or
  call the Harness, so defer work with `queueMicrotask`.

**Tool API (`execute(args, api, ctx)`)**
- Identity: `api.taskId`, `api.callId`, `api.conversationId`.
- State: `api.commit(fn, ctx)`, `api.snapshot`, `api.readSignal`.
- Memos: `api.memo(name, candidate, ctx)` is first-writer-wins and returns the stored value. `api.memo(name, ctx)`
  reads one.
- Environment: `api.env`, an `ExecutionEnv` for the session cwd. `api.now()`.
- `replay: "safe"` on a tool means it reruns after a crash. Unsafe tools are reported "interrupted" instead.

**Exec**
- `env.exec(argv[], { onOutput: (text, ctx, { stream }) => … }, ctx)` returns
  `{ ok: true, value: { exitCode } } | { ok: false, error }`.

**Hooks**
- `hook(GenerationTask, { onYield(answer, api, ctx) })`, where `api` has `snapshot`, `entries`, `memo`,
  `conversationId` and `now`.
- Return `{ continue: "text" }` to continue the run with that text as a user message, or `undefined`.

**Prompt sections**
- `section(name, (input) => string | undefined, { tag?: boolean })`. `input.env?.cwd` is the workspace, and
  `input.conversationId` identifies the session.
- Sections render as `<name>…</name>` unless `tag: false`.

**Extensions**
- `defineExtension({ name, tools?, sections?, hooks? })`. Every installed extension applies to every conversation, in
  install order.

**Faux model (fake mode and tests)**
- `fauxProvider()` returns a handle with `.provider`, `.setResponses(steps)`, `.appendResponses(steps)` and
  `.getPendingResponseCount()`. Register it with `createModels().setProvider(handle.provider)`, then use the model
  `{ provider: "faux", modelId: "faux-1" }`.
- A step is either an `AssistantMessage` (`fauxAssistantMessage(...)`) or a factory `(context) => AssistantMessage`,
  where `context.messages` is that conversation's transcript.
- Each step is consumed by one model call. **Keep the queue topped up** (for example, re-append inside the factory).
- Deciding each response from `context.messages` makes a scenario deterministic across concurrent conversations.
  This was verified.
- Tool calls: `fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" })`.
- Model errors: `fauxAssistantMessage("", { stopReason: "error", errorMessage })`.
- **The faux provider always reports zero cost.** To produce spend in tests, commit to the conversation's `UsageDoc`
  directly, for example `(await tx.doc(UsageDoc, conversationId)).models["test/x"] = { cost: { total: 9 } }`.
  Verified.
- Faux model definitions accept `contextWindow` and `maxTokens`, for example
  `fauxProvider({ models: [{ id: "faux-1", contextWindow: 8000 }] })`. Use a small window to force compaction in
  tests.

**Compaction (built in)**
- **Triggers and lifecycle (verified):** a threshold or context overflow starts a `CompactionTask`. It selects an
  old prefix of the active context, summarizes it, and places a `pi.compaction` entry: a user message wrapping the
  summary, with `head` set to the first entry kept verbatim. Older entries stay in storage.
- **A compaction during a run does not end the run.** The generation waits at the blocking threshold, then
  continues with the summary plus the kept tail.
- **Settings:** `settings.compaction` / `configure({ compaction })` take `{ enabled, reserveTokens,
  keepRecentTokens, backgroundTokens, modelOverrides }`. The defaults are fixed token counts (16,384 / 20,000 /
  32,768), not proportions of the model's window. A manual compaction is `conversation.compact(instructions?, ctx)`.
- **Live status:** `pi.live.compactions` lists running compactions (`trigger`: `manual` | `threshold` |
  `overflow`). `pi.live.compactionFailure` holds the newest failure.
- **Failure:** if a compaction the generation is waiting for fails, the run fails with `model_error`, with a detail
  starting `Compaction failed`.
- **The replacement hook (verified):**
  `hook(CompactionTask, { beforeCompact({ reason, entries, messages, firstKept, instructions }, api, ctx) })`
  returns `{ summary }` to supply the summary, or `{ decline: true }`. The built-in summarizer does not run when a
  summary is supplied. `api` is a hook API with `models`, `memo`, `snapshot`, `entries` (raw history, which
  compaction never changes), `conversationId` and `now`.
- **What the built-in summarizer does (the reason picloud replaces it):**
  - it serializes the replaced messages as plain text, **dropping thinking** and **truncating each tool result to
    its first 2,000 characters**;
  - it asks for one free-form markdown summary (Goal / Constraints / Progress / Decisions / Next Steps / Critical
    Context), with output capped below the reserve;
  - repeated compactions re-summarize the previous summary together with new messages;
  - nothing is computed from ground truth, and the person's words are paraphrased.

## A7. Repository layout

Suggested layout. You may organize it differently, but the paths marked **(required)** must exist.
```
package.json, package-lock.json, .npmrc, tsconfig files        (required)
README.md            (required) how to build, run dev:fake, test, e2e; points to RUNBOOK.md Part B for deployment
DECISIONS.md         (required) choices made where this runbook was silent
RUNBOOK.md           (required) this file, unchanged
src/shared/          API payloads, SSE events, document shapes, session states: imported by server and client
src/server/          main, config, harness, agent extension, sessions, github (real + fake), fake model, monitor,
                     notifications, maintenance, http
src/client/          TSX: app shell and routing, drawer, transcript, cards, composer, sheets, sync
src/sw/              service worker
public/              index.html, manifest.webmanifest, style.css, icons/  (static, no code)
build/               tsc output for client and service worker (generated, not committed)
test/                node:test suites (§A13.2)
e2e/                 Playwright specs (§A13.3)
deploy/              (required) install.sh, picloud.service, picloud-backup.service, picloud-backup.timer (§A16)
```

## A8. Data model

All state lives in one SQLite file managed by Durable. picloud adds three Harness-wide singleton documents (Durable
scope `"session"`, §A6.2) and one signal.

### A8.1 Document `picloud.sessions` (version 1)
`{ items: Record<sessionId, SessionItem> }`, where `sessionId` is `String(conversationId)`.

| Field | Type | Meaning |
|---|---|---|
| `id` | string | conversation id |
| `requestId` | string | idempotency key of the creating request |
| `repo` | string | `owner/name` |
| `mode` | `"new"` \| `"continue"` | new branch, or continue an existing branch |
| `baseBranch` | string | PR base: the chosen base (new) or the repo default branch (continue) |
| `branch` | string | working branch: `picloud/<slug>-<4 hex>` (new) or the chosen branch (continue) |
| `compareRef` | string | `origin/<baseBranch>` (new) or `origin/<branch>` (continue) |
| `startSha` | string | HEAD when the session started |
| `workspace` | string | absolute path; removed by maintenance when pruned |
| `title` | string | first line of the task, ≤ 60 chars; replaced by the plan title |
| `state` | SessionState | §A9 |
| `createdAt`, `updatedAt` | number | ms epoch; every change sets `updatedAt` |
| `budgetUsd?` | number | spend cap for this session (from config; raisable) |
| `plan?` | `{ title, summary, steps: string[], assumptions: string[], completed: number[] }` | from `submit_plan` / `update_plan`; `completed` holds 1-based step numbers |
| `planApproved?` | true | set when the person approves the plan; cleared when a new plan is submitted |
| `report?` | `{ summary, changes: string[], verification, notes: string[], commits: string[] }` | from `final_report` |
| `error?` | string | for `failed` / `stopped` |
| `archived?` | true | hidden from the main list |
| `pruned?` | true | workspace deleted by maintenance |
| `pushedAt?` | number | last successful push |
| `prUrl?` | string | PR for `branch`, created or detected |

### A8.2 Document `picloud.repos` (version 1)
`{ items: Record<"owner/name", { setupNotes: string, updatedAt: number }> }`. This is memory of how to build and test
each repo on this machine.

### A8.3 Document `picloud.push` (version 1)
`{ vapid?: { publicKey, privateKey }, subscriptions: PushSubscriptionJSON[] }`

### A8.4 Signal `picloud.reply` (version 1)
Schema `obj({ approved: opt(bool()), text: str() })`. The key is always `"reply"`. Each tool call is its own task,
so `(taskId, "reply")` is unique per card.

### A8.5 Files
- **Data directory:** `<PICLOUD_DATA>/durable.sqlite` (plus WAL files), mode 700.
- **Workspaces:** `<PICLOUD_DATA>/work/<uuid>/`, each a git clone.
- **Uploads:** `<workspace>/.picloud/uploads/`. `.picloud/` is listed in the workspace's `.git/info/exclude`, so it is
  never committed.

## A9. Session lifecycle

| State | Meaning | Entered by | UI group |
|---|---|---|---|
| `preparing` | cloning and branching | server on create | Working |
| `planning` | exploring or planning | server after submit; `ask_user` answered; plan revised | Working |
| `question` | `ask_user` parked | `ask_user` | Needs you |
| `approval` | `submit_plan` parked | `submit_plan` | Needs you |
| `implementing` | plan approved; nudge active | `submit_plan` approved; Continue when `planApproved` and no `report` | Working |
| `working` | interactive follow-up run (no nudge) | server when a message starts a run on an idle or finished session | Working |
| `idle` | run ended with an ordinary answer; the person's turn | monitor | Needs you |
| `reported` | report filed; awaiting delivery choice | `final_report` | Needs you |
| `delivered` | pushed (and maybe PR) | server deliver | Done |
| `stopped` | Stop pressed, or budget reached (`error` begins `Budget of`) | server, monitor | Done; a budget stop is Needs you |
| `failed` | setup or run failed | server, monitor | Needs you |

**Transition rules:**
- **`ask_user`** remembers the state it interrupted and restores it when answered. It can be called during planning
  or implementing.
- **Plan revision** sends the person's feedback as the `submit_plan` result and sets `planning`. The agent revises
  and calls `submit_plan` again.
- **Messages on an idle or finished session** (`idle`, `reported`, `delivered`, `stopped`, `failed`) start a run and
  set `working`, which is the "keep working" path. A later `final_report` returns the session to `reported`.
- **Delivery** is allowed only from `reported` or `delivered`, and only while no run is active.
- **On server start,** any `preparing` session becomes `failed` ("Server restarted during setup").
- **While `preparing`,** only Stop and Archive are accepted. Message, Answer, Continue, Budget and Deliver return
  409 "Session is still setting up". Stop sets `stopped`, and setup must check the state before submitting the task:
  if it is no longer `preparing`, setup leaves it as is.
- **Archive** is allowed in any state.
- **The state a run ends in is never overwritten by the monitor** if it is `reported`, `delivered`, `stopped` or
  `failed` (§A11.6).

## A10. The agent extension

Install in this order: `CodingTools`, then the **`pi-context`** extension, then the **`picloud`** extension. Prompt
text is sent with every request, so keep it as written.

### A10.1 `pi-context` (Pi's own context loaders)
Sections:
1. `preamble` (untagged): "You are Pi, a coding agent. You inspect files, run commands, and modify code to complete
   the person's task."
2. `project_context`: the workspace's project instruction files, from
   `loadProjectContextFiles({ cwd, agentDir: getAgentDir() })`. Render each file as its path followed by its content.
   Omit the section when there are none.
3. `skills`: `formatSkillsForPrompt(loadSkills({ cwd, agentDir: getAgentDir(), skillPaths: [], includeDefaults: true }).skills, "read")`.
   Omit it when empty.
4. `cwd`: the workspace path.

### A10.2 `picloud` system prompt section (verbatim; substitute the `{…}` placeholders from the session item)
```
You are running on a remote server. The person is on their phone and is usually not watching.
Repository: {repo}. You are on branch {branch}. {modeLine}

How to work:
- A question, or a small direct request: just answer or do it.
- Anything larger: explore the code first. If a decision is genuinely the person's to make (scope, behavior,
  trade-offs) and you cannot infer it, ask with ask_user, putting all questions in one call with your recommended
  option first. Then call submit_plan and wait for approval.
- After the plan is approved, work to completion without stopping to ask permission. Make reasonable decisions and
  record them in the report. Use ask_user only for a true blocker you cannot work around. Call update_plan as you
  complete plan steps.
- Verify your work (run the tests, build, or check behavior) before reporting.
- Commit your work on the current branch with clear messages. Never push and never switch branches.
- Before final_report: run `git fetch origin`; if {compareRef} has moved, rebase your commits onto it, resolve any
  conflicts, and verify again.
- Finish with final_report. The person reads the report first; make it accurate, including anything you could not
  do or verify. If you learned how to install, build, or test this repository on this machine, put it in setupNotes.
```
`{modeLine}` takes one of two forms:
- New branch: "It was created from {baseBranch} for this task."
- Continued branch: "You are continuing existing work on this branch; read its recent commits to understand it."

**Section `repo_notes`:** present only if `picloud.repos` has notes for the repo. Text:
`Notes from earlier sessions on this repository (may be outdated):` followed by the notes.

### A10.3 Tools

All four tools are part of the `picloud` extension. "Notify" means a fire-and-forget push notification (§A15).
Notification and other external side effects must happen **once per tool call, even if the call reruns**. Guard
them with `api.memo`.

**`ask_user`: the multiple-choice tool.** `replay: "safe"`.
- **Description (verbatim):** "Ask the person up to 4 multiple-choice questions on one card. They tap an option or
  type their own answer. Waits until they answer, possibly for hours; returns one line per question as
  `header: answer`. Use only when the decision is theirs and changes the work. Never ask the same thing twice."
- **Parameters:**
  ```
  questions: 1–4 of {
    header:      string 1–12 chars (a short tag, e.g. "Scope")
    question:    string 1–300 chars
    options:     2–4 of { label: string 1–60 chars, description?: string ≤ 160 chars }
                 (recommended option first; its label ends with "(Recommended)")
    multiSelect?: boolean
  }
  ```
- **Behavior:**
  - **Fresh call or woken:** decide with `api.readSignal`. It is a reply only if the result has a `value`.
  - **Fresh call:** memoize the current state with `api.memo` (first writer wins, so a rerun after a restart cannot
    replace it with `question`). Set state `question`, notify "Pi has a question" with the first question as the
    body (once per call, §A10.3), then park on `picloud.reply`.
  - **Woken:** restore the memoized state and return the signal's `text` as the result.

**`submit_plan`.** `replay: "safe"`.
- **Description:** "Submit your implementation plan for the person to approve. Waits for approval. If they ask for
  changes, revise and call submit_plan again. The title names the session."
- **Parameters:** `title` (1–60 chars), `summary` (≤ 600), `steps` (1–15 strings, each ≤ 300), `assumptions?` (≤ 10
  strings, each ≤ 300).
- **Behavior:**
  - **Fresh call:** store the `plan` (with `completed: []`), clear `planApproved`, set the session `title`, set state
    `approval`, and notify "Plan ready" with the plan title as the body. Park. A rerun of this step after a restart
    writes the same values, so it is harmless.
  - **Woken with `approved: true`:** set `planApproved`, set state `implementing`, and return "Approved. Implement the plan now, without
    stopping to ask permission. Call update_plan as steps complete. Finish with final_report."
  - **Otherwise:** set state `planning` and return "The person asked for changes: {text}. Revise the plan and call
    submit_plan again."

**`update_plan`.**
- **Description:** "Mark plan steps as completed."
- **Parameters:** `completed`: 1–15 integers ≥ 1 (step numbers).
- **Behavior:** merge the numbers into `plan.completed`, ignoring numbers that are out of range. Return
  "Progress saved ({done}/{total})." If there is no plan, return an error result: "There is no approved plan."

**`final_report`.**
- **Description:** "File the final report when the task is complete or cannot be completed. Commit your work first.
  The person reads this first."
- **Parameters:**
  - `summary` (1–2000 chars)
  - `changes` (≤ 30 strings, each ≤ 300)
  - `verification` (≤ 1000)
  - `notes?` (≤ 15 strings, each ≤ 300): decisions made, things not done, follow-ups
  - `setupNotes?` (≤ 1500): how to install, build and test this repo on this machine, for future sessions
- **Behavior:**
  1. If `git status --porcelain` in the workspace is not empty, return an error result: "There are uncommitted
     changes. Commit them (or revert what should not be kept), then call final_report again."
  2. Run `git fetch --quiet origin`. A failure is not fatal.
  3. Collect `commits` as the lines of `git log --format='%h %s' {compareRef}..HEAD`.
  4. In one commit: store `report`, set state `reported`, and if `setupNotes` was given, replace that repo's notes in
     `picloud.repos`.
  5. Notify "Report ready" with the summary's first line as the body.
  6. Return "Report filed. End your turn with one short sentence; do not repeat the report."

### A10.4 The `onYield` nudge
Applies only when the session state is `implementing`. A **nudge entry** is a `pi.user` entry whose message content
is exactly the nudge text below. That is the only way to recognize one: the hook counts them, the fake model
recognizes them, and the client hides them.
1. Count the nudges already given in this stretch. Scan entries from newest to oldest. Stop at the `pi.tool-result`
   whose `toolName` is `submit_plan`, or at a `pi.user` entry that is not a nudge. Count the nudge entries passed on
   the way.
2. If fewer than 3, continue the run with this exact text:
   `You have not called final_report yet. Continue the approved plan to completion, then call final_report.`
3. Otherwise, let the run end.

The count restarts only at a plan approval or a real person's message. So a Continue after the nudges were exhausted
gets no further nudges. This is intended: the person has seen the stop and chosen to continue.

Every session conversation also gets `maxTurns` from config (default 200). Durable restarts the turn count at each
`onYield` continuation, so one nudged run can take up to 4 × `maxTurns` turns. The spend budget (§A11.6) is the
bound on cost.

### A10.5 Compaction and resumption: the handoff

**Goal.** When the context is compacted mid-run, the agent continues on its own, and continues *correctly*: no
redone work, no re-asked questions, no forgotten constraints, no repeated dead ends. Durable's lifecycle (triggers,
placement, kept tail, continuation) stays. picloud replaces only what is carried forward, through `beforeCompact` in
the `picloud` extension.

**What makes a handoff effective after a lossy, truncated compaction.** These principles decide every detail below.
Where this section leaves something open, decide by them.
1. **Ground truth over memory.** Anything that can be recomputed from the workspace or from durable records is
   recomputed by code at compaction time, never summarized by a model. That covers git state, commits, changed
   files, plan progress and session state. It cannot drift, and it comes out the same on every run.
2. **The person's words are never paraphrased.** The task, every answer, plan feedback and later instructions are
   carried verbatim. They are short and authoritative, and they are the first thing paraphrase corrupts.
3. **Accumulate; don't re-summarize.** Each handoff is the previous one updated with what happened since: the
   ledger rebuilt, the narrative revised. It is never a summary of a summary. An item stays until it is resolved.
4. **Lead with the resume point.** The most valuable content is what was in progress at the cut, what was just
   learned, and the exact next action, stated specifically enough to act on without rereading anything.
5. **Keep negative knowledge.** What was tried, failed and why. It is the most often lost and the most expensive to
   rediscover.
6. **Point, don't paste.** Large content becomes a pointer: a path with a line range, a command to rerun, or an
   entry to recall. The workspace and the raw transcript survive compaction, so a pointer loses nothing.
7. **Make loss recoverable.** Pre-compaction entries remain in storage. A `recall` tool searches them, and the
   handoff says it exists.
8. **Verify before trusting.** The handoff ends by telling the agent to re-establish ground truth before acting.
9. **Never strand the run.** The model-written part is memoized, so a restart reuses it. If it fails, the
   deterministic part alone becomes the handoff. A run that still ends on a compaction error is continued
   automatically.
10. **Degrade in a fixed order.** The handoff has a size budget, and when over budget it sheds content in a fixed
    priority order. The same inputs always give the same shape.
11. **Size relative to the model.** Thresholds and budgets are proportions of the model's context window, not fixed
    counts.

**Handoff structure.** Markdown, with these sections in this order. **L** marks the ledger, built by code. **N**
marks the narrative, written by the model.

| Section | Source | Content |
|---|---|---|
| `## Resume point` | N | What was in progress at the cut, the latest result or finding, and the single next action. |
| `## Task` | L | The session's task, verbatim, plus repo, branch and mode. |
| `## The person's words` | L | In order, verbatim, labelled: every `ask_user` answer, every plan revision, every later person message. Nudges excluded. |
| `## Plan` | L | The plan, with each step's status from `plan.completed`, and whether it is approved. |
| `## Repository state` | L | Branch, `compareRef`, commits since start (`git log --format='%h %s' {compareRef}..HEAD`), and `git status --short`. |
| `## Files` | L | Files modified (from write/edit tool calls in raw history, plus `git diff --name-only`), then files read. |
| `## Recent commands` | L | The last 5 bash commands from raw history, each with its exit status and the last 15 lines of output. |
| `## Findings` | N | Facts about the code needed to continue, with `path:line` pointers. |
| `## Dead ends` | N | Approaches tried that failed, and why. |
| `## Decisions` | N | Choices the agent made (not the person), with a one-line reason. |
| `## Open questions` | N | Unresolved risks or questions. |
| `## How to continue` | fixed | The text below, verbatim. |

`## How to continue` text:
```
You are resuming after context compaction. Older details above are condensed and may be incomplete. Before
continuing: check `git status`, re-read any file before editing it, and re-run the last failing command if one
matters. Do not redo completed plan steps or re-ask answered questions. If you need a detail from before this point,
use the recall tool. Then take the next action from "Resume point". If no run was in progress, wait for the person.
```

**The narrative call.**
- **One request** to the session's model through `api.models`. Its fixed instruction asks for exactly the five
  narrative sections, under the principles above.
- **Input:** the previous handoff's narrative sections, when the replaced range begins with a `pi.compaction`
  entry, so it is updated rather than re-summarized. Plus the replaced messages, serialized as text.
- **Tool results in that input:** keep the first 40 and last 40 lines, plus every line that looks like an error or
  failure, rather than the first N characters.
- **Parsing:** a missing section becomes `(none)`.
- **Memoize** the result with `api.memo` under a key that identifies this compaction (for example its `firstKept`).
- **On any failure** (error, timeout, unparseable output), use `(unavailable; use recall)` for each narrative
  section, and still return the handoff.

**Budget.**
- **Target:** about 10% of the model's context window, estimated at 4 characters per token.
- **When over, shed in this order:**
  1. files read;
  2. output tails of recent commands (keep the commands and exit statuses);
  3. person messages older than the newest 10 (replaced by a count and a recall hint);
  4. findings, trimmed from the oldest;
  5. decisions;
  6. open questions;
  7. dead ends, trimmed from the oldest.
- **Never shed:** Resume point, Task, the person's answers and plan feedback, Plan, Repository state, How to
  continue.

**Thresholds.** When creating a session conversation, `configure` its `compaction` from the model's
`contextWindow`:
- `reserveTokens` = max(8,192, 10%);
- `keepRecentTokens` = 20%;
- `backgroundTokens` = 10%.

**`recall` tool** (part of the `picloud` extension, `replay: "safe"`):
- **Description (verbatim):** "Search this session's full history, including what was condensed by compaction.
  Returns matching excerpts with their entry ids. Use it when the handoff mentions something you need in detail."
- **Parameters:** `query` (1–200 chars) and `limit?` (1–10, default 5).
- **Behavior:**
  - Search the conversation's raw entries case-insensitively for all query terms: user text, assistant text, tool
    call arguments and tool results.
  - Return each match as `entry {id} ({kind}): …excerpt…`, with about 300 characters of context, newest first.
  - Tools reach raw entries through the server's Harness (`harness.conversation(id).entries(...)`).

**Interaction with the rest of the design**
- **States:** the session state and the nudge accounting (§A10.4) are unaffected, because both read raw history,
  which compaction never changes.
- **Monitor (§A11.6):** a run that ends with `model_error` and a detail beginning `Compaction failed` is continued
  automatically **once** (`submit({ type: "continue" })`). Only a second such failure in a row marks it `failed`.

## A11. Server behavior

### A11.1 Configuration (environment variables)
| Variable | Default | Meaning |
|---|---|---|
| `PICLOUD_DATA` | `/var/lib/picloud` | data directory |
| `PICLOUD_HOST` | `127.0.0.1` | bind address (loopback only; Tailscale is the ingress) |
| `PICLOUD_PORT` | `8787` | |
| `PICLOUD_PUSH_SUBJECT` | unset | VAPID subject (`mailto:` or `https:` URL). Unset: notifications are logged, not sent. |
| `PICLOUD_ALLOWED_LOGINS` | unset | comma-separated Tailscale logins. Unset: any tailnet user. |
| `PICLOUD_MAX_TURNS` | `200` | per-run turn limit |
| `PICLOUD_SESSION_BUDGET_USD` | unset | default per-session spend cap. Unset: no cap. |
| `PICLOUD_FAKE` | unset | `1` = fake mode (§A13.1) |

### A11.2 Startup and shutdown
**Startup:**
1. Load models: Pi's `ModelRuntime`, or faux in fake mode.
2. Resolve the default model from Pi settings. Missing in real mode means exit with code 1 and this message: "No
   default model. As user picloud run `pi`, then /login and /model." This happens before anything touches the data
   directory.
3. Create the data and work directories.
4. Build the registry (§A10).
5. Open SQLite storage and the Harness.
6. Ensure the three documents exist, and create VAPID keys if absent.
7. Mark `preparing` sessions as `failed`.
8. Start monitors for active sessions (`planning`, `question`, `approval`, `implementing`, `working`).
9. Call `harness.resume()`.
10. Start maintenance (§A11.8).
11. Listen.

**On SIGTERM/SIGINT:** stop accepting requests, end streams, close the Harness, settle credential writes, then exit
with code 0.

### A11.3 GitHub module
All GitHub-specific operations go behind one interface with two implementations: real (`gh` + `git`) and fake
(§A13.1).

**Operations:**
- list repos;
- list a repo's branches and default branch;
- clone;
- identity (name and email for commits);
- push;
- find an existing PR for a branch;
- create a PR.

**Real implementation notes:**
- **Repo list:** `gh api --paginate "user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member"`.
  Cache it for 60 s.
- **Branches:** `gh api --paginate repos/{repo}/branches`. The default branch comes from
  `gh repo view {repo} --json defaultBranchRef`.
- **Clone:** `gh repo clone {repo} {dir} -- --filter=blob:none`.
- **Identity:** from `gh api user`: name (or login), and email `{id}+{login}@users.noreply.github.com`. Set it in the
  workspace's local git config.
- **PR lookup:** `gh pr list --head {branch} --state open --json url`.
- **PR create:** `gh pr create --base {baseBranch} --head {branch} --title {title} --body-file {file}`. The PR body is
  the report rendered as markdown.
- **Push:** `git push -u origin {branch}`. A non-fast-forward rejection must surface as the error "The remote branch
  has new commits. Ask Pi to rebase onto it, then push again."
- **How to run them:** use `execFile` (no shell), `GIT_TERMINAL_PROMPT=0`, a 120 s timeout for network operations and
  30 s otherwise. Surface the stderr tail (≤ 500 chars) on failure.

### A11.4 Session operations

**Create** `(repo, branch?, text, attachments, requestId)`:
- **Idempotent** by `requestId`: a repeated `requestId` returns `201` with the existing session's `{ id }`.
- **Create the conversation** with the default model, `cwd` = a new workspace path, and `maxTurns`. Store the item
  as `preparing` and **respond immediately**.
- **Then, asynchronously:**
  1. Clone the repo.
  2. **New mode:** check out the chosen base (or the default branch) and create the working branch.
  3. **Continue mode:** check out the chosen branch tracking origin, and detect an existing PR.
  4. Set the git identity, add the exclude entry, and record `startSha` and `compareRef`.
  5. If the state is still `preparing`, submit the task with `requestId` (attachments per §A11.5), set `planning`, and
     start the monitor.
- **Any failure** sets `failed` with `error`.
- **Fake and real use the same git commands.** Only the clone source and the GitHub-API operations differ.

**Message** `(text, attachments, requestId)`: route in this order.
1. **A card is pending.** That means a `pi.live` tool slot with `status === "sleeping"` named `ask_user` or
   `submit_plan`. Signal that card:
   - `ask_user` gets `text = The person replied in their own words: "{text}"`.
   - `submit_plan` gets `{ approved: false, text }`.
   - Attachments are saved as files, and their paths are appended to the text.
2. **A run is active:** submit with `whenBusy: "steer"`.
3. **Otherwise:** submit. If the state is idle or finished (§A9), set `working` and start the monitor.

**Answer** `(callId, payload)`:
- **Find the card:** look up the slot by `callId`. It must be `sleeping`, otherwise return 409. The client never
  sends task IDs.
- **`ask_user` text:** `answers` are matched to questions **by position**; `header` is carried for readability. Each
  produces one line, `{header}: {answer}`. Selected labels are used verbatim, including any "(Recommended)".
  Multi-select answers are joined with `"; "`. A free-text answer becomes `Other: "{text}"`.
- **`submit_plan`:** `{ approved, text: feedback ?? "" }`.

**Stop:** set `stopped`, then abort the conversation.

**Continue:** used after `failed` or `stopped`. Submit `{ type: "continue" }`, then set `implementing` if
`planApproved` is set and no `report` exists, otherwise `working`.

**Budget** `(budgetUsd)`: set the session's cap. A value not greater than the current spend returns 400.

**Spend check:** while the session's spend is at or above `budgetUsd`, Message and Continue return 409 "Budget
reached; raise it first".

**Deliver** `(kind: "push" | "pr")`:
- **Preconditions:** the state is `reported` or `delivered`, no run is active, and the report has at least one commit.
- **Push.** For `pr`: if a PR already exists, return its URL; otherwise create one.
- **Store** `pushedAt` and `prUrl`, and set `delivered`.

**Diff:** `git diff --stat {mergeBase}` followed by `git diff {mergeBase}` (working tree included), where
`mergeBase = git merge-base {compareRef} HEAD`. Cap the output at 2 MB.

**Archive** `(archived)`: set or clear `archived`.

### A11.5 Attachments
- **Wire format:** attachments arrive as `{ name, type, data (base64) }`. The JSON body limit is 50 MB.
- **Images,** when the session model's input includes `image`, become image content parts.
- **Other files, and images for text-only models,** are saved to `.picloud/uploads/{timestamp}-{safe name}`, and
  `[Attached file: <relative path>]` is appended to the text.

### A11.6 Monitor
Use one `observeConversation` per active session. Defer handling out of `advance`.

**Run ended** (`pi.live.run` present → absent):

| `runFailure.reason` | Action |
|---|---|
| `aborted` | do nothing; Stop or budget already set the state |
| `model_error` whose detail begins `Compaction failed`, first time in a row | continue the run automatically (§A10.5) |
| any other reason | `failed`, `error = detail ? "{reason}: {detail}" : reason`, notify "Run failed" |
| no failure, state `planning` or `working` | `idle`, notify "Pi replied" (body: first 100 chars of the last assistant text) |
| no failure, state `implementing` | `idle`, notify "Pi stopped without a report" |
| no failure, any other state (e.g. `reported`) | no change |

**Budget:** evaluate on **every** `advance` of the conversation observer (a commit that only changes `pi.usage` also
produces one; verified), and whenever the budget is changed. Total the cost from `pi.usage` (sum of every
`cost.total`). When a run is active and the total reaches `budgetUsd`: set `stopped` with
`error = "Budget of ${budgetUsd} reached"`, abort, and notify "Budget reached".

**Detach** the observer only once no run is active and the session is not in an active state.

### A11.7 SSE streams
- **Headers:** `text/event-stream` and `cache-control: no-store`.
- **Keep-alive:** a `: ping` comment every 15 s.
- **Session stream:** on connect, send `base` `{ view }` (the watch value), then `ops` `{ ops }` for each change.
  Every reconnect starts with a fresh `base`.
- **Global stream:** `base`/`ops` of `picloud.sessions` via `observeDoc`, plus one `config` event
  `{ vapidPublicKey, fake }`.
- **Presence:** the server tracks which sessions have an open session stream. Notifications for those sessions are
  skipped (§A15).

### A11.8 Maintenance (daily, in-process, and once at startup)
For each session that is archived, delivered and not yet pruned, with `updatedAt` older than 14 days: if
`git status --porcelain` is empty and `git log --branches --not --remotes` is empty, delete the workspace and set
`pruned`. Never delete anything else. Never delete a workspace with unpushed commits.

### A11.9 Static files and vendor mapping
- **Static:** serve `public/`, and the compiled client at `/build/...`. Serve `build/sw.js` at `/sw.js` with
  `cache-control: no-cache`, so its scope is the whole app.
- **Vendor:** serve `/vendor/...` from `node_modules`, with no copies. Each path below was verified to exist in the pinned
  versions:

  | URL | File |
  |---|---|
  | `/vendor/preact.mjs` | `preact/dist/preact.mjs` |
  | `/vendor/hooks.mjs` | `preact/hooks/dist/hooks.mjs` |
  | `/vendor/jsx-runtime.mjs` | `preact/jsx-runtime/dist/jsxRuntime.mjs` |
  | `/vendor/marked.mjs` | `marked/lib/marked.esm.js` |
  | `/vendor/purify.mjs` | `dompurify/dist/purify.es.mjs` |
  | `/vendor/chord/*` | `@earendil-works/chord/dist/*` (its `delta/index.js` imports only relative files) |

- **Paths:** reject any path containing `..`.

### A11.10 Access control, errors, logging
- **Access control:** with `PICLOUD_ALLOWED_LOGINS` set, reject (403) any request whose `Tailscale-User-Login`
  header is absent or not listed. No cookies, tokens or app logins exist.
- **Errors:** JSON `{ error }` with status 400 (validation), 403, 404, 409 (state conflict) or 502 (git or GitHub
  failure).
- **Logging:** one line per request (method, path, status, ms) and one per state change. Never log message contents
  or credentials.

### A11.11 References in messages: `@file` and `#skill`
**Sources for the pickers:**
- **Files in a session:** the workspace's `git ls-files --cached --others --exclude-standard`. Cache it per session
  and refresh it when a run ends.
- **Files on the New session view:** the chosen repo and branch's remote tree. Real mode:
  `gh api repos/{repo}/git/trees/{ref}?recursive=1`, keeping blobs. Fake mode: `git ls-tree -r --name-only {ref}`
  on the bare repo.
- **Skills:** Pi's `loadSkills` for the session workspace (project plus global skills). On the New session view, use
  global skills only.

**Ranking** for a query `q` (case-insensitive):
1. basename starts with `q`;
2. a path segment starts with `q`;
3. `q` is a substring;
4. `q` is a subsequence.

Ties sort shorter path first, then alphabetically. Return at most 50. An empty query returns recently modified files
first in a session, and alphabetical order otherwise.

**Expansion** happens when a message or task is submitted, after the clone for a new session.
- **A file reference** is an `@` at the start or after whitespace, followed by a path that exists in the workspace.
  For each one, append:
  - `<file path="{path}">{contents}</file>` for a text file ≤ 100 KB, up to 400 KB in total per message;
  - otherwise `<file path="{path}" omitted="too large|binary"/>`, which the agent can read itself.
  - An image file becomes an image content part when the model accepts images.
- **A skill reference** is a `#` at the start or after whitespace, followed by a skill name. Prepend Pi's own skill
  block, with frontmatter removed (`stripFrontmatter` is exported by `pi-coding-agent`):
  `<skill name="{name}" location="{filePath}">\nReferences are relative to {baseDir}.\n\n{body}\n</skill>`.
- **Unknown references** stay as plain text.
- **The person's text is kept as typed.** The blocks are added around it.
- **When the message answers a pending card** (§A11.4), the expansions are appended to the signal text.

## A12. HTTP API

`:id` is the session id.

| Method & path | Body | Response |
|---|---|---|
| `GET /api/repos` | | `[{ fullName, private, pushedAt, description }]` |
| `GET /api/repos/:owner/:name/branches` | | `{ defaultBranch, branches: string[] }` |
| `GET /api/events` | | SSE (§A11.7) |
| `POST /api/sessions` | `{ repo, branch?: { mode: "new", base?: string } \| { mode: "continue", name: string }, text, attachments?, requestId }` | `201 { id }` |
| `GET /api/sessions/:id/events` | | SSE (§A11.7) |
| `GET /api/sessions/:id/entries?before=<entryId>&limit=50` | | `{ items }`, oldest first, strictly older than `before` (`maxEntryId` is inclusive, so exclude `before` itself) |
| `POST /api/sessions/:id/messages` | `{ text, attachments?, requestId }` | `202 {}` |
| `POST /api/sessions/:id/answer` | `{ callId, answers?: [{ header, selected: string[], other?: string }], approved?: boolean, feedback?: string }` | `202 {}` |
| `POST /api/sessions/:id/stop` | | `202 {}` |
| `POST /api/sessions/:id/continue` | | `202 {}` |
| `POST /api/sessions/:id/budget` | `{ budgetUsd }` | `200 {}` |
| `POST /api/sessions/:id/deliver` | `{ kind: "push" \| "pr" }` | `200 { pushedAt, prUrl? }` |
| `GET /api/sessions/:id/diff` | | `text/plain` |
| `POST /api/sessions/:id/archive` | `{ archived: boolean }` | `200 {}` |
| `POST /api/push/subscribe` | `PushSubscriptionJSON` | `201 {}` (deduplicated by endpoint) |
| `GET /api/sessions/:id/files?q=` | | `{ items: string[] }` (§A11.11) |
| `GET /api/repos/:owner/:name/files?ref=&q=` | | `{ items: string[] }` (New session view) |
| `GET /api/sessions/:id/skills` | | `[{ name, description }]` |
| `GET /api/skills` | | `[{ name, description }]` (global skills) |

## A13. Fake mode, tests and definition of done

### A13.1 Fake mode (`PICLOUD_FAKE=1`; `npm run dev:fake`)
Fake mode runs the complete product with no model credentials and no GitHub access. It exists for development, tests
and evaluation.

**Fake model:** the pi-ai faux provider with a deterministic scenario. Each response is decided from that
conversation's own messages (§A6.2), as a state machine:

Definitions:
- **The task:** the conversation's first user message.
- **A nudge:** a user message whose content equals the §A10.4 nudge text exactly.
- **A person's message:** any other later user message.
- `chat` is matched case-insensitively as a substring of the task.

Rules are checked top to bottom.

| Last message in the conversation | Fake model responds with |
|---|---|
| The task, containing the word `chat` | a plain text answer: `Fake answer.` (no tools) |
| The task, any other | `ask_user` with 1 question: header `Scope`, question `Which variant?`, options `Small (Recommended)` / `Large` |
| `ask_user` result | thinking `Planning.`, then `submit_plan`: title `Add demo file`, 2 steps |
| `submit_plan` result starting `The person asked for changes` | `submit_plan` again with title `Add demo file (revised)` |
| `submit_plan` result starting `Approved` | `write` `PICLOUD_DEMO.md` with content `demo\n` |
| `write` result | `bash` `git add -A && git commit -qm "Add demo file"` |
| `bash` result | `update_plan` `{ completed: [1, 2] }` |
| `update_plan` result | `final_report` with summary `Added PICLOUD_DEMO.md.`, 1 change, verification `File exists.`, setupNotes `No build needed.` |
| a picloud handoff (narrative) request | the five narrative sections, each with one fixed line |
| a nudge, or a `final_report` result | text `Done.` |
| a person's message (any state) | text `Noted.` |
| anything else | text `Done.` |

**Fake GitHub:**
- **Seeding:** at startup, create local bare repositories under `<PICLOUD_DATA>/fake-origin/`, if absent:
  - `demo/app`: default branch `main` with `README.md`, `src/app.ts` and `src/util.ts`, plus a second branch
    `feature/x` with one extra commit.
  - A global Pi skill `demo-skill` (a `SKILL.md` with a name and a description) in the temporary Pi agent
    directory.
  - `demo/lib`: `main` only.
- **Operations:**
  - The repo list and branches come from those bare repos.
  - Clone with `git clone <bare path>`; push to the bare repo.
  - Identity is `picloud-dev <dev@picloud.invalid>`.
  - PR create records a PR as a JSON file under `<PICLOUD_DATA>/fake-origin/prs/`, so PRs survive restarts. It
    returns `http://127.0.0.1:<port>/fake-pr/<n>`, which serves a page showing the title and body. PR lookup reads
    the recorded PRs.

**Other differences:** notifications are logged. The `config` event reports `fake: true`, and the UI shows a small
"Fake mode" label in the drawer footer.

**Command:** `npm run dev:fake` starts the server in fake mode on `127.0.0.1`. It uses `PICLOUD_PORT` if set,
otherwise a free port, and prints its URL. It uses a fresh temporary `PICLOUD_DATA` unless one is given, and a fresh
empty Pi agent directory (`PI_CODING_AGENT_DIR`, the variable Pi reads instead of `~/.pi/agent`).

**Isolation:** fake mode, tests and e2e never touch port 8787, the default data directory or the user's real Pi
configuration. They must run correctly on a machine where a real picloud is running.

### A13.2 Required automated tests (`npm test`, `node:test`)
Tests use real SQLite storage in temporary directories, the faux model and the fake GitHub. Do not mock Durable.

**Test seams (required).** The server must be constructible in-process, separately from `main`, with injectable:
- the data directory;
- fake mode;
- a replacement fake-model scenario (for example a model that only answers in plain text, or that errors);
- a notification sink, so tests can count notifications;
- a clock used by maintenance.

It must expose its Harness and listening port to tests, and close cleanly so a test can reopen the same data
directory. Choose the shape of this interface yourself and describe it in `README.md`.
Required cases:

1. **Lifecycle:** create → `question` → answer → `approval` → approve → `implementing` → `reported`. The report has
   the commit, the plan has `completed: [1, 2]`, and `picloud.repos` has the setup notes.
2. **Restart while parked:** with `ask_user` parked, close the Harness and reopen it on the same file. The slot is
   still sleeping with the same task id. Answering completes the session.
3. **Notification once:** each park produces exactly one notification even if the tool reruns.
4. **Revise:** feedback returns the session to `planning`, and the agent submits a revised plan.
5. **Nudge:** a model that keeps answering with plain text while implementing gets exactly 3 nudges, and then the
   session becomes `idle`. No nudge is ever given outside `implementing`.
6. **`final_report` with a dirty workspace** returns an error result, and the state stays `implementing`.
7. **Routing:**
   - composer text while a question is pending answers it ("own words" text);
   - while a plan is pending, it revises;
   - while running, it steers;
   - while reported, it sets `working`.
8. **Continue mode:** working on `feature/x` commits on top of it. Push updates `feature/x` in the bare repo, and
   report commits list only the new commits.
9. **Deliver:** push creates the branch in the bare repo. `pr` creates one fake PR, and a second `pr` returns the same
   URL. Deliver is refused while a run is active.
10. **Diff:** the diff output contains the session's change and nothing from the base branch.
11. **Budget:** set `budgetUsd` to 1. While a run is active (parked on `ask_user`), commit usage costing 2 to that
    conversation's `UsageDoc` (§A6.2). The run is aborted, and the state is `stopped` with the budget error. Raising
    the budget to 5 and continuing works.
12. **Failure:** a model error ends in `failed` with the reason. Continue resumes.
13. **Maintenance:** prunes only archived, delivered, clean, fully pushed workspaces older than 14 days.
14. **Access control:** with `PICLOUD_ALLOWED_LOGINS` set, requests without a listed `Tailscale-User-Login` get 403.
15. **Compaction mid-implementation** (faux model with a small `contextWindow`): the run continues to `reported`
    with no input from the person.
16. **Handoff contents:** the handoff contains the task verbatim, every answer verbatim, the plan with step
    statuses, the commits and modified files, and the fixed "How to continue" text. Three successive compactions
    still contain the task and the answers verbatim.
17. **Narrative failure:** with the narrative request failing, the handoff is the ledger with `(unavailable; use
    recall)` sections, and the run continues.
18. **Restart during compaction:** reopening reuses the memoized narrative. There is no second narrative request for
    the same compaction.
19. **Recall** finds a detail that exists only before the compaction.
20. **References:**
    - `@src/app.ts` adds that file's `<file>` block;
    - `#demo-skill` prepends its `<skill>` block;
    - an unknown `@x` stays plain text;
    - picker ranking orders basename-prefix matches first.

### A13.3 Required end-to-end suite (`npm run e2e`, Playwright)
- **Setup:** Playwright's `webServer` starts `npm run dev:fake` on a free port.
  - Use the device profile `iPhone 15`, but **override `defaultBrowserType` to `chromium`** (the profile defaults to
    WebKit).
  - Install the browser with `npx playwright install --with-deps chromium`. This is part of the work, not optional.
- **Required scenarios:**
  1. Open the app. With no sessions, the New session view is shown. Choose `demo/app` and send a task. The question
     card appears. Tap `Small (Recommended)`. The plan card appears. Tap Approve. The report card appears with Push
     branch and Open PR. Tap Open PR. A PR link is shown.
  2. Tool calls and thinking render **collapsed**. Expanding a tool group shows one line per call. Expanding a call
     shows its output.
  3. The drawer opens from ☰, lists sessions in the right groups, and switches sessions. The ☰ badge appears when
     another session needs attention.
  4. Typing in the composer while the question card is pending answers the card.
  5. Swipe-archive (or the Archive action) then Undo restores the session.
  6. The diff sheet groups changes by file with +/− counts.
  7. **Dark mode** (emulated `prefers-color-scheme: dark`) renders with no console errors.
  8. At a **375 px** width there is no horizontal page scroll.
  9. After a server restart mid-session, the page reconnects and shows current state.
  10. Typing `@ut` in the composer shows a picker containing `src/util.ts` that narrows as more is typed. Tapping it
      inserts `@src/util.ts `. Typing `#de` offers `demo-skill`.

### A13.4 Definition of done (all must hold)
1. `npm ci` succeeds from the committed lockfile.
2. `npm run build` succeeds, and `npm run check` reports 0 TypeScript errors across every tsconfig.
3. `npm test` passes every case in §A13.2.
4. `npm run e2e` passes every scenario in §A13.3.
5. All source is TypeScript (`.ts`/`.tsx`). The only JavaScript in the repository is generated output in `build/`,
   which is not committed.
6. The required files (§A7) exist, `RUNBOOK.md` is unchanged, and `DECISIONS.md` lists every choice made where this
   runbook was silent.
7. With `PICLOUD_FAKE` unset, `PI_CODING_AGENT_DIR` set to an empty temporary directory, and `PICLOUD_DATA` set to a
   writable temporary directory, `npm start` exits with code 1 and the "No default model" message (§A11.2).
9. `bash -n deploy/install.sh` passes, and `deploy/install.sh --dry-run` prints every step it would take without
   changing the system (§A16). Do not run it without `--dry-run`.
8. The code meets Rule 3 (§A2). Tests can't check this; it is how the result is judged.

## A14. PWA specification

Each design choice names the Apple Human Interface Guidelines (HIG) principle it serves.

### A14.1 Navigation
- **Structure:** one content area, showing either **New session** or **Session**, plus a **navigation drawer** with
  the session list. Use hash routes `#/new` and `#/s/<id>`.
- **Launch:** reopen the last route, saved in `localStorage` (wrapped in try/catch), or New session if there is none.
  - HIG principle: *preserve and restore context*.
- **Drawer:** a **☰** button at the top left opens it. It slides in from the left over a dim scrim, width
  min(85vw, 360px). Tapping the scrim, swiping left or choosing a row closes it.
  - HIG principles: *direct manipulation*, *predictable dismissal*.
- **Why a drawer:** the destinations are a changing list of peer conversations. A drawer is the established
  convention for that in chat apps, so switching sessions is pull-and-tap.
  - HIG principle: *consistency with conventions people know*.
- **Badge:** ☰ shows a dot when **another** session needs attention. This offsets hidden navigation's weak
  discoverability.
  - HIG principle: *communicate status without interrupting*.
- **Wide screens:** at ≥ 900 px the drawer is a persistent sidebar.
  - HIG principle: *adapt layout to the available space*.
- **Drawer contents:**
  1. **New session** row at the top, in the accent colour.
     - HIG principle: *primary action first*.
  2. Groups **Needs you**, **Working** and **Done** (§A9), newest first. Each row shows the title on one line and a
     secondary line `repo · state label · progress (e.g. 3/6) · relative time`. The current session is highlighted.
     - HIG principles: *clarity*, *hierarchy*, *status at a glance*.
     - State labels: Setting up, Planning, Question, Plan ready, Working, Your turn, Report ready, Delivered,
       Stopped, Budget reached, Failed.
  3. **Swipe a row left** to reveal **Archive**. Archiving shows an **Undo** toast for 5 s instead of a
     confirmation.
     - HIG principle: *forgiveness over confirmation*.
  4. Footer: **Enable notifications** (while not granted), **Show archived** toggle, and the "Fake mode" label in
     fake mode.
     - HIG principle: *rare actions out of the main path*.
- **No settings screen.**
  - HIG principle: *deference*: there is nothing to configure.

### A14.2 New session view
- **Empty-state prompt:** "What should Pi work on?", centred, in secondary text.
  - HIG principle: *helpful empty states*.
- **Above the composer:** a **repo chip**, defaulting to the last used repo, and a **branch chip**, defaulting to "New
  branch from {default}".
  - **Repo chip** opens a bottom **sheet** with search, repos sorted by recency, and recent picks first.
  - **Branch chip** opens a sheet with two sections:
    - **New branch from…** (base choices: default first);
    - **Continue a branch…** (existing branches).
  - HIG principles: *sensible defaults*, *minimize typing*, *sheets for focused sub-tasks*.
- **Send:** creates the session and navigates to it immediately ("Setting up…"). It is disabled until a repo is
  chosen and text is entered.
  - HIG principles: *immediate feedback*, *prevent errors*.

### A14.3 Session view
- **Header:** ☰, the title (truncated), the spend (e.g. "$0.42", secondary text, from `pi.usage`), and a **⋯** menu
  with View changes, Stop (only while running) and Archive.
  - HIG principle: *hierarchy by frequency of use*.
- **Transcript rendering** (from `view.entries` and `view.docs["pi.live"]`):

| Source | Rendering | HIG principle |
|---|---|---|
| `pi.user` | Right-aligned tinted bubble. Text is pre-wrapped; images are thumbnails (tap to enlarge). Nudge entries are not shown. | familiar chat layout |
| assistant text | Full-width markdown (marked, then DOMPurify). Code is monospace with horizontal scroll. Links open in a new tab with `rel=noopener`. | legibility, deference |
| assistant thinking | Collapsed row "▸ Thinking"; expands to secondary-colour text. | progressive disclosure |
| tool calls + results | Consecutive calls fold into one collapsed row summarized in plain words ("Read 6 files, edited 2, ran 3 commands"). A red mark shows on the row if any result `isError`. Expanded, it shows one line per call ("Read `src/a.ts`", "Ran `npm test`"). Tapping a call shows its input and output in monospace (first 200 lines, then "Show all"). | progressive disclosure (3 levels), plain language, never hide problems |
| `ask_user`, `submit_plan`, `update_plan`, `final_report` | Cards (§A14.5), never tool rows. `update_plan` renders nothing and only updates the plan card. | one clear call to action |
| `pi.compaction` | A thin divider: "Context compacted", plus "· continuing" if a run was active. Tapping it opens the handoff in a sheet. `pi.system` and `pi.reset` are hidden. | deference, progressive disclosure |
| `<file>` / `<skill>` blocks in a user message | Small chips ("📄 src/app.ts", "✦ demo-skill"), tap to expand. The person's own text renders normally. | clarity |
| `live.generation.message` | The streamed partial, rendered as the last assistant block and updated in place. No spinner over content. | non-blocking feedback |
| running tool slots | The group row reads "Running `npm test`…"; live output is shown at level 3. | feedback |
| `live.generation.retry` | Status line "Model error, retrying…" | keep people informed |
| `failed` / `stopped` state | Inline banner with the reason and **Continue**. For a budget stop (`error` begins `Budget of`), the banner reads "Raise to ${X} and continue", where X = max(2 × budget, ceil(spend) + 1). It calls Budget, then Continue. | recoverable errors with a next step |

- **Status line,** above the composer:
  - "Working · step {done}/{total}" when there's a plan, or "Working · turn {run.turns}" when there isn't;
  - "Waiting for you" when a card is pending;
  - "Compacting context…" while `pi.live.compactions` is non-empty;
  - hidden otherwise.
  - HIG principle: *system status visible, unobtrusively*.
- **Scrolling:** follow new content only when within 80 px of the bottom; otherwise show a "↓ New activity" pill.
  Reaching the top loads older entries.
  - HIG principle: *don't move content away from the reader*.

### A14.4 Composer (shared by both views)
- **Layout:** **(+)** attach on the left, an auto-growing **input pill** (1–6 lines, then scroll) in the middle, and
  **(↑)** send on the right. Every control is at least 44×44 pt.
  - HIG principles: *44 pt touch targets*, *familiar layout*.
- **Send becomes Stop:** while a run is active and the pill is empty, ↑ becomes **■ Stop**. Typing turns it back
  into ↑, which steers the run.
  - HIG principles: *one adaptive control*, *parity with common chat apps*.
- **Placeholder by state:**

  | State | Placeholder |
  |---|---|
  | Question pending | "Or type your own answer…" |
  | Plan pending | "Describe changes to the plan…" |
  | Reported | "Ask for changes to keep working…" |
  | Otherwise | "Message…" |

  - HIG principle: *say what an input will do*.
- **Keys:** Enter sends only with a hardware keyboard (`(hover: hover) and (pointer: fine)`); otherwise it inserts a
  newline.
  - HIG principle: *platform input conventions*.
- **Positioning:** the composer stays above the on-screen keyboard (`visualViewport`) and respects
  `env(safe-area-inset-bottom)`.
  - HIG principles: *keyboard avoidance*, *safe areas*.
- **Drafts:** per-session drafts persist in `localStorage` (try/catch).
  - HIG principle: *never lose input*.
- **Reference pickers:**
  - **Triggers:** `@` (files) and `#` (skills), only at the start of the input or after whitespace, so emails and
    `#123` issue numbers don't trigger them. A `#` followed by a digit closes the skill picker.
  - **Behavior:** the query is the text from the trigger to the cursor. The list refines on every keystroke
    (debounced about 100 ms) and sits directly above the composer. Rows are ≥ 44 pt: for files the basename in bold
    with the directory in secondary text, for skills the name with its description.
  - **Selection:** tapping, or Enter or arrows with a hardware keyboard, inserts the token followed by a space.
    Space, Escape or a tap outside dismisses the list.
  - **Accessibility:** `role="listbox"` with options and `aria-activedescendant`.
  - **No match:** a single "No matching files" row. The text stays plain.
  - HIG principles: *suggest, don't require*, *recognition over recall*, *minimize typing*, *immediate feedback*.
- **Attachments:**
  - (+) opens the system file picker: `multiple`, accepting images plus common text, pdf and zip types.
    - HIG principle: *use system pickers*.
  - Images are resized in the browser to a longest side of 2048 px and encoded as JPEG at quality 0.85. This also
    normalizes HEIC.
  - Other files may be up to 20 MB each.
  - Pending attachments show as removable chips or thumbnails in the pill.
    - HIG principles: *reversible actions*, *show what will be sent*.

### A14.5 Cards
- **Question (`ask_user`):**
  - **Layout:** each question shows its header in small caps, the question, then full-width option rows (≥ 44 pt),
    each with the label in bold and the description in secondary text. Keep the agent's order. The last row is
    **Other…**, which expands an inline text field. Multi-select rows use checkmarks.
  - **Submit:** a single single-select question submits on tap. Otherwise a primary **Submit** button enables once
    every question is answered.
  - **After answering:** the card collapses to a read-only summary of the answers.
  - HIG principles: *minimize typing*, *recognition over recall*, *fewest taps*, *clear completion*.
- **Plan (`submit_plan`):**
  - **Content:** title, summary, numbered steps with checkmarks for completed ones (live from `plan.completed`), and
    assumptions in secondary text.
  - **Buttons:** **Approve** (primary) and **Revise** (secondary). Revise focuses the composer with the plan
    placeholder.
  - **After approval:** a progress line "3 of 6 done", with the steps collapsible.
  - HIG principles: *one primary action*, *reuse familiar controls*, *status at a glance*.
- **Report (`final_report`, from the session item):**
  - **Content:** summary (markdown), Changes, Verification, Notes, Commits (monospace; collapsed when there are more
    than 5), the session cost, and a **View changes** link.
  - **Buttons:** **Push branch** (primary) and **Open PR** (secondary). If a PR already exists, they become **Push
    updates** and **View PR ↗**.
  - **While delivering:** buttons show progress and are disabled. Errors appear inline. After delivery the card shows
    "Pushed {branch}" and the PR link.
  - **No commits:** "No changes to deliver" and no buttons.
  - **Keep working:** this is the composer, so there is no extra button.
  - HIG principles: *don't duplicate controls*, *clear outcome feedback*.
- **Diff sheet:**
  - A full-height sheet, **grouped by file**: each file is a collapsible section with its path and `+added −removed`
    counts.
  - Sections start collapsed when there are more than 3 files.
  - Inside each section: monospace text, `+` lines green, `-` lines red, hunk headers bold, horizontal scroll.
  - Binary files show "Binary file changed".
  - Dismiss with a swipe down or **Done**.
  - HIG principles: *sheets for focused tasks*, *progressive disclosure*.

### A14.6 Visual and accessibility rules
| Rule | Requirement | HIG principle |
|---|---|---|
| Typography | the system font (`-apple-system-body`, `system-ui` fallback) and `rem` sizes, so the user's text-size setting applies | legibility, Dynamic Type |
| Dark mode | colour tokens on `:root`, redefined under `prefers-color-scheme: dark`; `<meta name="color-scheme" content="light dark">` | adapt to appearance |
| Contrast | ≥ 4.5:1 for body text and ≥ 3:1 for large text, in both modes | accessibility |
| Motion | transitions ≤ 200 ms; none under `prefers-reduced-motion` | motion is optional |
| Screen readers | real `<button>` elements; labels on icon buttons ("Open sessions", "Attach", "Send", "Stop"); `aria-expanded` on disclosures; cards labelled groups | accessibility |
| Layout | single column, max width 760 px, 16 px gutters, safe-area padding, no horizontal page scroll | safe areas, readable line length |
| Connectivity | a thin non-blocking "Reconnecting…" bar; reading and typing stay enabled; sends retry with the same `requestId` | graceful degradation |
| Loading | skeleton rows on first load; never a full-screen spinner | perceived performance |

### A14.7 Client sync
- **Session view:** one EventSource per open session. On `base`, replace the view. On `ops`, set
  `view = applyImmutable(view, ops)`.
- **Global stream:** one EventSource for the session list and config.
- **Visibility:** when the page becomes hidden, close both EventSources (this tells the server notifications are
  wanted). Reopen them when it becomes visible again. This also handles iOS's half-open connections after
  backgrounding.
- **Requests:** every create, message or answer carries a client-generated `requestId` (where the API has one).
  Retry network failures with backoff and the same id.

### A14.8 PWA plumbing
- **`index.html`:**
  - Viewport: `width=device-width, initial-scale=1, viewport-fit=cover`.
  - `apple-mobile-web-app-capable`, an `apple-touch-icon` (180 px) and the manifest link.
  - The import map: `preact`, `preact/hooks`, `preact/jsx-runtime`, `marked`, `dompurify` and
    `@earendil-works/chord/delta` (→ `/vendor/chord/delta/index.js`), mapped to the `/vendor/...` URLs (§A11.9).
  - The module script `/build/client/main.js`, or whatever entry the client compiles to.
- **Manifest:** name and short name `picloud`, `display: standalone`, `start_url: /`, and icons at 192 and 512 px
  (`any maskable`).
- **Service worker:**
  - Precache the app shell under a version constant.
  - Strategy: network-first for navigation, falling back to the cached shell. Cache-first for shell assets. Never
    cache `/api/*`.
  - On `push`: show the notification with `tag = sessionId` and `data.url`.
  - On `notificationclick`: focus an open client and navigate it, or open a new window.
- **Icons:** a simple glyph (for example "π") on the accent colour, in SVG plus PNG at 180, 192 and 512 px.

## A15. Notifications
- **Events (only these):**

  | Event | Title | Body |
  |---|---|---|
  | Question | "Pi has a question" | the first question |
  | Plan | "Plan ready" | the plan title |
  | Report | "Report ready" | the summary's first line |
  | Run failed | "Run failed" | the reason |
  | Pi replied | "Pi replied" | first 100 chars of the last assistant text |
  | No report | "Pi stopped without a report" | |
  | Budget | "Budget reached" | |

  - HIG principle: *timely, relevant, actionable*. There are no "started" or "progress" notifications.
- **Payload and sending:** `{ title, body, url: "/#/s/<id>" }`, sent with TTL 86400 s to every subscription. Remove a
  subscription when the push service answers 404 or 410.
- **Suppression:** skip the send while that session has an open session stream (§A11.7).
- **Subscribing:** happens from a tap on **Enable notifications**: `Notification.requestPermission()`, then
  `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`, then `POST /api/push/subscribe`. On iOS
  this requires iOS 16.4+ and the app opened from the Home Screen.

## A16. Deployment automation (`deploy/install.sh`)

A single idempotent bash script that turns a fresh Ubuntu 24.04 machine into a running picloud, and that upgrades an
existing install in place when re-run. It is written in Part A and run only in Part B.

**Interface:**
- **Run as root** from the repository checkout: `sudo deploy/install.sh [--dry-run]`.
- **`--dry-run`:** print each step and the commands it would run, without changing anything.
- **Optional environment input:**
  - `TS_AUTHKEY`: a Tailscale auth key, for non-interactive `tailscale up`.
  - `GH_TOKEN_FILE`: a file containing a GitHub token; it is used for `gh auth login --with-token`, then deleted.
  - `PICLOUD_PUSH_SUBJECT`, `PICLOUD_ALLOWED_LOGINS`, `PICLOUD_SESSION_BUDGET_USD`: written into `/etc/picloud.env`.

**Steps** (each skipped when already done):
1. Install base packages: `git`, `curl`, `sqlite3`, `build-essential`.
2. Install Node.js ≥ 22.19 if missing or older.
3. Create the `picloud` system user (home `/home/picloud`, no sudo), `/var/lib/picloud` (mode 700) and
   `/opt/picloud`.
4. Install the `pi` CLI globally (`@earendil-works/pi-coding-agent@1.6.0`).
5. Install `gh` from GitHub's apt repository. If `GH_TOKEN_FILE` is given, log in as `picloud` with it. Run
   `gh auth setup-git` as `picloud`.
6. Install Tailscale. If the machine isn't logged in, run `tailscale up`, with `--authkey` if `TS_AUTHKEY` is set.
   Otherwise print the login URL Tailscale gives and continue.
7. Copy the checkout to `/opt/picloud` (excluding `node_modules`, `build` and `.git`), owned by `picloud`. As
   `picloud`, run `npm ci`, `npm run build`, then `npm prune --omit=dev`.
8. Write `/etc/picloud.env`, keeping existing values unless new ones were given. Install `deploy/picloud.service` and
   the backup service and timer. Run `systemctl daemon-reload`, enable the units, and restart picloud.
9. Run `tailscale serve --bg 8787`. **Never** run `tailscale funnel`.
10. Print status (`systemctl is-active picloud`, the `tailscale serve status` URL) and the list of remaining human
    steps (§B2) that are not yet done. Check each one: Pi default model present? gh authenticated? Tailscale logged
    in?

**Requirements:**
- Fail fast (`set -euo pipefail`) with a clear message naming the step that failed.
- Re-running after a partial failure must complete the remaining steps.

**Deploy files `deploy/` must contain:**
- **`picloud.service`:** `User=picloud`, `WorkingDirectory=/opt/picloud`, `EnvironmentFile=/etc/picloud.env`,
  `Environment=HOME=/home/picloud`, `ExecStart=/usr/bin/env node --disable-warning=ExperimentalWarning src/server/main.ts`
  (or your entry point), `Restart=always`, `KillSignal=SIGTERM`, `After=network-online.target tailscaled.service`.
- **`picloud-backup.service` + `picloud-backup.timer`:** daily
  `sqlite3 /var/lib/picloud/durable.sqlite ".backup /var/lib/picloud/backups/picloud-<date>.sqlite"`, keeping the
  newest 7.

---

# Part B: Deploy and operate

These steps are performed only when someone deliberately deploys. An agent may perform them when asked to deploy.
The steps in §B2 need a person.

## B1. Deploy with the installer
1. **Provision the droplet:** Ubuntu 24.04, 2 vCPU / 4 GB RAM minimum (more for heavy builds), 50 GB disk. No inbound
   ports are needed.
2. **Install toolchains** your repositories need to build and test (Python, Go and so on). The installer does not
   guess these.
3. **Run the installer** from a checkout of the picloud repository:
   ```bash
   git clone <your picloud repo> ~/picloud-src && cd ~/picloud-src
   sudo TS_AUTHKEY=<optional> GH_TOKEN_FILE=<optional> PICLOUD_PUSH_SUBJECT=mailto:you@example.com deploy/install.sh
   ```
   Re-run it after completing any §B2 step, and to upgrade (after `git pull`).
4. **Confirm:** the installer's final output shows picloud active, the `https://<droplet>.<tailnet>.ts.net` URL, and
   no remaining human steps.

## B2. Steps that need a human
The installer prints whichever of these are still outstanding.

| Step | How |
|---|---|
| Tailscale login | open the login URL the installer printed, or provide `TS_AUTHKEY` (create one in the Tailscale admin console) |
| Tailscale admin settings | in the admin console, enable **MagicDNS** and **HTTPS certificates** |
| Pi sign-in and default model | `sudo -iu picloud pi`, then `/login` (choose provider), then `/model` (choose default), then quit; re-run the installer or `systemctl restart picloud` |
| GitHub token | create a **fine-grained token** limited to the repositories picloud may use (Contents read/write, Pull requests read/write, Metadata read). Pass it with `GH_TOKEN_FILE`, or run `sudo -iu picloud gh auth login`. |
| Branch protection | enable it on each such repository's default branch |

## B3. Phone
1. Install the Tailscale app and join the same tailnet.
2. Open the URL in Safari. Share → **Add to Home Screen**, then open picloud from the Home Screen.
3. Open the drawer, tap **Enable notifications**, and allow them.

## B4. Operations
- **Logs:** `journalctl -u picloud`.
- **Backups:** the installer sets up `picloud-backup.timer`.
  - They run daily: `sqlite3 /var/lib/picloud/durable.sqlite ".backup /var/lib/picloud/backups/picloud-$(date +%F).sqlite"`.
  - They keep the newest 7 backups.
  - Also back up `/home/picloud/.pi/agent/`.
- **Disk:** workspaces of old delivered, archived sessions are pruned automatically (§A11.8). Check usage with
  `du -sh /var/lib/picloud/work`.

## B5. Upgrades of `@earendil-works/*`
1. Read every package's CHANGELOG between the old and new versions, looking for the shapes in §A6.
2. Bump all five pins together on a dev machine, then run `npm run check`, `npm test` and `npm run e2e`.
3. **Back up the database before deploying.** Stored data may migrate, and rollback is not guaranteed.
4. Deploy with `git pull`, then re-run `sudo deploy/install.sh`.

## B6. Troubleshooting
| Symptom | Fix |
|---|---|
| "No default model" at start | §B2 (Pi sign-in) as user picloud |
| Runs fail with auth errors | `sudo -iu picloud pi` → `/login`, then restart |
| Repo list empty or clone fails | `sudo -iu picloud gh auth status`; check which repos the token covers |
| Push 403 | token lacks Contents write, or a protection rule matches the branch |
| Phone can't connect | Tailscale on the phone; check `tailscale serve status` |
| No notifications | open from the Home Screen; grant permission; iOS ≥ 16.4; `PICLOUD_PUSH_SUBJECT` set |
| "Pi stopped without a report" | read its last message and reply in the composer |
| Database errors | free disk space, or restore the latest backup |

---

# Appendices

## C1. Security model
- **Who can reach it:** only tailnet devices (and listed logins, if configured). The server binds to loopback.
  Anyone who can reach picloud can make Pi run commands as the `picloud` user.
- **What the agent can reach:** everything the `picloud` user can, including model credentials in `~/.pi/agent` and
  the GitHub token in `~/.config/gh`. "Never push" is an instruction, not an enforced boundary.
- **Mitigations:**
  1. A fine-grained token limited to chosen repos.
  2. Branch protection on default branches.
  3. A dedicated user without sudo.
  4. Normal delivery only happens on a tap.
- **Prompt injection:** content Pi reads can steer it. The worst case is bounded by the mitigations above.
- **Deferred:** a credential-holding git proxy, and a separate user or container for the agent's shell.
- **Durable semantics:** a model request in flight during a crash is retried, and may be billed twice. A
  non-replay-safe tool cut off by a crash returns "interrupted" to the model.

## C2. Decision log
| # | Decision | Why |
|---|---|---|
| D1 | Fresh thin server rather than reusing existing Pi web apps | Existing apps are prototypes or very large. Durable already provides the hard parts. |
| D2 | Tailscale instead of app authentication | Removes the whole auth layer and provides HTTPS. |
| D3 | Pi's own provider configuration | No provider code; one sign-in path. |
| D4 | One Harness, one SQLite file, state in Durable documents | No second database; list and transcript change atomically. |
| D5 | Every wait is a park on a signal | Zero cost while waiting; survives restarts. |
| D6 | Plan approval required before implementing | The owner wants one tap of confidence before unattended work. |
| D7 | Delivery chosen by the person (push / PR / keep working) | Nothing reaches GitHub without a tap. |
| D8 | `onYield` nudge (max 3), turn limit, optional budget | Unattended runs reach a report; spend is bounded. |
| D9 | Workflow taught by prompt, not enforced | Interactive use must remain possible. |
| D10 | Drawer navigation | Switching sessions should be pull-and-tap; a badge offsets discoverability. |
| D11 | `ask_user` multiple-choice tool | Front-loads decisions with minimal typing. |
| D12 | Repo setup memory via `setupNotes` | Each session on a repo starts with what earlier sessions learned. |
| D13 | Continue-existing-branch mode | Iteration on an existing branch or PR is common. |
| D14 | Plan progress via `update_plan` | Glanceable progress; helps the model stay on track. |
| D15 | Rebase before report | Avoids conflicted PRs after long runs. |
| D16 | Fake mode (faux model + local bare repos) | The whole product is testable and evaluable without credentials. |
| D17 | TypeScript everywhere; `tsc` as the only build tool; import maps; Node type stripping on the server | Seamless use of Pi Durable's types end to end, and API shapes shared between server and client; no bundler to maintain. |
| D19 | No size target; judged on completeness, correctness and maintainability | Size can't be known in advance. Optimizing for it trades away behavior and clarity. |
| D21 | `@file` and `#skill` references with narrowing pickers; skills use Pi's own block format | Fast, precise context from a phone without typing paths; the same skill semantics as the Pi CLI. |
| D22 | Replace the built-in summary with a structured handoff via `beforeCompact`, keeping Durable's lifecycle | The built-in summary truncates tool output, paraphrases the person and re-summarizes itself. A code-built ledger plus a narrow model-written narrative is accurate and consistent across runs. |
| D20 | Part A installs its own build and test tools and writes an idempotent installer; deployment runs only when deliberately invoked | The implementer has full CLI access, so setup should be automated. But Part A may run on a machine already serving picloud (including picloud rebuilding itself), so it must never touch live services, port 8787, the data directory or the real Pi config. |
| D18 | Exact pins at 1.6.0; use the npm README | Durable is experimental; GitHub main differs (§A6). |

## C3. Verification record
These facts were verified on 2026-11-21 against the published 1.6.0 packages, on Node 22.23.5 with SQLite storage
and the faux model:
- A tool parked on a signal leaves the Harness inactive (`wake().active === false`), survives close and reopen as
  the same task, and completes when signalled.
- `submit_plan`-style approval transitions work, and `CodingTools`' `write` writes into the conversation `cwd`.
- An `onYield` `{ continue }` resumes a run that stopped early. Counting nudge entries caps it at exactly 3.
- Applying watch ops with `applyImmutable` reproduces the server's view exactly.
- `observeDoc` on a Harness-wide (`scope: "session"`) document delivers one `advance` per commit.
- `observeConversation` also advances on a commit that only changes `pi.usage`, and the view's `docs` contain
  `pi.agent`, `pi.live`, `pi.inbox`, `pi.provider` and `pi.usage`.
- `observeConversation` reports run start and end, with `runFailure.reason` `aborted` (abort while parked) and
  `model_error`.
- `entries` with `maxEntryId` is inclusive. Entry and conversation IDs are numbers.
- `pi.usage` reports `models["faux/faux-1"].cost.total`. The faux provider always reports 0, and a host commit to
  `UsageDoc` is accepted.
- A faux scenario deciding responses from `context.messages`, with a topped-up queue, drives three concurrent
  conversations correctly.
- `ModelRuntime.create()` is accepted as Harness `models` and succeeds without credentials. `SettingsManager` gives
  the default model. The `pi-context` loaders typecheck.
- With a faux model whose `contextWindow` is 8,000 and small compaction settings, a threshold compaction triggered
  mid-run. A `beforeCompact` hook's `{ summary }` was used: one hook call, and the built-in summarizer did not run.
  The `pi.compaction` entry wrapped that summary, and the run continued on its own to its final answer, with the
  summary in context.
- The browser toolchain works end to end: TSX components using `preact/jsx-runtime`, plus shared types imported with
  `import type`, compiled by `tsc` 5.9.3 (`moduleResolution` bundler, `rewriteRelativeImportExtensions`). The result
  loads in Chromium through an import map mapping `preact`, `preact/hooks`, `preact/jsx-runtime`, `marked`,
  `dompurify` and `@earendil-works/chord/delta`. It renders, applies Chord ops and sanitizes markdown with no console
  errors and no bundler.
