# Pi Durable runtime: technical reference

Source: `/home/user/refs/pi` @ 780bf31, package `packages/durable` (`@earendil-works/pi-durable` 1.6.0 plus an
"Unreleased" section of further breaking changes). Everything below is read from the README, `docs/spec.md`
(normative), `docs/group-commit.md`, `docs/suspendable/`, `CHANGELOG.md` and `src/`. Citations are
`path:line` relative to `packages/durable/` unless a different package is named. `spec §n` is `docs/spec.md`;
`susp §n` is `docs/suspendable/spec.md`.

Status line to keep in mind: the README opens with "**Experimental.** The API changes without notice between
releases" (`README.md:3`). 1.6.0 shipped 2026-11-20 and `[Unreleased]` already lists seven breaking changes
(`CHANGELOG.md:3-13`: tagged parks, tagged `Wrap`, tagged `onYield`/`beforeCompact` results, `submit(tx,draft)`
renamed `admit`, tagged `SignalState`, tagged `CommitResult`). Expect churn.

---------------------------------------------------------------------------------------------------------------

## 0. One-paragraph model

Durable is a *library*, not a server. A **Harness** wraps one **Session**, which wraps one **Storage**. All state
(transcripts, task state machines, typed JSON documents, submission records) is written through a single serialized
"mutation line" as atomic commits; nothing is shown to any observer before it is stored (except explicitly
deferred progress commits). Agent turns are not a loop in memory: they are `pi.generation` and `pi.tool` *tasks*, i.e.
persisted state machines whose every step is a checkpoint commit. On open, whatever was `running` is flipped back to
`pending` and re-run from its last checkpoint. There is no daemon, no network protocol, no auth, no multi-process
coordination: the host embeds the library in one process per storage and builds the transport itself.

Layering (all in `packages/durable/src`):

| Layer | Files | Role |
|---|---|---|
| Records & storage interface | `types.ts` | ids, `Storage` (1376), `Tx` (1021), `Session` (1234) |
| Session kernel | `session/session.ts` (`SessionImpl` :219), `session/writer.ts`, `session/transaction.ts`, `session/cached-storage.ts` | mutation line, group commit, document trackers, publication |
| Harness | `harness/harness.ts` (`HarnessImpl`), `scheduler.ts` (3401 lines), `submissions.ts`, `generation.ts`, `tool.ts`, `compaction.ts`, `live.ts`, `view.ts` | tasks, runs, tools, views |
| Storage backends | `storage/{memory,jsonl,sqlite,indexeddb,store}` | see §3 |
| Env | `env/index.ts`, `env/node.ts` | ExecutionEnv (fs + shell) |
| Tools/extras | `tools/`, `codemode/`, `tool-search/`, `images/` | built-in tools |

Dependencies (`package.json:~175`): `@earendil-works/chord` (Context, Watch, delta ops, Store), `pi-ai` (Models,
Message types, streaming), `pi-codemode` (QuickJS sandbox), `pi-schema`, `pi-telemetry`, `photon` (wasm images).
Node >= 22.19.

---------------------------------------------------------------------------------------------------------------

## 1. Core data model

### 1.1 Terms (spec §1, :42-93)

- **Session**: owns exactly one mutation line, and all conversations/entries/tasks/submissions/documents in one
  Storage. `createSession(storage, opts)` (`session/session.ts:143`) gives a plain Session; `Harness.open` gives a
  Session plus the agent machinery.
- **Conversation**: a transcript scope; may fork another; may be owned by a task. Root conversation has the reserved
  id `ROOT_CONVERSATION_ID = 1` (`types.ts:43`), lazily created by `harness.root()`.
- **Entry**: immutable transcript record.
- **Task**: durable state machine attached to a conversation (and optionally owned by another task).
- **Document**: mutable typed JSON state represented as Chord delta ops plus periodic complete bases.
- **Turn** = one assistant response + its tool calls; **run** = turns from an admitted input to the final answer;
  a conversation is **busy** while `pi.live.run !== undefined` (spec §6, :3114-3125).

Invariants worth remembering (spec :54-80): one commit is atomic over all record+document writes; external
effects never run inside the mutation transaction; entries and ids are immutable/never reused; a storage error is
fatal to the open Session (must reopen); all visible progress is durable *except* deferred commits.

### 1.2 Record shapes (`types.ts`, spec §2 :94-300)

IDs are branded numbers from **one global namespace** minted by `Storage.mintId()` (ordered = creation order, the
Harness relies on it; `types.ts:1376+`, spec :6674-6680). Brands: `ConversationId`, `EntryId`, `TaskId<R>`,
`SubmissionId`, `DocumentId` (`types.ts:31-35`). `Seq` = strictly increasing commit sequence, gaps allowed
(`types.ts:40`).

```ts
ConversationRecord { id; parent?: { conversationId; at: EntryId };           // fork lineage
                     owner?:  { conversationId; taskId } }                    // task ownership (abort/idle traversal)
EntryRecord        { id; conversationId; kind: string;                        // types.ts:481
                     model?: Message[];     // what the LLM sees (pi-ai Message); absent = display-only
                     data?: JsonValue;      // app payload
                     head?: EntryId;        // context lower bound (reset / compaction summary)
                     edits?: ContextEdit[]; // omit/replace earlier entries in model context
                     byTaskId?: TaskId }
```

Built-in entry kinds (spec §8.1 :5097-5117): `pi.user`, `pi.assistant` (every response incl. failed/aborted
partials), `pi.system` (positional system-prompt/tool deltas; `content:""`, named `sections`, `toolsAdded/Removed`),
`pi.tool-result` (`data: { diagnostics }`), `pi.reset` (`head:"self"`), `pi.compaction` (`head` = first kept entry,
`data: { reason }`). Apps add their own kinds (must not start `pi.`; input entries via `SubmissionDraft.entry`,
README:620-636). Exported as typed tokens (`UserEntry`, `AssistantEntry`, ... `src/entries.ts`, `src/index.ts:7-14`).

Model context derivation (spec §2.1 :302-353): newest `head` marker defines the lower bound; per-target newest edit
wins; tool results reordered to follow their call; missing results synthesized as errors; aborted/error/deferred
assistant messages excluded from future requests; the first `pi.system` is moved to the front to keep provider
prompt cache valid. UI and model context are separate reducers (a view's `entries` is raw history, not model
context).

**Forks** (`Conversation.fork(at, opts)`, `session/forks.ts`): child sees parent's entries up to `at`. Documents are
copied per their definition's `fork` policy (`"initial" | "current" | "asOf"`, `types.ts:46-60`); `document.copy`
is a first-class `StorageWrite` (types.ts:946-967). A fork gets a fresh `pi.provider` UUIDv7 (spec :1000-1010) and the
agent as of the fork entry; its inbox is empty. Usage starts at zero (no double counting, spec :5889).

**Submissions** (`types.ts:534-640`): `{ id, conversationId, requestId?, notify?, type: input|write|continue,
status: queued|placed|done|unanswered, entry?, answer?, reason?, detail? }`. `unanswered` carries a machine reason
(`aborted`, `reset`, `model_error`, `no_model`, `turn_limit`, `faulted`, `stale`, `run_failed`, `nothing_to_answer`,
`interrupted`, `restart_limit`, or an orphan reason).

### 1.3 Tasks (spec §5, :2097-2840; `types.ts:686-800`)

```ts
TaskRecord { id; conversationId; kind; version; input; owner?: TaskId; background; abortRequested;
             abortReason?: "restart"; abandonOnRestart?; startedAt?; endedAt?; restarts?; memos?;
             state: TaskState }
TaskState = pending{checkpoint,wake?} | running{checkpoint,wake?}
          | waiting{checkpoint,on:TaskId[],policy:"failFast"|"allSettled"|"any"}
          | sleeping{checkpoint,until?,signals?}
          | completing{outcome}        // outcome decided, waiting for owned work to drain
          | terminal{outcome}          // completed | failed | aborted | orphaned | faulted
```

`defineTask({ name, version, initial(input), phases: {[phase]: handler}, abort, migrate?, hooks? })`
(`tasks.ts:4`, spec :2253-2263). A phase handler receives `(task, runtime, context)`; progress means *committing a
different checkpoint* through `runtime.commit(cb)`; a phase that returns without changing the checkpoint faults the
task ("no durable progress", spec :2403-2408). Rules enforced by the scheduler step between phases:
terminal/waiting/sleeping stop; session closing stops; abort mark ends the run invocation and starts a *separate
abort invocation*; uncaught error -> `faulted`.

Key mechanisms:
- **Effect sandwich** (spec §5.2 :2429-2445): commit intent -> perform effect -> commit outcome. Reopening in an
  intent phase means the effect *may* have happened; the handler must be idempotent or poll.
- **Memos** (`runtime.memo(name, candidate)`): first-writer-wins small values in the live task record; dropped on
  terminal. Used for idempotency keys and fixed deadlines.
- **Ownership tree** (spec §5.5): every task names an owner (conversation or task); abort cascades bottom-up;
  an owner holding live owned work becomes `completing`; `background:true` tasks are boundaries. Subagents =
  conversation owned by a task.
- **Sleeping** (spec §5.6): `{status:"sleeping", until?, signals?}` stores a deadline on the Harness clock; the task
  holds no invocation. Wake reason (`time | expired | signal | tasks`) is written into `state.wake` by the
  reservation commit.
- **Signals** (`signals.ts`, spec §5.7): typed JSON delivered with `harness.signal(taskId, token, key, value)`;
  results `delivered | duplicate | invalid | closed | not_found` (`signals.ts:50`, impl `deliverSignal` :198). Value is
  stored in the task record (kept even if it arrives before the sleep, which then wakes immediately). One wait per
  key; late/duplicate deliveries are final. **No sender authentication** (README:~190: "Nothing checks who sends a
  signal: authenticate senders in your host").
- **Migration**: task and document definitions carry `version` + `migrate`; a task whose definition is missing /
  too new / unmigratable stays blocked (`missing_task | task_too_old | migration_failed`), is never terminalized
  by the Harness, and is reconsidered on every registry change (spec :2578-2600).

### 1.4 Documents (spec §3, :1181-1850; `types.ts:46-140`, `documents.ts`)

`defineDoc<T>({ kind, version, scope: "session"|"conversation"|"task", history?: "latest"|"rewindable",
fork?: "initial"|"current"|"asOf", initial(), migrate?, checkpointWhen(value, ops, info) })` (README:~968). `checkpointWhen`
is *required* (true = store a complete base to bound replay; "checkpoint starvation" is a footgun, spec :7186).
Task-scoped documents retire with their task. Access: `tx.doc(token, id)` inside a commit (returns a mutable Chord
`Draft`), `harness.snapshot(token, id, ctx)` / `snapshotAsOf` outside; `observeDoc`/`watchDoc` for watches.
Document kinds and view mount paths are persisted/public protocol (spec :7203-7208).

Built-in conversation documents (all created in the same commit as the conversation, spec :960-990):

| kind | file:line | scope/history/fork | content |
|---|---|---|---|
| `pi.agent` | `harness/agent.ts:47` | conversation, rewindable, asOf | `AgentState`: model, thinkingLevel, extensions[], tools, modelTools, instructions, cwd, maxTurns, compaction |
| `pi.live` | `harness/live.ts:202` (v3) | conversation, latest, initial | `run`, `generation` (streamed partial/retry/deferred), `tools[]` slots, `nestedTools[]`, `compactions[]`, `runFailure` |
| `pi.inbox` | `harness/inbox.ts:24` | conversation, latest, initial | queued steer/followUp/write items |
| `pi.provider` | `harness/provider.ts:12` | conversation, latest, initial | `{ sessionId: uuidv7 }` provider-facing id (cache identity) |
| `pi.usage` | `harness/usage.ts:15` | conversation, latest, initial | token/cost per `provider/model` and per tool |

`AgentState` stores *names* only (spec :846-853): extensions and tools by name, resolved against the in-process
registry at use. Nothing in storage depends on code, which is what allows reopening under newer code.

---------------------------------------------------------------------------------------------------------------

## 2. The harness: how a turn executes durably

### 2.1 Open, scheduling and the host contract

`Harness.open(storage, options, context)` (`harness/harness.ts:608`): checks the registry holds the three built-in
tasks (`createRegistry()` always does; `harness.ts:615-620`), constructs `HarnessImpl` (:222) and runs
`openTasks` -> `TaskScheduler.open` (`scheduler.ts:483`). `HarnessOptions` (`harness/types.ts:796-860`):
`models` (pi-ai `Models` or a function, read at each use), `registry`, `settings` (object/getter/function, read at each
use), `env` (per-conversation ExecutionEnv factory), `conversationCreated`, `now`, `setTimer`, `onWake`, `onReport`,
`readOnly`, `identity`, `telemetry`.

**Open performs recovery** (scheduler.ts:483-526, spec :1013-1020): in one commit it scans *all live tasks*
(`pending|running|waiting|sleeping|completing`), loads them into scheduler memory, and rewrites each `running` task as
`pending` with `restarts + 1` (:508-511). It dispatches nothing. Scheduling starts only on `resume()` or on any call that
asks for progress (`submit`, `compact`, `abort`, `Submission.wait`, `signal`, `waitForTask`, `waitForIdle`;
spec :1030-1038). Read-only calls (`inspect`, `snapshot`, `watch`, ...) never start work.

`wake()` -> `{ active: boolean; at?: number }` (`scheduler.ts:568`; spec §5.6 :2909-2949): `active` while some task can
run now or is running (incl. pending recovery reconcile); `at` = earliest sleep deadline. Parked work (sleeping
on signals only, waiting, completing, blocked) counts as neither. With `onWake`, no timers are armed for sleeps: the
host arms an alarm and calls `resume()`; this is how the Cloudflare Durable Object example works (README:~125-165,
`test-workers/`). Without it, a foreground timer resumes sleepers and keeps a Node process alive
(`timers.ts`, spec :2879-2899).

Host rules from spec §5.6: arm the recovery alarm *before* any call that can make an idle Session active (submit,
signal, compact, abort, registry change, resume); an early alarm is harmless, a missing one strands work; a host
that exits when idle must hand `at` to something durable first; set a fallback alarm before `Harness.open` because
open itself can fail.

### 2.2 Admission: submit -> inbox -> run

`conversation.submit(draft, ctx)` -> `Submissions.submit` (`harness/submissions.ts:66`) -> `admitSubmission`
(:220-300) inside one commit:

1. **Idempotency**: `draft.requestId` is looked up with `tx.submissionByRequest(conversationId, requestId)` (:229);
   a hit returns the existing submission without writing (reusing a requestId for another type throws).
2. Display-only writes (only `kind`/`data`) append immediately and settle `done`, even mid-run (:243-250).
3. Else read `pi.live.run`: busy => `whenBusy: "reject"` throws `ConversationBusy` (:264); idle with
   `whenIdle:"reject"` throws `ConversationIdle` (:265); `continue` while busy throws `ConversationBusy`.
4. Idle + empty inbox: place `pi.user` entry, `startRun` (creates a `pi.generation` task and sets `pi.live.run =
   { taskId, inputs:[id], turns:0, first }`). Otherwise create a `queued` submission and push an item onto
   `pi.inbox` (`mode: steer|followUp|write`).

Draft shape (`harness/types.ts:81-132`): `{ type:"input", content, whenBusy?: "steer"|"followUp"|"reject",
whenIdle?: "reject", onAbort?: "withdraw"|"keep", entry?, requestId?, notify? }`, `{ type:"write", entry }`,
`{ type:"continue" }`.

`Conversation.admit(tx, draft)` (renamed from `submit(tx, ...)` in Unreleased) admits *inside the caller's commit*, so
host checks + admission + host-state writes are atomic; must precede the commit's first table write else
`ReadAfterWrite` (spec §4 :1973-1980; example `34-submit-in-commit.ts`). This is the idiom for "check quota/mute list and
admit in one transaction".

Boundaries (spec §6 :3256-3321): at a `postTools` boundary writes and selected steers are placed (steeringMode
`one-at-a-time` default); at `final` writes, steers and follow-ups are placed and start the next run. A queued
`reset` at a boundary ends the run (`unanswered:reset`). Stale head writes settle `unanswered:stale`.

### 2.3 Generation task (`harness/generation.ts`, spec §8.3 :5366-5668)

`GenerationTask` (`generation.ts:184`, version 3) phases (`GenerationCheckpoint`, :74-160):

| phase | what it does |
|---|---|
| `prepare` (:~203) | resolve agent once (`runtime.agent`), find model (`runtime.models.getModel`) else `failNoModel`; check blocking/background compaction thresholds; if context does not end in user/toolResult -> `nothing_to_answer`; render system sections via `runtime.env()` and `agent.sections`; one commit appends needed `pi.system` entries and moves to `request` pinning `{model, thinkingLevel, streamOptions, cutoff}` |
| `request` (:289) | if `task.restarts !== undefined` -> the previous attempt was cut off: `interrupted()` (:572) charges a retry or ends the run `interrupted`; else convert any stored partial into an aborted `pi.assistant`, set `pi.live.generation` (deferred commit), run `beforeRequest` hooks, `runtime.models.streamSimple(...)` (:811) streaming partials into `pi.live.generation.message` every 100 ms (deferred), then `classify()` (:829) |
| `retry` | durable backoff via `sleepUntil` (`retryDelayMs(policy, attempt)`); default `{enabled, maxRetries:3, baseDelayMs:2000, maxAgentDelayMs:60000}` (`harness/agent.ts:23`) |
| `poll` | provider "deferred" responses: stored handle + `pollAt`; `models.fetchDeferred()`; a crash during the fetch is charged as an attempt but the *same* deferred response is polled again |
| `tools` | `waiting{on: tool tasks, allSettled}`; sequential rounds create one tool task at a time via `pending[]`; on wake runs `finishToolRound` |
| `afterTools`, `yield`, `finish`, `drain` | hook-created child tasks (reviews, post-run tests, human questions); see §7 |

`classify` (single commit, clears the partial): `stop|length` -> append answer + apply final boundary + settle inputs
`done` (unless `onYield` tasks keep them open, or `afterRun` hooks defer `run` removal); `toolUse` -> append
assistant entry, create one `pi.tool` task per call (owned by the generation), `pi.live.tools` slots, bump
`run.turns`, `waiting`; `error` that `isContextOverflow` -> blocking compaction (owned by the generation) then retry
once; retryable error -> `retry` phase; other error -> inputs `unanswered:model_error`, run ends.

Settled-run facts: `Submission.wait()` resolves at the answer, which with `afterRun` hooks is *before* the
conversation is idle (spec :5502-5504, :7121-7124).

### 2.4 Tool task (`harness/tool.ts`, spec §8.4 :5670-5805)

`ToolTask` (`tool.ts:156`, version 4). Checkpoints: `call -> execute -> (parked)`.

- `call` (:170): read call from the assistant entry (`runtime.entry`), `cutOffTooOften` check, resolve the tool among
  the phase agent's `tools` (missing => `tool_unavailable` result, run continues), `prepareArguments`, validate with
  pi-ai `validateToolArguments`, run `beforeTool` hooks in extension order (first `block`/`sleep` wins, throw => block),
  re-validate, **commit intent** `{phase:"execute", arguments, replay: tool.replay ?? "unsafe"}` (:208), then `run()`.
- `execute` phase is *reached only by recovery* (:240-267): rerun only if both stored and current policy are `"safe"`
  (clearing progress), else append an `interrupted` error result built from the slot's durable partial
  output/details/diagnostics and end `failed`. So **a replay-unsafe tool (the default, e.g. `bash`) is never repeated
  after a crash**; the model sees "Tool X was interrupted and may have partially run".
- Restart limit: a task cut off `settings.restartLimit` (default 5, `harness/agent.ts:61`) times in a row without a
  state change ends with a `restart_limit` result (spec :2555-2564).
- Results: one `pi.tool-result` entry + slot `done` + `{entryId, control}`; `durationMs` spans first start to result
  (parks and crash downtime included). Three result channels: `output` (model), `structuredOutput` (programs / nested
  callers), `details` (UI) (README:~345-360). Controls: `terminate`, `handoff` (new context mid-run), `addTools`
  (loads deferred tools; used by `tool_search`).
- Nested calls: `api.executeTool(name, args, ctx, {key, wait, progress})` runs another tool as an owned child task,
  keyed for reattachment after a crash; `NestedCallDoc` holds the result until the caller settles (README:~372-385).
- **Parks** (new in 1.6.0, susp §4): `execute()` may return `{kind:"sleep", signals?, until?, checkpoint?}` or
  `{kind:"wait", on, policy, checkpoint?}`; the call then holds no invocation, `pi.live` slot shows
  `sleeping|waiting`, and a restart while parked runs no tool code, even for a replay-unsafe tool. On wake `execute`
  reruns with `api.wake` and `api.checkpoint`. Optional `cancel(args, api, ctx)` cleans up external work on abort.
  Footgun: a crash before the park is stored reruns a replay-safe `execute()` (use a memoized idempotency key);
  a first run cut off before parking runs no `cancel` (spec :7118-7123).
- Hooks around it: `afterTool` replaces every result the task writes (incl. harness-written error results, told apart
  by diagnostic code). Wrappers (`wrapTool`) decorate execution and never park.

Tool registration surface (`harness/types.ts:425-470`): `defineTool({ name, description, parameters (JSON Schema via
pi-schema), execute, replay?, executionMode?, prepareArguments?, structuredOutputSchema?, callers?, deferred?,
outputLimits?, cancel? })`. `ToolExecutionApi` (:294) gives `env`, `output()`, `details()`, `diagnostic()`, `commit()`,
`memo()`, `readSignal()`, `createTask()`, `conversation(id)`, `executeTool()`, `models`, `agent()`, `now()`,
`taskId`, `callId`, `wake`, `checkpoint`.

### 2.5 Tool rounds, turn limit, reset/handoff, continue (spec §8.5 :5806-5860, §6)

On `tools` resume, one commit: applies `control.addTools`, handles `handoff` (appends `pi.reset` of the last one and
continues), `terminate` (all results asked, or an `afterTools` task said so), `maxTurns` (run ends `unanswered:turn_limit`,
`runFailure` recorded), else removes `tools`, applies the `postTools` boundary and creates the next generation task
handed `pi.live.run`. `{type:"continue"}` resumes a failed run without a user message; check
`pi.live.runFailure` and idle first (README:~655-668).

### 2.6 Compaction (`harness/compaction.ts`, spec §8.7 :5895-6086)

`CompactionTask` (`compaction.ts:116`): phases `select -> summarize -> retry`. Three triggers: manual
`conversation.compact(instructions)`, background threshold (generation starts it, conversation-owned,
`backgroundTokens` below the blocking threshold, summary placed via a *write submission*), blocking
threshold / overflow (generation-owned, generation waits). Defaults: `{enabled:true, reserveTokens:16384,
keepRecentTokens:20000, backgroundTokens:32768}` (spec :2336-ish; `agent.ts:30`). Range selection is a pure function of
the `ContextView`; summary is a `pi.compaction` entry with `head`; raw entries remain. Stale ordering is enforced by the
head-staleness rule (spec §6). Per-conversation override in `pi.agent.compaction`; `modelOverrides` keyed by
`provider/modelId`. Spend counted in `pi.usage` even when the summary ends stale. `beforeCompact` hook can decline or
supply a summary.

### 2.7 What survives a crash, and exactly what recovery does

Persisted per commit (atomic): entries, task records (state + checkpoint + memos + restarts), submissions,
documents, signal values (inside task record). Not persisted: in-flight HTTP/model stream, in-memory tool state,
progress newer than the deferred window.

Deferred commits (spec §4.1 :2013-2095): the Harness defers exactly two kinds of writes - generation partials and
running tool output. They are visible to watches immediately but stored with the *next commit that reads `pi.live`* or
within `settings.progress.persistWithinMs` (default 1000 ms), at close, or on tracker drop. A crash loses at most
~1 s of streamed text / tool output; a stream that crashes in its first second may leave no aborted entry, and that
attempt's usage is not recorded (README:~513-516).

Recovery sequence after process death:

1. New process opens the same Storage; `TaskScheduler.open` turns every `running` task into `pending, restarts+1`
   (`scheduler.ts:508-511`). `sleeping`/`waiting` tasks stay parked; `completing`/`failFast` waits are re-evaluated.
2. `resume()` (or any progress call) enables reservation; the registry must contain the same extensions or tasks stay
   blocked (they are not terminalized).
3. `pi.generation` in `request`: `task.restarts !== undefined` => attempt charged as failed: partial converted to an
   aborted `pi.assistant`, sleep to `retry` if the policy allows else run ends `runFailure.reason = "interrupted"`
   (generation.ts:292, :572; spec :5424-5447). A *close* (graceful) is not counted and simply resends the same
   committed messages with the same pinned model/options.
4. `pi.tool` in `execute`: rerun iff replay `safe` on both sides, else `interrupted` result (see §2.4). `parked` calls
   resume normally. Nested calls reattach by key for safe callers; non-safe callers' unfinished nested children are
   aborted via `abandonOnRestart` on the first scheduling pass (spec :2640-2662).
5. Held deferred state is lost; derived entries were normal commits so nothing is converted twice.
6. Crash loops: `restarts` increments per crash with no progress; at `restartLimit` (default 5) the task ends visibly
   (`restart_limit`), reported as `task_interrupted`.

Exactly-once / idempotency guarantees (be precise):

| Thing | Guarantee |
|---|---|
| Commit | Atomic, once stored it is published once, in line order (spec :60-70). |
| `submit()` with `requestId` | Exactly-once per conversation, also across restart (dedup is a storage lookup in the admitting commit, `submissions.ts:229`). Without requestId a retried submit duplicates. |
| `createConversation`/`fork` | Atomic; no request id, so a host that can crash between create and first submit must find its conversation via a key written in `init` (spec :1092-1100). |
| Task checkpoints | At-least-once phase execution; effect sandwich + memos give idempotency (spec §5.2). |
| Tool execution | At-most-once for replay `unsafe` tools (default); at-least-once for `safe`; intent is committed before `execute()`. Nested calls: reattach by key, but an interrupted nested call follows its own replay policy ("not exactly-once", `harness/types.ts:~360`). |
| Model requests | At-least-once: an in-flight request at crash is charged as a failed attempt and retried (a second billed request is possible). Deferred (provider-side async) responses are polled again, not re-requested. |
| Signals | Stored in task record; duplicate/closed on repeats. Exactly one wake per key. |
| Storage commit outcome | A rejected `commit()` call is an *unknown outcome*; host reuses `requestId`s after reopen (spec :6858-6860). |

---------------------------------------------------------------------------------------------------------------

## 3. Storage

### 3.1 The interface (`types.ts:1376-1492`, spec §10 :6603-6850)

One **write** method, many reads:

```ts
commit(batches: StorageWrite[][], receive:(index,seq)=>void, ctx): Promise<
  {kind:"stored",stored:number} | {kind:"refused",stored:number,refused:unknown}>   // types.ts:~1400
publishing?(publish: ()=>void, ctx): void       // optional; run the Session's publication inside the backend's scope
mintId<I>(): Promise<I>                         // global monotonic numeric ids
conversation(id), scanConversations({ownerConversationId?,ownerTaskId?,order?}, limit, cursor)
entry(id) / entry(convId,id) -> {entry, commitSeq}; findLatestHeadMarker(convId, atOrBefore?); scanEntries(query, limit, cursor)
task(id), scanTasks({conversationId?,kind?,status?,abortRequested?,background?,order?})
submission(id), scanSubmissions(...), submissionByRequest(convId, requestId)
findDocument(address, at), document(id, at) -> StoredDocument, scanDocuments({scope, at, kind?})
close()
```

`StorageWrite` (types.ts:946): `conversation | entry | task | submission | document.create | document.copy |
document.change | document.retire`. Task and submission writes are *replacements of the full record*.

Contract obligations for a custom backend (spec :6603-6760):
- Each batch is one atomic commit with its own `seq`, checked against the state earlier batches left. On the first batch
  Durable's own checks refuse (global-id collisions, document-action consistency, copy-source resolution) stop, keep
  earlier batches, return `refused`. Any *other* failure must **reject** (unknown outcome) and store nothing it can roll
  back. No savepoints are required (Durable Object SQL forbids them).
- Call `receive(index, seq)` once per stored batch, in order, synchronously, after all are durable and before the
  next call; `receive` calls no Storage method and never throws. "A receipt is not publication."
- Every batch has >=1 write; empty commits never reach storage.
- Reads return detached JSON; commit args are borrowed until the call settles.
- `mintId` > every id stored or minted; must persist across reopen.
- Cursors are backend-owned opaque JSON objects honoring `order`; entry scans must apply fork ancestry caps and
  `order` (oldest-first reads root segment then each fork).
- Documents: base + ordered delta tail per incarnation; `document(id,"current")` returns undefined for retired;
  numeric `at` for rewindable docs reconstructs history; "missing base / version change inside a delta tail / unapplicable
  op" = corruption, not absence. One batch contains at most one create/change per incarnation plus optional retire;
  deltas cannot cross a version boundary.
- A storage error from any method is **final** for the Session (nothing retries; the backend must retry transient
  errors itself). Only `StorageRequestError` (bad cursor/unknown id) and cancelled reads are exempt, reads only
  (`errors.ts:33`; spec :6848-6900).
- Conformance: `registerStorageConformance({describe,expect,it}, name, use)` from `@earendil-works/pi-durable/testing`
  (`testing/storage-conformance.ts`, 2148 lines). `registerEnvConformance` exists for envs. There is a storage
  benchmark (`testing/storage-benchmark.ts`).

### 3.2 Backends

| Backend | File | Notes |
|---|---|---|
| Memory | `storage/memory.ts` (895) | Reference semantics; copies on write and read. `MemoryStorage` exported from root (`index.ts`). |
| SQLite | `storage/sqlite/{storage,commit,rows,statements,migrations,schema}.ts`; `/node` (node:sqlite via chord), `/cloudflare` (DO SQL) | Tables `record_ids, conversations, entries, tasks, submissions, documents, document_revisions` + `durable_schema/metadata` (`schema.ts:9-17`). One SQL transaction per `commit()` call; multi-row inserts through `json_each(?)`/`json_extract` (`commit.ts:181-310`, `statements.ts:1-54`), i.e. **SQLite dialect**. WAL + `synchronous=NORMAL` (README:~920): survives process crash, newest commits can be lost on power/host failure. Optional table-name `prefix`. Abstracted behind `SqliteDatabase` (`exec/run/get/all/transaction/close`; type from `@earendil-works/chord/sqlite`) so Bun/D1-like drivers can plug in. |
| JSONL | `storage/jsonl/{storage,node}.ts` (967) | `main.jsonl` + `doc-<id>.jsonl` + `task-<id>.jsonl` sidecars; marker-after-sidecar publication; keeps *whole history in memory*; `fsync:true` option; `readOnly:true` open for viewers (open otherwise *repairs* files); uses portable `FileSystem`. Not compacted. |
| IndexedDB | `storage/indexeddb.ts` (1275) | Browser; one `readwrite` txn per call; hold a Web Lock for single owner. |
| Cloudflare DO | `storage/sqlite/cloudflare.ts` | `openDurableObjectSqliteStorage(ctx.storage)`; `DurableObjectSqliteDatabase` shares the op queue with host tables. |
| Store | `storage/store/*` (`StoreStorage`) | Durable inside a Chord host's `ChordStore` (also SQLite, via `SqliteExecutor`); one commit queue and id allocator shared with host tables; implements `publishing()`. Example `35-durable-on-the-store.ts`. |

**There is no Postgres (or any networked-RDBMS) backend in this repo**, and the SQLite one is dialect-bound. A Postgres
backend is a from-scratch `Storage` implementation (or a `SqliteDatabase` facade over something SQLite-compatible, e.g.
libSQL/Turso/D1). See §9 for what to implement. Practical shape (derived from the SQLite one): ~8 tables
(records by type with indexed columns for the scan filters; `record_ids` for global id ownership; documents +
document_revisions for base/delta chains), `next_seq` and `next_id` counters, one transaction per `commit()` call,
checks done in memory against rows read up front.

### 3.3 Transactions, group commit, caches

- **Mutation line** (spec §4 :1852-2011; `session/session.ts`): commit callbacks run one at a time, may be async, and
  must not await models/network/humans or call Session reads (those queue on the same line and hang, spec :7149-7165).
  `MAX_OUTSTANDING = 256` jobs awaiting outcome (`session.ts:122`).
- **Group commit** (`docs/group-commit.md`, `session/writer.ts`): the line *admits* a commit logically and moves on;
  a writer off the line sends every commit admitted while no storage call is in flight as one `Storage.commit(batches)`
  call, then publishes them one by one in line order. A job that touches a key an unpublished commit wrote waits for it.
  Measured in the design doc: 26.8 runs/s at 4 ms storage RTT with 32 concurrent conversations without grouping;
  modeled ~250 runs/s with it (group-commit.md:12-16); SQLite impl reduced to a few SQL statements per call (CHANGELOG
  1.5.1). This is why a remote DB is viable but RTT-sensitive.
- **Publication** order (spec :1920-1960): caches, trackers, telemetry events, Session's own observers, scheduler,
  submission waits; then host `observeCommits()` observers one microtask later; watch listeners later still.
- **Read-your-writes rules** (spec §4 :1996-2011): table reads allowed before the first table write; after it they throw
  `ReadAfterWrite`; document access always allowed.
- **Caches**: `session/cached-storage.ts` (record cache), `session/conversation-tails.ts`, scheduler "kept context
  ranges" (`contextRetentionMs`, default 600 000), document tracker retention (`documentRetentionMs`, default 600 000;
  observed docs never evicted).
- **Failure** (spec §10.1): any storage error closes the Session (`SessionFailed` for later calls, watches end `failed`,
  tasks get abort signal, `onReport` once, `harness.closed` settles `{kind:"failed"}`); host reopens.

---------------------------------------------------------------------------------------------------------------

## 4. Env abstraction

### 4.1 Interface (`env/index.ts`)

`ExecutionEnv extends FileSystem, Shell` (`env/index.ts:377`). Both are returning-`Result<T,E>` (never throw for
expected failures; `ok/err/getOrThrow` helpers).

`FileSystem` (:212-300): `id: string` (namespace identity: "equal ids see the same files at the same paths"; edit/write
serialize per `id`+path), `cwd`, `absolutePath`, `joinPath`, `readTextFile`, `openTextLineReader`, `readTextLines`,
`readBinaryFile`, `openBinaryReader(path,{noFollow})` -> `BinaryReader{info,read(offset,len),scanLines,close}` (:96),
`writeFile`, `appendFile`, `truncateFile`, `flushFile`, `renameFile`, `fileInfo`, `listDir`, optional `listFiles` (git-ignore
aware, bounded), `openDirReader`, `watch(targets,onChange)` -> `FileWatcher{mode: native|polling}`, `canonicalPath`,
`exists`, `createDir`, `remove`, `createTempDir`, `createTempFile`, `cleanup`.

`Shell` (:362): `exec(command: string | string[], {cwd,env,inheritEnv,timeout,onOutput(text,ctx,{stream,skipped}),
spill:{afterBytes,afterLines}, window}, ctx) -> Result<{exitCode,spillPath?}, ExecutionError>`, plus `cleanup()` that
kills every command the env still runs. A string runs through the env's shell; an array runs argv directly with no
shell. `window` lets a remote env drop output outside the tail the caller keeps (bandwidth control).

Env is intentionally **not** a sandbox API: no network policy, no resource limits, no user switching, no mount control.
It is a "where do files and processes live" abstraction.

### 4.2 Node implementation (`env/node.ts`)

`NodeExecutionEnv({ cwd, shellPath?, shellEnv?, watch? })` (`env/node.ts:612`), `id = "node:local"` (:~614), spawns
`bash -c` (or `sh`) with `detached:true` process groups (:286-291, :812-815), kills groups on abort/timeout/cleanup, spills
long output to a temp file. **No sandboxing**: runs with the host process's privileges; absolute paths anywhere are
reachable; `inheritEnv` defaults to inheriting the host's environment (`bash.ts` `prepareExecution` sets
`inheritEnv:true`, `tools/bash.ts:~88`). In a multi-tenant server this must never be used directly.

### 4.3 How tools reach the host

Built-in tools touch the host only via `api.env` (`tools/env.ts:5-8` `requireEnv(api)`; absence => ordinary error result):
`read`, `write`, `edit` (serialized by `tools/file-mutation-queue.ts` keyed by env `id`+path), `bash`/`powershell`
(`tools/bash.ts`). `bash` calls `env.exec(command, {cwd: env.cwd, inheritEnv, window: api.outputWindow, spill})`
(`bash.ts:~120`). `BashToolOptions.prepare` can rewrite command/cwd/env per call (e.g. inject secrets, wrap in a
sandbox command). `read` supports images through an optional `ImageProcessor` (`/images/node` worker thread,
`/images/cloudflare`, or a custom one). Code mode (`/codemode`) runs model-written JS in a QuickJS sandbox
(`pi-codemode`), where each `tools.x()` call becomes a nested `pi.tool` call; the *only* host access is through the
registered tools (and it journals results for deterministic replay).

How the Harness builds an env (`harness.ts:297`): `buildEnv(id)` reads `pi.agent.cwd` and calls `options.env({
conversationId, cwd, read }, ctx)`. Called at *each use* (every tool execution, every prompt preparation,
`runtime.env()`); never on the Session line; a throw becomes the tool's error result. A recovery rerun builds the env
again with the conversation's *current* `cwd` (spec footgun :7258). So the host caches expensive envs (one per
conversation/container). The `read: DocumentReader` argument lets the factory look up per-conversation app documents
(spec :1162-1188 example: `ContainerDoc` -> container-backed env vs local).

### 4.4 Backing the env with a remote container/VM

Two ready-made paths:

1. **`packages/env` (`@earendil-works/pi-env`)** (outside durable but its stated purpose is Durable): a Rust
   `pi-env` daemon (`packages/env/daemon/`) speaks a framed binary protocol on stdin/stdout
   (`packages/env/docs/protocol.md`: `u32 length | u8 type | u32 id | u32 jsonLength | json | bytes`; request/result/
   error/event/cancel/ping frames; 16 MiB frames; cancel kills the process group). `RemoteExecutionEnv({connection,
   id, cwd})` implements `ExecutionEnv` against it (`packages/env/src/remote-env.ts`); `Connection` takes any
   `command: string[] | (() => Promise<string[]>)` (`connection.ts:76-82`), so the transport can be `ssh`, `docker exec
   -i`, `kubectl exec -i`, or a VM agent's exec channel - anything that gives a bidirectional byte stream to the
   daemon. `connectSsh`/`sshConnection` auto-deploy the daemon (named by SHA-256, verified) and pin host keys.
   Also provides `openTerminal` (pty), `openProcess` (pipes, e.g. MCP servers), `LocalExecutionEnv`. Runs Durable's env
   conformance suite plus differential tests against `NodeExecutionEnv`. Credentials/storage stay local to the Durable
   worker; only file ops and commands run remotely - the shape a "harness outside, sandbox inside" cloud agent wants.
2. **Hand-written `ExecutionEnv`** over a provider API (e.g. a sandbox vendor's file/exec RPC). Must set a stable
   `id` per container (shared id = shared files), implement ~25 FS methods + `exec`, and pass
   `registerEnvConformance` (`testing/env-conformance.ts`, 633 lines). `watch` and `listFiles` are optional
   semantically (`not_supported`/polling mode).

Per-conversation envs: example `28-sandbox-per-conversation.ts`; and `25-coding-agent.ts` for env following
`pi.agent.cwd`. Sandbox lifecycle (create/pause/destroy a VM) is not modeled by Durable; `ExecutionEnv.cleanup()` is
"shutdown the environment object", and the Harness never calls it for you.

---------------------------------------------------------------------------------------------------------------

## 5. Public API surface (what a server calls)

Everything is `async fn(..., context: Context)`; `Context` is Chord's (carries abort signal + telemetry span;
`BACKGROUND_CONTEXT` never cancels, `README.md:55-57`). Cancelling a wait never cancels the work.

### 5.1 Bootstrapping a session

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const models = createModels(); models.setProvider(openaiProvider());
const registry = createRegistry(); registry.install(CodingTools);
const harness = await Harness.open(
  await openNodeSqliteStorage("./session.sqlite"),
  { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }),
    settings: { retry: { maxRetries: 3 }, toolExecution: "parallel" }, onReport: log, onWake },
  context);
const root = await harness.root(context, { agent: { model: { provider: "openai", modelId: "gpt-6-sol" }, cwd: "/work" } });
harness.resume();           // recovery: continue whatever the last process left
```
(README:36-47, 105-113, 548)

### 5.2 Submit, wait, stream, interrupt

```ts
const sub = await root.submit({ type: "input", content: "Fix the test", requestId: "msg-8f2c" }, context); // dedup key
const settled = await sub.wait(context);   // {status:"done", answer: EntryId} | {status:"unanswered", reason, detail}
// later, after a restart:
const again = await (await harness.submission(sub.id, context))!.status(context);

// stream: committed state only
const watch = await root.watch(context);                // ConversationView: entries window + docs[...]
render(watch.value);
watch.start(async (call) => {                           // call.kind==="value": {value, ops, retired}
  const live = call.value.docs["pi.live"] as LiveState; // live.generation?.message (partial), live.tools[].output
  send(call.ops);                                       // Chord delta ops to remote client
});

await root.abort(context);                // Stop: withdraws queued inputs, aborts tool/generation tasks, resolves when idle
await sub.abort(context);                 // withdraw only a still-queued submission
await harness.abortTask(taskId, context); // one task
await root.reset("handoff text", context);
await root.compact("keep failing test names", context);
await root.submit({ type: "continue" }, context);   // resume after runFailure
await root.configure({ model, thinkingLevel: "high", instructions, cwd, tools: {remove:[bash]}, maxTurns: 50 }, context);
const fork = await root.fork(entryId, { ownership: { kind: "ownerless" } }, context);
const other = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: {...}, init }, context);
```
(README:640-700, 714-760, 812-860; `harness/types.ts:916-988`; `view.ts:36-48` for the view shape.)

### 5.3 Answering a human gate

```ts
const result = await harness.signal(taskId, Approval, key, { allow: true }, context); // delivered|duplicate|invalid|closed|not_found
```
`taskId` + `key` come from whatever UI shows the question (see §7). Also in a transaction: `tx.signal(...)`.

### 5.4 Resume after restart, close, liveness

```ts
const harness = await Harness.open(storage, opts, context);   // recovery scan happens here
harness.resume();                                             // start scheduling
harness.wake();                                               // {active, at?} -> arm an external alarm
harness.closed.then(end => { if (end.kind === "failed") reopen(end.error); });
await harness.close(context);                                 // joins invocations; running tasks written back `pending`, no restart counted
```

### 5.5 Listing / inspecting

There is **no "list sessions" API**: a Session is one Storage. Within one Harness:
- `harness.commit(tx => tx.scanConversations({ownerTaskId?}, limit, cursor))` or `conversation.commit` for conversation
  listing (`Tx.scanConversations`, `types.ts:~1028`); `harness.conversation(id)`; `conversation.entries(query,limit,cursor)`
  (cursor pages of fork-aware history); `conversation.context()` (model context); `harness.getTask(id)`;
  `harness.inspect()` -> live tasks (with blocked reasons) + queued/placed submissions; `harness.usage()`;
  `harness.watchTaskGraph()`; `harness.snapshot(Doc, id)`; `harness.observeCommits(observer)` gives every stored commit
  (suitable for replicating/exporting to a read model).
- Across sessions, the host must keep its own index (session id -> storage location -> metadata). Durable provides
  `HarnessOptions.conversationCreated(tx, conv)` and `init` hooks to write app documents atomically with creation, and
  `defineDoc` with `scope:"session"` for session-level app metadata.

### 5.6 Client-side transcript helper

`ConversationTranscript` (`harness/transcript.ts`) merges successive `ConversationView` values into a gap-aware item
list ("load earlier", "fill gap"), and gives `resume` info for `watch(context, resume)` after a reconnect
(README:~560-585, example `31-transcript.ts`).

### 5.7 Reading `Models` and providers

`HarnessOptions.models: Models | () => Models` is read at *each use* (generation, compaction, `api.models` in tools and
hooks), so credentials/provider tables can change without reopening (spec :1006-1013 area; `README.md:60`).
`pi-ai`'s `createModels({credentials, authContext})`, provider auth through `CredentialStore` and env vars
(`packages/ai/README.md:378-540`). `HarnessOptions.identity` sets provider attribution headers.

---------------------------------------------------------------------------------------------------------------

## 6. Concurrency and multi-client

**Within one process** (the supported case):
- All writes to a Session funnel through one mutation line (`session.ts` `#tail`); commits are totally ordered by
  `Seq`; entry/task/submission ids are totally ordered global numbers. Any number of clients can call `submit`,
  `signal`, `abort` etc. concurrently; ordering = line order. There is no per-client identity or permission in
  Durable: `owner` on conversations "records task attribution... is not an access-control capability" (spec :287-288).
- **Submissions and an agent in mid-run**: a second client's input while a run is active is queued (`steer` placed
  after the current tool round, `followUp` placed when the run answers; `reject` throws). Writes (chat messages, notes)
  are appended immediately. Everyone's inputs are recorded as separate submissions; only the Harness appends to a busy
  conversation (spec :7109-7114 footgun).
- **Observation**: `Conversation.watch()` / `watchDoc()` / `watchTaskGraph()` return Chord `WatchHandle`s: value at
  attachment + `{value, ops}` per callback, one callback at a time; commits that land during a callback are *folded*
  (appends joined, field sets keep last); past 10 000 pending ops the callback gets a root replacement; late joiners
  and reconnects start from current state (nothing is replayed; use `ConversationTranscript.resume` / `from`).
  A watch ends once (`stopped | aborted | ended | listener_error | failed`).
- `observeConversation/observeTaskGraph/observeDoc` = *synchronous* in-commit observers for adapters (they run inside
  publication and must not await); `observeCommits` = one callback per stored commit, with exactly what was stored (`CommitPublication`).
  This is the right hook for fan-out to remote clients that need a precise change feed or a replica.
- Each watch is per-process; to serve many remote clients a server attaches one watch per (conversation, window) and
  broadcasts ops (they are plain JSON). `ConversationWindow {from, min:50, max:100}` bounds payload.

**Across processes**: unsupported. README:~1010: "One process writes a storage at a time; there is no cross-process
locking." Opening a second writable Harness on the same storage would, in `open`, rewrite another process's `running`
tasks to `pending` and then run them too (scheduler.ts:508) -> double execution. Viewers use `readOnly:true` (Harness)
and, for JSONL, `{readOnly:true}` storage; a read-only open recovers nothing, all writes reject `ReadOnlySession`.
A host needs an external lease/fencing (e.g. DO single-instance guarantee, advisory lock, DB lease row) per Storage.

Idle/evict story: parked work needs no process; closing and reopening is cheap for signals ("a signal for a Session
whose process is gone is delivered by starting it and opening the Harness first", spec :2940-2943), but `open` scans
and loads every live task into memory (scheduler.ts:496-518), and JSONL/Memory keep all history in memory.

---------------------------------------------------------------------------------------------------------------

## 7. Human-in-the-loop hooks

Durable has **no built-in permission prompt, `ask_user` tool, or approval UI**. It supplies *primitives* (susp §1,
spec §5.7, §7.2) and examples (tests `38`-`46`); product semantics live in extensions. The suspendable design doc
says explicitly that composing plugins' gates, ordering, quotas is "the host's design (p2, p3), not Durable's"
(`docs/suspendable/spec.md:9-11, :883-899`).

Primitives, from lightest to heaviest:

1. **Gate before a tool runs** - `beforeTool` hook returns `{ block: "reason" }`, `{ arguments }` or
   `{ sleep: { signals, until } }` (`harness/types.ts:1186+`, `GateSleep` :1183; `tool.ts:184-205`, `parkAtGate`). The call
   is parked at phase `call`, slot `sleeping`, no invocation held. On *every* wake, registry publication and open, the
   whole `call` phase (all `beforeTool` hooks) runs again; gate must be idempotent, memoize its deadline
   (`api.memo`), read its answer with `api.readSignal(Token, key)`. Host delivers `harness.signal(taskId, Approval, key,
   {allow})`. Expiry arrives as `SignalState.kind === "expired"`. Reference: `test/examples/44-approval-gate.ts`
   (keyed by digest of arguments so a changed argument asks a new question; a second quiet-hours gate re-asked each
   wake). Caveat: approval binds to the arguments it saw; a later hook that rewrites arguments can run with
   unapproved arguments - order extensions accordingly (README:~800).
2. **Tool that asks and waits** - a tool's `execute()` returns `{kind:"sleep", signals:[Answer.key("answer")],
   until, checkpoint}`; reruns with `api.wake` set; result = the answer as tool output. This is the "ask the user a
   question" tool pattern. `cancel()` cleans up. Examples `40`, `41`, `43`. The question text itself is not stored by
   Durable: "What a parked task waits for, beyond keys and deadlines... is kept by whoever started the wait"
   (susp §7 :858-868). Examples keep it in an in-memory map (`44-approval-gate.ts:50-51`, `39-ask-a-person.ts` `inbox`);
   a real host should keep it in a durable document keyed by `(taskId, key)` written in the same commit as the park
   (use `api.commit()` before returning the park, or `defineDoc` task/conversation scope).
3. **Hook-created tasks** (`afterTools`, `onYield`, `afterRun`; `hookTask(Task, input)`): human review/approval as a
   task that sleeps on a signal. `onYield` tasks decide whether the final answer stands while inputs remain open
   (`{continue: "..."}` sends the agent back); `afterTools` task can answer `{terminate:true}` or submit a steer;
   `afterRun` runs after the answer (tests, delivery). Examples `45`, `46`, `32`.
4. **Plain tasks** `defineTask` + `runtime.commit({status:"sleeping", signals, until})` (example `39`).
5. **Sub-conversations** for interrogating a subagent: `api.conversation(id)`, `submit` with `notify:{taskId,key}` so
   the parent tool parks on `SubmissionSettled.key("answered")` (example `43`).

How a turn waits and resumes: while any tool slot is parked, the generation is `waiting` on the tool task; the run
stays busy (new messages queue and are placed after the round; "Stop is the way out", spec :7123-7124). All of it
holds zero processes: `wake()` reports inactive, `wake().at` is the earliest deadline. After the signal commits, the
scheduler reserves the sleeper (`wake: {reason:"signal", signal, key}`), the tool reruns, the generation resumes in its
`tools` phase and issues the next model request.

Implication for "front-load questions, then run autonomously": model the front-loaded questions as either (a) an
`ask_user` park-tool the agent calls up front (works, but the model decides when), or (b) a **host-side pre-run
questionnaire**, resolved *before* the first `submit()` - the answers go into the first input / `pi.agent.instructions`
/ an app document read by a prompt `section`. (b) needs no Durable support and avoids parked-run semantics. For
autonomy afterwards: gates only on risky tool calls; set `maxTurns`, `afterFailedRun`, `settings.restartLimit`; use
`beforeTool` blocks (not prompts) for the deny-by-default policy; `onYield` reviewers for completion checks.

Missing pieces to build in the product: pending-question store/index (durable, listable across sessions),
notification delivery, timeout policy per question, authz on `harness.signal` callers, UI mapping from
`pi.live.tools[].status = sleeping|waiting` to "needs input".

---------------------------------------------------------------------------------------------------------------

## 8. Limits, gaps, experimental flags, multi-tenant problems

### 8.1 Stability / maturity
- "Experimental. The API changes without notice" (README:3); Unreleased has 7 breaking changes; `pi.tool` v4 and
  `pi.generation` v3 databases are not opened by older Harnesses (CHANGELOG:19-20). Pin an exact version and write
  migration tests; never run mixed-version workers on one storage.
- `Agent Events (Experimental)` is a README section header (TOC); the main experimental surfaces are the Unreleased
  tagged-union migrations and the suspendable primitives (parks, signals, gates) that landed in 1.6.0.
- Docs/specs have inline cross-references to apps `p2`/`p3` (the in-repo products); behavior is validated by those
  hosts, not by an independent server reference implementation.

### 8.2 Hard limits / sharp edges (selected from spec §12 and code)
- **One writer per storage, no locking** (see §6). **One Session = one mutation line**; all conversations in a Harness
  share it. 256 outstanding jobs (`session.ts:122`).
- `Harness.open` loads *all live tasks* into memory; JSONL and Memory storage keep the whole history in memory;
  documents are cached with 10-minute retention by default; kept contexts 10 minutes.
- SQLite durability: `synchronous=NORMAL` can lose the newest commits on power/host failure; JSONL default has no fsync.
  A deferred-commit crash loses up to ~1 s of stream/tool output.
- A storage error is fatal to the Session: the host must reopen; no internal retry. With a networked DB the backend must
  own retries and must not leave "unknown outcome" ambiguity (use `requestId`s).
- Tool replay default is `unsafe` (never re-executed after crash; model sees an error). Making `bash` safe is not
  possible in general; plan for an "interrupted" result and idempotent re-asks by the model.
- Model requests in flight at a crash are re-billed (retry), and a crash-looping host counts toward `restartLimit`
  (default 5) which ends runs with `restart_limit`/`interrupted`. "Every task running when a process dies is counted,
  not only the one that killed it" (spec :2556-2560): a pod OOM-killing many sessions at once can exhaust limits on
  innocents.
- Clock: sleeps store deadlines on `HarnessOptions.now`; "every process that opens one storage must use the same clock"
  (README:~110); skew between workers matters.
- Hooks/extension composition: extensions are selected *whole* per conversation; a conversation with an array selection
  that omits a guard extension runs without it - "there is no registry-wide hook or wrapper" (spec :7246-7248). Security
  guards must be enforced by constructing the agent/registry server-side, not trusting conversation config.
- Default extension selection moves with settings/installed extensions, appending `pi.system` entries and busting
  prompt cache (spec :7262-7265).
- Reserved `pi.` names are not enforced (spec :7236).
- Signals are unauthenticated; `owner` is not access control; there are no users, tenants or permissions in the model.
- Idle hold semantics: a parked tool call keeps its *run* busy; a nested call awaited with `wait:true` (codemode) keeps
  its invocation while parked (susp §11 items 8-9).
- Close joins non-cooperative code: a tool ignoring its abort signal blocks `close()` and keeps Storage open (spec :7270).
- Env has no sandboxing; `NodeExecutionEnv` inherits host env and fs. Secrets in `process.env` leak into `bash` unless
  `inheritEnv:false`/`prepare` is used.
- Reading inside a commit callback via `snapshot()`/`getTask()` deadlocks the line (spec :7149-7165) - a frequent trap
  for custom hooks/tools.
- Streaming granularity is committed state: 100 ms partials by default, one watch callback at a time, folded under
  load. There is no token-level event stream or SSE primitive; `pi.live.generation.message` is the streamed message.
- The README's Cloudflare DO example is the only shipped "hosted" pattern; there is no server, auth, queue, or
  scheduler for many sessions in this package.

### 8.3 Multi-tenant remote hosting: what looks hard
1. **Session placement / single-writer lease.** One live Harness per storage, anywhere. Needs routing (consistent hash
   or lease table) and fencing so a zombie worker cannot commit after takeover. Postgres advisory locks or a
   `lease_epoch` check inside every `commit()` would be the natural place (inside the custom `Storage`).
2. **Memory per live Harness** (live tasks, 10-min context and document caches, a QuickJS sandbox if code mode is on)
   vs. thousands of mostly-idle sessions: close idle Harnesses (nothing needs a process while parked; `wake()` tells you
   when) and reopen on demand; budget the `open()` scan cost.
3. **Tenant isolation of the env**: the biggest risk. Use per-session container/VM envs; never `NodeExecutionEnv`
   on the API host; deny `inheritEnv`; enforce network egress outside Durable; own the `env` factory and `prepare` hooks.
4. **Credentials**: `models` is per-Harness; per-tenant provider keys must be injected via a `Models` instance /
   `CredentialStore` per tenant (or a function returning a tenant-bound `Models`). Tool-level secrets belong in the env,
   not in transcript entries (`data`/`model` are stored forever, and tool args/results are stored verbatim).
5. **Cost controls**: `pi.usage` is a per-conversation ledger; no quota enforcement. Enforce through `beforeRequest`
   hooks (can only replace messages, not block - there is no "gate a model request"; "gating a model request
   (`beforeRequest` sleeping) is deferred", susp :955-957) or through host-side `admit(tx, draft)` checks in the same
   commit as admission.
6. **Fleet crash behavior**: a node-wide failure marks *every* running task as one restart (count is not per-culprit);
   in-flight model requests are re-sent. Stagger recovery (`resume()` gating) and consider raising `restartLimit`.
7. **Observability at scale**: telemetry schema (`DURABLE_TELEMETRY_SCHEMA`, `harness/telemetry.ts`) is content-free
   spans/events/metrics via `@earendil-works/pi-telemetry`; reports via `onReport`. Good seam; host must supply the backend.
8. **Data lifecycle**: history never compacts or deletes (JSONL main file not compacted; SQLite grows). No per-entry
   delete/redaction API (entries are immutable, ids never reused); GDPR-style erase = drop the whole storage.
9. **Migration / rollout**: tasks and documents carry versions; new extensions must be installed before `resume()` or
   work blocks; rolling deploys with mixed code versions on one storage are unsafe (older Harness blocks newer tasks).
10. **Cross-session features** (listing, search, quotas, sharing) are entirely host-side; Durable's `search.ts` is
    transcript text search within a Harness (see `src/search.ts`, `test/search.test.ts`).

---------------------------------------------------------------------------------------------------------------

## 9. Integration points for a remote harness (the seams)

1. **Storage backend (the main one).** Implement `Storage` (`types.ts:1376`) for Postgres or use SQLite-per-session on
   durable block storage:
   - Option A (per-session SQLite file on a volume/Litestream/LiteFS): zero new code; pairs naturally with one
     Harness per session and a lease on the volume. `openNodeSqliteStorage(path)`; consider `synchronous=FULL` via a
     custom `NodeSqliteDatabaseOptions` (`storage/sqlite/node.ts`, chord `sqlite/node`).
   - Option B (shared Postgres): write `PostgresStorage` mirroring `storage/sqlite/{schema,commit,storage,rows}.ts`:
     tables per record type with the indexes in `schema.ts:20-37`; `record_ids(id, record_type)` for global-id
     ownership; `documents` + `document_revisions(base|delta)`; counters `next_seq`/`next_id`; scope all rows by a
     `session_id` column (many sessions in one DB; each `Storage` instance bound to one). One transaction per
     `commit(batches)`: read the batch pre-state in a few statements (`= ANY($1)` replaces `json_each`), run
     `checkGlobalIds/checkDocumentActions/resolveCopies` logic (port from `storage/sqlite/commit.ts`), insert per table in
     bulk (`unnest`/`jsonb_to_recordset`), call `receive(i, seq)` after COMMIT; return `refused` for Durable's own
     refusals, reject for everything else. Implement `scanEntries` with ancestry caps and `findLatestHeadMarker` with
     the entry-head index; opaque cursors; `submissionByRequest` unique index `(conversation_id, request_id)`. Keep
     RTT low: group commit sends everything admitted during a round-trip as one call, so use a single connection
     with pipelined statements or a stored procedure. Run `registerStorageConformance` and the storage benchmark
     (`testing/storage-benchmark.ts`). Add a lease/epoch check to fence zombies. Optionally implement `publishing()`
     if the host has its own batching scope.
   - Option C (`StoreStorage` on Chord's store): the intended path for p3; same SQLite-underneath.
2. **Env/sandbox.** `HarnessOptions.env({conversationId, cwd, read}, ctx)`: return a cached `RemoteExecutionEnv`
   (pi-env daemon over `docker exec -i`/`ssh`/your VM agent) or a custom `ExecutionEnv`. Keep per-session sandbox
   metadata in an app document (`defineDoc`, scope conversation or session), read via `target.read`; create the
   sandbox lazily on first tool call and tear it down in your own lifecycle (Durable never calls `env.cleanup`).
   Add `bash` `prepare` to scrub env vars; pick `env.id` = sandbox id for correct file-mutation serialization.
3. **Models / providers / credentials.** `HarnessOptions.models` (value or function), `identity`, per-tenant
   `CredentialStore`. Model selection is per conversation via `configure({model})`; thinking level and stream options
   (`settings.stream`, `ConversationStreamOptions`) are host policy. Deferred (batch) provider responses are supported
   (`poll` phase).
4. **Transport to clients.** Durable gives committed state and Chord delta ops, no wire format. Use `Conversation.watch`
   (or `observeCommits` for exact commit feed) and push `{value|ops}` over SSE/WebSocket; clients rebuild with Chord's
   `applyImmutable` (`view.ts` imports `@earendil-works/chord/delta`) and `ConversationTranscript`. Reconnect with
   `watch(ctx,{from})`. Commands (submit/abort/answer/configure) are plain async calls; map them to HTTP/RPC with
   `requestId` from the client for idempotency. (Chord's `remote/`, `link/`, `sync/`, `host/` packages are the in-repo
   transport; other agents are covering p2/p3/chord.)
5. **Auth / tenancy.** Entirely outside Durable: authenticate before calling `submit/signal/abort/configure`; check
   tenancy inside `admit(tx, draft)` commits when atomic checks matter; authorize `harness.signal(taskId,...)` against
   your own question record (taskId, key, session, user); keep ownership mapping (user -> session -> storage).
6. **Process lifecycle / scheduling.** `onWake` + `wake()` + `resume()` (DO-alarm pattern) for an
   "evict when idle, wake on signal/alarm" worker; `onReport` for crash-loop and storage-failure reactions
   (`harness.closed.then(...)`); `setTimer`/`now` for virtual time in tests; `settings.restartLimit` / `retry` /
   `afterFailedRun` for failure policy; `readOnly:true` for viewers.
7. **Extension registry as the product surface.** Tools (`defineTool`), prompt `section`s, hooks (`beforeTool` for
   permission policy, `afterTool` for redaction, `beforeRequest` for context shaping), `wrapTool`, `defineTask` for
   background jobs (e.g. test runner, PR creation), `createToolSearchExtension` + `deferred` tools for large MCP tool
   sets, `createCodemodeExtension` for code mode, `createFitImagesExtension`. Registry is process-local: build it per
   worker, identically across workers (the stored state refers to names only).
8. **Extra app state.** `defineDoc` documents co-committed with transcript state (e.g. pending-question index,
   repo/branch binding, quota counters); `HarnessOptions.conversationCreated` and `init` to seed them atomically.
9. **Telemetry.** `HarnessOptions.telemetry` (`pi-telemetry`) with W3C-style trace carriers stored in submissions/tasks
   for cross-service traces.

Suggested minimal architecture implied by the above (not prescribed by Durable): *one Harness per cloud session*, a
lease-guarded worker pool that opens a Harness on demand, a Postgres/SQLite `Storage` per session, a remote sandbox
`ExecutionEnv` per session, an HTTP/WS gateway that translates `watch` ops to clients and client commands to Durable
calls, and a host-side pending-question table keyed by `(sessionId, taskId, key)`.

---------------------------------------------------------------------------------------------------------------

## Appendix A. Test and example index (useful for behavior confirmation)

- Recovery: `test/harness-tools-recovery.test.ts`, `harness-generation-recovery.test.ts`, `harness-tasks-recovery.test.ts`,
  `harness-restart-failure.test.ts`, `harness-nested-tools-restart.test.ts`, example `12-recovery.ts`, `30-reload-and-restart.ts`.
- Signals/parks/gates: `harness-signals.test.ts`, `harness-tool-parks.test.ts`, `harness-tool-gates.test.ts`,
  `harness-park-children.test.ts`, `harness-sleep.test.ts`, examples `38`-`46`.
- Inbox/busy/continue/turn limit: `harness-inbox.test.ts`, `harness-continue.test.ts`, `harness-turn-limit.test.ts`,
  `harness-failed-run-inbox.test.ts`, `harness-submissions.test.ts`, `harness-submit-in-commit.test.ts`.
- Storage: `storage-memory`, `sqlite-storage.test.ts`, `sqlite-commit.test.ts`, `jsonl-storage.test.ts`,
  `indexeddb-storage.test.ts`, `store-storage-commit.test.ts`, `session-group-commit.test.ts`, `harness-group-commit.test.ts`,
  `harness-storage-failure.test.ts`; conformance in `src/testing/storage-conformance.ts`.
- Env: `env-node-conformance.test.ts`, `env-node.test.ts`, `src/testing/env-conformance.ts`; `packages/env/test/*`.
- Views/watches: `harness-view.test.ts`, `harness-view-run.test.ts`, `session-watches.test.ts`,
  `conversation-transcript.test.ts`, `harness-observers.test.ts`, `harness-read-only.test.ts`.
- Cloudflare DO: `test-workers/worker.ts`, `wake.test.ts`, `storage.test.ts`.

## Appendix B. Defaults at a glance

| Setting | Default | Where |
|---|---|---|
| retry | `enabled:true, maxRetries:3, baseDelayMs:2000, maxAgentDelayMs:60000` | `harness/agent.ts:23` |
| compaction | `enabled, reserveTokens:16384, keepRecentTokens:20000, backgroundTokens:32768` | `agent.ts:30` |
| progress | `partialIntervalMs:100, outputIntervalMs:100, persistWithinMs:1000` | `agent.ts:37`, spec :2316 |
| restartLimit | 5 | `agent.ts:61` |
| toolExecution | `parallel` | spec Settings :2331 |
| steering/followUp mode | `one-at-a-time` | spec :2332-2333 |
| contextRetentionMs / documentRetentionMs | 600 000 / 600 000 | `agent.ts:58`, spec :1851 |
| afterFailedRun | `keep` | spec :2335 |
| watch window | min 50, max 100 | `view.ts:~82` |
| Session outstanding jobs | 256 | `session/session.ts:122` |
| tool replay policy | `unsafe` | `harness/types.ts:~430`, `tool.ts:208` |
