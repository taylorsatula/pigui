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
- git.
- For real use: Ubuntu 24.04 with Tailscale, `gh`, and Pi signed in (see [Deploy](#deploy)).
- For the end-to-end tests: Chromium for Playwright 1.63 (`npx playwright install chromium` if it is not installed).

## Build, run and test

```bash
npm ci               # exact versions from the committed lockfile
npm run typecheck    # strict TypeScript: server, client, service worker, tests, end-to-end tests
npm run build        # bundles the phone app into dist/public (esbuild) and draws its icons
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
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi's own variable: where Pi's configuration (models, sign-in, global skills, global `AGENTS.md`) is read from. |

Models, sign-in and the default model come from Pi's configuration; picloud has no settings of its own for them. In
real mode, picloud exits with code 78 and instructions if Pi has no default model with credentials, before it touches
the data directory.

## Security model

- **Reach is power.** Anyone who can reach picloud can make Pi run commands as the service user. The boundary is
  membership of your tailnet, plus `PICLOUD_ALLOWED_LOGINS` when set. picloud listens on loopback only and has no login
  of its own; `tailscale serve` (never `funnel`) provides access and TLS.
- **The agent shares the service user's credentials.** Pi's model credentials and `gh`'s GitHub token belong to the
  same user the agent's commands run as. "Never push" is an instruction to the model, not an enforced boundary.
- **Mitigations:**
  - a fine-grained GitHub token limited to the repositories picloud may use (Contents and Pull requests: read and
    write; Metadata: read);
  - branch protection on those repositories' default branches;
  - a service user without sudo (the installer removes it from the `sudo` group if present);
  - pushes and pull requests made by the server only when the person taps.
- Logs carry identifiers, counts, durations and fixed reasons, never message text, tool output or credentials.
- The phone app sanitizes the agent's Markdown (DOMPurify) and is served with a restrictive Content Security Policy.

## Deploy

Deployment is Part B of [RUNBOOK-OPEN.md](RUNBOOK-OPEN.md) and happens only when someone deliberately deploys. On a
fresh Ubuntu 24.04 machine (2 vCPU, 4 GB RAM, 50 GB disk, no inbound ports), from a checkout of picloud:

```bash
# See every step first; this changes nothing.
sudo deploy/install.sh --dry-run
# Install. Every option is optional: the auth key joins the tailnet without a browser, the token file signs gh in.
sudo deploy/install.sh \
  --push-subject mailto:you@example.com \
  --tailscale-auth-key tskey-... \
  --github-token-file /root/github-token \
  --allowed-logins you@example.com
```

The installer is idempotent: it installs system packages, Node.js 22, `gh`, Tailscale and the `pi` CLI; creates the
`picloud` service user (no sudo) and `/opt/picloud`, `/var/lib/picloud` and `/etc/picloud`; installs and builds the
app; writes the configuration and the `picloud.service` unit; connects Tailscale and runs
`tailscale serve --https=443`; then reports status and lists the steps that need a person (B2): logging Tailscale in
and enabling MagicDNS and HTTPS certificates, signing Pi in (`sudo -u picloud -i pi`, then `/login` and `/model`),
creating the GitHub token and branch protection, and installing the app on the phone (Safari, Share, Add to Home
Screen, then turn on notifications from the app's menu). Re-run it after those steps, and to upgrade.

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
src/client/     the phone app (Preact), bundled by scripts/build.ts
src/sw/         the service worker
test/           automated tests (node:test)
e2e/            end-to-end tests (Playwright)
deploy/         the installer
```
