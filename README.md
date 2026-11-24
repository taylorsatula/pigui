# pigui

pigui is a self-hosted harness for the [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding
agent, driven from any browser. It is a faithful GUI layer on top of
[Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable): Pi Durable owns the agent loop, persistence,
compaction and recovery, and pigui configures those and adds the pieces a harness needs. It does not reimplement Pi's
internals.

pigui is built for long-horizon autonomous work. A session frontloads its planning: the agent asks questions to
resolve ambiguity before touching anything, presents an actionable plan for approval, implements it, and files a final
report with an option to open a pull request. You can put the phone away and come back to the report.

## How a session works

1. Pick a repository (or a directory on the machine) and describe the task.
2. The agent reads the project (and searches memory, when it is on), then asks its questions on cards. Single-choice questions come
   with a recommended option, shown first and pre-selected.
3. It proposes a plan. You approve it, or send feedback and get a revised plan.
4. It implements: edits, tests, and in a repository session a commit on its own branch. When the run ends you are
   notified.
5. The report says what changed, what was checked and where it departed from the plan. From the report card you can
   push the branch, open a pull request, view the diff, or keep working.

None of this touches GitHub until you tap. The agent commits; the server delivers, only when you ask.

## What pigui adds

- **Compaction built for long runs.** Before the context fills, pigui asks the agent for a short first-person
  handoff note, then writes a checkpoint — current state, evidence tiers, decisions, commands, tests and failures, the
  work queue — with the cut chosen by a summarizer and validated by code. Your own words are carried verbatim, never
  paraphrased. The agent resumes from its own note, and anything compaction removed from view stays readable through
  `recall_history`. Pi Durable's own compaction remains as a backstop. A session can run for hours across many context
  windows without losing the plot.
- **Built-in subagent support.** Pi can hand work to subagents — separate Pis with their own prompt, tools and model,
  working in a conversation of their own. Foreground (the default) or background, steering a running agent, or
  resuming a finished one. Their spend counts toward the session's cap; they are listed in an Agents panel with a Stop
  button. pigui ships four:
  - `scout` — read-only investigator with a fixed report shape, for establishing facts in a codebase.
  - `implementer` — executes an already-specified code change and reports what landed.
  - `verifier` — read-only check of a finished change against its spec.
  - `thought-partner` — pressure-tests designs.

  You can define your own as Markdown files; see [Your own agents and skills](#your-own-agents-and-skills). An agent runs in the session's directory, under the session's sandbox,
  with the project's instructions and skills, but never with pigui's own session tools, and agents start no agents of
  their own.
- **Long-term memory (optional).** Pi remembers across sessions and repositories what no file states: how a host is
  set up, how a tool really behaves, a measurement that cannot be repeated. A report records, corrects and rates it; a
  search happens before the agent asks or plans. Embeddings run on the machine (LEAF) or through an OpenAI-compatible
  endpoint.
- **Reading aloud (optional).** A speaker under each reply reads it aloud, rewritten for the ear by the session's
  model, synthesized on the machine by Kokoro. The reading continues with the screen locked.
- **Delivery.** Push the branch or open a pull request from the report card, with the report as its body. The diff is
  measured from where the session's work began.
- **Push notifications** for the moments that need you: a question, a plan to approve, a report, a spend cap.

## Build

Requires Node.js 22.19 or newer and git. Everything else comes from the lockfile.

```bash
npm ci
npm run build        # esbuild bundle of the app + service worker, fonts, drawn icons, the Landlock launcher (Linux)
```

The server runs its TypeScript directly (Node's type stripping); there is no server build step.

## Run fake mode

Fake mode runs the complete product with no model credentials and no GitHub access, on a free port in a temporary
directory:

```bash
npm run fake
```

It prints `pigui fake mode on http://127.0.0.1:<port>` and a temporary `PIGUI_DATA_DIR`. It uses a scripted model
(questions → plan → edits → commit → report), a local stand-in for GitHub with repositories to pick, and a fake
synthesizer — everything works except anything that needs a real model or real GitHub. Restart it on the same data
directory with `PIGUI_DATA_DIR=<that dir> npm run fake` and sessions continue where they left off.

## Run for real

```bash
PIGUI_DATA_DIR=/var/lib/pigui PIGUI_AGENT_GH_TOKEN=<read-only fine-grained token> node --disable-warning=ExperimentalWarning src/server/main.ts
```

Real mode without a Pi default model with credentials exits immediately with a message telling you how to sign in
(`pi`, `/login`, `/model`). Configuration is by environment variables; see below.

## Test

```bash
npm test        # node:test against the real server in fake mode, real Durable storage, no mocks
npm run e2e     # the same flows through the phone app in Chromium (390×844, touch)
```

Tests build the server through `startApp` in fake mode on a free port over a temporary data directory, with an empty
Pi configuration. Restarting closes the server and opens a new one on the same data directory, so restart behavior is
tested for real. Nothing is mocked; the scripted model is Pi's faux provider with one response factory per request.
End-to-end tests run the same fake server as a child process per fixture and drive Chromium.

Note: e2e needs Chromium's system libraries (on Debian/Ubuntu: `npx playwright install --with-deps chromium`), and on
a machine with no system fonts installed at all the suite needs any one system font present or fontconfig finds no
substitutes for the bundled faces.

## Configuration

All configuration is environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PIGUI_DATA_DIR` | (required) | The directory pigui keeps its database, workspaces, backups and keys in |
| `PIGUI_HOST` | `127.0.0.1` | Must be loopback; pigui has no other way in |
| `PIGUI_PORT` | `8787` (`2025` OnPrem) | Port to listen on |
| `PIGUI_PUSH_SUBJECT` | `mailto:pigui@localhost` | Contact for push services (`mailto:` or `https:`) |
| `PIGUI_ALLOWED_LOGINS` | empty | Comma-separated Tailscale logins allowed in; empty allows the whole tailnet |
| `PIGUI_SPEND_CAP` | none | Default per-session spend cap in US dollars |
| `PIGUI_AGENT_GH_TOKEN` | (required in real mode) | Read-only token agent commands get as `GH_TOKEN` |
| `PIGUI_COMPACTION_MODEL` | each session's model | `provider/modelId` for the compaction checkpoint writer |
| `PIGUI_SANDBOX` | on | `off` runs agent commands unconfined (for kernels without Landlock) |
| `PIGUI_MEMORY_PROVIDER` | `lunaroute` | Pi provider whose stored credential signs embeddings |
| `PIGUI_MEMORY_EMBED_MODEL` | `emb-qwen3` | Embedding model name; vectors from different models never mix |
| `PIGUI_MEMORY_EMBED_URL` | provider's catalog/`embeddings` | An explicit OpenAI-compatible embeddings URL |
| `PIGUI_ALLOWED_HOSTS` | none | OnPrem only: host names it is reached under, beside localhost |
| `PIGUI_MODELS_UNLOAD` | `never` | `never` keeps Kokoro/LEAF loaded; a number is minutes idle before release |
| `PIGUI_FAKE` | off | `1` runs fake mode |
| `PIGUI_ONPREM` | off | `on` runs on the person's computer with their full access |

Not read by the server, only by the installers and image: `PIGUI_TS_HOSTNAME`, `PIGUI_SPEECH`, `PIGUI_MEMORY_LOCAL`,
`TS_AUTHKEY`, `GH_TOKEN`, `AGENT_GH_TOKEN`. `PI_CODING_AGENT_DIR` overrides Pi's configuration directory (default
`~/.pi/agent`).

## Security model

**Reach.** Anyone who can reach pigui can make Pi run commands as whatever user pigui runs as. Tailnet membership
(plus the optional `PIGUI_ALLOWED_LOGINS`) is the boundary; there is no application login. `tailscale serve` (never
`funnel`) is the way in, and pigui checks the Tailscale identity header it adds. pigui also refuses connections made
by its own user, so an agent's commands cannot call pigui's own API.

**Credentials.** pigui holds its own read-write token for pushes and pull requests, used only when you tap, in its
own process, never in a sandbox. Agent commands get a separate read-only token as `GH_TOKEN`/`GITHUB_TOKEN` and never
see pigui's token or any `PIGUI_*` setting. Pi's own configuration stays Pi's.

**Confined files and reach.** On a server, every agent command and every file-tool path is confined: read-write the
session's workspace, its scratch directory and `/dev`; read the system, the files its environment points at, and the
skills pigui ships. From ABI 6 signals and abstract sockets are scoped too. What stays open, honestly: commands can
reach any host the machine reaches (the tailnet, a cloud metadata service) because builds need registries, the file
tools have a check-then-use race, and below ABI 6 commands can signal pigui and other sessions.

**Stated mitigations.** A fine-grained GitHub token limited to chosen repositories; branch protection on their default
branches; a service user without sudo; delivery only on a tap; the token split above. In Docker both containers drop
every capability (Tailscale keeps its two) and run `no-new-privileges`; pigui's root is read-only.

**OnPrem.** pigui OnPrem deliberately has none of the confined-user protections, because it runs on the person's own
computer as them: their directories, toolchains, credentials and services. It binds to localhost, answers to
`localhost` and the names in `PIGUI_ALLOWED_HOSTS`, and (on Linux) allows only connections from its own user and
root. A local session works in any directory it names; a server refuses local sessions with 403.

## Deploy

Three deployment paths, one decision tree — see **`deploy/` and `install.sh`**:

```bash
curl -fsSL https://raw.githubusercontent.com/taylorsatula/pigui/main/install.sh | bash -s --
```

It asks three questions — container or not, this computer or a remote server, then the flags — and installs or updates
in place.

- **Containerized remote deployment.** Two Docker containers on any machine with Docker: one runs Tailscale and serves
  pigui over HTTPS to your tailnet only, the other runs pigui sharing its network, listening on its loopback.
  Nothing is published on the machine's ports. The agent's commands are confined by the host's Landlock.
- **Local unrestricted install (OnPrem).** pigui on your own computer as you, with your full access, at
  http://localhost:2025.
- **Sandboxed server.** Debian or Ubuntu, a systemd service as its own user, agent commands confined by Landlock.

Part B of the runbook (deliberate deploys, human steps) and `deploy/` hold the full instructions.

## Your own agents and skills

pigui loads the same files the Pi CLI does, so what you already use works here with no setup.

- **Agents** are Markdown files in Pi's agents directory: `~/.pi/agent/agents` (or `$PI_CODING_AGENT_DIR/agents`). A
  repository can carry its own in `.pi/agents/` and `.agents/agents/`, which override yours, which override the bundled
  four. A file that names a tool pigui does not have runs without it, with the missing tools named; one that names a
  model Pi does not run is refused. Definitions are read at every use, so an edit applies with no restart. To hide an
  agent, list its name, one per line, in `~/.pi/agent/agents/.disabled`.
- **Skills** are directories with a `SKILL.md`, loaded from `~/.pi/agent/skills`, `~/.agents/skills`, the repository's
  `.pi/skills` and `.agents/skills`, and the ones pigui ships. On a name collision the project's and your own win over
  the bundled one.

## Layout

`src/shared` — every shape both sides use. `src/server` — the app: sessions, agent subsystem (`src/server/agent`),
delivery, memory, speech, subagents, sandbox. `src/client` — the phone PWA (Preact, markdown sanitized with
DOMPurify). `src/sw` — the service worker. `test` — node:test against the real server in fake mode. `e2e` —
Playwright. `deploy` — the installer, the Dockerfile pieces and the models script. `MANIFEST.md` — the functional
specification this reimplementation was built to; `DECISIONS.md` — the design choices and why.

MIT licensed.
