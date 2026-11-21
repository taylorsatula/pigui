# Claude Code in the cloud (claude.ai/code, "remote" sessions): product reference

Researched 2026-11-21 from current docs. Anything marked **[inferred]** is my deduction, not
something the docs state. Anything marked **[unverified]** is from third-party/user reports.
Primary source index: https://code.claude.com/docs/llms.txt . Doc pages are cited inline.

Terminology drift worth knowing: "Claude Code on the web" is now "cloud sessions";
`--remote` is a deprecated alias for `--cloud`; "routines" were renamed "cloud scheduled
tasks"; "bridge environment" = the entry Remote Control registers for your own machine.

Key pages:
- Main: https://code.claude.com/docs/en/claude-code-on-the-web
- Quickstart: https://code.claude.com/docs/en/web-quickstart
- Environments/network/setup: https://code.claude.com/docs/en/cloud-environments
- Remote Control: https://code.claude.com/docs/en/remote-control
- Scheduled tasks: https://code.claude.com/docs/en/routines
- Projects (orchestration beta): https://code.claude.com/docs/en/claude-projects
- Mobile: https://code.claude.com/docs/en/mobile
- Permission modes: https://code.claude.com/docs/en/permission-modes
- Security: https://code.claude.com/docs/en/security
- Data usage: https://code.claude.com/docs/en/data-usage
- Slack: https://code.claude.com/docs/en/slack
- Self-hosted: https://code.claude.com/docs/en/self-hosted-environments
- Eng blog (sandboxing, Oct 2025): https://www.anthropic.com/engineering/claude-code-sandboxing
- Eng blog (auto mode): https://www.anthropic.com/engineering/claude-code-auto-mode
- Launch post: https://claude.com/blog/claude-code-on-the-web

---------------------------------------------------------------------------------------------

## 1. Architecture as publicly described

### 1.1 Control plane vs. worker
- A cloud session is "Claude Code running somewhere other than your machine." By default on
  Anthropic-managed VMs; optionally on customer runners (self-hosted environments).
  https://code.claude.com/docs/en/claude-code-on-the-web
- It is the *same Claude Code binary* as the terminal ("Claude Code behaves the same
  everywhere. What changes is where the session runs"). https://code.claude.com/docs/en/web-quickstart
  This matters: the product is a thin remote-hosting + sync layer around the unmodified CLI agent
  loop, not a different agent. Slash commands that need a TUI picker are degraded to
  argument-form (`/model sonnet`) or text output.
- Self-hosted topology (the best public view of the control-plane/worker split):
  environment = named queue; runner = long-lived poller; session = child Claude Code process the
  runner spawns. Runner polls `api.anthropic.com` (10 s per poll; poll doubles as heartbeat; lease
  lapses ~60 s after polling stops; requeue "a few minutes"). Child process holds an SSE/event
  stream to the API; **Anthropic never connects inbound**; all connections outbound HTTPS.
  A runner locks to one "owner" at first claimed session so checkouts never mix between owners.
  https://code.claude.com/docs/en/self-hosted-environments
  **[inferred]** The Anthropic-hosted path is very likely the same queue/lease protocol with
  Anthropic-operated runners/VMs. Transcript lives server-side (event stream), the VM is a
  disposable executor.
- Session transcript is stored by Anthropic so a session can be reopened on a fresh VM
  ("Restored: your conversation history"). https://code.claude.com/docs/en/data-usage
- Session identity: env var `CLAUDE_CODE_REMOTE_SESSION_ID` (prefix `cse_`) maps to URL prefix
  `session_`. Commits get a `Claude-Session: <url>` trailer; PR bodies get the session URL.
  https://code.claude.com/docs/en/cloud-environments#link-output-back-to-the-session

### 1.2 Isolation unit
- "Isolated, Anthropic-managed VM" per session. The isolation tech (Firecracker/gVisor/etc.)
  is NOT stated in Anthropic docs. A third-party write-up claims gVisor; treat as **[unverified]**.
  https://code.claude.com/docs/en/security#cloud-execution-security
- Base OS: Ubuntu 24.04; setup scripts run as root. Common runtimes/DBs pre-installed
  (Python w/ pip/poetry/uv/ruff/pytest, Node, etc.), `gh` pre-installed.
  https://code.claude.com/docs/en/cloud-environments#installed-tools
- You get **no shell into the VM**; "Claude runs every command for you." (cloud-environments, "Run tests...")
- Replacing the base image is "not supported yet"; workaround is setup script or running your own
  containers with docker compose alongside.

### 1.3 Resource limits
- ~4 vCPU, 16 GB RAM, 30 GB disk, "approximate and may change." VM may kill memory-heavy tasks.
  https://code.claude.com/docs/en/cloud-environments#resource-limits
- Foreground command timeout: 2 min default, up to 10 min; on timeout the command is moved to
  background and may live up to 30 more minutes. SessionStart hooks: 600 s default.
  https://code.claude.com/docs/en/cloud-environments#time-limits
- No separate VM charge; usage counts against the same plan limits as all Claude usage.
  Parallel sessions consume limits proportionally. https://code.claude.com/docs/en/claude-code-on-the-web#limitations

### 1.4 How the repo gets in
Three paths:
1. **Clone from GitHub** at session start (fresh clone every session, branch selectable).
   Auth is either the **Claude GitHub App** (public repos + private where installed) or a
   **`/web-setup`** flow that uploads the user's local `gh auth token` (encrypted at rest on
   Anthropic servers; reaches any repo the token can). https://code.claude.com/docs/en/web-quickstart
2. **Local bundle upload** (`claude --cloud` from a repo with no remote, or when App not
   installed, or `CCR_FORCE_BUNDLE=1`): full history bundle, <100 MB, falls back to
   current-branch-only then a squashed snapshot; includes uncommitted *tracked* changes;
   excludes `.env`, `*.tfvars`, keys (`id_rsa`, `*.pem`), and git-filter/LFS-managed changes
   on mac/Linux/WSL; needs git >= 2.31; refuses odd layouts (submodule cwd, `--separate-git-dir`,
   reftable, sparse worktrees). Bundled sessions can push back only to GitHub with push access.
   https://code.claude.com/docs/en/claude-code-on-the-web#send-local-repositories-without-github
3. **No repository** ("No repository" option in the picker).
- Multiple repos per session are supported in web UI; CLI `--cloud` is single-repo.
- Non-GitHub hosts: clone/PR creation need GitHub; GitLab/Bitbucket only via bundle, and results
  cannot be pushed back. GitHub Enterprise Server supported on Team/Enterprise.
  (same page, Limitations)

### 1.5 Git credential handling (the "GitHub proxy")
Strongest, most reusable design in the product.
- Real GitHub credential is stored encrypted on Anthropic servers and "never enters a session's
  VM." VM holds a **short-lived credential scoped to that session**; git client talks to a
  dedicated proxy which verifies it and swaps in the real token server-side.
  https://code.claude.com/docs/en/security#cloud-execution-security ,
  https://code.claude.com/docs/en/cloud-environments#github-proxy
- Engineering blog describes the same flow: scoped credential in sandbox -> proxy verifies
  credential AND inspects the git request ("e.g. only pushes to the configured branch") ->
  attaches real token -> forwards to GitHub.
  https://www.anthropic.com/engineering/claude-code-sandboxing
- Proxy rules documented today:
  - Rejects branch deletions and pushes of non-branch refs (tags).
  - Does **not** restrict *which* branch can be updated; docs say to use GitHub branch
    protection/rulesets (and note a rule the connected identity can bypass will not block it).
  - **Repository scope**: API calls for repos not attached to the session -> 403
    ("GitHub access to ... is not enabled for this session"); also blocks archive/codeload
    downloads of unattached repos, even public.
  - **GraphQL blocked entirely** (403, tells you to use REST via `gh api repos/...`). So
    `gh pr`/`gh issue` subcommands fail; `gh api` works; Projects v2 unreachable.
  - `GH_TOKEN`/`GITHUB_TOKEN` read as the literal placeholder `proxy-injected` inside commands;
    proxy substitutes real creds on outbound GitHub requests. If the user sets their own token
    in env it passes through verbatim (and is then visible to anyone using the environment).
- Built-in GitHub tools (read issues, list PRs, fetch diffs, comment) authenticate via the same
  proxy. PR creation is a UI/tool action ("Create PR" button / Claude-driven).
- Commit signing keys likewise stay outside the sandbox (blog post).

### 1.6 Network egress
- All outbound traffic from Anthropic-hosted VMs goes through an HTTP/HTTPS **security proxy**
  ("protection against malicious requests; rate limiting and abuse prevention", plus audit
  logging per data-usage page). https://code.claude.com/docs/en/cloud-environments#security-proxy
- Three levels per **environment**: **None**, **Limited** (default; allowlist of package registries,
  GitHub, cloud SDKs, container registries + user-supplied domains, with `*.` wildcard), **Full**.
  "Allow package managers" checkbox toggles the default list. Per-environment only; **no
  org-wide allowlist** and no managed-setting to add domains.
  https://code.claude.com/docs/en/cloud-environments#access-levels
- Changing the policy applies to *existing* sessions within ~1 minute (policy enforced at the
  proxy, not baked into the VM). **[inferred]** proxy looks up policy per environment dynamically.
- Paths that bypass the allowlist even at "None": GitHub (separate proxy), MCP connectors (traffic
  goes through Anthropic servers, not the VM network), hosts attached to network secrets, and
  the Anthropic API itself. Docs explicitly warn that at "None" Claude Code can still talk to the
  Anthropic API "which may allow data to exit the VM."
  https://code.claude.com/docs/en/claude-code-on-the-web#security-and-isolation
- Agent SDK secure-deployment doc admits domain-fronting risk with allowlist proxies and
  suggests a TLS-terminating proxy for stronger guarantees (surfaced via search):
  https://code.claude.com/docs/en/agent-sdk/secure-deployment
- Blocked-request UX: 403 / ENOTFOUND style errors; see
  https://code.claude.com/docs/en/errors#host-not-allowed-in-a-cloud-session . (My own
  WebFetch calls from this very cloud session failed with `getaddrinfo ENOTFOUND` for
  non-allowlisted hosts, i.e. blocked at DNS level, with a tool message telling the model to stop
  trying more hosts and tell the user to allow the host. Observed, not documented.)

### 1.7 Secret/credential injection ("network secrets")
- Per-environment **network secrets**: an API key stored server-side; the **agent proxy adds it
  to requests to listed hosts after they leave the VM**; the key is never in env vars or files.
  Header name/prefix configurable (Bearer default; `X-Api-Key` etc.); also username/password.
  Hosts on a secret are reachable even when the access level would block them.
  Value cannot be viewed again after save; to change, delete and re-add.
  https://code.claude.com/docs/en/cloud-environments#add-network-secrets
- Never injected for: GitHub (own proxy), `api.anthropic.com`, public registries (npm, pypi,
  crates, jsr, go proxy), **setup-script requests** (proxy attaches after Claude Code launches),
  Claude Code's own telemetry export.
- Not available in self-hosted or with customer-managed encryption keys.
- Plain environment variables are explicitly NOT secret: "Anyone who uses the environment can
  read its environment variables and setup script."

### 1.8 Setup scripts and environment caching
- Per-environment Bash script (<=64 KB), runs as root before Claude launches, **after clone,
  before env vars are set** (script must define what it needs). Non-zero exit -> session fails
  to start (or starts missing the tools).
- **Caching**: if the script finishes in ~5 minutes, Anthropic snapshots the **filesystem** and
  starts later sessions from that snapshot (skipping the script). Process state is not cached
  (databases, `docker compose up` don't survive). Rebuild triggers: script change, allowed-hosts
  change, ~7-day expiry. Script is not re-run when an idle VM is merely resumed.
  https://code.claude.com/docs/en/cloud-environments#environment-caching
- Division of labor: setup script = provision the VM (toolchains); **SessionStart hook** (from
  the repo's `.claude/settings.json`) = per-session project prep (`npm install`) that runs on
  every start/resume, not cached, so should be idempotent and fast.
- Repo-committed config carries over (CLAUDE.md, `.claude/settings.json` hooks/permissions in
  single-repo sessions, `.mcp.json`, skills/agents/commands/rules). Plugins declared in
  repo settings are NOT installed. User-level `~/.claude` is absent unless a setup script writes it.
  Org policy arrives via server-managed settings fetched at session start.
- Common failure: "New sessions hang or time out during setup" when the script exceeds the 5-min
  budget. https://code.claude.com/docs/en/web-quickstart#new-sessions-hang-or-time-out-during-setup

### 1.9 Session lifetime, idle, reclamation (three tiers)
1. **Running**: continues after tab/phone closes ("by design... continues until Claude finishes
   the current task, then idles").
2. **Paused**: "after a few minutes without activity, a session's VM pauses with its files saved.
   Your next message restores the same VM and starts Claude Code again." Env vars re-read on
   each restore; setup script does not re-run. You can't pause manually.
3. **Reclaimed / "Environment expired"**: paused VM later reclaimed after an unspecified
   inactivity period. Reopen -> fresh VM provisioned; conversation history restored; **not**
   restored: running shell commands, subagents (told which stopped; some resumable),
   session-scoped scheduled tasks and `/loop`s. Permission mode is restored.
   Projects page adds: if sandbox can't be resumed "the thread continues from a fresh clone, so
   uncommitted changes can be lost. On long tasks, ask Claude to commit and push work in progress."
   https://code.claude.com/docs/en/claude-code-on-the-web#environment-expired ,
   https://code.claude.com/docs/en/claude-projects#limitations
- A session counts as inactive **while it waits for you to approve an MCP connector call or
  sign in to an MCP server**, and can expire during that wait. (Notable: "waiting on human"
  does not keep the VM alive.)
- Exact pause/reclaim durations are not published. **[inferred]** a "few minutes" pause is
  essentially a VM snapshot/suspend used to cut cost.
- Self-hosted analogue: `--release-idle-session-min` releases an idle session; next message
  resumes it on a fresh runner.
- Data deletion: user can delete a session (removes event data). Archive hides it from sidebar;
  archived sessions reject new messages. Consumer retention 30 days (training off) or 5 years
  (training on); commercial 30 days; ZDR/HIPAA orgs cannot use cloud sessions at all, nor CMEK orgs.
  https://code.claude.com/docs/en/data-usage

---------------------------------------------------------------------------------------------

## 2. Session model

### 2.1 How sessions are created (all hit the same backend)
| Surface | Notes | Source |
|---|---|---|
| claude.ai/code (web) | repo + branch picker, env picker, permission-mode picker, prompt. URL prefill params: `prompt`/`q`, `prompt_url`, `repositories`/`repo`, `environment` (hook for "open in Claude Code" buttons from trackers) | web-quickstart |
| Claude mobile app, Code tab | same picker; sessions sync across devices | mobile |
| Desktop app | choose "Cloud" environment; can also send a Local session to cloud via "Open in" menu | claude-code-on-the-web |
| CLI `claude --cloud "task"` | clones the *remote* at current branch (not local checkout) unless bundling; live provisioning checklist in CLI; messages typed during provisioning are queued | claude-code-on-the-web |
| CLI `claude -p "msg" --cloud <session-id>` | **queues a follow-up into an existing session** from any machine/CI, exits immediately; `--output-format json` returns `{ok, session_id, url}` | claude-code-on-the-web#send-follow-ups-from-the-cli |
| Slack `@Claude` | intent-routing (Code only / Code+Chat); context gathered from thread/channel; progress posted to thread; DM + "View session" / "Create PR" buttons; sessions auto-shared with team on Team/Ent; legacy bot retired 2026-10-05 in favor of org-level "Claude Tag" | slack |
| Scheduled tasks (cron, API POST, GitHub events) | each run = a cloud session | routines |
| `/autofix-pr` in CLI, "auto-fix" on PR | spawns a cloud session that subscribes to PR webhooks | claude-code-on-the-web#auto-fix-pull-requests |
| Projects (beta) | coordinator conversation spawns thread sessions | claude-projects |
| Terminal-only gating | requires claude.ai subscription auth; not Bedrock/Vertex/API-key; org policy `allow_remote_sessions` | claude-code-on-the-web |

Handoff is **one-way per CLI**: cloud -> terminal via teleport; terminal -> cloud only by
starting a new `--cloud` session (or Desktop "Open in").

### 2.2 Branches and results
- Each task gets its own session and branch; Claude pushes the branch "when it reaches a stopping
  point"; the session stays open for PR creation and further edits (same conversation).
  Scheduled-task runs push to `claude/`-prefixed branches by default.
  https://code.claude.com/docs/en/routines#repositories-and-branch-permissions
- Results surface in a side panel "**Changes**" card (`+42 -18`) -> diff view; compare vs. base
  branch by default or any other branch; **inline line comments queue and ride along with your
  next message**; "Create PR" / "Create draft PR" button; PR title/description generated.
  Diffs computed from raw git blobs (no textconv/diff drivers). Gap: diff list is built from
  *pushed commits*, so uncommitted changes from shell commands (e.g. a formatter) don't show
  until Claude commits and pushes. https://code.claude.com/docs/en/claude-code-on-the-web#review-changes
- Auto-fix: Claude subscribes to GitHub PR events (CI failures, review comments) via the Claude
  GitHub App; fixes clear cases, asks you on ambiguous/architectural ones, notes duplicates; replies
  on PR threads *as the user's GitHub identity labeled as Claude Code* (warning: can trip
  `issue_comment`-triggered automation like Atlantis). GitHub emits no webhook for base-branch
  merge conflicts, so conflicts need a manual "rebase" request.
- Sharing: Private / Team (Team+Ent) or Private / Public-to-signed-in-users (Pro/Max); shared view is
  a snapshot that does not live-update; optional repo-access verification.

### 2.3 Teleport (cloud -> local terminal)
- `claude --teleport [id]`, `/teleport` (`/tp`), `/tasks` then `t`, web "Open in > Terminal",
  or `/teleport` inside the cloud session which prints the exact command.
- Requirements: clean git state (stash prompt), run from a checkout of the *same repo (not a fork)*,
  the session's branch must be **pushed**, same claude.ai account. Fetch is non-interactive (no
  password/passphrase prompts).
- Terminal gets its **own copy** of the conversation: new work stays local and does not appear in
  the cloud session. Compacted history is not copied (continues from the summary). To keep
  steering from phone afterward, run `/remote-control` locally.
  https://code.claude.com/docs/en/claude-code-on-the-web#continue-a-cloud-session-in-your-terminal

### 2.4 Remote Control (the inverse: drive your machine from web/phone)
- `claude remote-control` (alias `claude rc`; server mode, multiple concurrent sessions,
  `--spawn session|worktree`), `claude --remote-control`, or `/remote-control` in a running session
  (CLI, Desktop, VS Code). QR code in terminal; session appears in claude.ai/code and the app.
- Architecture: local process makes **outbound HTTPS only, no inbound ports**; registers with the
  API and **polls for work**; server relays messages over a streaming connection; "multiple
  short-lived credentials, each scoped to a single purpose and expiring independently."
  Transcript is stored on Anthropic servers while connected for sync/reconnect. Execution and
  filesystem stay local; **no VM or sandbox involved**.
  https://code.claude.com/docs/en/remote-control#connection-and-security
- Optional **Trusted Devices** (enrolled device credential + sign-in < 18 h old with biometric
  step-up) gating who can steer a Remote Control session.
- Both surfaces live: conversation and subagent progress sync; send messages from terminal, browser,
  phone interchangeably; attachments (photos, files) are downloaded to the local machine and passed as
  `@` refs; diff pane shows local changes; model/effort/permission mode switchable from device;
  **Fork** a session from the browser (when idle).
- Failure model: local process must stay up (sleep -> auto-reconnect; server mode gives up after
  ~10 min offline; presence heartbeat failure ~30 min disconnects); 403 retries up to 3 min.
  **Forwarded permission prompts and AskUserQuestion stay open until answered; other dialogs expire
  after 5 min** (`dialogExpiry`).
- Permission modes over Remote Control: Manual, Accept edits, Plan, Auto (no Bypass from app).
- Comparison table of "away from terminal" options (Dispatch, RC, Channels, Slack, self-hosted,
  scheduled): https://code.claude.com/docs/en/remote-control#remote-control-vs-cloud-sessions
- Channels (Telegram/Discord/iMessage plugin push events into a local session):
  https://code.claude.com/docs/en/channels

### 2.5 Parallel sessions and orchestration
- Parallelism is just "start more sessions": each its own VM/branch ("without managing multiple
  worktrees"). Limit is plan usage, not concurrency (no concurrency cap is documented).
- **Projects (public beta, Pro/Max/Ultra, not Team/Ent)**: a long-running *coordinator*
  conversation; routes each message to answer-in-place, new **thread**, or existing thread;
  threads are cloud sessions (or RC sessions on your machine) each on own branch/PR, "report back
  to the conversation when they finish." Coordinator "sees what threads report back, not every
  step they take." Shared **project memory** (`MEMORY.md` index + files) and **project
  instructions** (<=16,000 chars) injected into every thread. **Overview pane** buckets threads:
  Ready for review / Waiting on you / Working / Idle (and failed under Waiting on you). Threads run
  in auto mode; approvals must be answered **inside the thread** (telling the coordinator "go ahead"
  doesn't reach it). Project threads do not read repo `.claude/settings.json` permission rules, and
  skip `.mcp.json`/hooks. Single-owner; not shareable. Claude "proposes" threads vs. auto-starts
  depending on how you tune it ("tell Claude to start without asking you to confirm, and walk away").
  https://code.claude.com/docs/en/claude-projects
  Troubleshooting entry "Threads guessed or stalled instead of asking" suggests the fix is
  project-level instructions/environment, not per-thread.
- Subagents work as locally (Agent tool, `.claude/agents/`); agent teams behind
  `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.
- Cross-session messaging exists (sessions can message each other, incl. across machines):
  https://code.claude.com/docs/en/cross-session-messaging
- Also: "Ultrareview" (multi-agent code review in a cloud sandbox), "Claude Tag" (org-shared @Claude
  in Slack on same infra).

### 2.6 Scheduled / recurring tasks ("routines")
- Saved config = prompt + repos + connectors + environment; triggers: **schedule** (hourly/daily/
  weekly/cron, plus one-off timestamp), **API** (`POST /fire` with bearer token, beta header
  `experimental-cc-routine-2026-04-01`), **GitHub events** (PR/release, with filters on
  branch/label/etc.). One task may combine triggers. Create at claude.ai/code/routines or `/schedule`.
- "Run autonomously as full Claude Code cloud sessions." The prompt "must be self-contained and
  explicit about what success looks like." Runs belong to the creator's account, act as that
  GitHub/connector identity, push to `claude/*` branches.
- **Permission model for unattended runs**: session starts in **auto mode** unless unavailable;
  classifier allows/blocks; ask-rule matches still prompt; at repeated-block thresholds a prompt
  appears in the run's session and **waits until someone answers** (open run from detail page).
  If auto mode is unavailable, run keeps the launch mode.
- Limits: 100 scheduled runs/hour/account (waits when over); "Run now"+API fires 30/hour/task, 100/hr/
  account; GitHub events have per-task and per-account hourly caps (dropped over limit). Usage draws
  from the subscription; credits/overage optional. Subscription paused -> tasks held.
  https://code.claude.com/docs/en/routines#usage-and-limits
- Run history statuses are *session-ended* statuses (Succeeded/Failed/Cancelled), "not whether
  Claude completed the work your prompt describes."
- Separate session-scoped `/loop` and CLI/Desktop scheduled tasks exist; session-scoped ones die when
  the VM is reclaimed.

---------------------------------------------------------------------------------------------

## 3. Interactivity model vs terminal Claude Code (most important)

### 3.1 What the docs actually say vs. the framing "front-load questions, then go autonomous"
Honest finding: **the public docs do not describe a dedicated "ask-everything-up-front" mechanism
in the cloud product.** What exists is a *combination of*: (a) an explicit pre-flight step you do
yourself, (b) mode choices at task creation, (c) ordinary Claude Code behavior (plan mode,
AskUserQuestion) running in a headless-friendly harness, and (d) a safety classifier replacing the
human approval loop. The "front-load" behavior is largely **UX guidance + plan mode**, not a
separate protocol.

Evidence:
- Docs recommend: "Plan locally, execute in the cloud": run `claude --permission-mode plan`,
  iterate on the approach, save the plan to the repo, push, then
  `claude --cloud "Execute the migration plan in docs/migration-plan.md"`.
  https://code.claude.com/docs/en/claude-code-on-the-web#tips-for-cloud-tasks
- Quickstart positions cloud for "Tasks that don't need frequent steering: submit a well-defined
  task, do something else, and review the result when Claude is done", and tells users to be
  specific (name files, paste errors, describe expected behavior).
  https://code.claude.com/docs/en/web-quickstart
- Scheduled tasks: "the prompt must be self-contained."
- Projects: tells you to have Claude "propose threads before starting them" until trust is built, and
  lists "Threads guessed or stalled instead of asking" as a failure mode, i.e. threads *can* guess
  rather than ask; remedy is better standing instructions.
- Plan mode is offered as a permission mode in cloud: "Claude proposes an approach and waits for you
  to approve it before editing files." (web-quickstart). The approval menu in plan mode (terminal
  docs): "Yes, and use auto mode / Yes, manually approve edits / No, keep planning."
  https://code.claude.com/docs/en/permission-modes#plan-mode
- AskUserQuestion: a built-in tool Claude uses for clarifying questions (common in plan mode).
  In permission docs, `AskUserQuestion` is in the list of things **no mode auto-approves** (even
  bypass), and `dontAsk` denies it. In cloud, a question that is unanswered leaves the session
  idle: "If Claude asks a question and the session sits idle, you can still answer when you come
  back, up to environment expiry, and the session continues from your answer."
  https://code.claude.com/docs/en/claude-code-on-the-web#start-a-cloud-session-from-your-terminal
  In Remote Control, "permission prompts and AskUserQuestion questions stay open until answered".
- Official statement that cloud sessions *front-load questions* by design: **not found**.
  The Slack doc ("Define success... should Claude write tests? create a PR?") and the Quickstart
  both push the *user* to front-load context instead. **[inferred]** The "ask first, then work
  autonomously" feel comes from plan mode + AskUserQuestion + the model's own training, not a
  harness feature.

### 3.2 Permission modes available in cloud
- Cloud offers **Auto, Accept edits, Plan** only. **No Manual/default, no Bypass, no dontAsk.**
  "Accept edits corresponds to `default`, since cloud sessions pre-approve file edits."
  Cloud sessions **ignore** `defaultMode: bypassPermissions|dontAsk` in repo settings so a
  checked-in file can't escalate. Mode is chosen at creation and switchable via dropdown mid-run;
  restored on reopen.
  https://code.claude.com/docs/en/permission-modes#cloud-sessions ,
  https://code.claude.com/docs/en/web-quickstart#start-a-task
- Why no Bypass: the VM is the sandbox, but bypass "offers no protection against prompt injection";
  Anthropic chooses to keep a classifier in the loop even inside the VM. **[inferred]** rationale.
- Remote Control sessions (your machine) offer Manual, Accept edits, Plan, Auto; Bypass never from app.
- **Auto mode** (the mode that makes unattended work viable):
  - A separate classifier model (defaults Sonnet 5; earlier blog: Sonnet 4.6) gates each tool call
    before it runs; two stages (fast yes/no biased to block; then chain-of-thought only on flagged
    actions). Sees user messages, the agent's tool calls, and CLAUDE.md; **tool results and assistant
    prose are stripped** (so injected content and agent rationalizations can't steer it).
    In-project file edits and read-only tools skip it.
    https://www.anthropic.com/engineering/claude-code-auto-mode
  - Plus a **server-side prompt-injection probe** scanning tool outputs and prepending a warning to
    re-anchor the agent on the user's request. (permission-modes page; auto-mode post)
  - Published numbers: FPR 0.4% on 10k real internal calls; FNR 17% on 52 real overeager actions;
    5.7% on 1k synthetic exfiltration; "users accept 93% of manual permission prompts" (the
    motivation: approval fatigue). Anthropic says it is "not a substitute for careful human review
    on high-stakes infrastructure."
  - Blocked by default: `curl | bash`, sending sensitive data externally, prod deploys, force push,
    `git reset --hard`, `terraform destroy`, merging unapproved PRs, deleting pre-existing files.
    Allowed: local edits, installing declared deps, read-only HTTP, **pushing to branches of the
    repo you're working in**, creating a PR matching the request.
  - On a block the agent gets the reason as a tool result and is told to find a safer path, not
    route around it. **3 consecutive or 20 total blocks -> auto pauses and Claude falls back to
    prompting a human** (non-configurable). In headless `-p` with no prompt tool the action simply
    doesn't run and the agent keeps going (post says the process terminates; docs say it continues,
    docs are newer).
  - Stated user boundaries ("don't push") are treated as block signals but are not stored as rules
    and can be lost to compaction; use deny rules for hard guarantees.
- Rules still apply: explicit `ask` rules, org connector tools set to ask, `AskUserQuestion`,
  protected-path writes (`.git`, `.claude`, `.gitconfig`, `.npmrc`, `.mcp.json`, ...), critical-path
  `rm`. Deny rules block in every mode.

### 3.3 What still prompts a human in a cloud session
1. `AskUserQuestion` (model-initiated clarification).
2. Plan-mode plan approval.
3. Classifier fallbacks after repeated blocks (3 in a row / 20 total).
4. `ask` rules (org or repo) and protected-path writes.
5. **MCP connector tool calls and MCP sign-ins** can wait for approval; docs warn the VM can
   expire while waiting.
6. Projects: approvals are per-thread; surfaced in "Waiting on you."
Everything else (bash, edits, installs, push of the working repo's branches) runs without a prompt.

### 3.4 Steering mid-run
- You can **send messages while Claude is working**; they are **queued** until Claude reads them, and
  you can **cancel a queued message with the X** (text returns to the box) as long as Claude hasn't
  already read it. See https://code.claude.com/docs/en/claude-code-on-the-web#take-back-a-queued-message .
  **[inferred]** this is the "next turn boundary" injection pattern (message delivered at the next
  model call), not a hard interrupt.
- Interrupt: the cloud docs do not describe a stop button explicitly. **[inferred]** it exists in the
  UI as in the terminal (Esc equivalent); the Remote Control doc talks about "interrupt" only via
  Fork-when-idle. Not verified in docs.
- Inline diff comments queue with the next message. Mode dropdown and `/model`, `/effort` args can
  change mid-run. `/compact`, `/context`, `/clear` work.
- Follow-ups from anywhere via `claude -p "..." --cloud <id>` (CI-friendly; non-blocking).
- Rewind to an earlier message exists ("Rewind to here"), and Fork exists on RC sessions.
- Auto-compaction is tuned for cloud: sessions set `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` themselves so
  compaction triggers partway through the window (user env value ignored); window adjustable via
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` or `/autocompact`.

### 3.5 Being left alone: phone, closed tab, idle
- Closing the tab/app never stops the session. It works until the turn ends, then idles (VM pauses
  after "a few minutes", reclaimed later).
- If Claude asks a question and you don't return: session stays idle awaiting you; answer later up to
  environment expiry; session resumes from the answer, possibly on a fresh VM (history restored,
  background work lost).
- **Known fragility [unverified, GitHub issues surfaced by search]**: AskUserQuestion "breaks after
  a web async session resume" (aborts instantly or hangs) and "an idle session appears to be
  periodically re-woken" re-emitting a pending question (issues #77549, #72704 on
  claudeissues.com / anthropics/claude-code; could not fetch bodies, host blocked). Treat as
  *reported*, not confirmed.
- Notifications: Docs describe push for **Remote Control** ("Push when Claude decides" for
  long-task-finished/needs-decision, "Push when actions required" for permission prompts/questions;
  suppressed while you're active in the terminal; ask in prompt "notify me when tests finish").
  https://code.claude.com/docs/en/remote-control#mobile-push-notifications
  For **cloud** sessions I found no doc explicitly promising native push on finish/blocked.
  The Projects doc does: desktop-app notification when Claude posts, a thread errors or needs input
  (suppressed while viewing); browser shows a dot on the Threads button; optional per-turn
  notifications. Slack sessions DM you on completion. Scheduled tasks have a "last run" warning UI.
  Third-party/GitHub issues report push not arriving on iOS for "needs input" **[unverified]**.
  https://code.claude.com/docs/en/claude-projects#see-what-needs-you-in-overview
- Usage-limit hit mid-run: project threads pause and **auto-continue when limits reset** (default on).

### 3.6 Synthesis: how the cloud product reduces interactivity
1. Move the human checkpoint *before* (plan mode, "plan locally," well-specified prompt, URL-prefill
   from issue trackers) and *after* (diff review + inline comments + PR).
2. Replace in-run approvals with (a) a VM boundary, (b) a network allowlist, (c) a push-limited git
   proxy, (d) a classifier + injection probe, rather than a human.
3. Keep the in-run human channel but make it *durable*: questions/approvals persist while the VM
   sleeps; any device can answer.
4. Make the agent cheap to leave: state in server-side transcript; VM disposable; branch is the
   durable artifact ("ask Claude to commit and push work in progress").
5. Fall back to a human only after repeated classifier blocks, not on every risky action.

---------------------------------------------------------------------------------------------

## 4. Client surfaces

### Web (claude.ai/code)
- Sidebar of sessions (archive/unarchive/delete; "Archived" tab), session title menu (rename,
  share, Open in Terminal, Fork), mode dropdown, model/effort commands, repo+branch+environment
  pickers, multi-repo selection, "No repository" mode.
- Right-hand **activity/session rail** panel: Changes card (+/- counts), PR state, Auto-fix toggle on
  the PR's menu. Diff view with Compare-against, inline comments queued into next message.
  Can be opened as a pane in Desktop. https://code.claude.com/docs/en/claude-code-on-the-web#review-changes
- Live: streaming conversation, tool activity, subagent/workflow progress (RC docs), compaction
  progress. Summarized/lagging: diff (only pushed commits), shared-session views (snapshot),
  project coordinator (only what threads report back; "doesn't post each step").
- No file browser or terminal into the VM is documented ("You don't get a shell into the session
  VM"). **[inferred]** file viewing happens through the diff view and through Claude reading files
  in chat.
- Plugin suggestion cards in chat ("Add" button) are a notable proactive-UI element.
- Artifacts (published HTML pages) can be created by sessions; in auto mode unattended runs may
  publish without asking (private until shared).

### Mobile (iOS/Android "Code" tab of the Claude app)
- "A client for Claude Code sessions rather than a place where code runs." Start cloud sessions
  (repo+branch), open projects, drive RC sessions, message Dispatch. Check progress, answer
  questions, steer, tell Claude to watch a PR (auto-fix). Modes available: Accept edits, Plan, Auto
  (cloud); Manual/Accept edits/Plan/Auto (RC). No Bypass. Terminal-only slash commands unavailable.
  Photo/file attachments (to RC sessions: saved under `~/.claude/uploads/`).
  https://code.claude.com/docs/en/mobile
- Launch note: iOS was "early research preview" (Oct 2025). https://claude.com/blog/claude-code-on-the-web
- `/mobile` (alias `/ios`, `/android`) prints a QR code.

### Desktop app
- Environment selector with Cloud vs Local; sends local sessions to cloud; pane layout; notifications
  for projects; Dispatch (phone messages the desktop app; not for new users, not Team/Ent).

### Slack
- Thread-based status updates, final message edit with "View session"/"Create PR"/"Switch to code
  repo..." buttons; only channels, not DMs; one PR per session; GitHub only; warning that Claude may
  follow instructions from other messages in the thread context.

---------------------------------------------------------------------------------------------

## 5. Security model

### Trusted vs untrusted (as stated or implied)
- **Untrusted**: everything inside the VM (assumed compromisable): repo contents, tool output, web
  pages, Slack thread text, PR comments, MCP outputs, the model's own code execution.
  Hence credentials, signing keys and network secrets are kept outside, attached by proxies.
- **Trusted/authoritative**: the control plane, the proxies, the classifier, org-managed settings
  (server-managed settings fetched at start), the user's explicit messages.
- Repo-committed `.claude/settings.json` is semi-trusted: loaded in single-repo sessions but cannot
  grant bypass/dontAsk in cloud; `allowManagedPermissionRulesOnly` can ignore it entirely.
  Plugins from repo are not auto-installed. Project threads don't load repo permission rules/hooks/.mcp.json.

### Documented mitigations
- VM isolation; per-env network policy at a proxy; GitHub proxy with session-scoped credential,
  repo scoping, ref-type limits, GraphQL ban; network secrets injected out-of-VM; audit logging of all
  cloud operations ("All operations in cloud sessions are logged"); automatic VM cleanup; deletion.
  https://code.claude.com/docs/en/security#cloud-execution-security
- Auto-mode classifier with stripped inputs; server-side injection probe; subagent checks at spawn,
  mid-run and return. Deny rules, protected paths.
- Slack: only trusted conversations; `/invite` required per channel.
- Scoped GitHub access: App installed per org/repo, or `gh` token scope (warns on missing `workflow`
  scope), per-session repo attachment; recommend GitHub branch protection because proxy won't limit
  branches. Replies/comments are posted as the user.
- Data: encrypted at rest on Anthropic side for GitHub tokens; ZDR/HIPAA/CMEK orgs excluded.
- Self-hosted: customer owns isolation, egress, git creds; Anthropic never connects inbound; session
  content still goes to Anthropic.

### Admitted gaps
- "Auto mode reduces permission prompts but does not guarantee safety" (17% miss on overeager actions).
- Network "None" still allows Anthropic API egress (possible exfil channel).
- Allowlist proxies are vulnerable to domain fronting (SDK secure-deployment doc).
- Connectors bypass the egress policy (traffic via Anthropic servers).
- Auto-fix replies under the user's identity can trigger comment-driven automation.
- Env vars/setup scripts readable by everyone using a shared environment.

---------------------------------------------------------------------------------------------

## 6. Limitations and common complaints

Official limitations (https://code.claude.com/docs/en/claude-code-on-the-web#limitations):
- Shared rate limits with all Claude usage; parallel work drains faster.
- GitHub only for clone/PR (bundle workaround is one-way); GitLab/Bitbucket second-class.
- Setup script >~5 min -> uncached; per-command timeouts; 4 vCPU/16 GB/30 GB.
- Can't push a terminal session to cloud (only start new); teleport needs same account/repo/pushed branch.
- Not available with Bedrock/Vertex/API-key auth, ZDR, HIPAA, CMEK.
- GraphQL blocked => `gh pr`/`gh issue`/Projects v2 unusable.
- Diff view misses unpushed/unstaged changes.
- No org-wide network allowlist; environment env vars not secret.
- Idle sessions reclaimed; background shells/subagents/loops lost; Projects threads can resume from
  fresh clone with lost uncommitted changes.
- Remote Control: local process must remain running; one remote session per interactive process.
- Projects: beta, Pro/Max/Ultra only, no sharing, no org controls, thread can't move between projects.
- Slack: one PR per session; channels only.
- Auto-fix cannot see merge conflicts.
- Scheduled tasks: research preview; hourly caps; run status != task success.

User-reported complaints (GitHub issues / third-party; **[unverified]** severity, found via search,
could not open all bodies because third-party hosts are blocked in this session):
- Network allowlist confusion and inconsistent behavior ("Trusted" level semantics; tools fail
  inconsistently on blocked domains): https://github.com/anthropics/claude-code/issues/10223
- Playwright browser downloads blocked (CDN not on allowlist; hooks/permissions can't override
  container-level policy): https://github.com/anthropics/claude-code/issues/15583
- Requests to allow Wrangler/Terraform-style CLIs outbound (issue 32959, closed within days).
- Generic "execution error" on every session tied to git proxy infra:
  https://github.com/anthropics/claude-code/issues/22277
- Sessions failing even with Full network (issue 72602); egress settings ignored in some cloud
  contexts (issue 93512, "Cowork cloud sessions").
- AskUserQuestion breaking after resume; idle session re-waking and re-asking (issues 77549, 72704).
- Missing "needs input" push on iOS (issue 58548).
- Simon Willison's launch write-up exists (https://simonwillison.net/2025/Oct/20/claude-code-for-web/);
  I could not fetch it (host not allowlisted).

---------------------------------------------------------------------------------------------

## 7. Design patterns worth borrowing / pitfalls

### Patterns
1. **Credential-free VM + scoped session credential + brokering proxy.** Issue a per-session
   short-lived token that is only valid at *your* proxy; proxy validates the request semantics
   (repo, ref type, no deletes), then swaps in the real token. Extend the same idea to arbitrary
   APIs ("network secrets": inject by destination host, never expose value, refuse to inject into
   the model API/registries/setup phase). Also expose a placeholder (`proxy-injected`) so tools that
   require a non-empty token env var keep working.
2. **Policy at the proxy, not in the image.** Environment-scoped egress policy changes hit running
   sessions in ~1 min. Three simple levels (none / allowlist+package-managers / full), with
   non-network side-channels (git, connectors, model API) explicitly enumerated in docs.
3. **Environment = (network policy, env vars, setup script, secrets) as a saved, shareable object**
   with a *Default*; org-shared variant; archive; per-surface selector. Snapshot the filesystem
   after the setup script and reuse it; rebuild on config change or ~7 days; keep process state
   out of the cache; separate "provision" (cached) from "per-session start hook" (uncached, idempotent).
4. **Three-tier lifecycle**: run -> pause (suspend with files) after minutes -> reclaim; transcript
   server-side so reclaim is lossless for conversation and lossy for processes; tell the model
   exactly which background things died on resume. Persist permission mode across resume.
5. **Branch as the durable artifact.** Push at stopping points; diff view over pushed commits; PR
   button; trailer with session URL in commits/PRs for provenance; "commit and push WIP" guidance.
6. **Same agent, many doors**: one session backend, many creators (web, mobile, CLI, Slack, cron,
   GitHub webhook, API). Provide a headless "queue a message into session X" command for CI.
   URL prefill params let other tools launch sessions with a prompt.
7. **Replace the approval loop with layered automation**: sandbox + egress policy + classifier that
   is *blind to tool outputs and to the agent's prose* + injection probe on tool results + hard
   deny rules + escalation to human after N consecutive/M total blocks. Return block reasons to the
   agent and tell it not to circumvent. Make thresholds non-configurable.
8. **Durable human-in-the-loop**: questions and approvals persist while the VM sleeps; any device
   can answer; messages sent mid-run are queued and retractable; inline diff comments are bundled
   into the next message.
9. **Outbound-only worker connectivity** (poll + stream, lease/heartbeat, no inbound ports) for
   both local (Remote Control) and customer-hosted runners; short-lived single-purpose credentials.
   Runner-owner locking to avoid cross-tenant checkout contamination.
10. **Mode surface reduction in cloud**: only {auto, accept-edits, plan}; ignore repo-committed
    attempts to escalate to bypass. Consider the same: the repo is untrusted input.
11. **Coordinator/worker split for orchestration** (Projects): coordinator sees summaries, not
    steps; shared memory + instructions; "Waiting on you / Ready for review" inbox; propose-then-run
    toggle; thread-level approvals.
12. **Unattended runs need self-contained prompts and bounded blast radius**: separate branch
    prefix (`claude/`), connector allowlist per task, hourly rate caps, explicit run-status semantics.

### Pitfalls (observed in product or docs; some **[inferred]**)
- **"Waiting for human" must not consume or be killed by the idle clock without a clear resume story.**
  Claude Code's own docs concede the VM can expire while waiting on an MCP approval, and users report
  AskUserQuestion breaking across resume. Design the question/answer as persisted *state in the
  control plane*, not an in-process promise that dies with the VM. **[inferred]**
- **Don't trust allowlist alone**: Anthropic API and connector paths bypass it; domain fronting;
  "None" isn't airtight. Document every bypass path.
- **Branch restriction is the repo owner's job**: their git proxy blocks deletes/tags but not
  arbitrary branches; a connected identity that can bypass protection defeats rules. If you
  want "only push to claude/*", enforce it in the proxy (the blog implies they verify "the configured
  branch", but current docs say otherwise).
- **GraphQL ban** breaks `gh pr`, causing real friction; if you proxy GitHub, plan for CLI
  compatibility (or ship your own PR tools).
- **Diff built from pushed commits** surprises users; prefer computing the diff against the VM
  working tree or auto-committing.
- **Fresh-clone fallback loses uncommitted work**: either snapshot the disk reliably or auto-commit
  WIP to a hidden ref.
- **Setup-script time budget** is the top onboarding failure; give streaming progress and a cache
  build status; allow background phases.
- **Env vars are not secrets**; ship the secret-injection feature on day one, or users will paste
  tokens into shared environments.
- **Notifications are the weak link**: docs promise push mainly for Remote Control; cloud-session
  push is under-documented and reported flaky. If your product's thesis is "walk away," build
  first-class done/blocked/needs-input push (and a "Waiting on you" inbox) early, with presence
  suppression.
- **Classifier miss rate is real** (17% on overeager actions). Keep the VM, egress and git-proxy
  layers independent of the classifier; don't let auto mode be the only barrier.
- **Questions vs guessing**: even Anthropic's coordinator can "guess rather than ask." If front-loaded
  clarification is a core promise, implement it explicitly (a pre-flight "clarify" phase or required
  plan approval for non-trivial tasks) instead of relying on model disposition. **[inferred]**
- **Identity**: auto-fix replies and scheduled-task actions appear as the user. Label agent-authored
  content (Anthropic does) and warn about comment-triggered automation.
- **Quota coupling**: no concurrency cap but shared usage budget means parallel fan-out can silently
  burn the plan; Projects add auto-continue-after-reset, which may surprise users.
- **One-way handoff** (cloud -> terminal copy diverges; terminal -> cloud needs a new session) is a
  UX cliff; consider a shared transcript with explicit ownership transfer.

### Minimal checklist if building on a different agent runtime **[inferred]**
- Session = {id, transcript (server), VM (disposable), branch, mode, env_id}.
- Worker agent connects outbound; control plane relays user messages (queued) and approvals.
- Git broker + egress broker + secret injector as separate services, all keyed by a per-session
  token; VM has no long-lived creds.
- Environment snapshot service (post-setup FS snapshot, TTL ~7 d, hash on config).
- Pause/resume/reclaim state machine with "what died" notice injected into the next turn.
- Mode set: plan, accept-edits, auto(+blind classifier); no bypass; repo config cannot escalate.
- Inbox UI: Waiting on you / Ready for review / Working / Failed; push notifications with presence
  suppression; diff review with queued inline comments; PR button; session-URL provenance trailers.
- Headless API: create session (prefill), send message, list/queue, webhook triggers, cron.
