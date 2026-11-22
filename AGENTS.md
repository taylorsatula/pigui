# AGENTS.md

## What this project is
picloud is a small, self-hosted harness that lets one person run the Pi coding agent on their own server and drive it
from a phone. Typical flow: pick a repo, answer a few questions, approve a plan, put the phone away, and come back to
a report and a push button. It is a tool its owner uses every day, so it has to work correctly and stay easy to
maintain.

If a runbook is present in the repository, it is the specification. This file doesn't override it. It describes how
to work within it.

## Be Pi-native
picloud is thin glue around Pi. Most of what it needs already exists, so look there before writing anything.

- **Pi Durable owns the agent.** That covers the loop, coding tools, persistence, retries, compaction, recovery and
  live views. picloud configures it and extends it with tools, hooks, prompt sections and documents.
- **Pi owns models and credentials.** Use Pi's configured models and settings. Don't write provider code.
- **Established tools own everything around it:** Tailscale for access and TLS, `gh`/`git` for GitHub, Web Push for
  notifications, systemd for supervision.
- **Use Durable's mechanisms, not imitations of them.**
  - Waiting for a person is a tool that parks on a signal. It is not an in-memory promise, a timer or a polling loop.
  - Shared state is a Durable document changed in commits. It is not a second store.
  - Live updates come from watches and observers. They are not re-fetching.

  If you find yourself writing a retry loop, a cache of agent state, or a background poller, check whether Durable
  already does it.
- **Read the installed packages, not memory or GitHub.** The `@earendil-works/*` packages are experimental and
  pinned. Their GitHub main branch differs from the published version. The README and `.d.ts` files in
  `node_modules` are the truth, and a five-minute experiment against them beats a guess.

## Keep it small by saying no
- **Build what the product needs, and nothing it doesn't.** No speculative options, plugin points, settings or
  "while I'm here" features. A feature that doesn't serve "pick repo → plan → approve → run → report → deliver" needs
  a reason that does.
- **One way to do each thing.** Before adding a second helper, client, state path or pattern, extend the first one.
- **Delete rather than comment out.** No dead code, no unused exports, no TODO scaffolding.
- **Treat a new dependency as a decision.** Prefer the standard library and the packages already here. Pin every
  version exactly.

Small is a result, not a goal. Never drop correct behavior, error handling or a restart path to make code shorter.

## Write clean TypeScript
- **TypeScript everywhere:** server, browser client, service worker, tests. Strict mode. No `any` unless it's at a
  library boundary, with a comment saying why.
- **Define each shape once.** API payloads, events, document shapes and session states live in shared modules that
  both the server and the client import. Prefer types from `@earendil-works/*` over re-declaring them.
- **Small modules with one responsibility,** talking through small typed interfaces. A file that keeps growing is
  asking to be split, or asking whether it does too much.
- **Handle errors where they enter:** validate at the HTTP boundary, wrap shell-outs with messages a person can act
  on, never swallow an error silently, and make failures visible in the UI with a next step.
- **Names follow the domain** (session, card, plan, report, handoff) and stay consistent across server, client and
  tests.
- **Comments explain why,** for example a constraint, a trap or a non-obvious choice. They don't restate what the
  code does.

## Design for a phone in a pocket
- **Waiting is free and survives restarts.** Every wait for the person is durable, and every side effect around it
  (notifications, external calls) happens once, even if code reruns after a crash.
- **Nothing reaches GitHub without the person's tap.** The agent commits; the server delivers.
- **The interface is a conversation set to be read:** a text field, an attachment button and a send button. Detail is
  collapsed until asked for, except the work of a turn under way, which shows inline until the turn ends. Keep its look (serif for titles, buttons and the person's words, sans for reading, monospace
  for what is a record, light weights, paper and ink, one yellow for what needs the person; see DECISIONS.md) rather than drifting back to stock chat-app parts, or on into a theme. Follow Apple's Human Interface Guidelines: clarity, deference, sensible defaults, 44 pt targets,
  readable in dark mode and at large text sizes. Choose the simple control that works well over the clever one.

## Test what matters
- **Test behavior through public interfaces.** Exercise flows the person cares about: answering, approving,
  restarting, delivering, recovering from failures.
- **Use real Durable storage in tests, not mocks.** Restart and recovery behavior is the point. Use the scripted
  (faux) model and local git remotes so tests need no credentials.
- **Don't change code without running the checks:** typecheck, tests, and end-to-end tests where the UI is
  involved.

## Work safely on this machine
This machine may be running a live picloud. While developing:
- don't change system services, Tailscale, system users or `/var/lib/picloud`;
- don't bind port 8787;
- don't read or write the real Pi configuration (`~/.pi/agent`);
- use temporary directories, free ports and an empty `PI_CODING_AGENT_DIR` for anything you run.

## Leave a trail
- **Record significant decisions** in `DECISIONS.md`: what you chose, the alternatives, and why. One clear paragraph
  beats a page.
- **Keep `README.md` current** for how to build, run, test and deploy.
