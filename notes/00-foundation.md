# picloud: foundational plan

A thin remote harness for Pi: a droplet runs Pi Durable, a phone talks to it. You pick a repo and describe a task.
Pi does its planning up front and asks multiple-choice questions while it plans. It then implements on its own
until it writes a final report and pushes a branch.

Research behind this document (all in `notes/research/`):

| File | Covers |
|---|---|
| `01-pi-durable-runtime.md` | Durable internals: commit model, tasks, recovery, storage, env, public API, human-in-the-loop primitives |
| `02-pi-web-app-integration.md` | p2 (Pi Mobile), p3, Chord: how the official apps wire Durable to a UI |
| `03-pi-agent-stack.md` | pi-ai, agent-core, coding-agent, env, mcp, codemode; what Durable does and doesn't use |
| `04-claude-code-cloud.md` | Claude Code on the web: architecture, session model, interactivity, security, pitfalls |

Reference code (not in this repo, re-clone if the container is gone):
- `/home/user/refs/pi`: `earendil-works/pi` at `780bf31`. Durable is `packages/durable`, Pi Mobile is `apps/p2`.
- `/home/user/refs/pi-durable-cloudflare`: official minimal Durable web app (Durable Object host).
- `/home/user/refs/pi-pocket`: third-party mobile-first Durable app. It is about 209k lines, so use it only as a
  reference for push notifications, approval UI and plan mode.

## What the research settled

1. **Durable is a library, not a server.** It has no wire protocol, auth, session list or tenancy. That host
   layer is the part we write, and it can stay small.
2. **Durable already does the hard parts.**
   - Crash-safe runs: every step is a checkpoint commit, and `resume()` continues from the last one.
   - Queued and steering input: `whenBusy: "steer" | "followUp"`.
   - Idempotent submits via `requestId`.
   - Live views: `watch()` gives the value plus Chord ops, with a late-join window and reconnect resume.
   - Built-in read/write/edit/bash tools in `@earendil-works/pi-durable/tools`.
   - Hooks, compaction and subagents.
3. **Durable does not use `pi-coding-agent` or `pi-agent-core`.** It has its own loop, tools and session store. The
   dependencies we need are `pi-durable`, `pi-ai` and `chord` (for `Context` and watches). `pi-env` and `pi-mcp` are
   optional.
4. **Pi has no permission system and no ask-user tool.** Durable has the primitive for both: a tool or a
   `beforeTool` gate can *park* on a signal. A parked call holds no process and survives restarts. It resumes when
   the host calls `harness.signal()`. This is exactly the right shape for a phone that answers hours later.
5. **The official apps are not a base.** p2 calls itself throwaway and is tangled up with Chord's object runtime
   and binary WebSocket protocol. p3 is the future but has no Durable, chat or UI yet. The right base is a fresh
   thin server that copies p2's integration patterns (see `02` §4: `apps/p2/src/runtime/worker.ts:753-808`,
   `plugins/chat/worker.ts`).
6. **Claude Code cloud gets "ask first, then run" from prompting, plan mode and a permission classifier.** It has no
   dedicated mechanism. We can do better by building the planning → implementing → reported states into the
   harness itself. It also has no documented push notification on finish or block, which we should have.

## Architecture

```
phone (PWA) ──HTTPS/WSS──> Caddy or Tailscale Serve ──> picloud server (Node ≥22.19, one process)
                                                         ├─ sessions index (SQLite): id, repo, branch, state, pending questions, push subs
                                                         ├─ per session: Harness over its own SQLite file
                                                         │    └─ root conversation, agent = model + coding tools + picloud extension
                                                         ├─ per session: workspace /srv/picloud/work/<id>/<repo> (git clone, own branch)
                                                         └─ web-push sender (VAPID)
```

### Process and storage model
- **One process.** A second writable open of the same storage would rerun another process's running tasks
  (`01` §6), so never run two server instances against the same data.
- **One Harness and one SQLite file per session:** `/srv/picloud/sessions/<id>/durable.sqlite`. Why:
  - Deleting a session is `rm`; Durable entries cannot be erased in place.
  - One session's crash loop doesn't count restarts against the others.
  - Listing sessions is our own index, which we need anyway.
- **Opening and closing.** Harnesses open lazily. A session with live or parked work is opened at boot and
  `resume()`d. Idle ones can be closed.

### Workspace and env
- **Setup on session create:**
  - `git clone` the repo with a fine-grained PAT through a credential helper.
  - `git switch -c picloud/<slug>`.
  - Run an optional per-repo setup command.
- **Env per call.** `HarnessOptions.env` returns a cached `NodeExecutionEnv({ cwd: workspace })` per session.
- **Isolation level.** Run the server as a dedicated unprivileged user. Directory-per-session is enough for your own
  repos.
- **Upgrade path.** Use `pi-env`'s `RemoteExecutionEnv` over `docker exec -i` for a container per session. No other
  code would change, because the tools only touch the host through `api.env`.

### The picloud extension (the real product)
One `defineExtension({ name: "picloud", ... })` selected on every session's conversation:

- **System prompt section.** It covers:
  - You are running remotely on a server and the user is on a phone, mostly not watching.
  - Workflow: plan, then ask any questions with `ask_user` (batch them), then call `begin_implementation`, then
    work until done, then call `final_report`.
  - After `begin_implementation`, ask only on genuine blockers, and prefer a reasonable decision noted in the report.
  - Repo, branch, push rules, how to run tests, and what is installed.
- **`ask_user` tool (multiple choice).**
  - Arguments: `questions: [{ id, prompt, options: [{ label, description }], multiSelect, allowOther }]`. One call
    carries a batch, so planning interrupts the user once, not five times.
  - On a fresh call it memoizes a question id, writes the question into our index (for push and the
    "waiting on you" list), sends a push, and parks with `{ kind: "sleep", signals: [Answer.key(qid)] }`.
  - On wake it reads the signal and returns the answers as the tool result.
  - Mark it `replay: "safe"`, since its side effects are keyed by the memoized id.
  - Durable doesn't store question text separately, but the arguments are in the assistant entry, so the live view
    can render the card too.
- **`begin_implementation` tool.**
  - Arguments: `{ plan, assumptions[] }`.
  - Moves a `picloud.session` doc from `planning` to `implementing` and shows the plan on the phone.
  - Optional: in "review plan" mode it parks for a thumbs-up first.
- **`final_report` tool.**
  - Arguments: `{ summary, changes[], tests, commits, branch, followUps[] }`.
  - Moves the doc to `reported` and sends a push.
  - The phone renders the report as the session's headline.
- **`onYield` hook.** If the run tries to end while the state is `implementing`, continue it with a short nudge.
  This guards against the model stopping to ask "want me to continue?". Cap the nudges at about 3 per run. Combined
  with `maxTurns`, that is what makes "runs until the final report" reliable instead of hopeful.
- **`beforeTool` guard on bash.**
  - Block `git push --force` and any push to the default branch or to a branch that isn't the session's.
  - Block `git config credential` changes.
  - Cheap insurance against prompt injection, since the PAT is in the sandbox.

### HTTP surface (JSON plus one WebSocket)
| Route | Purpose |
|---|---|
| `GET /api/repos` | repos the PAT can see |
| `POST /api/sessions` `{repo, base?, task, model?}` | clone, branch, open the Harness, submit the task |
| `GET /api/sessions` | index: state, last activity, pending questions, report present |
| `WS /api/sessions/:id/watch` | relay `watch()` (first value, then ops); the client resumes with `transcript.resume` |
| `GET /api/sessions/:id/entries?before=` | page older transcript |
| `POST /api/sessions/:id/messages` `{text, requestId, mode: steer\|followUp}` | message mid-run or after |
| `POST /api/sessions/:id/answers` `{questionId, answers}` | `harness.signal(Answer, qid, ...)` |
| `POST /api/sessions/:id/stop` | `conversation.abort()` |
| `POST /api/sessions/:id/continue` | `submit({type:"continue"})` after a failed run |
| `GET /api/sessions/:id/diff` | `git diff base...HEAD` for review on the phone |
| `POST /api/push/subscribe` | store a Web Push subscription |

### Client
- **Tech:** a Preact PWA with no build step, or a minimal Vite build.
- **Screens:** session list ("waiting on you" first), new session, session view, report view.
- **Session view:** a transcript with folded tool calls, a question card, a plan card and a composer.
- **Report view:** the summary, the diff, and a "create PR" button if wanted.
- **Push:** a service worker handles push and opens straight to the question.

### Auth and exposure
- **Recommended: Tailscale.** No public port at all, and `tailscale serve` provides the HTTPS that Web Push and
  service workers need.
- **Alternative: Caddy.** If a public URL is wanted, put Caddy (automatic TLS) in front and use a single owner token
  exchanged for an httpOnly signed cookie.
- **Either way, single owner.**

## Risks and known gaps
- **Durable is experimental.** 1.6.0 already has 7 breaking changes pending. Pin exact versions of all
  `@earendil-works/*` packages and upgrade on purpose.
- **Double billing on crash.** A model request in flight at a crash is retried (counted as a failed attempt).
- **Interrupted tools aren't rerun.** Tools default to replay-unsafe, so a crash mid-bash gives the model an
  "interrupted" result. That's correct behavior, but the model must cope with it, which it generally does.
- **PAT inside the sandbox.**
  - Mitigations: a fine-grained token scoped to chosen repos, the push guard above, and GitHub branch protection on
    default branches.
  - The full fix is a credential-injecting git proxy like Claude Code's; defer it unless needed.
- **Claude subscription login.** Pi's Claude Pro/Max OAuth path presents itself to the API as Claude Code (`03`). For
  a personal droplet that's your call, but an Anthropic API key is the clean route.
- **No quotas.** `pi.usage` records spend but doesn't enforce limits. Add a per-session budget check in a
  `beforeRequest` hook if wanted.

## Build order
1. **Server skeleton.** Open a Harness per session over SQLite, with a coding-tools registry, an Anthropic model, a
   workspace clone and `submit`. Drive it from curl.
2. **Watch relay over WebSocket and a bare client** that renders entries plus `pi.live`.
3. **The picloud extension:** system prompt, `ask_user`, `begin_implementation`, `final_report`, `onYield` nudge and
   push guard.
4. **Phone polish:** PWA install, question card, report and diff view, Web Push.
5. **Deployment:** systemd unit, Tailscale or Caddy, backups of `/srv/picloud`.
6. **Later:** container per session, PR creation, scheduled or recurring tasks, multiple repos per session.

## Decisions (2026-11-21)
- **Scope rule:** nothing gets built unless it serves "pick repo, plan with questions, approve, run unattended,
  report, deliver". No browser, marketplace, multiplayer or self-editing.
- **Model provider:** not Anthropic. Which provider is still open.
- **Access:** Tailscale only, with `tailscale serve` for HTTPS. There is no public port and no app-level login
  beyond the tailnet.
- **Plan gate:** `begin_implementation` parks until the user approves the plan on the phone. The user can also
  reject it with feedback, which returns the run to planning.
- **Delivery:** `final_report` is followed by a choice on the phone:
  - push the branch;
  - push and open a PR;
  - keep working, which submits the user's feedback as a follow-up that starts a new implementation run.
  Nothing reaches GitHub until the user picks.

## Open questions for the user
- Just you, or other users eventually? (This decides auth and isolation scope.)
- Model and auth: Anthropic API key, or Claude subscription via Pi's OAuth?
- Should finished sessions open a PR automatically, offer a button, or only push the branch?
- Should the plan need an explicit thumbs-up before implementation starts, or start immediately after questions are
  answered?
- Tailscale or a public URL?
- Several sessions running at once on one droplet? (Supported by the design; it's a sizing question.)
