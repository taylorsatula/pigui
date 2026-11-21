# Pi web/mobile apps and their integration with Pi Durable

Reference for building a remote-server "Pi harness" (a cloud agent service that a mobile web app talks to).
Source: `earendil-works/pi` at commit `780bf31`, read from `/home/user/refs/pi`. Paths below are relative to that
checkout. Line numbers refer to that commit. Durable internals are covered elsewhere; this note covers the
app/server/client layer and how it calls Durable.

Facts I verified in code are stated plainly. Things I inferred or did not verify are marked "(inferred)" or "(not verified)".

---

## 0. Summary in ten lines

1. **Chord** (`packages/chord`, package `@earendil-works/chord` 1.6.0) is an object runtime, not an HTTP framework. A
   client and a server hold *references* to typed objects and the state of those objects is synced over one binary
   WebSocket link (`/chord`). There is almost no REST: the UI is a client of Chord contracts.
2. "Chord v1" no longer exists in the tree. The root export is v2 since 1.5.1; v1 was moved to `/old` and then deleted
   (`packages/chord/CHANGELOG.md:50-57`). Everything in `apps/` is on v2.
3. **p2** ("Pi Mobile", `apps/p2`) is the working app: server + one forked worker per session + web UI + TUI + voice +
   terminals + sharing. README says "prototype ... will be gone soon ... do not build on it" (`apps/p2/README.md:3-6`).
4. **p3** ("Pi Roam", `apps/p3`) is the planned successor on the same Chord: ~2.7k lines, headless, only sessions CRUD,
   sign-in, a local process runner and a `p3` CLI. **It does not call pi-durable at all yet** (Durable is only a
   devDependency, `apps/p3/package.json:52-55`; the harness is slice 3, "brief").
5. p2's Durable integration is small and concentrated: `DurableHarness.open(StoreStorage, {models, registry, settings,
   env, telemetry, onReport})` in the session worker (`apps/p2/src/runtime/worker.ts:753-808`, inside `openHarness` `:683-693`), then `Chat`/`Conversation`
   Chord objects wrap `conversation.submit/abort/entries/configure/compact/reset` (`apps/p2/plugins/chat/worker.ts`).
6. Streaming agent output = Durable's `ConversationView` (window of entries + docs such as `pi.live`) mirrored into a Chord
   state member `view`, delivered to every client as delta ops. No SSE, no per-token events from the app.
7. Auth: p2 = signed owner cookies minted from a one-time token/link (+ guest share links + Radius relay); p3 = bearer
   token or signed cookie from a `SignIns` store, owner link `/_p3/owner#<token>`. Both bind loopback only and need a
   tunnel/relay for remote use. There are **no tool permission prompts** in p2 ("There is no per-turn authority").
8. Both are **single-owner, self-hosted, "one Pi per person"** designs; the agent has full shell access as the server's OS
   user. Neither is multi-tenant. p2 runs on the owner's own phone (Termux) or Mac.
9. For a remote multi-device harness neither app is a drop-in base. p2 is the only complete reference for the
   Durable<->UI wiring; p3 is the cleaner base for the server/worker/auth/runner shell. See section 5.2 and 6.
10. Mobile concerns that exist in code: reconnect loop with wake detection, service worker app shell, IndexedDB conversation
    cache, a composer outbox with idempotent `requestId`, stale-bundle detection. **No web push / notifications.**

---

## 1. Chord

### 1.1 What it is and which version

- `packages/chord/README.md:3-12`: "builds applications out of objects that live in several processes (a server, workers,
  browser tabs) and keep running while their plugins are reloaded." Building blocks: object *contracts* (name, params, host,
  members, version), *facets* (a plugin's declarations for one host kind), *references*, *documents*, *derives*, *jobs*,
  per-call *principals*, and plugin *reload*.
- Design rule book: `packages/chord/docs/design.md` (3691 lines). Concept table at `design.md:46-76`; goals at `:20-43`.
- v1 vs v2: CHANGELOG `1.5.1` "Chord v2 is the package's root ... Chord v1 moved unchanged to `@earendil-works/chord/old`"
  and "Chord v1 ... removed" (`packages/chord/CHANGELOG.md:50-57`). p2 notes: "p2 runs on Chord v2 only"
  (`apps/p2/docs/p2-notes.md:3,364-366`). v1 was the runtime of the previous app Pi Mobile (`apps/mobile`, removed;
  `apps/p2/docs/handoff.md:~17`), which also had a hand-written protocol. So "v1 vs v2" is historical; do not look for v1.
- Entry points (`packages/chord/README.md:14-41`): `chord` (core), `/http` (fetch-handler HTTP component), `/workers`
  (forked worker per host address), `/plugins` (esbuild builds, watcher, rollout), `/app` (an "app kit": `startServer`,
  `startWorker`, sign-ins, pairing, files), `/surfaces` (`webSurface`, `tuiSurface`), `/web` (`startPage`), `/react`
  (hooks), `/tui`, `/sqlite/*`, `/telemetry-sqlite`. **p2 uses `/app/files` only; p3 deliberately copied/replaced the app
  kit with its own base** (`apps/p3/docs/slices/01-base-and-sessions.md:19-24`; first copy is `apps/p3/old/src/kit/`).

### 1.2 Hosts, links, wire

- A **host** is a process/tab with a logical identity (`Server()`, `Session({id})`). A **link** is an ordered bidirectional
  channel of binary messages (`packages/chord/src/link/README.md`): `memoryLinkPair`, `ipcLink` (parent<->forked worker),
  `webSocketLink` (browser<->server). Protocol version 1; messages: `hello`, `hold`, `release`, `call`, `bound`, `state`
  (delta ops), `event`, `ack`, `failed`, `result`, `error`, `ping/pong`, `revoke` (`link/README.md`, "For Chord's layers").
- Codec: `binaryCodec` default, `textCodec` for debugging only (`link/README.md`, "Codec"). Large JSON parts > 16 KiB are
  raw-deflated by the originating host if given `nodeCompression` (p2 does: `apps/p2/src/hosts/server.ts:222`,
  `apps/p2/src/hosts/worker.ts:71`). Untrusted-link limits: 16 MiB wire / 64 MiB decoded per part; p2 browsers use 32/128
  MiB (`apps/p2/src/runtime/link-limits.ts:63`).
- Heartbeat: a link silent for 15 s pings, 30 s closes (`link/README.md`, "The heartbeat").
- Server accepts a link with `host.accept(webSocketLink(socket), { principal, limits }, ctx)`
  (`apps/p2/src/hosts/server.ts:904-908`; p3: `createHttp(..., {links: {path: "/chord", opened}})`,
  `apps/p3/src/server.ts:111-122`).
- Everyone receives a **reference** (`host.hold(Type, params, ctx)`), never the object. A reference is loading/live/failed/
  ended and keeps the object alive; the last release ends it (`README.md:5-6`, quick start `:46-74`;
  p2 helper layer `apps/p2/src/runtime/refs.ts`).

### 1.3 Contracts and how a plugin defines "server routes" / RPC / state

- **Contract** = `local(name, {version, params, members})` (host-internal, one per params) or `remote(name, {version, params,
  hostAddress, variants})` (reachable over links, one object per (type, params, principal key)). Members are *state* (a
  schema value) or *methods* (`method(argsSchema, resultSchema)`); a `remote` has **variants** chosen per principal
  (e.g. `viewer`/`participant`, `owner`/`guest`). Example: `apps/p2/plugins/chat/contract.ts:224-275` (`Chat`, version 6,
  `hostAddress: sessionHost`, variants `viewer` and `participant`).
- Schemas are `@earendil-works/pi-schema` (`obj`, `str`, `opt`, `union`, ...); contracts are fingerprinted, and a version
  bump must keep an `evolve(...)` history + provider `accepts` table so old open pages keep working (p2 docs
  `p2-notes.md:463-469`; example `plugins/sessions/contract.ts:238-372`).
- **Facet** = `defineFacet((host) => { host.serve(Contract, factory) ... })`. A server-side factory receives
  `(params, principal, self)` and returns `{variant, members}`; state members are `self.derive`/`self.follow`/`self.state`,
  method members are async functions `(args, ctx) => ...`. See `apps/p2/plugins/chat/worker.ts:421-559`.
- **Calls are the RPC**: `await ref.send({text, requestId}, ctx)`. **State is the streaming**: `ref.view` is a watchable
  that the server updates and Chord ships as delta ops (`design.md:1617-1780`, "Kinds of state / Watchables"). Fire-and-forget
  `event` members exist (`design.md:1780`).
- **Plain HTTP routes** are a separate registry. Chord core: `Http` registry contributions `{routes, wraps, sockets, hosts,
  csp ...}` with `Authenticators` (`design.md:2840-2935`; p3 uses this: `apps/p3/plugins/control/server.ts:299-326`,
  `apps/p3/plugins/sign-in/owner.ts:60-90`). p2 still uses its own `Routes`/`Upgrades`/`Authenticators` registries
  and a hand-written `node:http` server (`apps/p2/src/runtime/server.ts:225-289`, `apps/p2/src/hosts/server.ts:250-280,739-863`),
  routes keyed `"METHOD /path"` (`/prefix/*` wildcard) -> `(request, response, {principal, origin}, ctx)`.
- **Registries** (`defineRegistry`/`keyedRegistry`) are how plugins extend each other (one contribution per contributor, composed
  by the owner): p2 `Extensions` (Durable extensions), `SendRouters`, `InputGates`, `Routes`, ...; p3 `ServerRuntime`,
  `WorkerRunners`, `LinkOpened`, `Http`. `design.md:2141-2236`.

### 1.4 Plugin model, facets, workers, reload

- A p2 plugin is a **directory** under `apps/p2/plugins/<name>/` with facet files named by host kind: `server.ts`, `worker.ts`,
  `web.tsx`, `tui.ts` (+ shared `contract.ts`). No manifest; `package.json` is just `{name, private, type}`
  (`plugins/chat/package.json`). Discovery lists facet files; load order is alphabetical but dependencies resolve **by contract
  name** (`apps/p2/src/hosts/plugins.ts:44-89`; `docs/handoff.md:~24-30`). 49 built-in plugins (`ls apps/p2/plugins`).
- Kinds and build targets (`plugins.ts:112-124`): `server` (node), `worker` (node), `web` (browser, served by Chord's
  `webSurface`); `tui` facets are bundled by p2 itself (`src/hosts/bundles.ts`). Host packages are shared instances passed in
  (`src/hosts/host-packages.ts`), so plugins import `@p2/app/v1` (API modules in `apps/p2/src/api/v1/`) and never Chord directly.
  p3's API is `@earendil-works/p3/v1`, `/v1/server`, `/v1/worker` (`apps/p3/src/app.ts:1-26`).
- **Workers**: `createWorkers` from `@earendil-works/chord/workers` forks one Node process per host address (`Session({id})`),
  starts it on first hold, stops it when idle (`design.md:2936-3007`; p2 `apps/p2/src/hosts/session-workers.ts`, entry
  `apps/p2/src/hosts/worker.ts`). Server<->worker is `ipcLink` (trusted). Workers have their own SQLite store at
  `<data>/sessions/<id>/store.sqlite` (`p2-notes.md:372-377`).
- **Reload**: plugin edits are built by esbuild and rolled out to server, every running worker and the open web pages
  without a restart (`design.md:2341-2660`; p2 `server.ts:464-531`; `p2-notes.md:107-181`). Base code needs a restart. Pages
  detect a stale base bundle via `?web=<hash>` on the link and reload (`apps/p2/src/runtime/stale-page.ts`, `server.ts:262-268`).
  This is dev ergonomics; for a cloud harness it is optional machinery.
- **Client UI**: web facets are React; the page boots with `startPage` (`apps/p2/src/hosts/web/main.tsx:84-133`) and renders a
  `Slot name="app"` that plugins fill. Documented p3 decision: UI is contributed from a plugin's facet, objects only supply data
  (`apps/p3/docs/decisions.md:~28`).
- Persistence: Chord store (SQLite via `node:sqlite`) with tables/documents; `defineState({persist:true})` documents
  (e.g. p3 sign-ins, `apps/p3/plugins/sign-in/sign-ins.ts:44-56`). Jobs: owned background work that outlives the call
  (`design.md:1961`).

---

## 2. p2 architecture

### 2.1 Process layout

```
browser/TUI/script ──WS /chord──► p2 server process (node:http on 127.0.0.1:8788)
                                   ├─ Chord host "Server": catalog, sessions, auth, models/settings, routes
                                   ├─ SQLite  <data>/server/store.sqlite   (+ <data>/*.json config files)
                                   └─ forks one worker per session (idle stop 5 min)
                                        └─ Chord host "Session{id}": Durable Harness, chat, tools, terminals bridge
                                           SQLite <data>/sessions/<id>/store.sqlite (Durable records, via StoreStorage)
```

- Entry: `apps/p2/package.json:6` `npm start` -> `node --import ./src/source.ts src/hosts/server.ts`; `startServer`
  `apps/p2/src/hosts/server.ts:152-969`. Data dir `P2_DATA_DIR` (default `~/.pi/p2`), port `PORT` (8788), process lock "one server
  per data directory" (`:184-188`). Directory is chmod 0700 (`:183`). **Listens on `127.0.0.1` only** (`:284`).
- Worker spawn parameters (`SessionWorkers`, `src/hosts/session-workers.ts:36-60`): idle stop `P2_IDLE_MS`/5 min (`:147`), crash
  restart at most 5 per minute then sticky "failed, Retry" (`:52-55`; `p2-notes.md:420-423`), `--max-semi-space-size=2`
  (`server.ts:305`). `Chat` objects linger 30 s after last viewer (`plugins/chat/worker.ts:418`).
- Worker bootstrap (`apps/p2/src/hosts/worker.ts:49-144`): opens the session store, `createHost({address, principal: HOST})`,
  `host.connect(parent, {principal: SERVER, trusted: true})`, loads worker facets, waits for `HarnessHost` to be live, then
  `harness.durable.resume()` unless `session.resume === false`.
- Data layout: `server/store.sqlite`, `server/files/`, `sessions/<id>/store.sqlite`, `sessions/<id>/files/` (uploads, downloads),
  `settings.json`, `models.json`, `auth.json` (provider credentials), `envs.json`, `mcp.json`, `radius.json`, `owner-key`,
  `owner-token.txt` (`README.md:22-27`, `p2-notes.md:30,372-397`).
- Web serving: `webSurface(host, {plugins, entry, routes:false})` builds the base bundle with esbuild after listen and serves
  content-hashed files under `/_chord/web/...`; the HTML shell is p2's own template (`src/hosts/web.ts`, `p2-notes.md:39-63`).

### 2.2 Endpoints (HTTP / WebSocket)

Everything funnels through `handle()` (`server.ts:739-863`): sets `no-store`, `nosniff`, `no-referrer`, CSP, `X-Frame-Options: DENY`
(`:740-745`); resolves access (principal + origin); 403 unless Host/Origin acceptable (`:755-759`); then in order: `/health`,
public PWA files, `/__p2_dev`, `/__p2_tui*`, plugin `Routes`, app pages for owner/guest, else sign-in page.

Plugin-contributed routes (from `grep '"(GET|POST|HEAD) '` in `apps/p2/plugins`):

| Route | Plugin / file | Purpose |
| --- | --- | --- |
| `GET /health` | `server.ts:762` | `{ok:true,name:"p2"}`, unauthenticated, known Hosts only |
| `GET /owner`, `POST /owner/claim`, `GET /owner/check`, `POST /owner/logout`, `POST /owner/logout-all` | `devices/server.ts:123-165` | owner sign-in page, redeem one-time token, check, sign out |
| `GET /owner-token` | `devices/server.ts:136-149` | local owner only; issues a one-time token (10 min) |
| `POST /owner/local/challenge`, `POST /owner/local/claim` | `devices/server.ts:167-195`, `runtime/local-owner.ts:13-14` | loopback sign-in by HMAC proof under `owner-key` |
| `GET\|POST /join/*`, `POST /join` | `sharing/server.ts:403-408` | guest share links |
| `POST /upload?session=&name=` (raw body) -> `{id,...}` | `files/server.ts:85-148`, client `chat/web.tsx:162-164` | attachment upload, max 25 MiB (`files/uploads.ts:10`), 1 MiB chunks into the worker's `Files` |
| `GET\|HEAD /download?session=&id=` | `files/server.ts:150+` | range-capable download of session files |
| `GET\|HEAD /entry-image?session=&conversation=&entry=&message=&part=` | `chat/server.ts:30-66` | image bytes of a transcript entry (view carries references only; `src/runtime/entry-images.ts`) |
| `GET\|HEAD /workspace-file`, `POST /workspace-upload` | `workspace/server.ts:175-178` | file browser read/write in the session's cwd, 25 MiB |
| `GET /artifact-frame` | `artifacts/server.ts:263` | sandboxed iframe for HTML artifacts |
| `POST /client-error` | `logs/server.ts:104` | browser error reports |
| `POST /voice/sample`, `POST /voice/log` | `voice/server.ts:359-361` | TTS sample proxy, voice logging |
| `GET /mcp/sign-in/*`, `GET /mcp/callback` | `mcp/routes.ts:15-16` | MCP OAuth |
| `GET /discord/avatar` | `discord/server.ts:141` | |
| `GET /__p2_dev`, `POST /__p2_dev` | `server.ts:777-800` | owner dev controls (reload/restart); only with `P2_DEV=1` |
| `GET /__p2_tui`, `GET /__p2_tui/<sha256>.mjs` | `server.ts:801-825` | TUI manifest + bundle for the terminal launcher |
| `/sw.js`, `/manifest.webmanifest`, `/icons/*` | `src/hosts/web.ts:23`, `public/` | PWA shell |

WebSocket upgrades (`server.ts:254-280`): `/chord` (the object link; query `?web=<base hash>` for pages or `?client=tui|cloud|script`),
plus plugin `Upgrades` by exact path: `/terminal` (terminal byte channel, owner only, `terminals/server.ts:53-64`) and `/voice/room`
(`voice/server.ts:363+`; proxy to the Python speech service). Upgrade without a principal -> 403 (`:277`).

### 2.3 The `/chord` link and its contracts (the real "API")

All app functionality for chat/session management goes through Chord contracts over `/chord`. Principal variants: owner,
guest, worker, server, host (`src/runtime/principals.ts:6-38`). Full table in section 5.

Session lifecycle as the UI sees it (`plugins/sessions/*`):

1. The page holds `Sessions` (server host, `owner` variant): state `sessions[]` (id, env, cwd, title, createdAt, updatedAt,
   archivedAt, pinned, model, thinkingLevel, main, branches[]), `defaultCwd`, `defaultEnv`, `operations[]`
   (`plugins/sessions/contract.ts:238-372`; the contract is v7, state shape `SessionSchema` `:55-63`).
2. `Sessions.create({id?, env, cwd, createDirectory, title, model, thinkingLevel})` (`:90-100`; **client-chosen UUID id**
   so the page can navigate before the answer). Implementation `sessions/server.ts:661`. Row goes into table
   `p2.catalog:sessions` in the server store (`p2-notes.md:384-390`). The worker is **not started by listing**.
3. Opening a session: the page holds `Chat{session, conversation}`; the server route for host `Session({id})` forks the worker
   on first hold (`session-workers.ts`); `WorkerInit.values.session` carries `{id,cwd,env,model,thinkingLevel,resume}`
   (`src/runtime/session-worker.ts:7-16`, `src/runtime/worker.ts:48-57`).
4. Worker idle (no refs/calls/Durable tasks) -> stops after 5 min; a running agent run keeps it alive. A server restart re-opens
   workers whose runs were interrupted and Durable resumes them (`p2-notes.md:139-143`, `hosts/worker.ts:139-143`).
5. `rename`, `pin`, `archive` (runs `SessionArchived` cleanups: port forwards, stops worker; `plugins/sessions/server.ts:720`),
   `restore`, `clone`, `fork`, `relocate` (move to another machine/cwd in place via `Harness.relocate`), `dismissOperation`.
   Lifecycle operations are Chord jobs persisted on the server store (`contract.ts:~200-260`, `p2-notes.md:431-438`).

### 2.4 Streaming agent output

- In the worker, `Conversation` (a `local` object, one per conversation, shared by all viewers) does
  `self.follow((observer, ctx) => harness().durable.observeConversation(id, observer, ctx))` and exposes the result as the state
  member `view` (`plugins/chat/worker.ts:211-221`). Image parts of entries are replaced by references (`entryImageRefs`), the
  bytes are served by `/entry-image`.
- `ConversationView` (Durable, `packages/durable/src/harness/view.ts:37-48`): `{conversation, entries[] (a window: newest 50, grows to
  100), before?, docs}`. `docs` holds built-in documents like `pi.agent` (model/cwd/thinking) and `pi.live`
  (`packages/durable/src/harness/live.ts:167-199`: `run`, `generation.message` = the committed throttled partial assistant
  message, `generation.retry`, `tools[]` slots, `nestedTools`, `compactions`). So **token streaming is "committed partial message
  in the live doc"**, shipped as state delta ops; there is no separate event stream.
- Older history is paged by `Chat.entries({minEntryId,maxEntryId,order,limit})`, cut at ~1 MB per page
  (`chat/worker.ts:366-391`, `ENTRIES_PAGE_BYTES` `:86`). Client assembles through `ConversationTranscript`
  (`src/web/transcript.ts`, `history.ts`).
- Derived `stats` (context tokens) and `model` (name, contextWindow, thinking levels) members (`chat/worker.ts:222-248`).
- Status for the sidebar: `SessionStatus` (server, in-memory; running, error, usage, tasks, work, failure) reported by each
  worker (`plugins/status/contract.ts:59-160`); `StatusReport.push` is awaited by `send`/`stop` so the working dot is current when
  the call returns (`chat/worker.ts:182,324,349`).
- User shell commands (`!cmd`) stream via a separate state member `liveShell` (`plugins/chat/contract.ts:88-103`).

### 2.5 Sending messages, interrupts, permissions

- **Send**: `Chat.send({text<=1e6, requestId, whenBusy?: "steer"|"followUp", attachments?: uploadIds[], replyTo?})` ->
  `{submissionId}` (`chat/contract.ts:52-65,244`). Participant-only (owner or full-access guest). Worker flow
  (`chat/worker.ts:504-520` then `submit` `:302-326`): reject blank; run `SendRouters` (chat-mode may take it); resolve
  attachments via `Attachments.resolve`; wrap the text with a `<sender>` block (author kind/id/name; `senderText`); call
  `conversation.submit({type:"input", content, entry:{kind:"p2.input", data:{author,text,attachments}}, requestId:
  `${author.id}:${requestId}`, whenBusy: whenBusy ?? "steer"})`. The request id makes retries **idempotent** per author.
  `InputGates` wait for async prompt resources before first input (`worker.ts:~150-158`).
- **Queueing/steering**: while busy, `steer` injects into the current run, `followUp` queues. `dequeue({submissionId, restore})`
  and `dequeueOwn()` withdraw queued inputs via `harness.abortSubmission` (`chat/worker.ts:288-300,352-365`); the author's
  own text is returned to the composer, other authors' texts go to their `DraftStore` (`:453-457`).
- **Interrupt**: `Chat.stop()` -> `conversation.abort(ctx, {background:false})`, returns the caller's withdrawn queued texts
  (`chat/worker.ts:335-351,521-525`). `RunControl.stop` (`chat/contract.ts:282-287`) stops from outside the chat (sidebar). Cancelling
  compaction: `abortCompaction` -> `durable.abortTask` (`:274-287`). Stopping a session stops its subagents too (`README.md` sidebar section).
- **Configure model/thinking**: owner-only `Chat.configure({model?, thinkingLevel?})` -> `conversation.configure`; also updates the
  catalog row (`chat/worker.ts:405-414,535-556`). `compact`, `reset` (owner only) -> Durable `compact/reset`.
- **Permission/approval answers: none exist.** `src/runtime/tool-access.ts:1-5`: "There is no per-turn authority: whoever may send
  input in a session may have its agent call every tool it has; what a session's agents may reach is decided by its tool
  selection, its location (a sandbox) and its lock." A `Questions` service (confirm/select/text, quorum policies) is only a
  design doc (`apps/p2/docs/questions.md`, "Status: design"); grep finds no implementation. p3 slice 11 "Questions" is a brief.
- **Idempotency and offline sending** on the client: `plugins/chat/outbox.ts:1-169` keeps unsent messages, retries with
  500 ms -> 10 s doubling backoff (`:40-41`), gives up after 6 failures while connected and restores the text to the composer
  (`:46`), keeps accepted messages shown until the transcript has them.

### 2.6 File and shell access

- Agent tools: `createCodingTools` (read/write/edit/bash/grep/find/ls) from `@earendil-works/pi-durable/tools`
  (`plugins/coding-tools/worker.ts:12`), PowerShell tool, code mode (`@earendil-works/pi-durable/codemode`), MCP, terminals tool,
  subagents, artifacts, ports, views, history, send_file, etc. (each plugin contributes a Durable `Extension` to the worker's
  `Extensions` registry; see 4.2). Execution environment: `NodeExecutionEnv({cwd, shellPath})` (local), `RemoteExecutionEnv` over SSH,
  Gondolin sandboxes (QEMU) on an SSH host (`src/runtime/worker.ts:485-495`, `docs/remote-envs.md:1-100`). "Remote sessions never fall
  back to local execution" (`remote-envs.md:3-5`). **Guest/full access = tool access = shell; "not filesystem isolation"**
  (`plugins/coding-tools/worker.ts:21`).
- User-driven: `Chat.shell({command, includeInContext, requestId})` runs `!cmd` in the conversation cwd, no run started, result becomes
  a `p2.shell` entry (`chat/contract.ts:107-113,269`). Interactive terminals: `Terminals` (control methods `open/attach/close/resize/ack/...`
  in Chord, `channel()` returns a token) + raw WebSocket `/terminal` for bytes with ack-based flow control
  (`terminals/contract.ts:31-70`, `terminals/protocol.ts`, `terminals/server.ts:53-64`); detached terminal host survives server restarts
  (`p2-notes.md:141-142`).
- Workspace file browser/editor: `Workspace` (`query`), `WorkspaceTransfer` (`read/write`) + routes `/workspace-file`, `/workspace-upload`
  (`workspace/contract.ts:84-101`, `workspace/server.ts:175-178`). Session files (`uploads`, `downloads` spaces) via chord app kit `Files`.

### 2.7 Voice

- Browser mic -> p2 -> **external Python speech service** (`apps/p2/voice-server/server.py`, CPU only: Silero VAD + Parakeet TDT STT;
  Supertonic/Kokoro/Pocket TTS). Button shows only if `<data>/voice.json` = `{url, token}` exists (`README.md:~230-236`). p2 holds the
  token; browsers never reach the service directly. Plugin `plugins/voice/`: `Upgrades["/voice/room"]` opens an upstream WS with
  `Authorization: Bearer`, identity headers `X-Room`, `X-Participant-*` set from the authenticated principal; allowed JSON commands for
  owner vs guest differ (`voice/server.ts:363-460`). Audio: 16 kHz PCM16 mic frames up, 16-bit PCM chunks down
  (`server.py` docstring protocol: `/listen`, `/speak/stream`, `/speak`, `/voices`, `/health`). README still mentions `/voice/listen`,
  `/voice/speak`; code now has `/voice/room` (README is stale; not verified whether the Python service already exposes `/room`).
- Voice also hooks the conversation (short spoken answers prompt via a Durable extension: `plugins/voice/worker.ts` imports `defineExtension, section`).

### 2.8 Client-side vs server-side

- **Server**: all state, history, agent runs, auth, files, secrets (`auth.json`), model catalog, tool execution.
- **Client web** (React 19 + Elanor design system, `apps/p2/src/web/`, `plugins/*/web.tsx`): rendering, markdown, tool cards, composer
  with draft state, outbox, optimistic messages, command menu, drawer/swipe gestures, IndexedDB conversation cache, theme, voice audio
  pipeline. Page code is served by the server, so a page is always the server's version.
- **TUI client** (`src/hosts/tui*.ts`): a launcher process on the user's machine with a sandboxed Node worker (permission model) running
  downloaded TUI facets; same `/chord` link. Elaborate threat model in `README.md:140-190`.
- **Headless script client**: `/chord?client=script` + `localOwnerSignIn` cookie, then `createHost` + `host.hold(Sessions...)`
  (`apps/p2/scripts/verify-sessions.ts:30-60`). This is the minimal pattern for a non-browser client.

### 2.9 Mobile-specific behaviour (all verified in code)

| Concern | Mechanism | Where |
| --- | --- | --- |
| Reconnect | Connection loop: retry 250 ms doubling to 5 s; resets after a link stayed open 10 s; immediate on wake (visibility, online, network change); gives up sockets not open after 20 s; replaces socket silent > 25 s after a wake | `packages/chord/src/surfaces/connection.ts:1-30`, `:184-190` |
| "Offline" banner | shown only after link closed > 2 s, or device offline | `apps/p2/src/runtime/connection-state.ts:10-61` |
| Resync after drop | server sends fresh `bound` snapshots + `state` ops on re-hold; client re-holds by itself ("errors look like disconnects") | `design.md:20-43` (goal 5), `link/README.md` |
| Backpressure | client frame max 1 MiB, unsent output max 4 MiB then socket terminated (client resyncs) | `apps/p2/src/hosts/socket-limits.ts:7-54` |
| Offline send | outbox with request ids | `plugins/chat/outbox.ts` |
| Cold start / background kill | service worker keeps app shell + last 2 bundle versions (network-first for the page, 3 s wait); IndexedDB `p2-conversations` keeps newest ≤ 20 conversations (≤ 4 MB each) for instant open; owner only, cleared on sign out | `apps/p2/public/sw.js:1-60`, `apps/p2/src/web/conversation-cache.ts:1-40` |
| Installable PWA | `manifest.webmanifest` standalone, icons; Chrome WebAPK cross-site launch handled | `apps/p2/public/manifest.webmanifest`, `src/hosts/principals.ts:82-96` |
| Stale code | link names the bundle hash; mismatch -> close code 4001, page reloads | `server.ts:254-268`, `stale-page.ts` |
| Touch UI | long-press menus, drawer swipe, sheet drag, drum picker | `src/web/drawer-swipe.ts`, `elanor-extra/*` |
| **Push notifications** | **None** (no `PushManager`/`Notification` use; grep empty). "unread" state is in-app only | grep over `src plugins public` |
| Where it runs | the server itself runs on the owner's phone in Termux (`docs/handoff.md:28`) or a Mac (`apps/p2-mac`) | |

p2-mac (`apps/p2-mac/README.md`): AppKit shell with WKWebView, menu bar item that starts/adopts a local p2 (bundles Node + p2), signs in as local
owner without a token, Sparkle updates. Nothing protocol-specific beyond `/health`, `dev.sock`.

---

## 3. p3 architecture

### 3.1 Process model and layout

`apps/p3/README.md:3-5`: "One Pi per person: a server on your machine with a worker per session, and the command `p3` that runs it. The
successor of p2 (Pi Mobile) on Chord v2, built in slices; so far it is headless (no page yet). Node 26.3.1 or newer."

```
p3 (bin.ts) ──spawn detached──► supervisor.ts ──► server.ts (Chord host Server(); createHttp on 127.0.0.1:<port>)
                                                       ├─ /chord  (WS links)   ├─ /_p3/owner, /_p3/owner/link, /_p3/stop, /_p3/apply
                                                       ├─ server store.sqlite  └─ runner plugin forks:  worker.ts per session
                                                                                  Chord host Session{id}, store at workers/<id>/store.sqlite
```

- Base (`apps/p3/src/`, 1.3k lines): `bin.ts` (CLI, 289 lines), `server.ts` (startServer, `:73-193`), `worker.ts` (worker bootstrap), `supervisor.ts`,
  `files.ts`, `pi.ts` (named "Pis"), `records.ts`, `principals.ts`, `api/v1/*`. Everything else is a plugin (`README.md:31-43`; decision
  "Reloads first", `docs/decisions.md:~20`).
- Built-in plugins (only four): `control`, `runner`, `sessions`, `sign-in` (`ls apps/p3/plugins`). 2,751 lines total in `src`+`plugins`.
- **Route to workers**: `host.route(Session, {admit: admitSession, resolve})` (`server.ts:138-152`): admission derives from table
  `sessions.rows` ("session exists", never from a worker principal); `resolve` asks the `WorkerRunners` registry, which starts a worker and
  returns the `Link` (`src/server-core.ts:186-191`, `plugins/runner/local-runner.ts:23-50`). Runners are **pluggable** (decision "Pluggable worker
  runners", `decisions.md:~339`; slice 24 brief): local fork now, remote machines / Durable Objects later.
- Worker (`src/worker.ts:34-98`): IPC link to parent, waits for `start` control message `{session, dir, idleMs, scripts}`, opens the store, creates
  host, loads shipped worker plugins, sends `ready`. Idle shutdown by the runner plugin when no refs/calls/jobs and all `WorkerBusy` counts are 0
  for `idleMs` (5 min) (`plugins/runner/worker.ts:1-35`). Crash -> session `failed` until `retry` or rollout (no restart loop)
  (`local-runner.ts:41-47`).
- The "waker": at server start, every session whose row says `working` is started so Durable can resume (`sessions/server.ts:157-172`).
- Data dir = a "Pi": default `~/.pi/p3` port 8789; `--pi <name>` -> `~/.pi/p3/pis/<name>`; `--dir`; port kept in `pi.json`
  (`src/pi.ts:1-67`). Private modes 0700/0600 (`src/files.ts:19-52`).

### 3.2 The `p3` CLI

`apps/p3/README.md:7-21`, `src/bin.ts:21-39`: `p3` (start in background under supervisor + print owner link), `p3 server` (foreground), `status`,
`stop`, `restart`, `list`; flags `--pi`, `--dir`, `--port`. The CLI talks to the running server over HTTP with the owner token file
(`<data>/owner-token`, Bearer): `POST /_p3/owner/link` -> `{link}`, `POST /_p3/stop` (`bin.ts:~136-150`, `sign-in/owner.ts:16-30,72-80`,
`control/server.ts:12-18`). `POST /_p3/apply` builds changed plugins and rolls them out to server+workers (`control/server.ts:312-322`). Release build
(`scripts/build-release.ts`) bundles server/worker/supervisor with esbuild for npm packaging (slice 26).

### 3.3 API surface today

HTTP (all on loopback; Chord HTTP baseline applies):

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /_p3/owner` | public | owner-link page; script posts `location.hash` token (`owner.ts:60-65,104-112`) |
| `POST /_p3/owner` `{token}` | public (one-time token, 10 min, single use) | issues browser sign-in, `Set-Cookie` (`owner.ts:66-79`) |
| `POST /_p3/owner/link` | owner | mint fresh link (`owner.ts:80-87`) |
| `POST /_p3/stop` | owner | stop server |
| `POST /_p3/apply` | owner | build+rollout plugins |
| `WS /chord` | any valid sign-in (Bearer token header, else signed cookie `p3-<id>`) | Chord link (`sign-ins.ts:94-96,170-176`) |

Chord contracts (`plugins/sessions/contract.ts`): `sessions.sessions` (owner: `create({title?})->id`, `rename`, `archive`, `restore`),
`sessions.list` (params `{app, set: active|archived, view}`; state `list {rows, moreAfter}`; method `more`; 50 per page), `sessions.facts`
(worker variant: its own row; `report({state})` with `working|waiting|settled|failed`), `sessions.start` (server's waker), `sessions.worker`
(owner view of a worker, forwards the row). `sign-in` contract `p3.sign-ins` is `local` (server-internal): `list/issue/verify/revoke`.

### 3.4 What changed vs p2, and why (from `apps/p3/docs`, `apps/p2/docs/p3-handoff.md`)

- Direction (owner decision 2026-11-13, `decisions.md:210-213`): "one Pi per person, one owner who installs every plugin; plugins are trusted
  code; only people are confined." Timeline stated there: Dec 1 "Pi Roam", Dec 18 "Org Devices" (each member their own Pi on an org machine),
  February "hosted".
- Motivations visible in the docs: p2's hand-written server and many cross-cutting special cases (generation fences, proxy markers, TUI source
  bundles) -> p3's base is tiny and "everything else is a plugin" with the page shell itself a plugin; use Chord's own `createHttp` and
  `createWorkers`; admission as part of route (workers start only for existing sessions); sign-in tokens revocable per device (p2 has cookies +
  device list); pluggable worker runners; pairing and Radius sign-in instead of owner-key/HMAC tricks; "stale workers are Chord's problem" (p2
  hand-wrote generation fencing, `decisions.md:~345`); performance budgets (`docs/performance.md`; release `p3` idle worker ~28 MiB).
- Principal is identity only: `{owner}`, `{person,id,name}`, `{worker,session}`, `{server}` (`src/principals.ts:14-26`; decision
  `decisions.md:~214`); roles/shares are data read by admissions (planned).
- Sign-in decisions (`decisions.md:~392-400`): no owner passwords; new device shows a short code, signed-in device approves (`p3 pair <code>`);
  "Remote requests are accepted for any host name; authority comes only from host-bound sign-ins"; Radius (Earendil's relay/identity service)
  as the first identity provider (slice 25).
- `apps/p3/old/` is the **superseded first build** (kit copied from Chord's app kit); `tsconfig.json` and `npm test` globs exclude it
  (`tsconfig.json:include`, `package.json:test`). The redo is described in `docs/slices/01-base-and-sessions.md:1-30`.

### 3.5 Done vs planned (slice table `apps/p3/docs/slices/README.md:7-37`)

| Status | Slices |
| --- | --- |
| Built | 1 base and sessions (list/create/rename/archive/restore), 26 release build + `p3` command + several Pis ("round 2 review next"), Chord slice 14 (admission, named queries) |
| Brief / planned | 25 Radius sign-in + first web scaffold; 2 apply; **3 talk to a session (Durable harness, transcript, send, queue, stop)**; 7 models; 8 environments + coding tools; 9 prompt; 10 agents/code mode; 11 questions (approvals); 12 files; 13 MCP; 14 views; 15 groupings; 16 web/terminal UI ("waiting for the team's Elanor port"); 18 session lifecycle; 19 workspace/terminals; 20 status/search; 21 remote access, forwards, backups; 22 Discord/voice; 24 worker runners; 27 terminal client; 28 telemetry; 5 people/apps and 6 locks (designed in part); 17 org (later) |

Slice 3 spec (`slices/03-transcript.md:1-20`): plugin `harness` (Durable's `Harness` in the worker on the session's store via `StoreStorage`, opened
paused and resumed after load), plugin `models`, plugin `transcript`. Open questions there include how the harness plugin gets its store/keep-alive
(`HostRuntime`/`KeepAlive` registries), and that "pi-ai has no `source` export condition". `design.md:3262-3281` pre-specifies the harness object
(`Harness.open(await StoreStorage.open(store, Harness.name, ctx), {models, env, settings, registry: registryReader(...)})`, then
`harness.resume()` after `host.load`).

---

## 4. Integration points with `@earendil-works/pi-durable`

### 4.1 Dependency and subpaths used (p2)

`apps/p2/package.json` (pi-durable at `:29`): `@earendil-works/pi-durable`, `pi-ai`, `pi-codemode`, `pi-env`, `pi-mcp`, `pi-schema`, `pi-telemetry`, `pi-tui`,
`chord`, all pinned `1.6.0`. Durable subpaths imported by p2 (from `grep pi-durable`): root (`Harness`, `defineExtension`, `defineDoc`, `defineTool`,
`section`, `hook`, `LiveDoc`, `UsageDoc`, `InboxDoc`, `AgentDoc`, `GenerationTask`, `createRegistry`, `ROOT_CONVERSATION_ID`, types
`ConversationView`, `EntryRecord`, `HarnessSettings`, `RegistryReader`, `ToolRegistration`, ...), `/env` + `/env/node`
(`ExecutionEnv`, `NodeExecutionEnv`), `/storage/store` (`StoreStorage`), `/tools` (`createCodingTools`, `createPowerShellTool`, `imageLimits`),
`/codemode`, `/tool-search`, `/images/fit`, `/images/node` (`createNodePhotonImages`) (`src/hosts/host-packages.ts` lists the shared modules).
p3 imports none (`apps/p3/package.json:52-55` devDependency only).

### 4.2 Where Durable is opened and configured (p2)

**Open** (`apps/p2/src/runtime/worker.ts:753-808`, inside a `self.open` native of the worker's `HarnessHost` object; line numbers of the call
as grepped: `:753` open, `:758` storage, `:759` `DurableHarness.open`):

```ts
await whenPresent(config, "default", signal);                       // models plugin must have contributed model access
const storage = await durableStorage(store, ctx);                   // StoreStorage.open(store, "p2.durable", ctx)  (src/runtime/session-store.ts:93-103)
const harness = await DurableHarness.open(storage, {
  models,                                // Proxy over pi-ai `Models`, looked up per call: configured().models()   (:720-726)
  telemetry,                             // worker host's recorder or undefined (settings.json `telemetry`)
  registry: durableRegistry(extensions, switches, durableContext(observing.signal)),   // src/runtime/durable.ts:42-89
  settings,                              // Proxy over HarnessSettings from the models plugin           (:717-722)
  env: async (target, context) => execution.value.at(await execution.value.locate(target.conversationId, context, target.read)),
  onReport: (r) => console.error(`durable: ${r.kind}:`, r.error),
}, ctx);
const root = await harness.root(ctx, { agent: { model: session.model, cwd, thinkingLevel } });   // main conversation
await followSession(place, harness, location.value, ctx);           // subagents/locations placement
if (!agent.model || !models.getModel(...)) throw new Error("Unknown model");
```

Then `harness.durable.resume()` in `src/hosts/worker.ts:141-143` (Durable opens with scheduling paused, resumes after all plugins' extensions are
registered; skipped when `session.resume === false`, used for archived sessions started only to rebuild a search index).
`harness.close(BACKGROUND_CONTEXT)` on the native's close (`worker.ts:~805`). `Harness.relocate`-style moves: `relocate()` in the same function
(`:~810-830`).

- **Storage backend**: Chord SQLite store of the session host (`<data>/sessions/<id>/store.sqlite`) through `StoreStorage` under owner name
  `p2.durable`; tables `p2.durable:*` beside `chord.app.files:*` (`p2-notes.md:378-383`). `openSessionStorage` opens a stopped session's store
  for offline tools (`session-store.ts:110-131`). Outbox on stores only while backup is configured (`hosts/worker.ts:59-60`, `src/runtime/backup.ts`).
- **Env/config**: `P2_DATA_DIR`, `PORT`, `P2_IDLE_MS`, `P2_FAKE`, `P2_PROVIDER`+`P2_MODEL` (default model), `P2_ALLOWED_HOSTS`, `P2_PUBLIC_URL`,
  `P2_RADIUS`, `P2_DEV*`, `P2_TERMINAL_DAEMON` (`p2-notes.md:28-37`). Worker env passes dev flags only; secrets are redacted from logs
  (`session-workers.ts:57-61`).
- **Providers/models**: `createP2Models(fake, {credentials, modelsStore})` = `builtinModels` from `@earendil-works/pi-ai/providers/all`, or the
  scripted `faux` provider in fake mode (`plugins/models/models.ts:6-8`, `fake.ts`). Credentials in `<data>/auth.json` (`FileCredentials`), custom
  models in `models.json` / `models-store.json`, defaults and run settings in `settings.json` (hot reloaded by `Resources`,
  `plugins/models/resources.ts:62-110,164-235`). **HarnessSettings** surfaced live from settings.json: `stream`, `retry`, `compaction`,
  `toolExecution`, `steeringMode`, `followUpMode` (`resources.ts:111-134`). Worker also registers lazy OAuth flows and Bedrock
  (`hosts/worker.ts:36-41`), and Node HTTP/2 workaround `configureFetch` (`src/runtime/fetch.ts`).
- **Tools / extensions**: every plugin contributes `Extension<P2Tool>`s to registry `Extensions` (`src/runtime/durable.ts:22`) and optionally
  an on/off switch via `ExtensionSwitches` (e.g. `codemode` setting). `durableRegistry` makes a Durable registry snapshot per (extensions,
  switched-off set), wraps each tool with `guardTool` (scope main/subagent; locked-session capability; `tool-access.ts:41-59`), and installs
  `createToolSearchExtension()` when deferred tools exist and code mode is off (`durable.ts:61-67`). Core tools:
  `plugins/coding-tools/worker.ts:10-37` (`createCodingTools({images})` + sections `preamble`, `cwd`). Image handling: `fitImage`, `imageLimits(model)`
  (`chat/worker.ts:18-19,129,149`).
- **Calls from Chord into Durable**: `harnessOf(self)().durable` yields the Harness; used methods (all in `plugins/chat/worker.ts`):
  `durable.conversation(id)`, `conversation.submit({type:"input"|"write", ...})`, `conversation.abort(ctx,{background:false})`,
  `abortSubmission`, `abortTask`, `waitForTask`, `submission(id).status`, `snapshot(InboxDoc, convId)`, `conversation.entries(query, limit)`,
  `conversation.context()`, `conversation.agent()`, `conversation.configure()`, `conversation.compact()`, `conversation.reset()`,
  `observeConversation` (the view follower), `inspect(ctx)` (`runtime/worker.ts:443`), `root()`. Observer rule: Durable observers run
  synchronously inside the commit; only record, never await (`design.md:3252-3258`).
- **Calls from Durable code into Chord** (tools/hooks/sections): Durable contexts are Chord `Context`s; code outside Chord calls uses
  `serverOf(self)().root(fn, ctx)` / `workerOf(self)().root(fn, ctx)` (`p2-notes.md:424-430`). p3 plans a `chord(fn, context)` helper with a typed
  context key (`design.md:3282-3290`).
- **Telemetry**: `HarnessOptions.telemetry` fed by a worker recorder that streams spans to the server's SQLite telemetry store every second
  (`hosts/worker.ts:44-121`); only if `settings.json telemetry:true` at server start.

### 4.3 What the UI knows about Durable

Web/TUI import only types (`ConversationView`, `EntryRecord`, `LiveState`, `UsageState`, `AgentState`) and render `ConversationView.docs`
(`pi.live`, `pi.agent`). `src/web/activity/model.ts` (802 lines) turns entries/live docs into display rows. The `p2.input` entry kind carries
author metadata; plugin entry kinds (e.g. `p2.shell`, `chat.mention`) get display hooks via `TranscriptEntries` registry (`chat/contract.ts:337-342`).

---

## 5. Client <-> server protocol

### 5.1 Table (p2, the more complete app)

Transport: `WSS /chord` (Chord binary link, protocol v1; `?web=<hash>` or `?client=tui|cloud|script`; cookie auth; Origin must match). "Hold" = client
acquires a reference; state members are server->client delta streams; methods are client->server calls with schema-checked args/results.
Contract names are Chord names (`p2.*`).

| Endpoint / member | Dir | Payload (shape) | Purpose |
| --- | --- | --- | --- |
| `WS /chord` hold `p2.access` {} | both | state `grant` (guest) | who am I: owner or guest grant (`runtime/access.ts:35-41`) |
| hold `p2.sessions` {} (owner) | S->C | state `sessions[]`, `defaultCwd`, `defaultEnv`, `operations[]` | live session list (`sessions/contract.ts:238-372`) |
| `p2.sessions.create` | C->S | `{id?:uuid, env?, cwd, createDirectory?, title?, model?, thinkingLevel?}` -> Session row | new session (client-chosen id) |
| `.rename/.pin/.archive/.restore/.clone/.fork/.relocate/.dismissOperation` | C->S | `{id,...}` / `{id,conversation,before,copy?}` / `{id,cwd,env}` | lifecycle; long ones run as jobs shown in `operations` |
| hold `p2.session-status` {} (reader) | S->C | state `statuses{sessionId:{running,error,usage,tasks,busy,work,failure}}` | sidebar working/failed dots (`status/contract.ts`) |
| hold `p2.worker-control` {session} | C->S | `restart()` | retry a failed worker |
| hold `p2.chat` {session, conversation} | S->C | state `view` (Durable `ConversationView` window + docs), `stats`, `model`, `liveShell` | transcript + streaming + live shell output |
| `p2.chat.send` | C->S | `{text, requestId, whenBusy?:"steer"\|"followUp", attachments?:uploadId[], replyTo?}` -> `{submissionId}` | user message (idempotent) |
| `p2.chat.stop` | C->S | `()` -> `{restored:string[]}` | interrupt run, get own queued texts back |
| `p2.chat.dequeue` / `dequeueOwn` | C->S | `{submissionId, restore?}` -> `{text\|null}` / `() -> {restored[],skipped}` | edit/withdraw queued inputs |
| `p2.chat.configure` | C->S | `{model?:{provider,modelId}, thinkingLevel?}` | owner picks model/thinking |
| `p2.chat.compact/abortCompaction/reset` | C->S | `{instructions?}->{taskId}` / `()->{aborted}` / `{handoff?}` | context management |
| `p2.chat.entries` | C->S | `{minEntryId?,maxEntryId?,order?,limit}` -> `{items:EntryRecord[],more}` | page older history |
| `p2.chat.shell` / `abortShell` | C->S | `{command,includeInContext,requestId}->{shellId}` / `{shellId}` | `!cmd` in session cwd |
| hold `p2.run-control` {session, conversation} | C->S | `stop()` | stop from sidebar |
| hold `p2.chat-costs` {session, conversation} | C->S | `costs()` -> per-response `{entryId,timestamp,cost,cacheHit,provider,model,stopReason}[]` | cost sheet |
| hold `p2.session-metrics` {session, viewer} | S->C | state `clients`, `usage` | viewer count + spend |
| hold `p2.models` {} (owner) | both | state `models[]`, `resources`, `defaultModel`, `enabledModels`, `scopedModels`; methods `setDefault`, `setEnabledModels` | model picker (`models/contract.ts:32-70`) |
| hold `p2.provider-login` / login service | both | login flows (API key, OAuth, device code, pasted code) | provider credentials into `auth.json` (`login/contract.ts`) |
| hold `p2.terminals` {session, view} (owner) | C->S | `open{cols,rows,conversation}`, `attach`, `close`, `resize`, `theme`, `ack`, `channel()->{token}` | control plane of terminals |
| `WS /terminal` | both | raw bytes + framing (`terminals/protocol.ts`), ack-based flow control | terminal I/O |
| hold `p2.workspace` / `p2.workspace-transfer` | both | `query`, `read`, `write` | file browser/editor |
| hold `p2.sharing` {session} (owner) | both | state `links[]`, `guests[]`, `people[]`; `link{mode,reset?}` ... | share links (view/full) |
| hold `p2.guest-presence` | C->S | marks connected | presence |
| `POST /upload?session=&name=` | C->S | raw bytes (<= 25 MiB) -> `{id,name,size,...}` | attachment, then id in `send.attachments` |
| `GET /download?session=&id=` | S->C | bytes, Range ok | session download |
| `GET /entry-image?session=&conversation=&entry=&message=&part=` | S->C | image bytes, `immutable` | transcript images |
| `GET/POST /owner...`, `/join/*` | C->S | JSON `{token}` / `{challenge,proof}` | sign-in, share join |
| `WS /voice/room?session=&conversation=` | both | JSON commands + PCM16 audio frames | voice mode via speech service |
| `GET /health` | S->C | `{ok:true,name:"p2"}` | readiness (unauth) |

Notes: (a) p2 contract set is large (116 `local`/`remote` declarations, versions included). (b) Method signatures and state shapes carry versions; old
clients keep working through `accepts` tables. (c) All Chord bytes are binary-encoded; to debug use `textCodec`. (d) A non-browser client needs the
Chord client library (`createHost`, `webSocketLink`) and the contract definitions (importable from `plugins/*/contract.ts`); it cannot be done
with `curl`.

### 5.2 p3 (today)

Only what is in 3.3: HTTP token/link routes and `WS /chord` with `sessions.*` contracts. No chat, no transcript, no model contracts.

### 5.3 Which is the better base?

- **For the integration knowledge** (Durable <-> UI): p2 is the only complete implementation, and its `plugins/chat`, `src/runtime/worker.ts`,
  `durable.ts`, `session-store.ts`, `plugins/models`, `plugins/coding-tools` are the template. It is also the more entangled (49 plugins; TUI
  sandbox, Radius, Discord, voice, rollups all cross-linked) and **self-declared throwaway**.
- **For the server skeleton** (process model, auth, extension points): p3 is cleaner and explicitly meant to carry the product, with per-session
  workers behind a **pluggable runner** (the natural seam for cloud sandboxes), revocable bearer sign-ins usable by non-browser clients, admission
  at the route, and release packaging. But it has no agent, no UI, no remote ingress yet, and is moving daily (slice states change weekly).
- **Recommendation (inferred from the above)**: for a mobile-web harness, pick p3's skeleton + a port of p2's `chat`/harness/models/coding-tools
  plugins (that is p3's own plan, slices 3/7/8) rather than extending p2. If the goal is to avoid being coupled to Chord entirely, the minimum
  thing to copy is the *shape*: one process per session owning one `Harness.open(StoreStorage, ...)`, a view stream of `ConversationView`, and the six
  calls `submit/abort/abortSubmission/entries/configure/compact` with idempotent `requestId`s (section 4.2). A thin HTTP+SSE facade can wrap that
  without Chord, at the cost of re-implementing delta/resync, which Chord gives for free.

---

## 6. Deployment assumptions, security model, and changes for a remote phone-facing server

### 6.1 Stated assumptions

| Aspect | p2 | p3 |
| --- | --- | --- |
| Users | One owner + guests via share links per session (view/full) (`sharing`, `principals.ts:25-33`). Guests can use tools = shell | One owner per Pi; `person` principal exists in type but no plugin issues it yet (`principals.ts`; people/org slices planned) |
| Location | Owner's own device (phone/Mac/Linux). `127.0.0.1` listener only | Same: "a server on your machine"; `127.0.0.1`, port 8789 (`server.ts:93`) |
| Remote reach | HTTPS tunnel/reverse proxy preserving Host, `P2_ALLOWED_HOSTS`, `P2_PUBLIC_URL`, owner link `https://host/owner#token`; or **Radius** (Earendil's hosted relay: outbound brain WS, owner-authenticated, forwards via `*.rdtun.com`) | **Not possible yet**: Chord's HTTP baseline treats non-loopback Host as remote only for hosts contributed to `Http.hosts` and no p3 plugin contributes any (`grep hosts:` empty); remote ingress/pairing/Radius are slices 21/25 (brief) |
| Auth credentials | HMAC-signed HttpOnly SameSite=Lax cookies (Secure on https), 30 days, server-side expiry, per-device revocation, "sign out all" rotates key (`README.md:44-77`); owner-key file + challenge/HMAC for local clients | Opaque token `<id>.<secret>`; only hash stored; Bearer header or signed cookie; 400 days idle expiry; per-sign-in revocation closes live links (`sign-ins.ts:44-62,170-176`) |
| Isolation | **None for the agent**: "Owners have full agent and shell control on that server and its workers; this is not server-side filesystem isolation" (`README.md:7-9`); optional SSH env / Gondolin QEMU sandbox per session (`remote-envs.md`) | Same trust model: "plugins are trusted code; only people are confined" (`decisions.md:210`); locks (slice 6) designed, not built |
| Browser security | CSP default-src 'none', Fetch-Metadata foreign-request denial (no credentials for cross-site except top-level navigation), Origin==Host checks, `X-Frame-Options: DENY`, DNS-rebinding Host allowlist (`hosts/principals.ts:15-120`, `server.ts:728-738`) | Chord HTTP baseline gives the same set (`design.md:2864-2884`) |
| Stated limits | Cookies not port-scoped on loopback; DoS accepted (TUI sandbox watchdog); tunnel/relay sees API keys and pasted codes; secrets in plaintext `auth.json` (private dir); "Do not run competing servers against the same data dir" | Admitted: Chord whole package installed (~15 MB), no build cache, single server hub is scale bottleneck "solution wanted later" (`decisions.md:~339-343`) |
| Scale | Per-session worker (~35 MiB RSS idle in p3 measurements, `slices/26-release.md` numbers table); phone-class | Same; 10 idle workers ~300 MiB PSS |

### 6.2 What would have to change to run on a remote server reachable from a phone

1. **Ingress and TLS**: put p2/p3 behind Caddy/nginx on a public host with TLS; p2 needs `P2_ALLOWED_HOSTS`, `P2_PUBLIC_URL`, a proxy that
   overwrites the marker header and forwards WebSocket upgrades (`README.md:98-123`; the Caddyfile there uses a unix socket). p3 needs a plugin
   contributing `Http.hosts` (Chord feature exists: `design.md:2864`, example `46-allowed-hosts`) and `Secure` cookies; remote sign-in via
   pairing/Radius is unbuilt.
2. **Sign-in UX for a phone**: p2's flow requires an owner link minted on the host (`npm run owner-link`) and a one-time token; fine for a
   single owner but needs a first-run bootstrap (print link in logs / admin API) for a hosted service. p3 `owner token file` + `POST /_p3/owner/link`
   are the equivalents. A real service would add accounts (p3 `person`) and a per-user instance or per-user data dir; both apps assume one OS
   user = one owner (`openDataDir` refuses other-user dirs: `p3/src/files.ts:19-35`).
3. **Multi-tenancy**: nothing here isolates tenants. Agent shell/file tools run as the server user (`NodeExecutionEnv({cwd})`), providers' keys
   live in one `auth.json`, workers are plain child processes. A cloud harness must run each user's Pi (server + workers) in its own container/VM
   (the p3 "one Pi per person" model, "Org Devices", "hosted" in Feb) or implement a runner that starts workers in a sandbox
   (p3 `WorkerRunners` seam; p2's remote-env/Gondolin path where the worker stays on the server and *tools* run in the sandbox, so Durable
   history and credentials are outside the sandbox, `remote-envs.md:1-5`).
4. **Persistence/durability**: all state is local SQLite files in the data dir; runs resume after restart because the worker comes back
   (`resume()`; p3 waker). For a cloud service you need a volume per user and either always-warm workers or a wake-on-demand scheduler
   (p3 notes "worker hands its next wake to the server; a due wake starts it" as an open design point, `slices/03-transcript.md:~28`). Backups are
   via the store outbox (`plugins/backup`, `plugins/sync`; p3 decision "Backups, not session sync" `decisions.md:94`).
5. **Push / background**: none exists. A phone web app cannot be notified when a long run finishes. Add Web Push (VAPID) in the server (outside
   any app today), or a status channel the PWA can poll when resumed; the status data already exists (`SessionStatus`, p3 `SessionState`).
6. **Mobile transport**: the Chord link already reconnects aggressively, resyncs from snapshots, has backpressure and an outbox, so the biggest
   mobile risk is the *page/bundle build* (esbuild at server start, Elanor design system) and that the client must speak Chord's wire protocol.
   If the harness UI is a separate frontend, either reuse `@earendil-works/chord/web` + p2's contracts, or add an HTTP/SSE facade over the
   same objects (not present today; the `Http` registry + `sockets` would host it, `design.md:2905-2916`).
7. **Provider credentials**: stored as plaintext JSON in the data dir; per-user cloud deployments should inject via env/secret store; the
   `FileCredentials`/`Models` objects are the seam (`plugins/models/credentials.ts`, `resources.ts:62-110`).
8. **Tool permissions**: with a remote shell-capable agent, per-tool approval is a likely requirement. None exists; the design point is the
   `Questions` service (p2 `docs/questions.md`) + Durable tool hooks/`ToolPark`; p3 slice 11.
9. **Operational**: Node >= 26.3.1 for p3 (22.19+ for p2 server; TUI needs 26.5.1), one process lock per data dir, esbuild at runtime (needs
   dev toolchain in image unless using p3's release bundle), `node:sqlite` store, optional Python speech service.

### 6.3 Risks and unknowns

- Both apps and Chord are pre-1.0 in practice (p2 data formats "change without notice" `README.md:3-6`; p3 slices re-planned frequently;
  Chord CHANGELOG [Unreleased] already has breaking changes). Pin the commit.
- I did not run either app; all behaviour above is from code/docs. I did not verify the Python speech service's `/room` endpoint, the p3
  worker-level facts after the `Unreleased` changelog items, or that p3 tests currently pass.
- The Chord packages published to npm under `@earendil-works/*` are at 1.6.0 in this tree; whether the same versions are publicly installable
  was not checked.

---

## 7. File index (most useful starting points)

| Topic | Files |
| --- | --- |
| Chord concepts | `packages/chord/README.md`, `packages/chord/docs/design.md` (§3 hosts/links, §5 types, §17 registries, §21 reload, §23 HTTP/workers/app kit, §24 Durable) |
| Chord wire | `packages/chord/src/link/README.md`, `packages/chord/src/surfaces/connection.ts` |
| p2 server | `apps/p2/src/hosts/server.ts`, `src/hosts/session-workers.ts`, `src/hosts/worker.ts`, `src/hosts/principals.ts`, `src/runtime/server.ts`, `src/runtime/principals.ts` |
| p2 Durable integration | `apps/p2/src/runtime/worker.ts` (`:683-830`), `src/runtime/durable.ts`, `src/runtime/session-store.ts`, `src/runtime/tool-access.ts`, `plugins/chat/{contract,worker}.ts`, `plugins/models/resources.ts`, `plugins/coding-tools/worker.ts` |
| p2 auth | `plugins/devices/server.ts`, `src/runtime/local-owner.ts`, `plugins/sharing/server.ts`, `README.md:40-130` |
| p2 client | `src/hosts/web/main.tsx`, `plugins/chat/web.tsx`, `plugins/chat/outbox.ts`, `src/web/conversation-cache.ts`, `public/sw.js`, `src/runtime/connection-state.ts` |
| p2 docs | `docs/p2-notes.md` (§Chord v2 at 364), `docs/handoff.md`, `docs/remote-envs.md`, `docs/questions.md` |
| p3 base | `apps/p3/src/{server,worker,bin,pi,files,principals}.ts`, `src/api/v1/*` |
| p3 plugins | `apps/p3/plugins/{sessions,sign-in,runner,control}/` |
| p3 plans | `apps/p3/docs/{README,decisions}.md`, `docs/slices/{README,01,03,21,25,26}*.md` |
