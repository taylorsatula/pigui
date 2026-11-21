# picloud implementation runbook

| | |
|---|---|
| Document | Formal implementation runbook for picloud v1 |
| Status | Approved design, ready for implementation |
| Date | 2026-11-21 |
| Target platform versions | `@earendil-works/*` **1.6.0** (npm), Node.js ≥ 22.19 (verified on 22.23.5), Ubuntu 24.04 |
| Verified by | Spike in `reference/spike/`, run against the published 1.6.0 packages (see §20) |

This runbook is self-contained. An implementer with no access to the conversation that produced it can build, test,
deploy and operate picloud from this document plus the files under `reference/`. The supporting research in
`notes/` explains *why*; this document says *what* and *how*.

---

## Table of contents
1. Product definition
2. Scope rules and non-goals
3. Glossary
4. Architecture
5. Pinned dependencies and external programs
6. Pi Durable 1.6.0: the API surface picloud uses
7. Repository layout and line budget
8. Data model
9. Session lifecycle
10. The agent extension (system prompt, tools, hook)
11. Server specification
12. HTTP API reference
13. PWA specification (UX, HIG rationale, rendering rules)
14. Notifications
15. Implementation phases with acceptance criteria
16. Testing strategy
17. Deployment runbook (droplet)
18. Operations runbook
19. Security model and known limitations
20. Verification record
21. Decision log
22. References

---

## 1. Product definition

picloud is a thin, self-hosted remote harness for the **Pi** coding agent. You run it on your own server, called the
droplet. You use it from your phone as an installed web app (PWA).

**The core use case is zero-shot work.** From the phone you pick one of your GitHub repositories and describe a
task. Pi then explores the code and asks a few multiple-choice questions that you answer by tapping. It proposes a
plan, which you approve. You put the phone away, and Pi implements, tests and commits on its own branch. When it's
done you get a notification and a final report, from which you choose to **push the branch**, **open a pull
request**, or **keep working** by typing feedback.

**Interactive use is not barred.** Asking a question gets an answer. A small direct request ("fix the typo in the
README") is simply done. The plan-first workflow is a strong default taught by the system prompt, not a lock.

**Success criteria for v1:**
1. A task started from the phone runs to a final report with no interaction beyond the up-front questions and the
   plan approval, in the common case.
2. Every wait for the person costs no running process and survives a server restart or reboot. Waits include
   questions, plan approval, and the phone being in a pocket.
3. The PWA is a simple chat interface: an input pill, an attachment button and a send button. Tool calls and
   thinking are collapsed by default. Sessions are a tap away in a drawer.
4. Nothing reaches GitHub until the person taps Push or Open PR.

## 2. Scope rules and non-goals

**Rule 1: use what already exists.** If an established dependency already does something, picloud does not
rebuild it:

| Concern | Owned by | picloud's share |
|---|---|---|
| Authentication, TLS, device trust, remote reachability | **Tailscale** (`tailscale serve`) | none (optional login allowlist, §11.9) |
| Model providers, sign-in, OAuth refresh, default model | **Pi** (`pi` CLI → `/login`, `/model`; `~/.pi/agent/`) | load `ModelRuntime` and `SettingsManager` |
| Agent loop, coding tools, retries, compaction, crash recovery, persistence | **Pi Durable** | configuration only |
| Project instructions (`AGENTS.md`/`CLAUDE.md`), skills | **Pi** (`loadProjectContextFiles`, `loadSkills`) | two prompt sections |
| Live state sync to the browser | **Durable watches** plus **Chord `delta`** in the browser | an SSE relay |
| Repo listing, clone, push, pull requests, git credentials | **`gh`** and **`git`** | shell-outs |
| Push notifications | **Web Push** standard plus the **`web-push`** package | send on a few events |
| Markdown rendering and sanitizing | **marked** plus **DOMPurify** | none |
| Process supervision, restart on crash | **systemd** | one unit file |

**Rule 2: say no.** Each feature must serve this loop: *pick repo → plan with questions → approve → run unattended →
report → deliver*. Explicit non-goals for v1:
- multi-user or tenancy;
- a settings UI;
- model pickers;
- containers per session;
- a built-in browser;
- an extension marketplace;
- multiplayer or presence;
- self-editing;
- design tools;
- document formats (PPTX and so on);
- scheduled tasks;
- voice;
- an IDE-style file browser.

**Rule 3: line budget.** About 1,200 lines of server TypeScript and about 1,400 lines of PWA code (including CSS,
excluding vendored libraries). Tests are not counted. Going over the budget means stopping to ask what is being
built that was said no to.

## 3. Glossary

| Term | Meaning |
|---|---|
| **Pi** | The coding agent toolkit from `earendil-works/pi`. The `pi` CLI is its terminal coding agent. |
| **Pi Durable** | `@earendil-works/pi-durable`, an embeddable library that runs agents durably. Every model turn and tool call is committed to storage before it is shown, and restarts resume work. It is a library, not a server. |
| **Harness** | Durable's main object: one open storage plus the machinery that runs agents on it. picloud opens exactly one. |
| **Conversation** | A durable transcript plus agent configuration. One picloud **session** is one conversation. |
| **Entry** | An immutable transcript record. Kinds picloud renders: `pi.user`, `pi.assistant`, `pi.tool-result`. Kinds it ignores or marks subtly: `pi.system`, `pi.reset`, compaction summaries. |
| **Document (doc)** | Typed JSON state stored next to transcripts and changed atomically in commits. Built-in docs: `pi.live` (running generation and tool slots), `pi.agent`, `pi.inbox`, `pi.usage`. picloud defines `picloud.sessions` and `picloud.push`. |
| **Tool park** | A tool's `execute()` returns `{ sleep: { signals } }` instead of a result. The call then holds **no process**, survives restarts, and reruns once a matching signal arrives. |
| **Signal** | A typed value delivered to a parked task with `harness.signal(taskId, token, key, value)`. picloud uses signal `picloud.reply`, key `"reply"`. |
| **Watch** | `conversation.watch()`: the conversation's view (an entry window plus docs) at attach time, then each commit as **Chord ops**. |
| **Chord ops** | JSON patch-like operations (`[["r", value]]` is a whole replacement). The browser applies them with `applyImmutable` from `@earendil-works/chord/delta`. |
| **Steer / follow-up** | Input sent to a busy conversation. A *steer* joins the running work after the current tool round. A *follow-up* waits for the run to finish. |
| **Run / turn** | A turn is one model response plus its tool calls. A run is the turns from an input to its final answer. |
| **Droplet** | The Linux server picloud runs on. Any VPS works. |
| **Tailnet** | The private Tailscale network your phone and droplet join. |

## 4. Architecture

```
 iPhone / Android (PWA, installed to the home screen, on the tailnet via the Tailscale app)
        │  HTTPS  https://<droplet>.<tailnet>.ts.net
        ▼
 tailscale serve  (TLS termination, tailnet-only, adds Tailscale-User-Login header)
        │  HTTP  127.0.0.1:8787
        ▼
 picloud server  (one Node.js process, user "picloud", systemd)
   ├─ http.ts       JSON API + 2 SSE streams + static PWA + /vendor mapping
   ├─ sessions.ts   create / message / answer / stop / deliver / diff / archive; git + gh shell-outs
   ├─ monitor.ts    observes active conversations: run ended → idle / failed
   ├─ push.ts       VAPID keys, subscriptions (Durable doc), web-push sends
   ├─ extension.ts  Pi extension: system prompt sections + ask_user + submit_plan + final_report + onYield nudge
   └─ harness.ts    ONE Harness over ONE SQLite file
          ├─ models   = Pi's ModelRuntime (reads ~/.pi/agent/auth.json, models.json, OAuth refresh)
          ├─ registry = CodingTools (read/write/edit/bash) + PiContext + Picloud
          ├─ env      = NodeExecutionEnv({ cwd: <session workspace> }), cached per workspace
          └─ storage  = /var/lib/picloud/durable.sqlite
 Workspaces: /var/lib/picloud/work/<workspaceId>/   (git clone of the repo, own branch)
```

**Key properties:**
- **One process, one Harness, one SQLite file.** Durable does not support two writable processes on one storage. A
  second writer would rerun the first one's tasks. Never run two picloud instances against the same data directory.
- **Session list is a Durable document.** It is updated in the same commits as the agent's work, so the list and the
  transcripts cannot disagree, and there is no second database.
- **The agent never pushes.** The server performs push and PR creation on the person's tap, using `gh`/`git`
  credentials (§19 covers the limits of this).
- **Every wait for the person is a tool park on a signal.** Asking, plan approval and crash recovery cost nothing
  while waiting and survive restarts. This was verified in the spike (§20).

## 5. Pinned dependencies and external programs

Pin **exact** versions. Pi Durable is experimental and its API changes between releases (§6.1). Upgrades are a
deliberate procedure (§18.4).

### 5.1 npm runtime dependencies
| Package | Version | Used for |
|---|---|---|
| `@earendil-works/pi-durable` | 1.6.0 | Harness, docs, signals, tools, hooks, NodeExecutionEnv, SQLite storage |
| `@earendil-works/pi-ai` | 1.6.0 | message and content types (transitively required) |
| `@earendil-works/pi-coding-agent` | 1.6.0 | `ModelRuntime`, `SettingsManager`, `getAgentDir`, `loadProjectContextFiles`, `loadSkills`, `formatSkillsForPrompt` |
| `@earendil-works/chord` | 1.6.0 | `BACKGROUND_CONTEXT` (server) and `delta.applyImmutable` (browser) |
| `@earendil-works/pi-schema` | 1.6.0 | tool parameter and signal schemas (`obj`, `str`, `arr`, `opt`, `bool`) |
| `web-push` | 4.0.0 | Web Push (VAPID) sending. It ships no types; see §7. |
| `preact` | 11.2.0 | PWA rendering (served from `node_modules` via import map) |
| `htm` | 3.1.1 | JSX-free templates for Preact |
| `marked` | 18.2.1 | Markdown rendering |
| `dompurify` | 3.4.18 | HTML sanitizing |

### 5.2 npm dev dependencies
| Package | Version |
|---|---|
| `typescript` | 5.9.3 (typecheck only, `noEmit`) |
| `@types/node` | 22.20.5 |

No bundler, no transpiler and no framework are used. Node runs `.ts` files directly through built-in type
stripping, so use only erasable TypeScript syntax: no `enum`, no `namespace`, no parameter properties. Import local
files with the `.ts` extension.

### 5.3 External programs on the droplet
| Program | Purpose | Notes |
|---|---|---|
| Node.js ≥ 22.19 | runtime | 22.23.5 verified; Node 24 LTS also acceptable |
| `pi` CLI (`npm i -g @earendil-works/pi-coding-agent@1.6.0`) | one-time `/login` and `/model` as user `picloud` | picloud reads the files it writes |
| `gh` (GitHub CLI) | repo list, clone, PR creation; git credential helper | `gh auth login` as user `picloud` |
| `git` ≥ 2.40 | all repo operations | |
| Tailscale | network, TLS, identity | `tailscale serve` |
| systemd | supervision | |
| Language toolchains your repos need (for example Python or Go) | so Pi can run tests | install per repo needs |

## 6. Pi Durable 1.6.0: the API surface picloud uses

### 6.1 Critical warning: npm 1.6.0 vs the GitHub main branch
The `earendil-works/pi` main branch already contains **unreleased breaking changes**. Its README and examples use
different shapes than the published 1.6.0. **Always read the README inside
`node_modules/@earendil-works/pi-durable/README.md`, never GitHub main.** The differences that matter:

| Concept | npm **1.6.0** (use this) | GitHub main (do NOT use) |
|---|---|---|
| Tool park | `return { sleep: { signals: [Tok.key("k")], until?, checkpoint? } }` | `{ kind: "sleep", signals, ... }` |
| Read a signal | `state` is `{ value }`, `{ expired: true }` or `undefined`; test with `"value" in state` | `state.kind === "value"` |
| `onYield` continue | `return { continue: "text" }` | `{ kind: "continue", continue: "text" }` |
| Admit in your own commit | `conversation.submit(tx, draft)` | `conversation.admit(tx, draft)` |

### 6.2 Imports (all verified to resolve and typecheck)
```ts
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { applyImmutable } from "@earendil-works/chord/delta";            // also works in the browser
import { arr, bool, obj, opt, str } from "@earendil-works/pi-schema";
import { type Conversation, createRegistry, defineDoc, defineExtension, defineSignal, defineTool,
         GenerationTask, Harness, hook, LiveDoc, section } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";          // read, write, edit, bash
import { formatSkillsForPrompt, getAgentDir, loadProjectContextFiles, loadSkills,
         ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
// Tests only:
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
```

### 6.3 Calls and their exact signatures (1.6.0)
- **Models:** `const models = await ModelRuntime.create()` builds Pi's own configured `Models`. It reads
  `~/.pi/agent/auth.json` and `models.json`, refreshes OAuth, and implements Durable's `Models`. On shutdown call
  `await models.settleCredentialWrites()`.
- **Default model:** `const s = SettingsManager.create(cwd, getAgentDir())`, then `s.getDefaultProvider()`,
  `s.getDefaultModel()` and `s.getDefaultThinkingLevel()`.
- **Open:** `Harness.open(storage, { models, registry, env }, ctx)`. Here `env` is
  `({ cwd }) => ExecutionEnv` and is called at every tool call and prompt build.
- **Conversations:**
  - Create: `harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider, modelId }, cwd, maxTurns, thinkingLevel? } }, ctx)`.
  - Look up: `harness.conversation(id, ctx)` returns `Conversation | undefined`.
- **Conversation methods:**
  - `submit({ type: "input", content, requestId?, whenBusy?: "steer" | "followUp" | "reject" }, ctx)` returns a
    `Submission` with `.wait(ctx)`.
  - `submit({ type: "continue" }, ctx)` resumes after a failed run.
  - `abort(ctx)`, `entries(query, limit, cursor, ctx)`, `watch(ctx, window?)`, `configure(change, ctx)`.
- **Content with images:** `content` is either a string or
  `[{ type: "text", text }, { type: "image", data: <base64>, mimeType }]`.
- **Signals:**
  - Define: `defineSignal({ name, version, schema })`.
  - Deliver: `harness.signal(taskId, Token, key, value, ctx)`. It returns `"delivered"` and is idempotent on retry.
  - Read inside a tool or hook: `api.readSignal(Token, key, ctx)`.
- **Documents:**
  - Define: `defineDoc<T>({ kind, version, scope: "session", initial, checkpointWhen: () => false })`.
    `checkpointWhen` is required.
  - Write in a commit: `(await tx.doc(Token)).field = ...`. `tx.doc` creates the document on first use.
  - Read: `harness.snapshot(Token, ctx)`, or inside tools and hooks `api.snapshot(Token, ctx)`.
  - Observe: `harness.observeDoc(Token, { advance(call, ctx) {}, end(end) {} }, ctx)`.
- **Live state:** `harness.snapshot(LiveDoc, conversationId, ctx)` returns `LiveState`:
  - `run?`: `{ taskId, inputs, turns, first? }`, present while busy;
  - `generation?`: `{ attempt, message? (streamed partial), retry?: { at, error } }`;
  - `tools?`: `ToolSlot[]`, each `{ callId, name, status: "pending" | "running" | "sleeping" | "waiting" | "done", output?, details?, taskId?, entry? }`;
  - `runFailure?`, which says why the last run ended without an answer.
- **Tool API** (`execute(args, api, ctx)`):
  - Identity: `api.taskId`, `api.callId`, `api.conversationId`.
  - Documents and state: `api.commit(tx => ..., ctx)`, `api.readSignal(...)`, `api.snapshot(...)`.
  - Memos: `api.memo(name, candidate, ctx)` is first-writer-wins and returns the stored value;
    `api.memo(name, ctx)` reads one.
  - Environment: `api.env` (`ExecutionEnv`) and `api.now()`.
- **Exec through env:** `await env.exec(["git", "status", "--porcelain"], { onOutput: (text, _c, { stream }) => ... }, ctx)`
  returns `{ ok: true, value: { exitCode } } | { ok: false, error }`.
- **Hooks:** `hook(GenerationTask, { onYield(answer, api, ctx) })`, where `api` has `snapshot`, `entries`, `memo`
  and `conversationId`. Return `{ continue: "text" }` to keep the run going, or `undefined`.
- **Prompt sections:** `section(name, (input) => string | undefined, { tag?: boolean })`. `input.env?.cwd` is the
  session workspace. Sections render as `<name>…</name>` unless `tag: false`.
- **Extension:** `defineExtension({ name, tools?, sections?, hooks? })`. By default every installed extension is
  selected by every conversation, in install order.

## 7. Repository layout and line budget

```
picloud/
  RUNBOOK.md                 this document
  package.json               "type": "module", exact pins, scripts (below)
  tsconfig.json              strict, noEmit, allowImportingTsExtensions, module/moduleResolution nodenext
  src/
    main.ts          ~120    startup, shutdown
    config.ts         ~40    env vars → Config
    harness.ts       ~120    open Harness, registry, docs, signal token, env cache
    extension.ts     ~280    PiContext + Picloud extensions (prompt, 3 tools, onYield)
    sessions.ts      ~300    session operations, git/gh shell-outs, message routing
    monitor.ts        ~70    run-end detection → idle/failed + notifications
    push.ts           ~70    VAPID keys, subscriptions, send
    http.ts          ~250    router, JSON/SSE helpers, static + vendor files, login allowlist
    web-push.d.ts     ~10    minimal type declaration for web-push 4.0.0
  public/
    index.html        ~40    import map, manifest, root element
    manifest.webmanifest
    sw.js             ~70    app-shell cache, push display, notification click
    app.js           ~260    state, routing, SSE clients, drawer, screens
    transcript.js    ~300    entry + live rendering, tool groups, thinking
    cards.js         ~220    QuestionCard, PlanCard, ReportCard
    composer.js      ~170    pill, attachments (resize), send/stop
    style.css        ~350    tokens, light/dark, layout
    icons/           icon.svg, icon-180.png, icon-192.png, icon-512.png
  test/
    lifecycle.test.ts        faux-model lifecycle incl. restart (port of reference/spike/spike.ts)
    routing.test.ts          composer text routed to pending cards / steer / follow-up
    git.test.ts              clone from a local bare repo, branch, commit check, push
  deploy/
    picloud.service          systemd unit (§17.7)
  reference/spike/           validated spike (keep; do not ship)
  notes/                     research and design background
```

**package.json scripts:**
```json
{
  "start": "node src/main.ts",
  "test": "node --test test/*.test.ts",
  "check": "tsc -p ."
}
```

**`src/web-push.d.ts`** (web-push 4.0.0 has no bundled types):
```ts
declare module "web-push" {
  export interface PushSubscription { endpoint: string; keys: { p256dh: string; auth: string } }
  export function generateVAPIDKeys(): { publicKey: string; privateKey: string };
  export function setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  export function sendNotification(sub: PushSubscription, payload: string, options?: { TTL?: number }): Promise<{ statusCode: number }>;
  const _default: { generateVAPIDKeys: typeof generateVAPIDKeys; setVapidDetails: typeof setVapidDetails; sendNotification: typeof sendNotification };
  export default _default;
}
```

## 8. Data model

All state lives in **one SQLite file** managed by Durable. picloud defines two session-scoped documents and one
signal.

### 8.1 `picloud.sessions` (session-scoped singleton)
```ts
type SessionState =
  | "preparing"     // server is cloning/branching; no agent yet
  | "planning"      // agent exploring / planning
  | "question"      // ask_user parked, waiting for the person
  | "approval"      // submit_plan parked, waiting for the person
  | "implementing"  // plan approved; onYield nudge active
  | "working"       // interactive follow-up run (no nudge)
  | "idle"          // run ended with an ordinary answer; the person's turn
  | "reported"      // final_report filed; awaiting delivery choice
  | "delivered"     // pushed and/or PR opened
  | "stopped"       // person pressed Stop
  | "failed";       // setup or run failed (see error)

type Report = { summary: string; changes: string[]; verification: string; notes: string[]; commits: string[] };

type SessionItem = {
  id: string;            // conversation id
  requestId: string;     // client idempotency key of the creating request
  repo: string;          // "owner/name"
  baseBranch: string;    // e.g. "main"
  baseSha: string;       // commit the branch started from
  branch: string;        // "picloud/<slug>-<4 hex>"
  workspace: string;     // absolute path
  title: string;         // first line of task, ≤ 60 chars; replaced by submit_plan's title
  state: SessionState;
  createdAt: number; updatedAt: number;  // ms epoch
  archived?: true;
  error?: string;        // for failed
  report?: Report;
  pushedAt?: number;
  prUrl?: string;
};
const Sessions = defineDoc<{ items: Record<string, SessionItem> }>({
  kind: "picloud.sessions", version: 1, scope: "session",
  initial: () => ({ items: {} }), checkpointWhen: () => false,
});
```
**JSON rule:** never store `undefined`. Omit the key instead, because documents must be JSON. Every state change also
sets `updatedAt`.

**Grouping in the UI:**
- **Needs you:** `question`, `approval`, `reported`, `idle`, `failed`.
- **Working:** `preparing`, `planning`, `implementing`, `working`.
- **Done:** `delivered`, `stopped`.

Within each group, sort by `updatedAt` descending. Archived items are hidden unless "Show archived" is on.

### 8.2 `picloud.push` (session-scoped singleton)
```ts
const Push = defineDoc<{ vapid?: { publicKey: string; privateKey: string }; subscriptions: PushSubscriptionJSON[] }>({
  kind: "picloud.push", version: 1, scope: "session",
  initial: () => ({ subscriptions: [] }), checkpointWhen: () => false,
});
```

### 8.3 Signal
```ts
const Reply = defineSignal({ name: "picloud.reply", version: 1, schema: obj({ approved: opt(bool()), text: str() }) });
// Always key "reply". Each tool call is its own task, so (taskId, "reply") is unique per card.
```

### 8.4 Files on disk
```
/var/lib/picloud/                 PICLOUD_DATA (owned by picloud, mode 700)
  durable.sqlite (+ -wal, -shm)   all state
  work/<workspaceId>/             one git clone per session
    .picloud/uploads/             non-image attachments (excluded from git via .git/info/exclude)
/home/picloud/.pi/agent/          Pi's auth.json, settings.json, models.json, skills (written by `pi`)
/home/picloud/.config/gh/         gh credentials
```

## 9. Session lifecycle

```
                      POST /api/sessions
                              │
                         [preparing] ──(clone/branch fails)──▶ [failed]
                              │ submit task
                              ▼
          ┌──────────────▶ [planning] ◀──────────── revise (feedback) ──────┐
          │                  │   │                                          │
          │      ask_user ◀──┘   └──▶ submit_plan                           │
          │         │                    │                                  │
          │    [question]            [approval] ── approve ──▶ [implementing]
          │         │ answer                                       │     │
          └─────────┘ (back to previous state)        ask_user ◀───┘     │ final_report
                                                       (blocker)         ▼
                                                                    [reported]
   run ends with plain answer (planning/working) ──▶ [idle]          │      │
   message while idle/reported/delivered/stopped/failed ──▶ [working] │      └─ push / PR ─▶ [delivered]
   Stop ──▶ [stopped]      run error (monitor) ──▶ [failed]          └─ type feedback ─▶ [working]
```

**Transition owners:**
- **Server:**
  - `preparing`;
  - `failed` on setup errors;
  - `working` when a message is sent while the session is idle or finished;
  - `stopped`;
  - `delivered`.
- **Tools:**
  - `ask_user`: `question`, then restores the previous state;
  - `submit_plan`: `approval`, then `implementing` or `planning`;
  - `final_report`: `reported`.
- **Monitor (§11.6):** `idle` and `failed` when a run ends.
- **Nudge:** only while `implementing`.

**Plan approval semantics:** a plan revision ("revise") returns the person's feedback to the agent as the
`submit_plan` result. The agent revises and calls `submit_plan` again.

## 10. The agent extension

Two extensions, installed in this order after `CodingTools`: **`pi-context`** and **`picloud`**. Keep the prompt
text compact. It is sent with every request.

### 10.1 `pi-context` extension (reuses Pi's own loaders)
```ts
export const PiContext = defineExtension({
  name: "pi-context",
  sections: [
    section("preamble", () =>
      "You are Pi, a coding agent. You inspect files, run commands, and modify code to complete the person's task.",
      { tag: false }),
    section("project_context", (input) => {
      const cwd = input.env?.cwd; if (cwd === undefined) return undefined;
      const files = loadProjectContextFiles({ cwd, agentDir: getAgentDir() });
      return files.length === 0 ? undefined : files.map((f) => `## ${f.path}\n\n${f.content}`).join("\n\n");
    }),
    section("skills", (input) => {
      const cwd = input.env?.cwd; if (cwd === undefined) return undefined;
      const { skills } = loadSkills({ cwd, agentDir: getAgentDir(), skillPaths: [], includeDefaults: true });
      return skills.length === 0 ? undefined : formatSkillsForPrompt(skills, "read");
    }),
    section("cwd", (input) => input.env?.cwd),
  ],
});
```

### 10.2 `picloud` extension: the system prompt section (use verbatim)
Section name `picloud`, rendered with tags. `{repo}`, `{branch}` and `{baseBranch}` come from the session item,
which the section reads with `input.read.snapshot(Sessions, ctx)` keyed by `input.conversationId`.

```
You are running on a remote server. The person is on their phone and is usually not watching.
Repository: {repo}. You are on branch {branch}, created from {baseBranch}.

How to work:
- A question, or a small direct request: just answer or do it.
- Anything larger: explore the code first. If a decision is genuinely the person's to make (scope, behavior,
  trade-offs) and you cannot infer it, ask with ask_user, putting all questions in one call with your
  recommended option first. Then call submit_plan and wait for approval.
- After the plan is approved, work to completion without stopping to ask permission. Make reasonable decisions
  and record them in the report. Use ask_user only for a true blocker you cannot work around.
- Verify your work (run the tests, build, or check behavior) before reporting.
- Commit your work on the current branch with clear messages. Never push, never switch branches, never rewrite
  commits from before you started.
- Finish with final_report. The person reads the report first; make it accurate, including what you could
  not do or verify.
```

### 10.3 Tool: `ask_user` (the multiple-choice tool)
- **Purpose:** ask the person 1 to 4 multiple-choice questions on one card and wait, possibly for hours.
- **Parameters** (pi-schema):
  ```ts
  const Option = obj({ label: str({ minLength: 1, maxLength: 60 }), description: opt(str({ maxLength: 160 })) });
  const Question = obj({
    header: str({ minLength: 1, maxLength: 12 }),          // short tag, e.g. "Scope"
    question: str({ minLength: 1, maxLength: 300 }),       // ends with "?"
    options: arr(Option, { minItems: 2, maxItems: 4 }),    // recommended first, label ends "(Recommended)"
    multiSelect: opt(bool()),
  });
  parameters: obj({ questions: arr(Question, { minItems: 1, maxItems: 4 }) })
  ```
- **Description (verbatim):** "Ask the person up to 4 multiple-choice questions on one card. They tap an option or
  type their own answer. Waits until they answer; returns one line per question as `header: answer`. Use only when
  the decision is theirs and changes the work. Never ask the same thing twice."
- **`replay: "safe"`**
- **Behavior:**
  ```ts
  async execute(args, api, c) {
    const s = await api.readSignal(Reply, "reply", c);
    if (s !== undefined && "value" in s) {
      const prev = await api.memo<SessionState>("picloud.prev", c);
      await setState(api, prev ?? "planning", c);
      return { output: [{ type: "text", text: s.value.text }] };
    }
    // Fresh call (or rerun before the park was stored):
    const current = (await api.snapshot(Sessions, c))?.items[api.conversationId]?.state ?? "planning";
    await api.memo("picloud.prev", current === "question" ? "planning" : current, c);
    const token = crypto.randomUUID();
    if ((await api.memo("picloud.notified", token, c)) === token) notify(api.conversationId, "Pi has a question", firstQuestion(args));
    await setState(api, "question", c);
    return { sleep: { signals: [Reply.key("reply")] } };
  }
  ```
  `setState` is `api.commit(async tx => { const d = await tx.doc(Sessions); const it = d.items[id]; it.state = s; it.updatedAt = api.now(); }, c)`.
  `notify` is fire-and-forget (§14). The memo guarantees one notification even if the call reruns.
- **Answer text format** (composed by the server, §12.7): one line per question, `"{header}: {answer}"`. Multi-select
  answers are joined with `"; "`. A free-text answer is `Other: "{text}"`. A free-text reply typed in the composer
  instead of the card is `The person replied in their own words: "{text}"`.

### 10.4 Tool: `submit_plan`
- **Parameters:**
  ```ts
  obj({ title: str({ minLength: 1, maxLength: 60 }), summary: str({ maxLength: 600 }),
        steps: arr(str({ maxLength: 300 }), { minItems: 1, maxItems: 15 }),
        assumptions: opt(arr(str({ maxLength: 300 }), { maxItems: 10 })) })
  ```
- **Description:** "Submit your implementation plan for the person to approve. Waits for approval. If they ask for
  changes, revise and call submit_plan again. `title` names the session."
- **`replay: "safe"`**
- **Behavior:**
  - **Fresh call:** set the session `title` to `args.title`, set state `approval`, notify "Plan ready" (one
    notification, guarded by a memo), then park as in `ask_user`.
  - **On a signal with `approved: true`:** set state `implementing` and return "Approved. Implement the plan now,
    without stopping to ask permission. Finish with final_report."
  - **On a signal with `approved` false or absent:** set state `planning` and return "The person asked for changes:
    {text}. Revise the plan and call submit_plan again."

### 10.5 Tool: `final_report`
- **Parameters:**
  ```ts
  obj({ summary: str({ minLength: 1, maxLength: 2000 }),
        changes: arr(str({ maxLength: 300 }), { maxItems: 30 }),
        verification: str({ maxLength: 1000 }),       // what was run/checked, and results
        notes: opt(arr(str({ maxLength: 300 }), { maxItems: 15 })) }) // decisions made, things not done, follow-ups
  ```
- **Description:** "File the final report when the task is complete (or cannot be completed). Commit your work
  first. The person reads this first."
- **Default replay** (unsafe is fine: it is quick and idempotent in effect).
- **Behavior:**
  1. Run `git status --porcelain` via `api.env.exec`. If the output is not empty, return an error result: "There are
     uncommitted changes. Commit them (or revert what should not be kept), then call final_report again."
  2. Run `git log --format=%h %s {baseSha}..HEAD` and collect the lines as `commits`.
  3. In one commit, set `report = { ...args, notes: args.notes ?? [], commits }`, state `reported`, and `updatedAt`.
  4. Notify "Report ready" with the summary's first line.
  5. Return "Report filed. End your turn with one short sentence; do not repeat the report."

### 10.6 Hook: the `onYield` nudge (keeps unattended runs going)
```ts
const NUDGE = "You have not called final_report yet. Continue the approved plan to completion, then call final_report.";
hook(GenerationTask, {
  onYield: async (_answer, api, c) => {
    const item = (await api.snapshot(Sessions, c))?.items[api.conversationId];
    if (item?.state !== "implementing") return undefined;
    const page = await api.entries({ order: "descending" }, 100, undefined, c);
    let nudges = 0;
    for (const e of page.items) {
      const m: any = e.model?.[0];
      if (e.kind === "pi.tool-result" && m?.toolName === "submit_plan") break;   // approval boundary
      if (e.kind === "pi.user") { if (m?.content === NUDGE) nudges++; else break; } // real person message
    }
    return nudges >= 3 ? undefined : { continue: NUDGE };
  },
}),
```
**Also set `maxTurns: 200`** on every session conversation as a backstop.

## 11. Server specification

### 11.1 Configuration (environment variables)
| Var | Default | Meaning |
|---|---|---|
| `PICLOUD_DATA` | `/var/lib/picloud` | data dir (§8.4) |
| `PICLOUD_HOST` | `127.0.0.1` | bind address. Keep it loopback: Tailscale serve is the only ingress. |
| `PICLOUD_PORT` | `8787` | |
| `PICLOUD_PUSH_SUBJECT` | required for push | VAPID subject, `mailto:you@example.com` or `https://<droplet>.<tailnet>.ts.net` |
| `PICLOUD_ALLOWED_LOGINS` | empty (allow all on tailnet) | comma-separated Tailscale logins allowed (§11.9) |
| `PICLOUD_MAX_TURNS` | `200` | per-run backstop |

### 11.2 Startup sequence (`main.ts`)
1. Read config. Create `PICLOUD_DATA` and `work/` (mode 700).
2. `models = await ModelRuntime.create()`. `settings = SettingsManager.create(PICLOUD_DATA, getAgentDir())`. If
   `getDefaultProvider()` or `getDefaultModel()` is missing, **exit 1** with: "No default model. As user picloud
   run `pi`, then /login and /model."
3. `registry = createRegistry()`, then install `CodingTools`, then `PiContext`, then `Picloud`, in that order.
4. `storage = await openNodeSqliteStorage(join(DATA, "durable.sqlite"))`.
5. `harness = await Harness.open(storage, { models, registry, env: envFor, onReport: (r) => console.error("[durable]", r) }, ctx)`.
6. Ensure both docs exist: `harness.commit(async tx => { await tx.doc(Sessions); await tx.doc(Push); }, ctx)`.
7. Generate VAPID keys into `Push.vapid` if absent, then call `webpush.setVapidDetails(...)`.
8. Mark every item still in `preparing` as `failed`, with error "Server restarted during setup. Start a new
   session."
9. Start the monitor (§11.6) for every non-archived item whose state is in {planning, implementing, working}.
10. `harness.resume()`. This continues anything a crash or stop interrupted.
11. Start the HTTP server on `PICLOUD_HOST:PICLOUD_PORT`.
12. On `SIGTERM`/`SIGINT`, in order: stop accepting requests, end SSE streams, `await harness.close(ctx)`,
    `await models.settleCredentialWrites()`, then `process.exit(0)`.

`envFor({ cwd })` returns a cached `new NodeExecutionEnv({ cwd })` per cwd from a `Map<string, NodeExecutionEnv>`.
If `cwd` is undefined it throws, which becomes the call's error result.

### 11.3 Git and gh shell-outs
All server-side git work uses `execFile` (no shell) with `{ cwd: workspace, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }`
and a timeout of 120 s for network operations or 30 s otherwise. The agent's own git use goes through its bash tool.

| Operation | Command(s) |
|---|---|
| List repos | `gh api --paginate "user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member" --jq '.[] \| {full_name, private, pushed_at, description}'` (cache 60 s) |
| Clone | `gh repo clone {repo} {workspace} -- --filter=blob:none` |
| Base branch / sha | `git symbolic-ref --short refs/remotes/origin/HEAD` (strip `origin/`), then `git rev-parse HEAD` |
| Identity | `gh api user --jq '.login + " " + (.id\|tostring) + " " + (.name // .login)'`, cached for the process lifetime. Then `git config user.name "{name}"` and `git config user.email "{id}+{login}@users.noreply.github.com"` |
| Branch | `git switch -c picloud/{slug}-{4 hex}`, where `slug` is the first 5 words of the title, lowercase, `[a-z0-9-]`, ≤ 40 chars |
| Exclude uploads | append `.picloud/` to `.git/info/exclude` |
| Push | `git push -u origin {branch}` |
| PR | after a push: `gh pr create --base {baseBranch} --head {branch} --title "{title}" --body-file {tmp.md}`. The URL is the last line of stdout. |
| Diff | `git diff {baseSha}` (working tree included), capped at 2 MB. Prefix it with `git diff --stat {baseSha}`. |

`gh auth setup-git` (run once at deploy time, §17.5) makes `git push` use gh's credentials.

### 11.4 Session operations (`sessions.ts`)
- **create(repo, text, attachments, requestId):**
  1. If an item already has this `requestId`, return its id.
  2. Generate `workspaceId = randomUUID()`.
  3. `conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model, cwd: workspace, maxTurns, ...(thinking ? { thinkingLevel: thinking } : {}) } }, ctx)`.
  4. Commit the item with state `preparing` and a title from the task's first line.
  5. **Respond to the client now.**
  6. Asynchronously: clone, then base, identity, branch and exclude. Then
     `conv.submit({ type: "input", content: buildContent(text, attachments), requestId }, ctx)`, set state
     `planning`, and start the monitor.
  7. On any error, set state `failed` with `error` set to the stderr tail (≤ 500 chars).
- **message(id, text, attachments, requestId):** routing, in this order.
  1. **A card is pending:** a `LiveDoc` tool slot with `status === "sleeping"` and `name` either `ask_user` or
     `submit_plan`. Save any attachments as files (§11.5) and append their paths to the text. Then signal it:
     - `ask_user`: `{ text: 'The person replied in their own words: "…"' }`;
     - `submit_plan`: `{ approved: false, text }`.
  2. **Busy** (`live.run` present): `submit({ type: "input", content, requestId, whenBusy: "steer" })`.
  3. **Idle:** `submit({ type: "input", content, requestId })`. If the state is in {idle, reported, delivered,
     stopped, failed}, set state `working` and start the monitor. A planning session simply continues planning.
- **answer(id, callId, payload):**
  1. Find the slot by `callId`. It must be `sleeping`. Otherwise return 409 "This card was already answered."
  2. Compose the text (§10.3) or the approval value.
  3. Call `harness.signal(slot.taskId, Reply, "reply", value, ctx)`.
  The client never supplies a `taskId`.
- **stop(id):** `conv.abort(ctx)`, then set state `stopped`.
- **continue(id):** `conv.submit({ type: "continue" }, ctx)`, used after a failed run. Then set state `working`, or
  `implementing` if the failed run was implementing.
- **deliver(id, kind):**
  - Allowed from `reported`, or from `delivered` for `pr` after a push.
  - Push (also done before a `pr`), then create the PR for `pr`.
  - Set `pushedAt` / `prUrl` and state `delivered`.
  - Errors return 502 with the stderr tail.
- **diff(id)** (§11.3).
- **archive(id, archived)** sets or unsets `archived`. Archiving does not delete the workspace (§18.3).

### 11.5 Attachments
- **Wire format:** the client sends attachments as base64 JSON `{ name, type, data }`. Images are already resized
  client-side (§13.6). The request body limit is 50 MB.
- **Images,** when the session model accepts image input (check
  `models.getModel(provider, id)?.input.includes("image")`), become `{ type: "image", data, mimeType }` content parts.
- **Everything else,** and images for text-only models, is written to `{workspace}/.picloud/uploads/{timestamp}-{safeName}`.
  The text gets `\n\n[Attached file: .picloud/uploads/…]` appended.
- **New sessions** handle attachments after the clone, in the same way.

### 11.6 Monitor (`monitor.ts`): run-end detection
- **When:** for each session that enters planning, implementing or working.
- **How:** `harness.observeConversation(id, observer, ctx)`. The observer's `advance` must be synchronous and quick:
  record `value.docs["pi.live"]`, then `queueMicrotask` the handling below.
- **On a transition from `run` present to absent:**
  - `runFailure` present with reason `aborted`: do nothing (Stop already set `stopped`).
  - Any other `runFailure`: state `failed`, `error = runFailure.reason + detail`, and notify "Run failed".
  - No failure, and the state is `planning` or `working`: state `idle`, and notify "Pi replied".
  - No failure, and the state is `implementing` (the nudge budget is spent): state `idle`, and notify "Pi stopped
    without a report".
  - `reported` and other states: unchanged.
- **Detach** the observer when the state leaves the active set.

### 11.7 SSE streams
- **Headers:** `content-type: text/event-stream`, `cache-control: no-store`, `x-accel-buffering: no`.
- **Keep-alive:** a `: ping` comment every 15 s.
- **Per-session stream:** on connect, `watch = await conv.watch(ctx)`. Send
  `event: base\ndata: {"view": <watch.value>}`. Then `watch.start(call => { if (call.kind === "value") send("ops", { ops: call.ops }) })`.
  On client disconnect, `watch.stop()`. Every reconnect starts with a fresh `base`; the client replaces its view.
- **Sessions stream:** `harness.observeDoc(Sessions, observer, ctx)`. Send `base` with the doc value, then `ops` per
  change, plus `event: config` with `{ vapidPublicKey }`.
- **Presence:** the server counts open per-session streams. If a stream for the session is open, the person is
  looking, and notifications for that session are skipped (§14).

### 11.8 Static and vendor files
- `GET /` serves `public/index.html`. Other `public/*` paths are served with correct MIME types.
- `sw.js` is served with `cache-control: no-cache`.
- `/vendor/*` maps to these files under `node_modules` (verified to load in Chromium via import map, §20):

| URL | File |
|---|---|
| `/vendor/preact.mjs` | `preact/dist/preact.mjs` |
| `/vendor/hooks.mjs` | `preact/hooks/dist/hooks.mjs` |
| `/vendor/htm.mjs` | `htm/dist/htm.mjs` |
| `/vendor/marked.mjs` | `marked/lib/marked.esm.js` |
| `/vendor/purify.mjs` | `dompurify/dist/purify.es.mjs` |
| `/vendor/chord/*` | `@earendil-works/chord/dist/*` (`delta/index.js` imports only relative files and `../json.js`) |

Reject paths containing `..`.

### 11.9 Access control
- **Base model:** Tailscale is the authentication layer. Bind to loopback only, and only `tailscale serve` can reach
  the server.
- **Allowlist (optional):** if `PICLOUD_ALLOWED_LOGINS` is set, reject with 403 any request whose
  `Tailscale-User-Login` header is missing or not in the list. Tailscale serve sets this header for tailnet users.
- **No cookies, tokens or sessions exist.**

### 11.10 Errors and logging
- **Errors:** JSON responses `{ error: string }` with status 400 (validation), 403, 404, 409 (state conflict) and
  502 (git/gh failure).
- **Logs:** `console.log`/`console.error` to journald. Log one line per request (method, path, status, ms) and every
  state transition. Never log message contents or credentials.

## 12. HTTP API reference

All bodies are JSON. `:id` is the session id (the conversation id).

| # | Method & path | Body | Response | Notes |
|---|---|---|---|---|
| 12.1 | `GET /api/repos` | | `[{ full_name, private, pushed_at, description }]` | gh, cached 60 s |
| 12.2 | `GET /api/events` | | SSE: `base`/`ops` of `picloud.sessions`; `config` | §11.7 |
| 12.3 | `POST /api/sessions` | `{ repo, text, attachments?, requestId }` | `201 { id }` | §11.4 create; idempotent by `requestId` |
| 12.4 | `GET /api/sessions/:id/events` | | SSE: `base`/`ops` of the ConversationView | §11.7 |
| 12.5 | `GET /api/sessions/:id/entries?before=<entryId>&limit=50` | | `{ items: EntryRecord[] }` oldest→newest | `conv.entries({ maxEntryId: before, order: "descending" }, limit+1)`; drop the `before` entry; reverse |
| 12.6 | `POST /api/sessions/:id/messages` | `{ text, attachments?, requestId }` | `202 {}` | §11.4 routing |
| 12.7 | `POST /api/sessions/:id/answer` | `{ callId, answers?: [{ header, selected: string[], other?: string }], approved?: boolean, feedback?: string }` | `202 {}` | `answers` for ask_user; `approved`/`feedback` for submit_plan |
| 12.8 | `POST /api/sessions/:id/stop` | | `202 {}` | |
| 12.9 | `POST /api/sessions/:id/continue` | | `202 {}` | after a failure |
| 12.10 | `POST /api/sessions/:id/deliver` | `{ kind: "push" \| "pr" }` | `200 { pushedAt, prUrl? }` | may take up to 2 min |
| 12.11 | `GET /api/sessions/:id/diff` | | `text/plain` | §11.3 |
| 12.12 | `POST /api/sessions/:id/archive` | `{ archived: boolean }` | `200 {}` | also used for Undo |
| 12.13 | `POST /api/push/subscribe` | `PushSubscriptionJSON` | `201 {}` | dedupe by `endpoint` |

## 13. PWA specification

### 13.1 Principles
- **Simple chat interface:** an input pill, an attachment button and a send button. Content first, chrome recedes.
- **Built in Preact and htm, served without a build step.**
- **Follows Apple's Human Interface Guidelines (HIG).** Each design choice below names the HIG principle it serves,
  and the same choices map onto Material conventions on Android.

### 13.2 Navigation: drawer + one content area
- **Structure:**
  - Content area: one of two views, **New session** or **Session**.
  - Navigation drawer: the session list, opened by **☰** at the top left.
- **Launch behavior:** open the last viewed session, or New session if there is none. Use hash routes `#/new` and
  `#/s/<id>`, with the last route saved in `localStorage` (wrapped in try/catch).
  - HIG principle: *preserve and restore context*.
- **Drawer behavior:** it slides over the content from the left with a dimmed scrim. Tapping the scrim, swiping the
  drawer left, or tapping a row closes it. Width is min(85vw, 360px).
  - HIG principles: *direct manipulation*, *predictable dismissal*.
- **Why a drawer:** the destinations are a changing list of peer conversations. The drawer is the established
  convention for that in chat apps (Claude, ChatGPT), so switching sessions is a pull-and-tap.
  - HIG principle: *consistency with conventions people know*.
  - HIG generally prefers tab bars for fixed top-level sections, which picloud doesn't have. Hidden navigation's
    weakness is discoverability, which the badge below addresses.
- **Badge:** ☰ shows a dot when any *other* session is in a Needs you state.
  - HIG principles: *communicate status without interrupting*, and the fix for hidden navigation.
- **Wide screens** (≥ 900 px, iPad or desktop): the drawer becomes a persistent sidebar. This is CSS only.
  - HIG principle: *adapt layout to size class*.

**Drawer contents, top to bottom:**
1. **New session** row (primary, accent colour).
   - HIG principle: *primary action first and prominent*.
2. Groups **Needs you**, **Working** and **Done** (§8.1), as plain section headers. Each row shows a 1-line title
   plus a secondary line `repo · state label · relative time`. The current session is highlighted. State labels:
   Question, Plan ready, Report ready, Your turn, Failed, Setting up, Planning, Working, Delivered, Stopped.
   - HIG principles: *clarity*, *visual hierarchy*, *status at a glance*.
3. **Swipe a row left** to reveal **Archive**. Archiving shows an **Undo** toast for 5 s instead of a confirm dialog.
   - HIG principles: *forgiveness over confirmation*, *direct manipulation*.
4. Footer: **Enable notifications** while permission isn't granted (§14), and a **Show archived** toggle.
   - HIG principle: *rare actions out of the main path*.

There is no settings screen, because there is nothing to configure: models are set in Pi and access in Tailscale.
- HIG principle: *deference*.

### 13.3 New session view
```
┌──────────────────────────────┐
│ ☰                             │
│                               │
│      What should Pi work on?  │  empty-state prompt (secondary text colour)
│                               │
│ ┌──────────────────────────┐  │
│ │ ⌂ acme/web ▾             │  │  repo chip
│ │ (+)  Describe a task…  (↑)│  │  composer (§13.5)
│ └──────────────────────────┘  │
└──────────────────────────────┘
```
- **Empty-state prompt** teaches what to do.
  - HIG principle: *helpful empty states*.
- **Repo chip** defaults to the last used repo. Tap it to open a bottom **sheet** with a search field and repos
  sorted by `pushed_at`, with recent picks first.
  - HIG principles: *sensible defaults*, *minimize typing*, *sheets for focused sub-tasks*.
- **Send** creates the session and navigates to it immediately, showing "Setting up…". Disable send until a repo is
  chosen and text is non-empty.
  - HIG principles: *immediate feedback*, *prevent errors*.

### 13.4 Session view
```
┌──────────────────────────────┐
│ ☰  Fix login redirect     ⋯   │  title (truncates), overflow menu
│                               │
│ ┌ You ───────────────────────┐│  user bubble (right-aligned, tinted)
│ │ The login page loops on…   ││
│ └────────────────────────────┘│
│ ▸ Thinking                    │  collapsed
│ ▸ Read 6 files, ran 2 commands│  collapsed tool group
│ Pi's prose answer in markdown │  assistant text (full width, no bubble)
│ ┌ Pi asks ───────────────────┐│  question card (§13.7)
│ │ ...                        ││
│ └────────────────────────────┘│
│ ── Working · turn 12 ──────── │  status line
│ (+)  Message…            (■)  │  composer
└──────────────────────────────┘
```
**Overflow ⋯ menu:** View changes (diff sheet), Stop (only while running), Archive.
- HIG principle: *hierarchy by frequency of use*.

**Transcript rendering rules.** The view comes from the SSE `base` plus `ops`: `view.entries` and
`view.docs["pi.live"]`.

| Source | Rendering | HIG rationale |
|---|---|---|
| `pi.user` entry | Right-aligned tinted bubble. Text uses `white-space: pre-wrap`; image parts become thumbnails (tap to enlarge). Hide the NUDGE text: if content equals the nudge string, render nothing. | familiar chat layout; *clarity* |
| `pi.assistant` text parts | Full-width markdown: `marked` → `DOMPurify.sanitize` → `innerHTML`. Code blocks are monospace with horizontal scroll. Links get `target=_blank rel=noopener`. | *legibility*, *deference* |
| `pi.assistant` thinking parts | A collapsed row "▸ Thinking". Expanded, it shows the text in secondary colour. | *progressive disclosure* |
| `pi.assistant` toolCall parts plus their `pi.tool-result` | Consecutive calls (until the next text part) fold into **one collapsed row** with a plain-language summary, e.g. "Read 6 files, edited 2, ran 3 commands". A red ✕ marks any `isError` result even while collapsed. Level 2 (expanded group) shows one line per call: "Read `src/app.ts`", "Ran `npm test`", "Edited `x.ts`", "Wrote `y.ts`". Level 3 (tap a call) shows input and output in monospace, output truncated at 200 lines with "Show all". | *progressive disclosure* (3 levels), *speak the user's language*, *never hide problems* |
| `ask_user` / `submit_plan` / `final_report` calls | Rendered as **cards** (§13.7), never as tool rows. | *one clear call to action* |
| `pi.system`, `pi.reset` | Hidden. A compaction summary entry shows as a thin divider, "Earlier context summarized". | *deference* |
| `live.generation.message` | Streamed partial, rendered as the last assistant block, updating in place. No spinner over content. | *non-blocking feedback* |
| `live.tools` running slots | The group row shows "Running `npm test`…" with live output in level 3. | *feedback* |
| `live.generation.retry` | Status line "Model error, retrying in Ns". | *keep people informed* |
| `live.runFailure` | Inline banner with the reason and a **Continue** button (`POST continue`). | *recoverable errors with a clear next step* |

**Status line** (above the composer): "Working · turn {run.turns}" while `live.run` is present, "Waiting for you"
while a card is pending, otherwise hidden.
- HIG principle: *system status always visible, unobtrusively*.

**Scroll behavior:**
- Auto-scroll to the bottom on new content only when already within 80 px of the bottom.
- Otherwise show a "↓ New activity" pill.
- Scrolling to the top loads older entries (§12.5).
- HIG principle: *don't yank content away from the reader*.

### 13.5 Composer (one component, used on both views)
- **Layout:**
  - **(+) attach** on the left.
  - An auto-growing **input pill** (1 to 6 lines, then scrolls) in the middle.
  - **(↑) send** on the right.
  - All tap targets are at least 44×44 pt.
  - HIG principles: *44 pt minimum touch targets*, *familiar layout*.
- **Context-aware send/stop:** while a run is active and the pill is empty, ↑ becomes **■ Stop**. Typing turns it back
  to ↑, which sends a steer.
  - HIG principles: *one adaptive control instead of extra buttons*, *convention parity with Claude and ChatGPT apps*.
- **Placeholder by state:**

  | State | Placeholder |
  |---|---|
  | Question pending | "Or type your own answer…" |
  | Plan pending | "Describe changes to the plan…" |
  | Reported | "Ask for changes to keep working…" |
  | Otherwise | "Message…" |

  The text is routed by the server (§11.4).
  - HIG principle: *tell people what an input will do*.
- **Keyboard:** Return inserts a newline on touch devices. Enter sends only when a hardware keyboard is detected
  (`matchMedia("(hover: hover) and (pointer: fine)")`). Shift+Enter is always a newline.
  - HIG principle: *respect platform input conventions*.
- **Safe areas:** the composer stays above the on-screen keyboard (`visualViewport` resize →
  `bottom: <keyboard height>`) and respects `env(safe-area-inset-bottom)`.
  - HIG principles: *keyboard avoidance*, *safe areas*.
- **Drafts:** an unsent draft is kept per session in `localStorage` (try/catch) and restored.
  - HIG principle: *never lose user input*.

### 13.6 Attachments
- **Picker:** (+) opens `<input type="file" multiple accept="image/*,.pdf,.txt,.md,.json,.csv,.log,.zip">`. The OS
  supplies camera, photo library and files.
  - HIG principle: *use system-provided pickers*.
- **Images** are resized client-side with `createImageBitmap` and a canvas to a longest side ≤ 2048 px, encoded as
  JPEG at quality 0.85. This also normalizes HEIC.
- **Size limit:** other files are limited to 20 MB each, with an inline error if exceeded.
- **Pending list:** pending attachments show as chips or thumbnails inside the pill, each with ✕ to remove.
  - HIG principles: *reversible actions*, *show what will be sent*.

### 13.7 Cards
- **Question card (`ask_user`):**
  - Each question shows a small caps header, the question text, then options as **full-width rows** (≥ 44 pt). Each
    row shows the label in bold and the description in secondary text, with the recommended option first as the
    agent ordered it. The last row is **Other…**, which expands an inline text field.
  - Multi-select questions use checkmarks.
  - One question with single-select submits on tap. Otherwise a **Submit** button (primary) is enabled once every
    question has an answer.
  - After answering, the card collapses to a summary of the answers, read-only.
  - HIG principles: *minimize typing*, *recognition over recall*, *fewest taps*, *clear completion state*.
- **Plan card (`submit_plan`):**
  - Content: title, summary, numbered steps, and assumptions in secondary text.
  - Buttons: **Approve** (primary, filled) and **Revise** (secondary). Revise focuses the composer, which shows the
    plan placeholder. Sending submits the revision.
  - After approval the card shows "Approved" and collapses its steps (tap to expand).
  - HIG principles: *one primary action*, *reuse familiar controls*, *avoid modal forms*.
- **Report card (`final_report`, data from `SessionItem.report`):**
  - Content: summary (markdown), **Changes** list, **Verification**, **Notes**, **Commits** (monospace, collapsed if
    more than 5). A **View changes** link opens the diff sheet.
  - Buttons: **Push branch** (primary) and **Open PR** (secondary). While delivering, the buttons show progress and
    are disabled. Afterwards the card shows "Pushed {branch}" and/or "PR opened ↗", with the PR link opening
    GitHub. If there are no commits, show "No changes to deliver" instead of buttons.
  - "Keep working" needs no button: the composer below already does it.
  - HIG principles: *don't duplicate controls*, *clear outcome feedback*.
- **Diff sheet:** a full-height sheet with plain monospace text. Lines starting with `+` are green, `-` red, and
  `@@`/`diff` lines bold. Horizontal scroll, pinch-zoom allowed, dismissed by swipe-down or a Done button.
  - HIG principle: *sheets for focused, dismissible tasks*.

### 13.8 Cross-cutting visual and accessibility rules
| Rule | Implementation | HIG principle |
|---|---|---|
| System typography | `font: -apple-system-body` with `system-ui` fallback; sizes in `rem`, so the user's text-size setting applies | *legibility*, *Dynamic Type* |
| Dark mode | colour tokens on `:root`, overridden under `@media (prefers-color-scheme: dark)`; `<meta name="color-scheme" content="light dark">` | *adapt to appearance* |
| Contrast | body text ≥ 4.5:1, large text ≥ 3:1, in both modes | *accessibility* |
| Motion | drawer and expand transitions ≤ 200 ms; none under `prefers-reduced-motion` | *motion is optional* |
| Screen readers | real `<button>` elements; `aria-label` on icon buttons ("Open sessions", "Attach", "Send", "Stop"); `aria-expanded` on disclosures; cards are `role="group"` with a label | *accessibility is not optional* |
| Layout | single column, max content width 760 px, 16 px side gutters, `env(safe-area-inset-*)` padding, no horizontal page scroll | *safe areas*, *readable line length* |
| Connectivity | thin non-blocking "Reconnecting…" bar; reading and typing stay enabled; sends carry `requestId` and retry with backoff | *graceful degradation* |
| Loading | skeleton rows in the drawer on first load; never a full-screen spinner | *perceived performance* |

### 13.9 Client state and sync
- **Session view:** one `EventSource` per open session (`/api/sessions/:id/events`). On `base`, set
  `view = data.view` and reset any older entries loaded from paging. On `ops`, set `view = applyImmutable(view, data.ops)`.
- **Drawer:** one `EventSource` for `/api/events`, which carries sessions and config.
- **Page visibility:**
  - On `visibilitychange` → hidden, close both EventSources. This tells the server you're not looking, so
    notifications resume.
  - On → visible, reopen them.
  - This also fixes iOS's silently half-open connections after backgrounding.
- **Requests:** POSTs use `fetch` with a client-generated `requestId` (`crypto.randomUUID()`) where the API takes
  one. Retry network failures 3 times with backoff, keeping the same id.

### 13.10 PWA plumbing
- **`index.html`:**
  - `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`
  - `<meta name="apple-mobile-web-app-capable" content="yes">`
  - `<link rel="manifest">` and `<link rel="apple-touch-icon" href="/icons/icon-180.png">`
  - The import map:
    ```html
    <script type="importmap">{"imports":{"preact":"/vendor/preact.mjs","preact/hooks":"/vendor/hooks.mjs","htm":"/vendor/htm.mjs","marked":"/vendor/marked.mjs","dompurify":"/vendor/purify.mjs","chord-delta":"/vendor/chord/delta/index.js"}}</script>
    ```
- **`manifest.webmanifest`:** `name` "picloud", `short_name` "picloud", `start_url` "/", `display` "standalone",
  `background_color` and `theme_color` matching the light background, icons 192 and 512 (`purpose` "any maskable").
- **`sw.js`:**
  - Precache the app shell (`/`, `/app.js`, `/transcript.js`, `/cards.js`, `/composer.js`, `/style.css`, vendor
    files, icons) under a version constant. Bump the constant on every deploy.
  - Strategy: network-first for navigations, falling back to the cached `/`. Cache-first for shell files. Never
    cache `/api/*`.
  - `push`: `showNotification(title, { body, data: { url }, tag: sessionId })`. The `tag` replaces stale
    notifications for the same session.
  - `notificationclick`: focus an open client and navigate it to `url`, or `clients.openWindow(url)`.
- **Icons:** a simple glyph (for example "π") on the accent colour. Export `icon.svg` to PNG at 180, 192 and 512 px
  with any tool.

## 14. Notifications

- **Events (only these):**

  | Event | Title | Body |
  |---|---|---|
  | `ask_user` parks | "Pi has a question" | first question text |
  | `submit_plan` parks | "Plan ready" | plan title |
  | `final_report` filed | "Report ready" | first line of summary |
  | Run failed | "Run failed" | reason |
  | Run ended in planning or working | "Pi replied" | first 100 characters of the last assistant text |
  | Implementing run ended without a report | "Pi stopped without a report" | |

  - HIG principle: *notifications must be timely, relevant and actionable*. There are no "started" or "still working"
    notifications.
- **Payload:** `{ title, body, url: "/#/s/<id>" }`. Send with
  `webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 86400 })` to every subscription. On status 404 or
  410, remove that subscription from the `Push` doc.
- **Suppression:** skip the send if an SSE stream for that session is open (§11.7). The person is already looking.
- **Enabling on iOS** (requires iOS 16.4 or later):
  - The app must be **added to the Home Screen** and opened from there.
  - Permission must be requested from a tap, via the drawer's **Enable notifications** row:
    `Notification.requestPermission()`, then
    `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidPublicKey })`, then
    `POST /api/push/subscribe`.
- **Delivery:** notifications go out through Apple's and Google's push services. The droplet needs ordinary
  outbound internet access; nothing inbound is required.

## 15. Implementation phases with acceptance criteria

Work through the phases in order. Each ends with a verifiable acceptance check, and you should not start a phase
until the previous one passes.

### Phase 0: repository bootstrap
- Create `package.json` (§5, §7 scripts, `"type": "module"`, `"engines": { "node": ">=22.19" }`), `tsconfig.json`
  (copy `reference/spike/tsconfig.json`, with `files` replaced by `"include": ["src", "test"]`), and
  `src/web-push.d.ts`.
- `npm install` with exact versions (`save-exact=true` in `.npmrc`).
- **Accept:** `npm run check` passes on an empty `src/main.ts`. In `reference/spike`, `npm install` followed by
  `node spike.ts` prints the six numbered results shown in §20.

### Phase 1: agent core (no HTTP)
- Implement `harness.ts` and `extension.ts` exactly as §8 and §10 specify.
- Port the spike into `test/lifecycle.test.ts` using `node:test`, with the faux provider and a temporary data dir.
- **Accept:** all of these pass:
  1. An `ask_user` park survives `harness.close()` and reopen (same task id). The answer signal completes the call.
  2. `submit_plan` revise returns feedback and state `planning`. Approve sets `implementing`.
  3. A `write` tool call creates a file in the workspace.
  4. The `onYield` nudge fires while implementing and stops after exactly 3. It never fires outside `implementing`.
  5. `final_report` refuses while `git status` is dirty and succeeds after a commit. The report and commits are
     stored in the item.
  6. Exactly one notification call per park, even when the tool reruns. Inject a fake `notify`.

### Phase 2: server and git
- Implement `config.ts`, `main.ts`, `sessions.ts`, `monitor.ts`, `http.ts` (without static files) and `push.ts`
  (send can be a no-op if `PICLOUD_PUSH_SUBJECT` is unset).
- `test/git.test.ts`: create a local bare repo as "origin" with one commit. Make the clone step injectable so tests
  use `git clone <bare>` instead of `gh repo clone`. Verify the branch, identity, exclude, push to the bare repo, and
  the diff output.
- `test/routing.test.ts`: covers a pending question, a pending plan, busy, and idle, each producing the correct
  signal or submit (faux model).
- **Accept:**
  - Unit tests pass.
  - **Manual curl run against a real model on a dev machine** (signed in with `pi`): create a session on a scratch
    repo with a trivial task, watch `curl -N /api/sessions/<id>/events`, answer via `/answer`, approve, and observe
    `reported`.
  - `deliver push` creates the branch on GitHub.
  - Kill the server (`kill -9`) while parked, restart it, answer, and the run completes.

### Phase 3: PWA shell and transcript
- `index.html`, `app.js` (routing, drawer, both views, SSE clients), `transcript.js`, `composer.js`, `style.css`,
  and the static and vendor routes in `http.ts`.
- **Accept** in Chromium via Playwright at an iPhone viewport (`devices["iPhone 15"]`):
  - A new session can be started.
  - Tool calls and thinking render collapsed, with 3-level expansion.
  - Streaming text updates in place.
  - The drawer opens, closes, switches sessions and shows the badge.
  - Dark mode renders.
  - No console errors.
  - No horizontal scroll at 375 px width.

### Phase 4: cards and delivery
- `cards.js`: question, plan and report cards, the diff sheet and the overflow menu. Composer routing placeholders.
- **Accept:** a scripted end-to-end run (faux model in a test server mode, or a real model) can be driven entirely
  by taps: answer, approve, read the report, push, open the PR. Free-text "Other" and composer replies route
  correctly. Archive with Undo works.

### Phase 5: notifications and installability
- `sw.js`, the manifest, icons, the subscribe flow, the presence-based suppression, and the monitor notifications.
- **Accept:**
  - Lighthouse "Installable" passes (use the Chromium path `/opt/pw-browsers/chromium` or any Chrome).
  - On a real iPhone (Phase 6 deployment): the app installs to the Home Screen, notifications are enabled, and a
    question arrives as a notification while the app is closed. Tapping it opens the card.

### Phase 6: deployment
- Follow §17 on a fresh droplet.
- **Accept:** from the phone over Tailscale, run a real task on a real repo through to a pushed branch and an opened
  PR. Reboot the droplet mid-run, and the run continues afterwards.

### Phase 7: phone polish checklist (all must pass on a real device)
- [ ] The composer stays above the keyboard. No content hides behind the notch or home indicator.
- [ ] Every control is ≥ 44 pt and reachable one-handed. Primary actions are in the bottom half where possible.
- [ ] Text-size setting at maximum: the layout remains usable.
- [ ] VoiceOver can start a session, answer a question, approve a plan and push.
- [ ] Airplane mode on, then off: a "Reconnecting…" bar appears, and the transcript catches up with no duplicate
      sends.
- [ ] Backgrounding for 10 minutes, then foregrounding: the transcript updates within 2 s.
- [ ] The line budget is respected (`wc -l src/*.ts public/*.js public/*.css`).

## 16. Testing strategy

- **Unit and integration tests:**
  - Run with `node --test` and the **faux provider** from pi-ai (`fauxProvider()`, `fauxAssistantMessage`,
    `fauxToolCall`). Script responses with `faux.setResponses([...])`.
  - Every test uses a temporary `PICLOUD_DATA` and real SQLite storage, so restart behavior is tested for real.
  - `reference/spike/spike.ts` is the template.
- **Git tests** use local bare repositories, so they need no network.
- **UI checks** use Playwright with the iPhone 15 device profile against a test server instance running the faux
  model. Check rendering rules (§13.4) with screenshots at deviceScaleFactor 1.
- **Manual device test** covers the Phase 5–7 checklists on a real phone. It is required before calling v1 done.
- **Don't mock Durable.** Its storage and restart semantics are the point.

## 17. Deployment runbook (droplet)

Steps are for Ubuntu 24.04 as root, unless a step says `sudo -iu picloud`.

### 17.1 Provision
- **Size:** 2 vCPU and 4 GB RAM minimum. Use 4 vCPU and 8 GB RAM if your repos have heavy builds or tests. 50 GB
  disk.
- **Firewall:** no inbound ports are needed. Allow SSH only from Tailscale once it's set up.
- **Base packages:** `apt update && apt upgrade -y && apt install -y git curl build-essential`.

### 17.2 Service user
```bash
adduser --system --group --home /home/picloud --shell /bin/bash picloud
install -d -o picloud -g picloud -m 700 /var/lib/picloud
install -d -o picloud -g picloud -m 755 /opt/picloud
```
The `picloud` user has no sudo.

### 17.3 Node.js
Install Node 22 (≥ 22.19) or Node 24 LTS from NodeSource or the official tarball, then verify with
`node --version`.

### 17.4 Pi: sign in and choose the default model
```bash
npm install -g @earendil-works/pi-coding-agent@1.6.0
sudo -iu picloud pi            # inside pi: /login (pick provider), then /model (pick default), then quit
sudo -iu picloud ls ~/.pi/agent  # expect auth.json and settings.json
```
To change the model later, repeat `/model` and restart picloud.

### 17.5 GitHub CLI
1. Install `gh` from GitHub's official apt repository (cli.github.com).
2. **Recommended:** create a **fine-grained personal access token** limited to the repositories picloud may touch.
   - Contents: Read and write.
   - Pull requests: Read and write.
   - Metadata: Read.
3. Log in and wire gh into git:
   ```bash
   sudo -iu picloud gh auth login --with-token < token.txt   # then delete token.txt
   sudo -iu picloud gh auth setup-git
   sudo -iu picloud gh repo list --limit 5                    # verify
   ```
4. Turn on **branch protection** for the default branch of each such repo (§19).

### 17.6 Tailscale
```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up                       # authenticate the droplet into your tailnet
```
In the Tailscale admin console, enable **MagicDNS** and **HTTPS certificates**. On the phone, install the Tailscale
app and sign in to the same tailnet.

### 17.7 picloud
```bash
sudo -iu picloud git clone https://github.com/<you>/picloud /opt/picloud   # or rsync a release
cd /opt/picloud && sudo -u picloud npm ci --omit=dev
```
Create `/etc/picloud.env`:
```
PICLOUD_DATA=/var/lib/picloud
PICLOUD_PUSH_SUBJECT=mailto:you@example.com
# PICLOUD_ALLOWED_LOGINS=you@example.com
```
Create `/etc/systemd/system/picloud.service` (also kept in the repo as `deploy/picloud.service`):
```ini
[Unit]
Description=picloud
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
User=picloud
Group=picloud
WorkingDirectory=/opt/picloud
EnvironmentFile=/etc/picloud.env
Environment=HOME=/home/picloud NODE_ENV=production
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/main.ts
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```
Start it and expose it on the tailnet:
```bash
systemctl daemon-reload && systemctl enable --now picloud
journalctl -u picloud -f            # expect "listening on 127.0.0.1:8787"
tailscale serve --bg 8787           # HTTPS on https://<droplet>.<tailnet>.ts.net
tailscale serve status
```
Never use `tailscale funnel`: that would expose picloud to the public internet.

### 17.8 Phone
1. Turn Tailscale on, then open `https://<droplet>.<tailnet>.ts.net` in Safari.
2. Share → **Add to Home Screen**, then open picloud from the Home Screen.
3. Open the drawer and tap **Enable notifications**, then Allow.
4. Start a session.

## 18. Operations runbook

### 18.1 Health and logs
- **Service status:** `systemctl status picloud` and `journalctl -u picloud --since -1h`.
- **What's running:** the per-request log shows activity. Durable's own reports are prefixed `[durable]`.

### 18.2 Backups
- **What to back up:** `/var/lib/picloud/durable.sqlite` (all state) and `/home/picloud/.pi/agent/`. Workspaces are
  rebuildable from GitHub, except unpushed work.
- **Consistent snapshot while running:**
  `sqlite3 /var/lib/picloud/durable.sqlite ".backup '/backup/picloud-$(date +%F).sqlite'"`. Install with
  `apt install sqlite3`.

### 18.3 Disk cleanup
Archived sessions keep their workspace. To prune workspaces of sessions delivered more than 14 days ago, list them
via the sessions doc, or simply remove workspace directories untouched for 14 days that have no unpushed commits:
```bash
sudo -iu picloud bash -c 'for d in /var/lib/picloud/work/*/; do
  cd "$d" && [ -z "$(git log --branches --not --remotes --oneline 2>/dev/null)" ] \
  && find "$d" -maxdepth 0 -mtime +14 -print; done'
# review the list, then rm -rf the printed paths
```

### 18.4 Upgrading Pi packages (deliberate procedure)
1. Read `CHANGELOG.md` of each `@earendil-works/*` package between the old and new versions, looking for breaking
   changes (park shape, signal state, hook returns, `submit`/`admit`, doc semantics).
2. On a dev machine, bump all five `@earendil-works/*` pins together. Update `reference/spike` too and run it.
3. Run `npm run check` and `npm test`. Fix the differences.
4. **Back up `durable.sqlite` (§18.2) before deploying.** Durable may migrate stored data, and rollback after a
   migration is not guaranteed.
5. Deploy: `git pull && npm ci --omit=dev && systemctl restart picloud`. Bump the `sw.js` cache version.

### 18.5 Troubleshooting
| Symptom | Likely cause | Fix |
|---|---|---|
| Service exits at start: "No default model" | Pi not signed in or no default model | §17.4 as user picloud |
| Runs fail with auth errors | expired or revoked provider credential | `sudo -iu picloud pi` → `/login`; restart |
| Repo list empty or clone fails | gh not authenticated, or token lacks repo access | `sudo -iu picloud gh auth status`; adjust token repos |
| Push fails with 403 | token lacks Contents write, or branch protection blocks the branch | fix token permissions; protect only the default branch |
| Phone can't reach the URL | Tailscale off on phone, or serve not configured | Tailscale app on; `tailscale serve status` |
| No notifications | not opened from the Home Screen, permission not granted, or iOS < 16.4 | §17.8; check `PICLOUD_PUSH_SUBJECT` is set |
| Session stuck "Setting up" after a crash | server restarted during clone | it is marked failed at next boot; start a new session |
| Transcript stops updating on iPhone | backgrounded connection | foreground the app; the client reconnects on visibility |
| Run ended "Pi stopped without a report" | model kept stopping; nudge budget (3) spent | read its last message; reply in the composer to continue |
| Database errors in log | disk full or file corruption | free disk; restore the last backup |

## 19. Security model and known limitations

- **Who can reach it:**
  - Only devices on your tailnet (and only allowed logins, if configured).
  - The server binds to loopback, and there is no public exposure.
  - Anyone who can reach picloud can make Pi run arbitrary commands as the `picloud` user. Treat tailnet membership
    as root-equivalent for the `picloud` account.
- **What the agent can reach:**
  - Everything the `picloud` Unix user can: all session workspaces, `~/.pi/agent/auth.json` (model credentials) and
    `~/.config/gh` (GitHub token).
  - The agent is *instructed* never to push. This is not enforced against a determined or prompt-injected agent.
- **Mitigations in v1:**
  1. A fine-grained GitHub token limited to chosen repositories.
  2. Branch protection on default branches, so even a rogue push can't change `main`.
  3. Delivery normally happens only when the person taps.
  4. A dedicated `picloud` user with no sudo.
- **Prompt injection:** content Pi reads (repo files, web pages, issue text) can steer it. With the mitigations
  above, the worst case is limited to the scoped repos' non-default branches and the droplet's `picloud` account.
- **Deferred to later (not v1):**
  - A credential-holding git proxy, so the token never sits on the same user account.
  - A separate Unix user or a container for the agent's shell, via `pi-env`'s `RemoteExecutionEnv` over
    `docker exec -i`. No other picloud code would change, because tools only touch the host through `api.env`.
- **Model calls after a crash:** a model request in flight during a crash is retried, so it may be billed twice.
- **Interrupted tools:** a tool cut off by a crash is not rerun, unless it is replay-safe. The model gets an
  "interrupted" result and continues.

## 20. Verification record

On 2026-11-21, `reference/spike/spike.ts` was run against the published `@earendil-works/*@1.6.0` packages on Node
22.23.5 with SQLite storage and the faux model. Output:
```
1. parked on ask_user; sessions doc: {"items":{"2":{"state":"question","title":"task"}}}
   wake while parked: {"active":false}                 ← a parked question holds no process
2. after restart still parked, same task: true          ← survives close + reopen
   signal: "delivered"
3. parked on submit_plan; state: approval
4. submission: done | file: "hi\n"                      ← coding tool wrote in the session cwd
   final state: reported
   entries: pi.user pi.system pi.assistant pi.tool-result … pi.user pi.assistant pi.tool-result pi.assistant
   nudge present: true                                  ← onYield nudge resumed a premature stop
5. ops applied: 70 | mirror equals watch value: true    ← browser-side applyImmutable reproduces the view
6. never-reporting run: done | nudges: 3 | model calls left: 1   ← nudge cap holds at exactly 3
```
These were also verified:
- `reference/spike/prod-wiring.ts` typechecks: `ModelRuntime.create()` is accepted as Harness `models`, and
  `SettingsManager` provides the default model.
- `ModelRuntime.create()` succeeds with no credentials present.
- The `pi-context` sections typecheck with `loadProjectContextFiles`, `loadSkills` and `formatSkillsForPrompt`.
- `reference/spike/browser-check.mjs` loaded Preact, htm, marked, DOMPurify and Chord `delta` through an import map
  in Chromium with no bundler and no console errors.

The spike uses a reduced set of the §8.1 states and a simplified `ask_user` schema. §8 and §10 are authoritative.

## 21. Decision log

| # | Decision | Rationale |
|---|---|---|
| D1 | Build a fresh thin server; do not fork p2, p3 or pi-pocket | p2 is self-declared throwaway and tied to Chord's object runtime. p3 has no Durable, chat or UI yet. pi-pocket is ~280k lines (incl. tests), adds ~5–9k tokens of prompt per request, and waits on in-memory promises instead of Durable parks. See `notes/research/02`, `05`, `06`. |
| D2 | Tailscale for access; no app auth | Eliminates the authentication layer. HTTPS comes from `tailscale serve`. |
| D3 | Pi's own provider config (`ModelRuntime`, `SettingsManager`) | No provider code in picloud. One sign-in path (`pi` → `/login`). |
| D4 | One Harness, one SQLite file; session list as a Durable doc | No second database. List and transcript change atomically. |
| D5 | Every wait is a tool park on a signal | Survives restarts and costs no process. This is the core property for "answer from the phone hours later". |
| D6 | Plan approval required before implementation | Owner's choice: one tap buys confidence before unattended work. |
| D7 | Delivery chosen by the person: push / PR / keep working | Owner's choice. Nothing reaches GitHub without a tap. Removes the need for a push guard on the agent. |
| D8 | The `onYield` nudge (max 3) plus `maxTurns` 200 | Makes "runs until the final report" reliable rather than up to the model. |
| D9 | Workflow taught by prompt, not enforced | Interactive use must not be barred. Only the post-approval nudge is enforced. |
| D10 | Drawer navigation (☰) for sessions | Owner's choice: switching sessions should be pull-and-tap. It's the chat-app convention, and a badge solves discoverability. |
| D11 | The multiple-choice tool is `ask_user` (1–4 questions, 2–4 options, multiSelect, free-text Other) | Front-loads decisions with minimal typing. The schema follows the proven Claude Code / pi-pocket shape. |
| D12 | No bundler; Node type stripping on the server; import map on the client | Less tooling, fewer moving parts. |
| D13 | Agent shares the `picloud` user with gh credentials (v1) | Simplicity for a single-owner droplet with your own repos. Mitigated by a scoped token and branch protection (§19). |
| D14 | Pin `@earendil-works/*` at exactly 1.6.0; read the README in `node_modules` | Durable is experimental, and GitHub main already differs from 1.6.0 (§6.1). |

## 22. References

- **Pi monorepo:** https://github.com/earendil-works/pi (research done at commit `780bf31`). Pi Durable is
  `packages/durable`; examples are in `packages/durable/test/examples/` (main-branch shapes, see §6.1). Note
  `39-ask-a-person.ts`, `40-tool-waits-for-webhook.ts`, `44-approval-gate.ts` and `45-review-on-yield.ts`.
- **Authoritative API docs for 1.6.0:** `node_modules/@earendil-works/pi-durable/README.md` and the `.d.ts` files
  under `node_modules/@earendil-works/pi-durable/dist/`.
- **Research notes in this repo:**
  - `notes/00-foundation.md`: initial plan.
  - `notes/01-design.md`: design walkthrough. The drawer navigation in §13.2 supersedes its "no hamburger" choice.
  - `notes/research/01-pi-durable-runtime.md` to `04-claude-code-cloud.md`, plus `05`/`06` (pi-pocket).
- **Validated spike:** `reference/spike/` (`spike.ts`, `prod-wiring.ts`, `browser-check.mjs`).
- **Apple Human Interface Guidelines:** https://developer.apple.com/design/human-interface-guidelines/
- **Web Push on iOS (16.4+):** https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- **Tailscale serve:** https://tailscale.com/kb/1312/serve
