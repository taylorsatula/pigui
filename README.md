# picloud

picloud runs the [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding agent on your own server
and lets you drive it from your phone. Pick a repository, describe a task, answer Pi's questions with a few taps,
approve its plan, and put the phone away. Pi implements, verifies and commits on its own branch; you get a
notification and a report, and you choose whether to push the branch, open a pull request, or keep working.
Titles, buttons and your own messages are set in a serif, the agent's replies in a sans, and what it did as one quiet
line each, and the app follows the phone's light or dark mode. The ☰ button opens the session picker, a listing of
every session in columns, as a file browser lists a folder, with a coloured mark for each one's status.
A speaker under each reply reads it aloud, with a speech model that runs on the server ([Reading aloud](#reading-aloud)).
With an embedding key, or a local embedding model built in, Pi also remembers across sessions what no file states
([Long-term memory](#long-term-memory)).
It can also run on your own computer instead, at http://localhost:2025, where a session works in any directory there
with your full access ([PiCloud OnPrem](#picloud-onprem)).

It is thin glue around [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable), which owns the agent
loop, persistence, compaction and recovery. Tailscale provides access and TLS, `gh` and `git` talk to GitHub, Web
Push carries notifications, and systemd keeps it running. Why each piece is built the way it is lives in
[DECISIONS.md](DECISIONS.md).

## Requirements

- Node.js 22.19 or newer (the server runs its TypeScript directly with Node's type stripping).
- git, and a C compiler (`cc`) for the agent sandbox's launcher.
- For real use: Debian 13 (recommended) or Ubuntu 24.04, on a kernel with Landlock, with Tailscale, `gh`, Pi signed
  in and two GitHub tokens (see [Deploy](#deploy)). Or, on your own Mac or Linux computer, Node.js, git and Pi signed in
  ([PiCloud OnPrem](#picloud-onprem)).
- For the end-to-end tests: Chromium for Playwright 1.63 (`npx playwright install chromium` if it is not installed).

## Build, run and test

```bash
npm ci               # exact versions from the committed lockfile
npm run typecheck    # strict TypeScript: server, client, service worker, tests, end-to-end tests
npm run build        # bundles the phone app into dist/public, draws its icons, compiles dist/bin/picloud-sandbox
npm test             # automated tests (node:test), real Durable storage, fake mode
npm run e2e          # builds, then runs the Playwright tests in a phone-sized Chromium
npm run check        # all of the above
deploy/models.sh models speech memory   # optional: the local models, for real speech and embeddings here and their tests
```

### Fake mode

Fake mode is the whole product with no model credentials and no GitHub access. It is safe to run on a machine where a
real picloud is running: it uses a temporary data directory, an empty Pi configuration directory and a free port.

```bash
npm run build
npm run fake                       # prints the URL, for example http://127.0.0.1:41235
PICLOUD_PORT=8931 npm run fake     # a fixed port instead
```

What it runs:

- **A scripted model** (`src/server/fake/model.ts`): Pi's faux provider, answering each request from that request's
  messages, so many sessions can run at once. A task ending in `?` gets a plain chat reply (with Markdown). Any other
  task plays the zero-shot flow: it explores (with a thinking block), asks two questions on one card, proposes a
  three-step plan, writes `src/shout.ts` and a test, marks progress, runs the tests, commits and files its report. A
  later message makes a follow-up commit and a new report. In a local session (OnPrem), which has nothing to commit,
  it lists what it wrote instead. Its tokens are priced like a mid-range model so the spend
  cap can be tried. Directives in the task steer it, mostly for tests: `[checklist]` adds a multiple-choice card,
  `[no-report]` and `[never-report]` stop without a report, `[dirty-report]` reports before committing, `[model-error]`
  fails once, `[spin]` loops until stopped, and `[long]` produces verbose output so the context compacts: picloud asks
  for a handoff note, which the scripted model writes, then compacts and resumes. With `[long]`: `[recall]` searches
  history after a compaction, `[ignore-handoff]` ignores the request for a note, `[backstop]` prints so much in one
  round that Durable compacts first, and the scripted summarizer answers `[cut-invalid]` with an invalid cut,
  `[condense]` by condensing long results (which the agent then recalls), `[summarizer-fails]` with an error and
  `[summarizer-garbage]` with no checkpoint; `[compaction-fails]` fails Durable's own summarizer once. With
  long-term memory on, every report states its memory part; `[memory]` searches memory after exploring, rates what it
  found and, when it found nothing, records one memory, and `[unrated]` leaves the ratings out of its first report.
- **Embeddings without a network:** long-term memory is on, with a stand-in embedder that hashes words into counts,
  so texts sharing most of their words find each other.
- **A local stand-in for GitHub** (`src/server/fake/github.ts`): bare repositories under
  `$PICLOUD_DATA_DIR/fake-github/repos` that workspaces clone from and push to with plain git — `demo/greeter` (a
  small TypeScript library with an `AGENTS.md`, a Pi skill `release-notes`, a binary file, and a second branch
  `feature/farewell`) and `demo/notes` (branches `main` and `drafts`). Pull requests are kept in
  `fake-github/pulls.json`, so they survive restarts. Notifications are recorded instead of sent.
- **Reading aloud** without a model: the scripted model rewrites a reply for speech mechanically (a code block becomes
  "A code block.", Markdown's markers go), and a stand-in synthesizer answers each segment with a quiet tone as long as
  its text. `[speech-fails]` in the text to read fails the rewrite.
- `PICLOUD_FAKE_TOKENS_PER_SECOND` (only for `npm run fake`, default 60) sets how fast scripted text streams.
- **OnPrem** combines with it: `HOME=$(mktemp -d) PICLOUD_ONPREM=on npm run fake` serves it at localhost, with local
  sessions starting in that stand-in home. Give it a temporary `HOME`: OnPrem's commands run as you, and the scripted
  model writes files into the directory a session chose.
- **The sandbox** wherever this machine has Landlock and `npm run build` compiled the launcher; otherwise agent
  commands run unconfined, and the tests that need it skip. For those tests, the scripted model's `[probe]` directive
  runs the task's `$ command`, `read PATH` and `write PATH` lines one at a time.

### How tests construct the server

The automated tests call `startApp()` from `src/server/app.ts` — the same function `src/server/main.ts` uses — through
`TestServer` in `test/helpers.ts`. Each test server gets fake mode, port 0, a fresh temporary data directory and an
empty Pi configuration directory. Storage is the real SQLite storage of Pi Durable; nothing in Durable is mocked.
`restart()` closes the server and opens a new one on the same data directory, as a process restart would. Tests wait
on Durable watches of the session document rather than polling. A few seams in `AppOptions` exist for tests: a clock
(`now`), a request observer on the scripted model (`fakeModel.onRequest`, told each request's kind and last user
message), a smaller context window (`fakeModel.contextWindow`), `speech: false` for a build without speech,
`embedder` (`{ off: reason }` turns long-term memory off; a stand-in with another model name stands for a model change), and
`faults`, hooks that hold the code at an exact point so a test can cut it off there the way a crash would. The test that
reads with the real speech model runs only where `deploy/models.sh models speech` has fetched it, and those that embed
with LEAF only where `deploy/models.sh models memory` has. `PICLOUD_FAKE_MEMORY=off` starts `npm run fake` as a server
without an embedder, as `e2e/memory.spec.ts` does to see the session picker's notice.

The end-to-end tests (`e2e/`) start `scripts/fake.ts` as a child process per test file, on a free port with temporary
directories, and drive it with Playwright in Chromium at 390×844 (375 px for the horizontal-scroll check) with touch.
Restart tests kill the process and start it again on the same port and data. `test.use({ onPrem: true })` starts it as
OnPrem, with a temporary home, opened at localhost (`e2e/onprem.spec.ts`). Tests of OnPrem's local sessions give
`TestServer` `PICLOUD_ONPREM=on` and a temporary `HOME` in its `env`; the installer's are dry runs only, with stand-ins
for `uname` and the login shell, so the macOS paths run on Linux.

## Configuration

Configuration is by environment variables. The installer writes them to `/etc/picloud/picloud.env`; the OnPrem
installer writes its three into the service it installs.

| Variable | Default | Meaning |
|---|---|---|
| `PICLOUD_ONPREM` | `off` | `on` runs picloud on your own computer, as you ([PiCloud OnPrem](#picloud-onprem)): local sessions in any directory, agent commands with your environment and credentials, no sandbox, answering to localhost and to the tailnet names in `PICLOUD_ALLOWED_HOSTS`. It cannot be combined with `PICLOUD_SANDBOX=on` or `PICLOUD_AGENT_GH_TOKEN`, each of which promises a protection OnPrem does not have: picloud exits with code 2 and says which. |
| `PICLOUD_ALLOWED_HOSTS` | empty | OnPrem only: comma-separated host names, without a port, that picloud answers to besides localhost, such as the computer's MagicDNS name when `tailscale serve` puts it on your tailnet for your phone. The installer's `--tailscale on` sets it. Set without OnPrem, picloud exits with code 2. |
| `PICLOUD_DATA_DIR` | required | Database, workspaces, uploads, backups, push keys (and fake mode's stand-in GitHub). |
| `PICLOUD_HOST` | `127.0.0.1` | Bind address. Must be loopback; Tailscale serve, or in OnPrem this computer's browser, is the only way in. |
| `PICLOUD_PORT` | `8787`; `2025` in OnPrem | Bind port. `0` picks a free one. |
| `PICLOUD_PUSH_SUBJECT` | `mailto:picloud@localhost` | Contact (`mailto:` or `https:`) sent to push services with VAPID. Set a real one: Apple may reject a placeholder. |
| `PICLOUD_ALLOWED_LOGINS` | empty | Comma-separated Tailscale logins allowed in, checked against the `Tailscale-User-Login` header that `tailscale serve` adds. Empty allows anyone who reaches picloud through the tailnet. In OnPrem it applies to what comes through Tailscale; the computer's own browser at localhost needs no login. |
| `PICLOUD_SPEND_CAP` | none | Default spend cap per session, in US dollars. The person can raise a session's cap from the phone. |
| `PICLOUD_COMPACTION_MODEL` | each session's model | The model that writes compaction checkpoints, as `provider/modelId` the way Pi names it (for example `anthropic/claude-sonnet-4-5`). It must be one Pi has credentials for; while it is not, picloud logs a warning and uses the session's model. Its spend counts toward the session's cap. |
| `PICLOUD_FAKE` | `0` | `1` runs fake mode. |
| `PICLOUD_AGENT_GH_TOKEN` | required in real mode | The agent's read-only GitHub token (Contents and Metadata: read). Agent commands get it as `GH_TOKEN` and `GITHUB_TOKEN`, never picloud's own. Not in OnPrem, where they use your own `gh` and git credentials. |
| `PICLOUD_SANDBOX` | `on`; off in OnPrem | `on` confines every agent command and file tool with Landlock; `off` runs them unconfined, for a kernel without Landlock. |
| `PICLOUD_MEMORY_PROVIDER` | `lunaroute` | The Pi provider whose key signs long-term memory's embedding requests ([Long-term memory](#long-term-memory)). |
| `PICLOUD_MEMORY_EMBED_MODEL` | `emb-qwen3` | The embedding model. Memory's search thresholds are tuned for `emb-qwen3`; changing it re-embeds every memory once. |
| `PICLOUD_MEMORY_EMBED_URL` | the provider's | An OpenAI-compatible embeddings URL. By default, the provider's base URL in Pi's catalog plus `/embeddings`; for `lunaroute` without one there, `https://gw.lunaroute.com/v1/embeddings`. Set without a key, requests go unsigned, as to a local server. |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi's own variable: where Pi's configuration (models, sign-in, global skills, global `AGENTS.md`) is read from. In OnPrem, yours. |

Models, sign-in and the default model come from Pi's configuration; picloud's only settings of its own for them are
which model writes compaction checkpoints (`PICLOUD_COMPACTION_MODEL`) and memory's embeddings (`PICLOUD_MEMORY_*`). In
real mode, picloud exits with code 78 and instructions if Pi has no default model with credentials, before it touches
the data directory.

**Two GitHub tokens**, both fine-grained and limited to the repositories picloud may use:
- **picloud's own** (Contents and Pull requests: read and write; Metadata: read) lists repositories and branches,
  clones, pushes and opens pull requests, always from picloud's own process. With Docker it is `GH_TOKEN`; with the
  installer it is the service user's `gh` login.
- **the agent's** (Contents and Metadata: read) is `PICLOUD_AGENT_GH_TOKEN`, which agent commands get as their
  `GH_TOKEN`. `gh` reads it, and git through gh's credential helper, so nothing the agent runs can push.

With the sandbox on, real mode checks at startup that the launcher works, logs the kernel's Landlock ABI
(`sandbox.on`), and warns below ABI 6, where signals and abstract sockets are not scoped. Where it does not work,
picloud exits with code 2 and what to do: use a kernel with Landlock, or set `PICLOUD_SANDBOX=off`.

## Reading aloud

A speaker sits under each finished reply and on the report card. Tapped, it reads the reply aloud; tapped again, it
stops. Reading goes on with the phone locked.

- **What happens on a tap.** The phone sends the reply's Markdown to picloud, and the session's own model rewrites it
  as a script for the ear: code described rather than read, symbols and acronyms written as they are said. The script
  streams back a sentence at a time, and the phone fetches each sentence's audio, a few ahead of the one playing, so
  the first words come once the first sentence is ready. The rewrite is one small model call per reply,
  counted in the session's spend; reading the same reply again reuses its script.
- **The voice** is [Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) through `kokoro-js`, the
  8-bit model on the CPU, in the `af_heart` voice. It loads as the server starts (`speech.ready` in the log) and stays
  loaded, about 600 MB of memory. On two vCPU, synthesis takes about 0.6 of the speech's own length: a sentence takes
  about 3 seconds, so reading starts that long after the first sentence is written, and then stays ahead. After a
  short first sentence the phone waits for the next before it starts, so the reading does not stop after its first
  words. Kokoro's padding around each sentence is trimmed to a sentence's pause. One segment is read at a time. The log
  line `speech.script` gives the rewrite's time to its first sentence (`firstMs`), the other part of the wait.
- **Nothing leaves the machine for speech** apart from the rewrite, which goes to the session's model provider like
  the reply itself. The model is fetched at build or install time, from a pinned Hugging Face revision with checked
  checksums (`deploy/models.sh`); at run time picloud loads it from `models/` beside the sources and touches no
  network for it.
- **It is a build-time choice.** With Docker, `PICLOUD_SPEECH=off` in `.env` builds an image without the model, and,
  unless local memory is on, without `kokoro-js` and the runtime packages it shares with LEAF; the installer takes
  `--speech off`. picloud reads aloud when `kokoro-js` is installed and the model is in place, and logs `speech` at
  startup; otherwise the speaker does not appear.

## Long-term memory

Pi remembers across sessions, and across repositories, what no file states: how a host is set up, how a tool really
behaves on this machine, a measurement that cannot be repeated. It is the
[pi-durable-memory](https://github.com/taylorsatula/pi-durable-memory) extension's memory, kept in picloud's own
database.

- **Searching.** Once Pi can name the files and commands a piece of work touches, before it asks or plans, it searches
  memory with a short description of the work (`surface_memories`). It searches again only when the work reaches
  machinery that search did not cover, or when something fails in a way it cannot explain.
- **Recording.** Every report records what the work established, corrects or removes what proved wrong, and rates each
  memory the search showed: helpful ones rank higher next time. The report is refused until every memory shown is
  rated. The report card lists what was remembered under **Remembered**, with one line for the ratings; neither the pull
  request nor what is read aloud includes it.
- **Embeddings** come from one of two places, chosen at startup:
  - **On this server,** when it is built with the local model: [LEAF](https://huggingface.co/MongoDB/mdbr-leaf-ir-asym)
    (`mdbr-leaf-ir-asym`), 8-bit on the CPU, with no key and no network. A search is embedded by the 23M-parameter
    `mdbr-leaf-ir`; a memory, embedded once and searched many times, by `snowflake-arctic-embed-m-v1.5`, whose vector
    space LEAF was distilled into. It loads as the server starts (half a second, `memory.ready` in the log) and stays
    loaded, about 300 MB; a search embeds in about 25 ms. With Docker, `PICLOUD_MEMORY_LOCAL=on` in `.env`
    builds it in (about 135 MB of models); the installer takes `--memory-local on`. Its similarity floor was measured
    on a small set, so its search is less proven than `emb-qwen3`'s.
  - **From an OpenAI-compatible endpoint** otherwise, by default `emb-qwen3` through LunaRoute, signed with the key Pi
    holds for `PICLOUD_MEMORY_PROVIDER`. Each search sends its query there, and each report what it records. Setting
    `PICLOUD_MEMORY_EMBED_URL` chooses the endpoint even in a build with the local model.
- **Turning it on** without the local model: give Pi a key for the provider, an entry in its `auth.json`
  (`"lunaroute": { "type": "api_key", "key": "…" }`, beside what is there), or the provider registered in its
  `models.json`. Pi's configuration is the service user's `~/.pi/agent` (with Docker, in the `home` volume). Then
  restart picloud; its `started` log line names the embedding model.
- **Off otherwise.** With neither, picloud logs `memory.off` with the reason and runs without memory: no search tool,
  no memory part in the report and nothing about it in the prompt. The session picker's status bar says memory is
  off, why, and how to turn it on, for as long as it stays off.
- **When embedding fails,** a search returns the error to Pi, and a report is filed anyway, records nothing in memory
  and says why in its notes. After a model change, the first search or report re-embeds every memory.

## Security model

- **Reach is power.** Anyone who can reach picloud can make Pi run commands as the service user. The boundary is
  membership of your tailnet, plus `PICLOUD_ALLOWED_LOGINS` when set. picloud listens on loopback only and has no login
  of its own; `tailscale serve` (never `funnel`) provides access and TLS.
- **Each session's agent is isolated from picloud and from other sessions.** [DECISIONS.md](DECISIONS.md), "Session
  isolation", has the details.
  - **Tokens:** agent commands get only the agent's read-only GitHub token. picloud's own token, which can push,
    stays in picloud's process, so pushes and pull requests happen only when the person taps.
  - **Environment:** commands get an allowlist of picloud's variables (path, locale, proxies and certificates), and a
    home, tmp and `gh` configuration of the session's own. They never see the `PICLOUD_*` settings, provider keys or
    picloud's token.
  - **Landlock:** every command and file tool can write only the session's workspace, its home and tmp, and `/dev`,
    and read only those, the system's directories and Pi's skills. Other sessions, the database, Pi's sign-in,
    picloud's home and code, and the shared `/tmp` are out of reach. From Landlock ABI 6 (Debian 13's kernel),
    commands cannot signal picloud's or other sessions' processes either.
- **What stays open:**
  - **The network:** commands can reach any host. That includes picloud's own API on loopback, where they could act
    as the person, as well as the tailnet and a cloud provider's metadata service.
  - **A race:** the file tools check a path before using it, so a command running at the same moment could swap in a
    symlink in between.
  - **Older kernels:** below ABI 6 (Ubuntu 24.04's 6.8 kernel), commands can signal other processes of the service
    user.
  - **`PICLOUD_SANDBOX=off`** gives up Landlock, though not the tokens or the environment.
- **Mitigations that still matter:**
  - fine-grained tokens limited to the repositories picloud may use;
  - branch protection on those repositories' default branches;
  - a service user without sudo (the installer removes it from the `sudo` group if present).
- **Other sites' pages are refused.** A request that changes something is refused when the browser says it comes from
  another site: `Sec-Fetch-Site` other than `same-origin`, or an `Origin` whose host is not the one the request was
  sent to (the `Host`, or the `X-Forwarded-Host` a proxy adds). Without this, any page the phone opened could send a
  simple `text/plain` POST, which needs no preflight, and picloud would act on it. Requests with neither header come
  from programs, not from a page; the caller check and the login check still apply to them.
- Logs carry identifiers, counts, durations and fixed reasons, never message text, tool output or credentials.
- The phone app sanitizes the agent's Markdown (DOMPurify) and is served with a restrictive Content Security Policy.
- OnPrem's security model is different, and much weaker by design: see [PiCloud OnPrem](#picloud-onprem).

## Deploy

Deployment is Part B of [RUNBOOK-OPEN.md](RUNBOOK-OPEN.md) and happens only when someone deliberately deploys. On a
fresh Debian 13 machine (recommended; Ubuntu 24.04 works too) with 2 vCPU, 4 GB RAM, a 50 GB disk and no inbound
ports, from a checkout of picloud:

```bash
# See every step first; this changes nothing.
sudo deploy/install.sh --dry-run
# Install. Every option is optional: the auth key joins the tailnet without a browser, the first token file signs gh
# in with picloud's own token, the second gives the agent its read-only one.
sudo deploy/install.sh \
  --push-subject mailto:you@example.com \
  --tailscale-auth-key tskey-... \
  --github-token-file /root/github-token \
  --agent-github-token-file /root/agent-github-token \
  --allowed-logins you@example.com
# --speech off leaves out reading replies aloud: about 550 MB of packages and model, and 650 MB of memory while reading.
# --memory-local on embeds long-term memory on this machine: about 135 MB of models, and 300 MB of memory while embedding.
```

- **Why Debian 13.** Its 6.12 kernel has Landlock ABI 6, so agent commands cannot signal picloud's or other
  sessions' processes. Ubuntu 24.04's 6.8 kernel stops at ABI 4, which confines files but not signals.
- **Toolchains** for your repositories (step B1.2) belong under `/usr`, from apt or in `/usr/local`. Agent commands
  cannot reach the service user's home or `/opt`, so a per-user install such as rustup's is out of their reach.

The installer is idempotent: it installs system packages, Node.js 22, `gh`, Tailscale and the `pi` CLI; creates the
`picloud` service user (no sudo) and `/opt/picloud`, `/var/lib/picloud` and `/etc/picloud`; installs and builds the
app; writes the configuration and the `picloud.service` unit; connects Tailscale and runs
`tailscale serve --https=443`; then reports status and lists the steps that need a person (B2): logging Tailscale in
and enabling MagicDNS and HTTPS certificates, signing Pi in (`sudo -u picloud -i pi`, then `/login` and `/model`),
creating the two GitHub tokens and branch protection, and installing the app on the phone (Safari, Share, Add to
Home Screen, then turn on notifications from the app's menu). Re-run it after those steps, and to upgrade. The
configuration file `/etc/picloud/picloud.env` is readable by root only, since it holds the agent's token; systemd
reads it as root. The installer also reports the kernel's Landlock ABI.

### Run with Docker

The other way to deploy: two containers on any machine with Docker (a 2 vCPU, 4 GB droplet is enough). Tailscale
runs in one and serves picloud over HTTPS to your tailnet only. picloud runs in the other, sharing the first one's
network and listening on its loopback. Nothing is exposed on the machine's own ports. From a checkout of picloud:

```bash
cp .env.example .env              # fill in TS_AUTHKEY, GH_TOKEN and AGENT_GH_TOKEN; the rest is optional (PICLOUD_SPEECH and PICLOUD_MEMORY_LOCAL too)
docker compose build
docker compose run --rm picloud pi   # once: /login, then /model, then /quit
docker compose up -d
```

Then, in the Tailscale admin console, turn on MagicDNS and HTTPS certificates. Open
`https://<PICLOUD_TS_HOSTNAME>.<tailnet>.ts.net` on the phone and install it as on the other path. `.env.example`
documents every setting.

- **What lives where:**
  - the `data` volume holds the database, workspaces and daily backups, and each session's own home and tmp, where
    the tools the agent runs keep their caches;
  - the `home` volume holds picloud's home directory: Pi's sign-in and model choice;
  - the `tailscale` volume holds the machine's tailnet identity.

  Back up the first two.
- **Locked down:**
  - **picloud** runs as an unprivileged user with no Linux capabilities, cannot gain privileges, and has no setuid
    programs to try. Its system files are read-only: it writes only its two volumes and a 512 MB scratch `/tmp`. A
    process limit stops a runaway test from exhausting the machine.
  - **Agent commands** are confined further, by the host kernel's Landlock, to their own session's directories.
  - **Tailscale** keeps only the two capabilities a VPN interface needs, on a read-only system.
  - **Network:** no port is published on the machine, and Docker's default seccomp and AppArmor profiles stay on.
  - **Tailscale's access controls** can narrow which devices reach this machine, alongside
    `PICLOUD_ALLOWED_LOGINS`.
- **Not signed in to Pi:** picloud exits with instructions, and Docker retries with a growing delay. Sign in with the
  `run` line above, then `docker compose restart picloud`.
- **GitHub:** picloud's `gh` and git use `GH_TOKEN`. Agent commands get `AGENT_GH_TOKEN` as their `GH_TOKEN` and
  never see picloud's. Give both tokens only the repositories picloud should touch.
- **Logs:** `docker compose logs -f picloud`. **Upgrade:** pull the checkout, then `docker compose up -d --build`.
- **The image:**
  - an Ubuntu 24.04 userland, which the installer supports too, so the agent works in the same environment either
    way;
  - Node.js exactly as the official image ships it;
  - `git`, `gh`, a C toolchain and ripgrep;
  - the `pi` CLI from picloud's own pinned dependencies;
  - the sandbox launcher, in `/usr/local/bin`.

  The sandbox is Landlock, which lives in the host's kernel, not in the image. Run it on a Debian 13 host
  (recommended) or another whose kernel has Landlock ABI 6.

### Trim a small machine

On a dedicated droplet, either way of deploying, `deploy/trim.sh` leaves more memory and disk for the agent's builds
and tests:

```bash
sudo deploy/trim.sh --dry-run   # see what it would do
sudo deploy/trim.sh             # --swap 1G for a smaller swap file, --swap 0 for none
```

- **Services.** It masks the ones picloud never uses, such as snapd, multipathd, firmware and disk managers, crash
  reports, rsyslog, and the login-banner and Ubuntu Pro timers. Masking means they cannot be started on demand either.
- **Swap.** It adds a 2 GB swap file that the system uses only under memory pressure.
- **Journal.** It caps the system journal at 200 MB.
- **Kept on purpose:** SSH, networking, DNS, time sync, cron, AppArmor, security updates, cloud-init and
  DigitalOcean's own agents.

It is safe to re-run and prints how to undo each part. With Docker, `compose.yaml` also caps each container's logs at
three 10 MB files.

### Operate

- **Logs:** `journalctl -u picloud`.
- **Backups:** picloud backs up its database once a day with SQLite's online backup into
  `/var/lib/picloud/backups` (the newest 14 are kept). Back up that directory and the service user's Pi
  configuration (`/home/picloud/.pi/agent`).
- **Cleanup:** once a day, workspaces of sessions archived more than seven days ago are removed — only when git shows
  nothing uncommitted, the session's branch is on GitHub (or nothing was changed), and no other local branch has
  commits GitHub lacks.
- **Upgrading `@earendil-works/*`:** read every changelog between the versions, bump all five packages together, run
  `npm run check`, back up the database first (stored data may migrate and rollback is not guaranteed), then re-run
  the installer.

## PiCloud OnPrem

picloud can run on your own computer instead of a server: a Mac or a Linux machine, as a web app at
http://localhost:2025, with the same app. A new session starts in a directory on the computer: your home directory
(`~`) unless you type another, any existing absolute directory, `/` included. Pi works there in place, as you, as if
you had opened a terminal there and run `pi`. Repository sessions, on a clone and a branch of their own that picloud
pushes when you tap, remain the other choice wherever `gh` is signed in; if listing repositories fails, the New
session screen says why and sessions on the computer still start. With `--tailscale on` the same picloud is also on
your tailnet, for your phone, whether the computer is a laptop or a server somewhere.

### Install, update and uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/taylorsatula/picloud/main/deploy/onprem.sh | bash -s --
# Every flag is optional; see every step first with --dry-run:
curl -fsSL https://raw.githubusercontent.com/taylorsatula/picloud/main/deploy/onprem.sh | bash -s -- --dry-run --port 2026
```

| Flag | Default | Meaning |
|---|---|---|
| `--speech on\|off` | `on` | Read replies aloud with Kokoro, on this computer: about 550 MB of packages and model, 650 MB of memory while reading. |
| `--memory-local on\|off` | `off` | Embed long-term memory on this computer with LEAF: about 135 MB of models. |
| `--port N` | `2025` | The localhost port. |
| `--ref REF` | `main` | The branch, tag or commit of picloud to install. |
| `--tailscale on\|off` | `off` | Serve picloud to your tailnet too, at `https://<this computer's MagicDNS name>/`, so your phone can use it as the PWA (see below). Off takes down picloud's own `tailscale serve`, if it had one. |
| `--allowed-logins LIST` | everyone on the tailnet | Comma-separated Tailscale logins let in through the tailnet; `''` for everyone again. |
| `--tailscale-auth-key KEY` | | As root, join the tailnet with this key instead of a login link. Used once, never kept. |
| `--dry-run` | | Show every step and the service it would write; change nothing. |
| `--uninstall` | | Stop and remove the service and the app; the data stays. |
| `-h`, `--help` | | Show the help. |

- **Run it as yourself** on your own computer, and nothing outside your home directory changes, apart from Tailscale's
  serve configuration with `--tailscale on`. **Run it as root on a server** (below) for picloud as root.
- **It remembers your choices.** Each install writes its flags to `~/.picloud/onprem.conf`, and the next run starts
  from them, so the bare one-liner updates picloud as it is; a flag given changes that choice.
- **It needs** Node.js 22.19 or newer, which it does not install (Homebrew: `brew install node@22`; or nvm:
  `nvm install 22`), and git. No C compiler is needed: OnPrem has no sandbox, and the build skips its launcher without
  one. `gh` is optional: repository sessions need it signed in (`gh auth login`).
- **Pi must be signed in**, as you: run `~/.picloud/app/node_modules/.bin/pi` (or your own `pi`), type `/login`, then
  `/model`. The installer checks with picloud's own check and stops with these instructions until it passes; your Pi
  configuration (`~/.pi/agent`) is the one picloud uses.
- **What it does,** step by step:
  1. checks the computer;
  2. clones picloud at `--ref` into `~/.picloud/app`, or updates it there, refusing to overwrite changes made in it;
     piped from curl, it fetches the code first and runs the installer of the version it installs;
  3. installs the exact dependencies and builds, keeping or pruning the optional speech packages exactly as the
     server installer does;
  4. fetches the chosen local models with `deploy/models.sh`;
  5. checks Pi's sign-in;
  6. with `--tailscale on`, runs `tailscale serve --bg --https=443 http://127.0.0.1:<port>` (never `funnel`), unless
     `https://<name>/` already serves something else, which it leaves alone and stops; with it off, takes down
     picloud's own serve if there is one;
  7. writes a service of your own user: on macOS the LaunchAgent
     `~/Library/LaunchAgents/com.github.taylorsatula.picloud.plist` (started at login and kept alive, logs in
     `~/.picloud/logs/picloud.log`); on Linux the systemd user unit `~/.config/systemd/user/picloud.service` (logs:
     `journalctl --user -u picloud`). It sets `PICLOUD_ONPREM=on`, `PICLOUD_DATA_DIR=~/.picloud/data`,
     `PICLOUD_PORT`, with Tailscale `PICLOUD_ALLOWED_HOSTS` (and `PICLOUD_ALLOWED_LOGINS` if given), and the PATH your
     login shell builds, captured now, because launchd and systemd start services with almost none and the agent's
     commands should find Homebrew, nvm and the rest;
  8. starts it, waits for it to answer, remembers the choices, prints the URL (and the tailnet one) and opens it.
- **Update** by running the one-liner again: it updates the app in place, rebuilds, captures your PATH again and
  restarts. **Uninstall** with `--uninstall`: the service and `~/.picloud/app` go, and your sessions and backups stay
  in `~/.picloud/data` until you remove `~/.picloud`.
- **On Linux,** a user service runs while you are logged in. To keep it running after you log out:
  `loginctl enable-linger $USER`. `tailscale serve` as yourself needs Tailscale's operator to be you, once:
  `sudo tailscale set --operator=$USER`; the installer says so if it is refused.

### A server of your own, on your phone

The case OnPrem is for on a server: a machine somewhere, yours, which you drive from your phone with Pi as root, with
nothing between it and the machine. On a fresh Debian or Ubuntu server, logged in as root:

```bash
curl -fsSL https://raw.githubusercontent.com/taylorsatula/picloud/main/deploy/onprem.sh | bash -s -- --tailscale on
```

- **As root,** the installer first installs what is missing with apt (git, curl, Node.js 22 from NodeSource, and
  Tailscale from its own repository, the same steps as the server installer), then installs picloud for root, in
  `/root/.picloud` whatever `HOME` says, as the system unit `picloud-onprem.service` (started at boot, after the
  network and Tailscale; logs: `journalctl -u picloud-onprem`).
- **Tailscale** logs in if it is not already: open the link it prints, or pass `--tailscale-auth-key`. Turn on
  MagicDNS and HTTPS certificates in the tailnet's admin console, if they are not on.
- **Pi** must be signed in as root: the installer stops and says how (`/root/.picloud/app/node_modules/.bin/pi`, then
  `/login` and `/model`); run the one-liner again after.
- Then open the printed `https://<server>.<tailnet>.ts.net/` on your phone. Sessions start in `/root`; any directory
  works, `/` included. The agent's commands run as root: `systemctl`, `apt`, `/etc`, `/sys`, everything.
- **As another user,** picloud runs with that user's rights and a user service (with `loginctl enable-linger`). sudo
  works for the agent only without a password (a `NOPASSWD` sudoers rule, as many cloud images give their default
  user), since nothing can answer a password prompt; the installer says which it is.
- **Not in a container.** A container would see only its own files, processes, `/sys` and network, and have no
  systemd to talk to; opened up enough to manage the host, it is root on the host with extra steps, and the tools are
  still the image's. picloud OnPrem installs on the machine itself.

### On your phone, through Tailscale

With `--tailscale on`, the computer serves picloud to your tailnet at `https://<its MagicDNS name>/`, which the
installer prints; MagicDNS and HTTPS certificates must be on in the tailnet's admin console. On the phone, with
Tailscale connected, open that URL in Safari, tap Share, then Add to Home Screen, and open picloud from there to turn
on notifications. It is the same picloud as at localhost, with the same sessions and the same full access: anyone you
let into it through the tailnet acts on this computer as you, so `--allowed-logins` is worth setting on a tailnet you
share. On a laptop, picloud is reachable while the laptop is awake.

### What OnPrem de-restricts, and what that means

- **The agent has your full access, and nothing it does is confined.** No sandbox: agent commands and file tools run
  as you, anywhere on the filesystem, with your environment (minus picloud's own `PICLOUD_*` settings), your home
  and `TMPDIR`, and every credential your tools find there: SSH keys, cloud command lines, your `gh` and git logins.
  They reach every service on your computer and your network. `@` references reach any file, by absolute path or
  `~/…`.
- **It can push, publish and send with your credentials.** No separate, read-only token stands between the agent and
  GitHub. In a repository session it is still told never to push, and picloud pushes only when you tap; in a local
  session it is told to ask, on a card, before anything destructive or irreversible the task did not name: deleting
  or overwriting files, pushing, publishing or sending anything, installing system-wide, changing system settings.
  These are instructions, not protection. A file or web page Pi reads can try to talk it into acting as you.
- **Sessions share the computer.** Two sessions in the same directory, or you and a session, can change the same
  files.
- **picloud itself never removes or rewrites anything in a directory you chose.** Its daily cleanup removes only its
  own directories of an old archived session (`~/.picloud/data/workspaces/<id>`, where attachments are kept, and
  never one a session chose to work in).
- Delivery and the diff belong to repository sessions; a local session's report card offers neither.

### Security on localhost

- **Loopback only.** picloud listens on 127.0.0.1 and nothing else. The tailnet reaches it only through
  `tailscale serve`, when you turn that on.
- **Host check.** It answers only requests addressed to `localhost`, `127.0.0.1` or `[::1]` at its own port, or to a
  name in `PICLOUD_ALLOWED_HOSTS` (the tailnet name). A web page on a name pointed at 127.0.0.1 (DNS rebinding) is
  refused, so it can neither read picloud nor drive it; a tailnet name is one no one else's DNS can point here.
- **Logins, for the tailnet.** What comes through Tailscale (addressed to the tailnet name, or carrying the
  `Tailscale-User-Login` header `tailscale serve` adds) is held to `PICLOUD_ALLOWED_LOGINS` when it is set, as on a
  server. Your browser at localhost needs no login.
- **Page-origin gate.** A request that changes something is refused when the browser says it comes from another site
  (see [Security model](#security-model)), so a page you visit cannot start a session or answer a card, which on this
  computer would mean running commands as you.
- **Own user only, on Linux.** picloud answers only connections opened by your own user, or by root, which is how
  `tailscale serve` arrives (root could read everything picloud holds anyway), found in the kernel's socket table;
  other users of a shared machine are refused. On macOS there is no such table, so picloud checks no caller:
  **any user account on the Mac can reach it on localhost and use it as you.** On a Mac shared with other accounts, do
  not install it.
- **No login of its own.** Any program running as you can use it, which already has your access.

### macOS privacy permissions

macOS keeps programs out of Documents, Desktop and Downloads (and iCloud Drive, removable volumes and the like) until
you allow them. A LaunchAgent's program has no window to ask from, so commands touching those folders fail with
"Operation not permitted". To let picloud's sessions in, if you choose to: System Settings, Privacy & Security, Full
Disk Access, then add the `node` binary the installer printed (Homebrew's `/opt/homebrew/bin/node` is a link: add the
file `realpath "$(command -v node)"` names), and run the one-liner again to restart it. That gives everything this
`node` runs that access, picloud's sessions included. It is your choice; without it, keep the work outside those
folders.

### What is unverified

- **macOS has not been run.** picloud OnPrem was built and tested on Linux. On macOS only the installer's dry run has
  been exercised (with stand-ins for `uname` and the login shell): the LaunchAgent it writes, `launchctl bootstrap` and
  `bootout`, the zsh login shell's PATH, `open`, the Full Disk Access advice, the app and its optional speech packages
  (onnxruntime's macOS binaries) under `npm ci`, and the server itself on macOS's filesystem. `deploy/models.sh`'s
  `shasum` fallback was tested on Linux with a PATH that has no `sha256sum`.
- **On Linux,** the systemd user unit has been checked only as the dry run writes it, not started; nor has a real
  install fetched, built and started picloud.
- **`tailscale serve` and the origin gate** (server mode): the gate accepts the browser's host in `Host` or in
  `X-Forwarded-Host`. Which of them `tailscale serve` passes on has not been tried on a real tailnet.

## Layout

```
src/shared/     shapes shared by server and phone: API payloads, documents, live protocol, reference syntax
src/server/     the server: app assembly, HTTP, sessions, supervisor, delivery, notifications, maintenance
src/server/agent/  what picloud adds to Pi: tools, prompt sections, spend cap, compaction cycle and checkpoints
src/server/speech/ reading aloud: the speakable script, Kokoro, and what the HTTP boundary calls
src/server/memory/ long-term memory: what the agent is told, the embeddings, the search and the report's changes
src/server/fake/   fake mode: scripted model, stand-in synthesizer, stand-in GitHub, fixture repositories
src/sandbox/    the agent sandbox's launcher (C), compiled by scripts/build.ts
src/client/     the phone app (Preact), bundled by scripts/build.ts
src/sw/         the service worker
test/           automated tests (node:test)
e2e/            end-to-end tests (Playwright)
deploy/         the installers (install.sh for a server, onprem.sh for your own computer), the local models' download,
                and the serve config for the Docker setup (Dockerfile and compose.yaml are at the root)
models/         the local models, once deploy/models.sh has fetched them (not in git)
```
