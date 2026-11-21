# picloud: implementation runbook (open edition, v1)

**Read this first.** This document specifies picloud v1 by its outcomes. It says what the product must do, what it
must not do, and how to know it is done. Most of *how* is left to you. You own the design: the architecture, module
structure, data model, API, protocol, agent tools, prompt wording, UI composition and test design. Every component
listed here is required. The way each one is built is your choice.

- **Work autonomously** until the definition of done (§A9) holds. Do not stop to ask questions.
- **Record your significant design choices** in `DECISIONS.md` at the repository root. Cover what you chose, the
  alternatives you considered, and why. Write it for a maintainer who will live with the code for years.
- **Install what you need.** You have full command-line access to this machine. Install whatever the build and tests
  need.
- **Do not change the machine's running services while building.** This machine may already be running picloud. While
  building, do not:
  - install, run or change systemd units, Tailscale, system users or `/var/lib/picloud`;
  - run your own installer;
  - bind port 8787;
  - read or modify the real Pi configuration in `~/.pi/agent`.

  Work inside the repository directory and temporary directories, apart from installing build and test tools.
- **Part B (deployment) happens only when someone deliberately deploys.**

| | |
|---|---|
| Language | **TypeScript everywhere**: server, browser client, service worker, tests. Pi and Pi Durable are TypeScript; share their types end to end. |
| Platform | `@earendil-works/*` **1.6.0** from npm; Node.js ≥ 22.19; Ubuntu 24.04 for deployment |
| Network to build | package registries and tool downloads only. No model credentials or GitHub access are needed (§A8). |

---

# Part A: Build

## A1. What picloud is

picloud is a self-hosted remote harness for the **Pi** coding agent. It runs on the owner's server (the "droplet").
The owner uses it from a phone, as an installed web app, over a private Tailscale network. It is a real tool the
owner will use every day, not a demo.

**The primary use is zero-shot work from a phone.**
1. Pick one of your GitHub repositories, and optionally a branch to start from or continue. Describe a task, and
   attach files or photos if useful.
2. Pi explores the code and front-loads its questions as tap-to-answer choices.
3. Pi proposes a plan. You approve it, or ask for revisions.
4. You put the phone away. Pi implements, verifies and commits on its own branch, and you can see its progress
   against the plan at a glance.
5. You get a notification and a final report. From the report you choose to push the branch, open a pull request,
   or keep working by typing feedback.

**Interactive use must not be barred.** A question gets an answer, and a small direct request is simply done. The
plan-first workflow is the default for substantial work. It is not a lock.

**Properties that must hold:**
1. **Waiting costs nothing and survives anything.** While picloud waits for the person (a question, a plan approval,
   a phone in a pocket), nothing is running. The wait survives server restarts and reboots, and resumes exactly
   where it was.
2. **Unattended runs reach a report.** A run that stops early without reporting must reliably be kept going, within
   bounds you define. Runaway runs are bounded in turns and in spend.
3. **Nothing reaches GitHub without a tap.** Pushes and pull requests happen only when the person chooses them. The
   agent commits locally and never pushes.
4. **The app is approachable.** It is a simple chat interface with an input pill, an attachment button and a send
   button. Tool calls and thinking are collapsed by default and expandable. Switching sessions is a quick pull-and-tap
   from a navigation drawer. Typing `@` references a repository file, and `#` invokes a Pi skill, through pickers
   that narrow as the person types.
5. **Long runs survive compaction.** When the context fills, the run is compacted and continues on its own, and the
   agent resumes correctly from what was carried forward (§A4.10). A compaction never needs the person and never
   ends a run.

## A2. Owner decisions (fixed)

### A2.1 Delegate to established tools
Do not rebuild what these already provide.

| Concern | Provided by |
|---|---|
| Authentication, TLS, remote reachability | **Tailscale** (`tailscale serve`; never `funnel`). No application login of its own. |
| Model providers, sign-in, credentials, default model | **Pi's own configuration** (the `pi` CLI writes `~/.pi/agent/`). picloud contains no provider code. |
| Agent loop, coding tools, retries, compaction, crash recovery, persistence | **Pi Durable** |
| Project instructions (`AGENTS.md`/`CLAUDE.md`) and skills | **Pi's own loaders** |
| Repos, branches, clone, push, pull requests, git credentials | **`gh`** and **`git`** |
| Push notifications | the **Web Push** standard |
| Process supervision | **systemd** |

### A2.2 Non-goals
Do not build:
- multi-user or tenancy;
- a settings screen;
- a model picker (models come from Pi);
- containers per session;
- a built-in browser;
- plugin systems;
- multiplayer or presence;
- self-editing;
- design or document tools;
- scheduled tasks;
- voice input;
- a file browser;
- CI watching;
- multi-repo sessions.

### A2.3 Quality bar
There is no size target. The result is judged on whether it is **complete**, **correct** and **maintainable**.
- **Complete and correct:** every requirement works, including error and restart paths. Smaller code that skips
  behavior is worse, not better.
- **Cohesive:** the parts fit together as one design: consistent names, consistent state handling, one way of doing
  each thing.
- **Maintainable:**
  - clear module boundaries;
  - each data shape defined once and shared by server and client;
  - strict TypeScript, with no unexplained `any`;
  - errors handled where they enter;
  - no dead code and no speculative abstraction;
  - tests that exercise behavior through public interfaces;
  - comments that explain why, not what.

## A3. Platform facts

These are facts about the libraries, not design choices. They are here because they are hard to discover and costly
to get wrong.

- **Pin the `@earendil-works/*` packages at exactly 1.6.0:** `pi-durable`, `pi-ai`, `pi-coding-agent`, `chord` and
  `pi-schema`. Pin every other dependency exactly too, and commit the lockfile.
- **Read the npm docs, not GitHub.** The `earendil-works/pi` GitHub main branch contains unreleased breaking changes,
  and its README and examples **do not match 1.6.0**. For example:
  - a 1.6.0 tool park is `{ sleep: { signals } }`;
  - signal state is `{ value } | { expired: true }`;
  - an `onYield` continuation is `{ continue }`.

  Treat `node_modules/@earendil-works/pi-durable/README.md` and the `.d.ts` files as the source of truth.
- **Pi Durable is a library, not a server.** One Harness over one storage. Only **one writable process** may open a
  given storage.
- **What Durable gives you for waiting:** a tool can park on a signal and hold no process while parked.
- **What Durable gives you for live views:** watches/observers deliver views and change operations, and
  `@earendil-works/chord/delta` can apply those operations in a browser.
- **Document scope:** a document with Durable scope `"session"` is one singleton per Harness, not per conversation.
- **IDs at runtime:** conversation, entry and task IDs are numbers.
- **Coding tools:** `@earendil-works/pi-durable/tools` provides Pi's coding tools (read, write, edit, bash). It brings
  **no system prompt** and does not load `AGENTS.md`.
- **What `@earendil-works/pi-coding-agent` exports:**
  - `ModelRuntime`, which is Pi's configured models, usable directly as Durable's `models`;
  - `SettingsManager`, for the default model;
  - `getAgentDir`;
  - `loadProjectContextFiles`, `loadSkills` and `formatSkillsForPrompt`.
- **Pi config location:** Pi reads its configuration from `PI_CODING_AGENT_DIR` when that is set, instead of
  `~/.pi/agent`.
- **Compaction is built into Durable, and its summary is weak.**
  - **Lifecycle:** a threshold or overflow starts a `CompactionTask`, which summarizes an old prefix of the context
    and places a `pi.compaction` entry ahead of a verbatim tail. A compaction during a run does not end it: the run
    continues with the summary in context. That was verified.
  - **What the built-in summarizer does:** it drops thinking, truncates each tool result to its first 2,000
    characters, writes one free-form summary, and on later compactions re-summarizes its own previous summary.
  - **Settings** are fixed token counts by default.
  - **The hook:** `hook(CompactionTask, { beforeCompact })` receives the replaced entries and messages and may return
    its own `{ summary }`, in which case the built-in summarizer does not run. The hook API includes `models`, `memo`,
    `snapshot` and raw `entries`.
  - **Failure:** a compaction the run waits on that fails ends the run with a `model_error` whose detail begins
    `Compaction failed`.
- **Pi's skill invocation format:** Pi invokes a skill by placing its body, with frontmatter stripped
  (`stripFrontmatter` is exported), in a `<skill name="…" location="…">` block that notes "References are relative
  to {baseDir}". Matching it keeps skills behaving as they do in the Pi CLI.
- **Credential-free model:** `@earendil-works/pi-ai/providers/faux` is a scripted model provider. Its responses can
  be functions of the conversation's messages, which makes scripts deterministic across concurrent conversations.
  Each queued response is consumed by one model call. It always reports zero cost.

## A4. Required capabilities

Each subsection states what must be true. How you achieve it is your design.

### A4.1 Sessions and workspaces
- A session is one task against one repository, with its own working copy and its own branch.
- **Starting a session:** the person picks a repo and either branches from a chosen base (default: the repo's default
  branch) or continues an existing branch, whose pushes then update it and any open PR.
- **Persistence:** sessions persist and survive restarts. A session caught mid-setup by a restart ends up in a clear,
  recoverable state.
- **Concurrency:** several sessions can run at once.
- **Repo memory:** what Pi learns about building and testing a repository on this machine carries over to later
  sessions on that repository.

### A4.2 The agent's environment and behavior
- **What Pi is told:** it is running remotely, with the person usually away. Which repo and branch it is on. How to
  work: answer simple things directly; for substantial work explore, front-load questions, plan, and get approval;
  after approval, work to completion without asking permission; verify before reporting; commit but never push or
  switch branches; bring its branch up to date with its comparison base before reporting; report honestly, including
  what it couldn't do.
- **Project context:** the repo's own instructions and skills are included, using Pi's loaders.
- **Required Pi tools.** Design each tool's name, schema, description and behavior.
  - A **single-choice question tool**: questions with radio-style options, a recommended option, and a free-text
    alternative.
  - A **multiple-choice question tool**: questions where several options can be selected, with a free-text
    alternative.
  - **Both question tools:** several questions on one card, so one interruption gathers all the answers.
  - A **plan tool** that submits a plan for approval, and accepts approval or revision feedback.
  - A **progress tool** that records which plan steps are complete.
  - A **report tool** that files the final report: summary, changes, verification, notes, and what was learned about
    building and testing the repo. It must refuse while there are uncommitted changes.
- **Waits are durable.** Every tool that waits for the person must wait durably (§A1 property 1). Side effects such
  as notifications happen once per wait, even if the tool reruns after a restart.
- **Unattended continuation.** Once a plan is approved, a run that ends without a report is continued automatically,
  a bounded number of times. Outside that situation the agent is never pushed to continue.
- **Bounds:** a per-run turn limit, and an optional per-session spend cap. When the cap is reached the run stops, the
  person is told, and they can raise the cap and continue.

### A4.3 Talking to Pi from the phone
- **Steering:** the person can send a message at any time. While a run is active, it steers the run. While a
  question or plan card is waiting, typed text answers that card. Otherwise it starts a new run (keep working).
- **Answering:** answering a card by tapping takes the fewest taps possible. A free-text answer is always possible.
- **Stop and continue:** the person can stop a run. A run that failed or was stopped can be continued.
- **Attachments:** images reach the model when it accepts images. Other files reach the agent's workspace without
  being committed. Phone photos are made a reasonable size before upload.
- **No duplicates:** a send that is retried (for example on a flaky connection) never takes effect twice.

### A4.4 Delivery
- **Choice:** from the final report, the person chooses push branch, open PR (or view and update an existing PR), or
  keep working.
- **Who pushes:** the server performs pushes and pull requests. The agent does not.
- **Push errors:** a push rejected because the remote moved produces a clear message the person can act on.
- **Reviewing changes:** the person can review the changes on the phone as a diff grouped by file, with added and
  removed counts.

### A4.5 Live state on the phone
- **Freshness:** the phone shows the session as it is now: streaming text, running tools, pending cards, progress,
  spend and status.
- **Reconnects:** after a dropped connection, a backgrounded app, or a server restart, the phone catches up on its
  own. A reconnect never costs a reload of the whole history.
- **History:** older history loads on demand.

### A4.6 Notifications
- **When to notify:** only when the person is needed or work is done:
  - a question is waiting;
  - a plan is ready;
  - a report is ready;
  - a run failed;
  - the agent replied or stopped without a report;
  - the budget was reached.
- **Suppression:** no notification for a session the person is currently looking at.
- **Tapping one** opens that session.

### A4.7 Access, logging and maintenance
- **Network:** the server listens on loopback only; Tailscale is the only way in. Optionally, access is limited to
  listed Tailscale logins (tailscale serve supplies the user's login in a request header).
- **Logging:** logs never contain message contents or credentials.
- **Workspace cleanup:** workspaces of old, delivered, archived sessions are cleaned up automatically. Cleanup
  **never** deletes unpushed work.
- **Backups:** the database is backed up daily.

### A4.8 Configuration
Configuration is by environment variables. Choose the set, document it in `README.md`, and keep it small. It must
cover:
- the data directory;
- the bind host and port;
- the Web Push subject;
- the optional login allowlist;
- the turn limit;
- the default spend cap;
- fake mode.

### A4.9 References in messages
- **The pickers:** typing `@` in the composer opens a picker of the repository's files, and typing `#` opens a picker
  of available Pi skills. Each refines as the person types and inserts the reference on tap.
  - Triggers must not fire inside ordinary text, such as email addresses or `#123` issue numbers.
  - On the New session view, files come from the chosen repo and branch before anything is cloned.
- **What the agent receives:** a file reference brings that file's contents, within sensible size limits, or a
  clear pointer when it is too large or binary. A skill reference invokes the skill the same way the Pi CLI does.
- **Display:** the person's text is shown as typed. The added context is visible but compact in the transcript.

### A4.10 Long sessions: compaction and resumption
Build picloud's own compaction handoff on top of Durable's compaction lifecycle. It must carry context forward far
better than the built-in summary (§A3), and the run must always continue on its own. Field-level design is yours.
These principles are the direction. They are what make a handoff work after a lossy, truncated compaction, so let
them settle the details, and explain in `DECISIONS.md` how your design follows each one:

1. **Ground truth over memory.** Anything that can be recomputed from the workspace or durable records is recomputed
   by code at compaction time, not summarized by a model. That includes repository state, commits, changed files,
   plan progress and session state. Code-built content cannot drift, and it is the same on every run.
2. **The person's words are never paraphrased.** The task, answers, plan feedback and later instructions are
   carried verbatim.
3. **Accumulate; don't re-summarize.** Each handoff updates the previous one. It is never a summary of a summary.
   Unresolved items persist until they are resolved.
4. **Lead with the resume point.** What was in progress at the cut, the latest result, and the exact next action,
   specific enough to act on without rereading.
5. **Keep negative knowledge.** What was tried and failed, and why.
6. **Point, don't paste.** Large content becomes pointers (paths and lines, commands to rerun, history to recall).
   The workspace and the raw history survive compaction.
7. **Make loss recoverable.** Give the agent a way to search the full pre-compaction history, and tell it that it
   exists.
8. **Verify before trusting.** The handoff tells the agent to re-establish ground truth before acting, and not to
   redo finished work or re-ask answered questions.
9. **Never strand the run.**
   - Model-written parts survive a restart without being regenerated.
   - A failed summarization still yields a usable handoff from the code-built parts.
   - A run that ends on a compaction error is resumed automatically.
10. **Degrade in a fixed order.** The handoff has a budget and sheds content in a defined priority order. It never
    sheds the resume point, the person's words, the plan state or the repository state.
11. **Size relative to the model.** Thresholds and budgets are proportions of the model's context window.

**Visibility:** the person can see that a compaction happened, and can open what was carried forward. The
compaction never changes the session's workflow state.

Real mode without a Pi default model must exit immediately with a message telling the operator how to sign in with
Pi. It must do this before touching the data directory.

## A5. The phone app (PWA)

**Platform:** an installable PWA written in TypeScript. It has an app shell that opens offline, a service worker,
Web Push, a manifest and icons. Choose your UI approach. Keep build tooling minimal, with no heavy bundler pipeline
unless you justify it in `DECISIONS.md`.

**Required experience:**
- **Navigation:** a ☰ drawer listing sessions, grouped by whether they need the person, are working, or are done.
  Each row shows enough status to decide where to look: state, progress and recency. The drawer offers a way to
  start a new session.
  - The ☰ button signals when *another* session needs attention.
  - Wide screens show the list persistently.
- **New session:** a repo choice and a branch choice with sensible defaults (the last repo; a new branch from the
  default), then the composer.
- **Session view:**
  - The transcript, with the agent's prose rendered as sanitized markdown.
  - Thinking is collapsed.
  - Tool activity is collapsed into plain-language summaries, expandable to each call and then to its full input and
    output. Failures are visible even while collapsed.
  - Question, plan and report content appear as cards, not raw tool calls.
  - Status and spend are visible without being loud.
- **Composer:** an input pill, an attachment button, and a send button that becomes Stop while a run is active and
  nothing is typed. It has the `@` file and `#` skill pickers (§A4.9). Its placeholder tells the person what sending will do in the current state. Drafts are never
  lost.
- **Errors and failures** show a clear reason and a next step (Continue, raise the budget, and so on).
- **Archive with undo,** not confirmation dialogs.
- **Platform fit:** it uses the system font and respects the text-size setting; works in dark mode; respects safe
  areas and the on-screen keyboard; has touch targets of at least 44 pt and sufficient contrast; respects reduced
  motion; works with screen readers; and never scrolls horizontally.

**Design guidance:** follow Apple's Human Interface Guidelines. In `DECISIONS.md`, name the HIG principle behind
each major UI choice.

## A6. Deployment automation

Produce an idempotent installer under `deploy/` that turns a fresh Ubuntu 24.04 machine into a running picloud, and
upgrades an existing install in place when re-run.
- **What it sets up:** system packages, Node, a dedicated unprivileged service user, data and install directories,
  the `pi` CLI, `gh`, Tailscale (install it and set it up, including `tailscale serve`), the app itself,
  configuration, systemd service(s), and daily backups.
- **Non-interactive input:** it accepts optional input for the parts that can be non-interactive, such as a Tailscale
  auth key or a GitHub token.
- **Leftover human steps:** it ends by reporting status and listing whichever human-only steps (§B2) remain.
- **Dry run:** it has a dry-run mode that changes nothing and shows every step it would take.
- **Not run during the build.** Verify it only with its dry-run mode and a syntax check.

## A7. Security model (must be documented in README)
- **Reach:** anyone who can reach picloud can make Pi run commands as the service user. Tailnet membership, plus the
  optional allowlist, is the boundary.
- **Credentials:** the agent shares the service user with the Pi and GitHub credentials. "Never push" is an
  instruction to the model, not an enforced boundary.
- **Stated mitigations:** a fine-grained GitHub token limited to chosen repositories, branch protection on default
  branches, a service user without sudo, and delivery only on a tap.

## A8. Credential-free mode and verification

**Fake mode.** It runs the complete product with no model credentials and no GitHub access, and works on a machine
where a real picloud is running. It needs:
- a scripted model (§A3) that exercises the zero-shot flow end to end: questions, plan, file changes, a commit,
  progress and a report;
- a plain chat reply when the task asks for one;
- a local stand-in for GitHub (repositories with at least two branches, push targets, and pull requests that survive
  a restart);
- a free port, a temporary data directory and an empty Pi configuration directory.

Design the scenario and the stand-in yourself, and document them.

**Automated tests** (TypeScript, real Durable storage, no mocking of Durable) must demonstrate each of these:
- the full zero-shot lifecycle through report and delivery;
- a pending question surviving a full server restart and completing afterwards;
- exactly one notification per wait, even across reruns;
- plan revision;
- the unattended-continuation bound, and its absence outside implementation;
- the report refusing uncommitted changes;
- message routing to a pending card, to a running run, and to a finished session;
- continue-branch mode committing on top of the existing branch;
- push and PR creation, with an existing PR reused, and delivery refused during a run;
- the diff showing only the session's changes;
- the budget stopping a run, then raising it and continuing;
- a model failure followed by continue;
- cleanup never touching unpushed work;
- the access allowlist;
- a compaction mid-implementation followed by the run reaching its report with no input from the person;
- the person's words and the plan state surviving several successive compactions verbatim;
- a failed summarization still producing a usable handoff and a continuing run;
- a restart during compaction not regenerating the model-written part;
- recall of a detail that exists only before a compaction;
- file and skill references expanding correctly, and unknown references staying plain text.

Fake mode needs repository files and a Pi skill to reference, and a way to force compaction (for example a small
context window on the scripted model).

**End-to-end tests** (TypeScript, Playwright, Chromium with a phone-sized viewport and touch, against fake mode) must
demonstrate:
- the whole tap flow, from new session through question, plan approval, report and opening a PR;
- collapsed and expandable tool calls and thinking;
- drawer navigation and the attention signal;
- answering a card by typing;
- archive and undo;
- the per-file diff;
- dark mode without console errors;
- no horizontal scroll at 375 px width;
- recovery after a server restart;
- the `@` and `#` pickers narrowing as the person types and inserting the chosen reference.

## A9. Definition of done
1. A clean install from the committed lockfile succeeds.
2. The build succeeds, and typechecking reports zero errors across all TypeScript.
3. All automated tests pass, covering everything in §A8.
4. All end-to-end tests pass, covering everything in §A8.
5. All source is TypeScript. JavaScript appears only as generated output, which is not committed.
6. `README.md` explains:
   - how to build, run fake mode, test and run end-to-end tests;
   - the configuration;
   - the security model;
   - how to deploy (pointing to Part B);
   - how tests construct the server.
7. `DECISIONS.md` covers the significant design choices with alternatives and reasons. That includes architecture,
   data model, API and live-update protocol, agent tool design and prompt, the continuation mechanism, the compaction
   handoff (mapped to each principle in §A4.10), references in messages, the UI approach and its HIG rationale, fake
   mode, and the installer.
8. Real mode without Pi credentials (using an empty Pi configuration directory and a temporary data directory) exits
   with the sign-in message.
9. The installer passes a syntax check, and its dry run lists every step without changing the system.
10. This file is unchanged in the repository.
11. The quality bar (§A2.3) is met. No test checks this; it is how the result is judged.

---

# Part B: Deploy and operate

Performed only when someone deliberately deploys. An agent may do it when asked.

## B1. Deploy
1. Provision Ubuntu 24.04: 2 vCPU / 4 GB RAM minimum, 50 GB disk, no inbound ports.
2. Install the language toolchains your repositories need.
3. Run the installer from a checkout of picloud, with any optional inputs (Tailscale auth key, GitHub token file,
   Web Push subject).
4. Re-run it after completing human steps, and to upgrade.

## B2. Steps that need a human
- **Tailscale:** log in (or supply an auth key), and enable MagicDNS and HTTPS certificates in the admin console.
- **Pi:** as the service user, run `pi`, then `/login` and `/model`.
- **GitHub:** create a fine-grained token for the repositories picloud may use (contents and pull requests
  read/write, metadata read), and enable branch protection on their default branches.
- **Phone:** install Tailscale and join the tailnet. Open the URL in Safari, **Add to Home Screen**, open picloud from
  there, and enable notifications.

## B3. Operate
- **Logs:** use the service journal.
- **Backups:** the daily database backups, plus the Pi configuration directory.
- **Upgrading `@earendil-works/*`:** read every changelog between the versions; bump all five packages together;
  run the full test and end-to-end suites; **back up the database first** (stored data may migrate, and rollback is
  not guaranteed); then re-run the installer.
