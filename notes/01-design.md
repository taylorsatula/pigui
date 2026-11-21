# picloud: design

The product in one sentence: from your phone, describe a task against one of your repos, answer a few tapped
questions, approve a plan, put the phone away, and come back to a report with a push / PR button.

Recurring rule: **if an established tool already does it, picloud doesn't**. picloud is glue: one small server, one
Pi extension, one PWA.

## 1. Who does what

| Concern | Handled by | picloud code |
|---|---|---|
| Auth, TLS, device trust, remote reach | Tailscale (`tailscale serve`) | none |
| Model providers, sign-in, default model | Pi (`pi` → `/login`, `~/.pi/agent/auth.json`, `settings.json`) | about 5 lines to load them |
| Agent loop, tools, retries, compaction, crash recovery | Pi Durable | none |
| Coding tools (read/write/edit/bash) | `@earendil-works/pi-durable/tools` | none |
| Persistence of sessions, transcripts, status | Durable storage (one SQLite file) and Durable documents | doc definitions only |
| Live sync to the phone | Durable `watch()` ops, applied in the browser by `@earendil-works/chord/delta` | an SSE relay |
| GitHub: repo list, clone, push, PR | `gh` and `git` on the droplet (`gh auth login` once) | shell-outs |
| Push notifications | Web Push standard plus the `web-push` npm package | send on 3 events |
| Markdown in replies | `marked` plus `DOMPurify` (vendored) | none |
| Process supervision | systemd | one unit file |

What picloud writes itself: the session lifecycle, three agent tools, one system-prompt section, one hook, the HTTP and
SSE surface, and the PWA. The target is about 2,000 lines total. Going over that budget means we're building
something we said no to.

## 2. Session lifecycle

```
 new ──▶ planning ──▶ awaiting approval ──▶ implementing ──▶ reported ──▶ delivered
            ▲  │  ask_user (tap answers)       │                 │
            │  └──────────────┘                │                 │
            └──── "revise" with feedback ──────┘                 │
            └──────────────── message in composer ("keep working") ┘
```

- **new:** the server runs `gh repo clone` into `/srv/picloud/work/<id>/`, creates branch `picloud/<slug>`, creates
  a Durable conversation with `cwd` there, and submits your task.
- **planning:** the agent explores and calls `ask_user` if a decision is genuinely yours. That can happen 0 or more
  times; the guidance is to batch questions into one call.
- **awaiting approval:** the agent calls `submit_plan`. The call parks on a signal and holds no process. The phone
  shows the plan with **Approve** and **Revise**.
  - Revise sends your text back as the tool result, and the agent re-plans.
- **implementing:** the agent works unattended. An `onYield` hook nudges it on if it tries to stop without a
  report, up to 3 nudges. `maxTurns` is the backstop.
- **reported:** the agent calls `final_report`. The phone shows the report with **Push branch** and **Open PR**.
  - Typing in the composer is "keep working". That is an ordinary follow-up message, so no extra button.
- **delivered:** the server runs `git push` / `gh pr create` with the report as the PR body. The agent never pushes.

Every wait (question, plan, crash, restart, phone in pocket) is a Durable park or checkpoint. A droplet reboot
mid-run continues where it stopped.

**Interactive use isn't barred.** The workflow is the default the system prompt teaches, not a lock. Ask "what does
this function do?" and you get an answer. Say "just fix the typo" and it fixes it. No plan ceremony is enforced in
code. The only hook that enforces anything (the nudge) applies only after a plan was approved.

## 3. Server

One Node process (≥22.19) running as user `picloud`, bound to localhost, exposed with `tailscale serve`.

- **One Harness, one SQLite file** (`/srv/picloud/durable.sqlite`). Each session is an ownerless conversation.
  - A global Durable document `picloud.sessions` holds the list: id, repo, branch, title, state, updatedAt.
  - Our tools update it in the same commit as their own work, so list and transcript never disagree.
  - Archive hides a session from the list. Durable entries are immutable, and that's fine.
- **Models:** `builtinModels({ credentials: AuthStorage.create() })` plus Pi's default provider and model.
- **Env:** `NodeExecutionEnv({ cwd })` per session, cached.
- **HTTP surface (all JSON except SSE):**
  - `GET /api/repos`: `gh repo list` (cached a minute)
  - `GET /api/sessions/events`: SSE of the sessions-list doc (value, then ops)
  - `POST /api/sessions` `{repo, text, attachments}`: create a session
  - `GET /api/sessions/:id/events`: SSE relay of `conversation.watch()`; reconnect sends `Last-Event-ID` → `transcript.resume`
  - `GET /api/sessions/:id/entries?before=`: older transcript pages
  - `POST /api/sessions/:id/messages` `{text, requestId, attachments}`: steer if running, follow-up if idle
  - `POST /api/sessions/:id/answer` `{taskId, key, value}`: `harness.signal()` for question and plan cards
  - `POST /api/sessions/:id/stop`: `conversation.abort()`
  - `POST /api/sessions/:id/deliver` `{kind: "push" | "pr"}`
  - `GET /api/sessions/:id/diff`: `git diff <base>...HEAD`
  - `POST /api/uploads`: images go to the model; other files are saved to `<workspace>/.picloud/uploads/`
  - `POST /api/push/subscribe`: stored in a Durable document
  - static: the PWA

## 4. The picloud extension (what the agent sees)

Kept small on purpose, because every byte here is sent with every request.

- **System prompt section, about 300 words.** It covers:
  - You run on a remote server and the person is on a phone, usually not watching.
  - For work beyond a small direct request, follow the workflow: explore, then ask (`ask_user`, batched), then
    `submit_plan`, then implement, then `final_report`.
  - After the plan is approved, don't stop to ask permission. Make reasonable calls and list them in the report.
    Use `ask_user` only for a true blocker.
  - Commit on the current branch. Never push; the person delivers from the report.
  - Repo, branch, and how to find the test commands.
- **`ask_user`.**
  - Schema: 1 to 4 questions, each with `header` (≤12 chars), `question`, 2 to 4 `options` `{label, description}`,
    and `multiSelect`. "Other" free text is always available in the UI.
  - Mechanics: it parks on a signal, and the answer comes back as `header: answer` lines.
- **`submit_plan` `{summary, steps[], assumptions[]}`.** Parks until the phone answers. Approve returns "approved"
  and sets state to `implementing`. Revise returns your feedback.
- **`final_report` `{summary, changes[], verification, notes[]}`.** Sets state to `reported` and sends a push.
  The branch and commits are filled in by the server from git, not by the model.
- **`onYield` hook:** described in §2.

## 5. The PWA

Plain HTML, CSS and JS with Preact + htm vendored, and no build step. It is installable to the home screen. It has
two screens, a few sheets, and one composer component used in both places.

### Screen 1: Sessions (home)

```
┌──────────────────────────────┐
│ Sessions                      │  large title
│                               │
│ ● Waiting for you             │  section: needs you
│   Fix login redirect          │
│   acme/web · Plan ready · 2m  │
│                               │
│   Working                     │
│   Add CSV export              │
│   acme/api · 14m              │
│                               │
│   Done                        │
│   Bump deps · Reported · 1h   │
│                               │
│ ┌──────────────────────────┐  │
│ │ [acme/web ▾]             │  │  repo chip (last used)
│ │ (+)  Describe a task… (↑)│  │  input pill
│ └──────────────────────────┘  │
└──────────────────────────────┘
```

- **Composer on home, not behind a "+" button.** Starting a task is the app's primary action, so it sits in the
  thumb zone and is ready immediately. Type, send, and you're in the new session.
  - HIG principles: *primary action prominent*, *reachability/thumb zone*, *minimize steps*.
- **Repo chip remembers the last repo.** Tapping it opens a searchable sheet, recent repos first.
  - HIG principles: *sensible defaults*, *minimize text entry*, *sheets for focused sub-tasks*.
- **List grouped by what needs you.** "Waiting for you" comes first, then Working, then Done. Each row shows title,
  repo, state and relative time, and nothing else.
  - HIG principles: *clarity*, *visual hierarchy*, *show status at a glance*.
- **Swipe to archive** with an Undo toast, and no confirm dialog.
  - HIG principles: *direct manipulation*, *forgiveness over confirmation*.
- **No settings screen, no hamburger, no tab bar.** Models are set in Pi and auth is Tailscale. There is nothing to
  configure.
  - HIG principles: *flat, shallow navigation*, *deference*: chrome stays out of the way of content.

### Screen 2: Session

```
┌──────────────────────────────┐
│ ‹ Sessions   Fix login…   ⋯   │  back, title, overflow: Stop/Archive/Diff
│                               │
│ You: The login page loops…    │
│                               │
│ ▸ Thought for 8s              │  collapsed
│ ▸ Read 6 files, ran 2 commands│  collapsed group
│                               │
│ ┌ Pi asks ──────────────────┐ │  question card
│ │ Scope                     │ │
│ │ Fix only Safari, or all?  │ │
│ │ [Safari only (Recommended)]│ │
│ │ [All browsers]  [Other…]  │ │
│ └───────────────────────────┘ │
│                               │
│ ┌ Plan ─────────────────────┐ │  plan card (after answers)
│ │ 1. … 2. … 3. …            │ │
│ │ Assumes: …                │ │
│ │ [Revise]        [Approve] │ │
│ └───────────────────────────┘ │
│ ─ Working · 6m ─────────────  │  status line
│ (+)  Message…           (■)   │  same composer; ■ = stop when empty
└──────────────────────────────┘
```

- **Transcript is the content and chrome recedes.** It uses the system font (`-apple-system`/`system-ui`), body
  text at the platform size, and Dynamic Type respected via `rem` and `font: -apple-system-body`.
  - HIG principles: *deference*, *legibility*, *respect user text-size settings*.
- **Thinking collapsed:** "▸ Thought for 8s". Tap to expand.
  - HIG principle: *progressive disclosure*.
- **Tool calls collapsed and grouped.** Consecutive calls fold into one line in plain words ("Read 6 files, ran 2
  commands"). Expand to see each call as a one-line summary ("Ran `npm test` — passed"). Tap one for full
  input and output in monospace.
  - HIG principles: *progressive disclosure* (three levels), *speak the user's language*, not tool-call JSON.
- **Errors stay visible.** A failed command shows a red mark on the collapsed group line.
  - HIG principle: *don't hide problems behind disclosure*.
- **Streaming text renders in place.** No spinner over content; the status line says "Working".
  - HIG principles: *feedback*, *non-blocking progress*.
- **Question card in the flow.**
  - Options are full-width tappable rows of at least 44 pt, with the recommended one first.
  - "Other…" expands an inline text field.
  - Multiple questions show stacked with one Submit. Single-select with one question submits on tap.
  - HIG principles: *44×44 pt touch targets*, *minimize typing*, *recognition over recall*, *fewest taps*.
- **Plan card: two buttons, Approve as the primary.** Revise focuses the composer with a "Revising plan" label;
  what you type is the feedback. No separate form.
  - HIG principles: *one primary action*, *reuse familiar controls*, *avoid modes*. The label is shown, and clearing
    it exits.
- **Report card.** Summary, then changes (tap for diff sheet), then verification, then notes. Buttons: **Push
  branch** (primary) and **Open PR**. After delivery the card shows the GitHub link.
  - "Keep working" needs no button: the composer is right there.
  - HIG principles: *don't duplicate controls*, *clear outcome feedback*.
- **One composer, context-aware.**
  - Layout: attachment (+) on the left and send (↑) on the right. The pill grows to about 6 lines, then scrolls.
  - While a run is going and the pill is empty, ↑ becomes ■ (Stop). Typing turns it back to ↑, which steers the
    running work.
  - This matches the Claude and ChatGPT apps, so there's nothing to learn.
  - HIG principles: *consistency with conventions users already know*, *a single control that adapts rather than
    extra buttons*.
- **Attachment (+)** opens the native picker (`<input type=file accept=image/*,...>`), which gives camera, photos
  and files for free. Thumbnails appear in the pill with ✕ to remove.
  - HIG principles: *use system pickers*, *reversible actions*.
- **Keyboard and safe areas.** The composer sits above the keyboard (`visualViewport`) and respects
  `env(safe-area-inset-*)`. Send-on-Enter only with a hardware keyboard.
  - HIG principles: *respect safe areas*, *keyboard avoidance*.
- **Overflow menu (⋯):** Stop, View changes, Archive. Rare actions stay out of sight.
  - HIG principle: *hierarchy by frequency*.

### Cross-cutting
- **Dark mode via `prefers-color-scheme`, with semantic color tokens.** Text contrast is at least 4.5:1.
  - HIG principles: *adapt to appearance*, *accessibility*.
- **`prefers-reduced-motion`** disables the expand animations.
  - HIG principle: *motion is optional*.
- **VoiceOver.** Real `<button>` elements, labels on icon buttons ("Attach", "Send", "Stop"), and expandables with
  `aria-expanded`.
  - HIG principle: *accessibility is not optional*.
- **Connectivity.** Losing the connection shows a thin "Reconnecting…" bar and never blocks reading or typing.
  - Sends carry a `requestId`, so a retry never double-sends.
  - Reconnect fetches only what was missed.
  - HIG principles: *graceful degradation*, *never lose user input*.
- **State restoration.** Reopening the app returns to the screen you left. A notification deep-links to its card.
  - HIG principle: *preserve context*.
- **Notifications** go out only when you're needed or the work is done: a question is waiting, a plan is ready, a
  report is ready, or a run failed. Each opens straight to the card. No "started" or "still working" noise.
  - HIG principles: *notifications must be timely, relevant, actionable*, *respect attention*.

## 6. Still open
1. **Agent and `gh` credentials share the `picloud` user.** The agent's bash could technically read the gh token
   and push.
   - Options: (a) accept it for v1, since the repos are yours: scope the token and protect default branches;
     (b) run the agent's shell as a second Unix user.
   - Recommendation: (a), revisit if it ever matters.
2. **Per-session model override.** v1 uses Pi's default only. Adding a picker later is a chip on the composer.
3. **Session title.** Use the first line of the task, or have the agent set a title via `submit_plan`? The second
   is free, since the field is already there.
4. **Diff view.** The plain monospace `git diff` sheet in v1 is enough. GitHub's compare view takes over after a
   push.
