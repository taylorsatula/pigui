# picloud

picloud runs the [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding agent on your own server
and lets you drive it from your phone. Pick a repository, describe a task, answer Pi's questions with a few taps,
approve its plan, and put the phone away. Pi implements, verifies and commits on its own branch; you get a
notification and a report, and you choose whether to push the branch, open a pull request, or keep working.

It is thin glue around [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable), which owns the agent
loop, persistence, compaction and recovery. Tailscale provides access and TLS, `gh` and `git` talk to GitHub, Web
Push carries notifications, and systemd keeps it running. Why each piece is built the way it is lives in
[DECISIONS.md](DECISIONS.md).

## Requirements

- Node.js 22.19 or newer (the server runs its TypeScript directly with Node's type stripping).
- git, and a C compiler (`cc`) for the agent sandbox's launcher.
- For real use: Debian 13 (recommended) or Ubuntu 24.04, on a kernel with Landlock, with Tailscale, `gh`, Pi signed
  in and two GitHub tokens (see [Deploy](#deploy)).
- For the end-to-end tests: Chromium for Playwright 1.63 (`npx playwright install chromium` if it is not installed).

## Build, run and test

```bash
npm ci               # exact versions from the committed lockfile
npm run typecheck    # strict TypeScript: server, client, service worker, tests, end-to-end tests
npm run build        # bundles the phone app into dist/public, draws its icons, compiles dist/bin/picloud-sandbox
npm test             # automated tests (node:test), real Durable storage, fake mode
npm run e2e          # builds, then runs the Playwright tests in a phone-sized Chromium
npm run check        # all of the above
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
  later message makes a follow-up commit and a new report. Its tokens are priced like a mid-range model so the spend
  cap can be tried. Directives in the task steer it, mostly for tests: `[checklist]` adds a multiple-choice card,
  `[no-report]` and `[never-report]` stop without a report, `[dirty-report]` reports before committing, `[model-error]`
  fails once, `[spin]` loops until stopped, `[long]` produces verbose output so the context compacts,
  `[recall]` searches history after a compaction, and `[summarizer-fails]` / `[compaction-fails]` fail summarization.
- **A local stand-in for GitHub** (`src/server/fake/github.ts`): bare repositories under
  `$PICLOUD_DATA_DIR/fake-github/repos` that workspaces clone from and push to with plain git — `demo/greeter` (a
  small TypeScript library with an `AGENTS.md`, a Pi skill `release-notes`, a binary file, and a second branch
  `feature/farewell`) and `demo/notes` (branches `main` and `drafts`). Pull requests are kept in
  `fake-github/pulls.json`, so they survive restarts. Notifications are recorded instead of sent.
- `PICLOUD_FAKE_TOKENS_PER_SECOND` (only for `npm run fake`, default 60) sets how fast scripted text streams.
- **The sandbox** wherever this machine has Landlock and `npm run build` compiled the launcher; otherwise agent
  commands run unconfined, and the tests that need it skip. For those tests, the scripted model's `[probe]` directive
  runs the task's `$ command`, `read PATH` and `write PATH` lines one at a time.

### How tests construct the server

The automated tests call `startApp()` from `src/server/app.ts` — the same function `src/server/main.ts` uses — through
`TestServer` in `test/helpers.ts`. Each test server gets fake mode, port 0, a fresh temporary data directory and an
empty Pi configuration directory. Storage is the real SQLite storage of Pi Durable; nothing in Durable is mocked.
`restart()` closes the server and opens a new one on the same data directory, as a process restart would. Tests wait
on Durable watches of the session document rather than polling. A few seams in `AppOptions` exist for tests: a clock
(`now`), a request counter on the scripted model (`fakeModel.onRequest`), a smaller context window
(`fakeModel.contextWindow`), and `faults`, hooks that hold the code at an exact point so a test can cut it off there
the way a crash would.

The end-to-end tests (`e2e/`) start `scripts/fake.ts` as a child process per test file, on a free port with temporary
directories, and drive it with Playwright in Chromium at 390×844 (375 px for the horizontal-scroll check) with touch.
Restart tests kill the process and start it again on the same port and data.

## Configuration

Configuration is by environment variables. The installer writes them to `/etc/picloud/picloud.env`.

| Variable | Default | Meaning |
|---|---|---|
| `PICLOUD_DATA_DIR` | required | Database, workspaces, uploads, backups, push keys (and fake mode's stand-in GitHub). |
| `PICLOUD_HOST` | `127.0.0.1` | Bind address. Must be loopback; Tailscale serve is the only way in. |
| `PICLOUD_PORT` | `8787` | Bind port. `0` picks a free one. |
| `PICLOUD_PUSH_SUBJECT` | `mailto:picloud@localhost` | Contact (`mailto:` or `https:`) sent to push services with VAPID. Set a real one: Apple may reject a placeholder. |
| `PICLOUD_ALLOWED_LOGINS` | empty | Comma-separated Tailscale logins allowed in, checked against the `Tailscale-User-Login` header that `tailscale serve` adds. Empty allows anyone who reaches the server. |
| `PICLOUD_MAX_TURNS` | `150` | Tool rounds one run may take before it stops and asks. |
| `PICLOUD_SPEND_CAP` | none | Default spend cap per session, in US dollars. The person can raise a session's cap from the phone. |
| `PICLOUD_FAKE` | `0` | `1` runs fake mode. |
| `PICLOUD_AGENT_GH_TOKEN` | required in real mode | The agent's read-only GitHub token (Contents and Metadata: read). Agent commands get it as `GH_TOKEN` and `GITHUB_TOKEN`, never picloud's own. |
| `PICLOUD_SANDBOX` | `on` | `on` confines every agent command and file tool with Landlock; `off` runs them unconfined, for a kernel without Landlock. |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi's own variable: where Pi's configuration (models, sign-in, global skills, global `AGENTS.md`) is read from. |

Models, sign-in and the default model come from Pi's configuration; picloud has no settings of its own for them. In
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
- Logs carry identifiers, counts, durations and fixed reasons, never message text, tool output or credentials.
- The phone app sanitizes the agent's Markdown (DOMPurify) and is served with a restrictive Content Security Policy.

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
cp .env.example .env              # fill in TS_AUTHKEY, GH_TOKEN and AGENT_GH_TOKEN; the rest is optional
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

## Layout

```
src/shared/     shapes shared by server and phone: API payloads, documents, live protocol, reference syntax
src/server/     the server: app assembly, HTTP, sessions, supervisor, delivery, notifications, maintenance
src/server/agent/  what picloud adds to Pi: tools, prompt sections, spend cap, compaction handoff
src/server/fake/   fake mode: scripted model, stand-in GitHub, fixture repositories
src/sandbox/    the agent sandbox's launcher (C), compiled by scripts/build.ts
src/client/     the phone app (Preact), bundled by scripts/build.ts
src/sw/         the service worker
test/           automated tests (node:test)
e2e/            end-to-end tests (Playwright)
deploy/         the installer, and the serve config for the Docker setup (Dockerfile and compose.yaml are at the root)
```
