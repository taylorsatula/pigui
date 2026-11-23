# PiCloud

PiCloud is a self-hosted harness for the [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding
agent, driven from any browser. It is a faithful GUI layer on top of
[Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable): Pi Durable owns the agent loop, persistence,
compaction and recovery, and PiCloud configures those and adds the pieces a harness needs. It does not reimplement Pi's
internals.

PiCloud is built for long-horizon autonomous work. A session frontloads its planning: the agent asks questions to
resolve ambiguity before touching anything, presents an actionable plan for approval, implements it, and files a final
report with an option to open a pull request. You can put the phone away and come back to the report.

## Not feature-bloat

PiCloud is deliberately small. Every feature in it serves one loop:

> pick a repository → describe the task → answer the questions → approve the plan → the agent works → report → push or pull request

If a feature does not serve that loop, it is not in. There is no plugin system, no settings zoo, no theme engine, no
bundle of unrelated categories that might one day be useful. One way to do each thing. A small dependency tree, pinned
exactly. Features get refused, not deferred.

This is the product's identity, not a shortcoming. PiCloud is a focused tool for running the Pi agent, and it stays
one.

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

## What PiCloud adds

- **Compaction built for long runs.** Before the context fills, PiCloud asks the agent for a short first-person
  handoff note, then writes a checkpoint — current state, evidence tiers, decisions, commands, tests and failures, the
  work queue — with the cut chosen by a summarizer and validated by code. Your own words are carried verbatim, never
  paraphrased. The agent resumes from its own note, and anything compaction removed from view stays readable through
  `recall_history`. Pi Durable's own compaction remains as a backstop. A session can run for hours across many context
  windows without losing the plot.
- **Built-in subagent support.** Pi can hand work to agents — separate Pis with their own prompt, tools and model,
  working in a conversation of their own. Foreground (the default) or background, steering a running agent, or
  resuming a finished one. Their spend counts toward the session's cap; they are listed in an Agents panel with a Stop
  button. PiCloud ships three:
  - `scout` — read-only investigator with a fixed report shape, for establishing facts in a codebase.
  - `implementer` — executes an already-specified code change and reports what landed.
  - `verifier` — read-only check of a finished change against its spec.

  A fourth bundled definition, `thought-partner`, pressure-tests designs. You can define your own as Markdown files. An agent runs in the session's directory, under the session's sandbox,
  with the project's instructions and skills, but never with PiCloud's own session tools, and agents start no agents of
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

## Desktop and mobile parity

The same app runs everywhere. There is one codebase, one interface, no device-gated features: the phone in your
pocket and the browser on your desk are the same product. On a phone it installs to the home screen as a PWA; on a
desktop it is a web app at the same address. The only differences are layout and pointer density — columns on wide
screens, larger touch targets on small ones — never capability.

## Deployment

One installer decides how and where PiCloud runs:

```bash
curl -fsSL https://raw.githubusercontent.com/taylorsatula/picloud/main/install.sh | bash -s --
```

It asks three questions — container or not, this computer or a remote server, then the flags — and installs or updates
in place. The ways to run it:

- **Containerized remote deployment.** Two Docker containers on any machine with Docker: one runs Tailscale and serves
  PiCloud over HTTPS to your tailnet only, the other runs PiCloud sharing its network, listening on its loopback.
  Nothing is published on the machine's own ports. The agent's commands are confined by the host's Landlock.
- **Local unrestricted install.** PiCloud on your own computer (Mac or Linux) or on a server you own, as you, with
  your full access: at http://localhost:2025 on this machine, or over SSH on a server of your choosing. Pi works in
  place, as if you had opened a terminal there and run `pi`. No sandbox, nothing between the agent and the machine.
- **Sandboxed server.** Debian or Ubuntu, a systemd service as its own user, agent commands confined by Landlock (ABI 6 on
  Debian 13; Ubuntu 24.04 confines files but not signals). The middle path: not a container, still confined.

**Remote access is Tailscale, and PiCloud ships no authentication module.** It binds to loopback only; `tailscale
serve` (never `funnel`) is the way in, and Tailscale's login header can narrow who is allowed, as can the tailnet's
own access controls. Anyone who can reach PiCloud can make Pi run commands, so the tailnet is the boundary, and that
is the design.

## What it costs to run

- **A $4/month droplet is enough** for PiCloud with reading aloud and long-term memory turned off.
- **A $12/month droplet runs the full-featured install**, with both: Kokoro is about 600 MB loaded, LEAF embeddings
  about 300 MB.

The optional models are fetched at install time from a pinned revision with every file's checksum verified; nothing
is downloaded at run time. `--speech off` leaves reading aloud out, and the installers build the local memory model in
only when you ask for it, which keeps a small machine small.

## Requirements

- Node.js 22.19 or newer, and git.
- Pi signed in with a model.
- `gh` for repository delivery (cloning, pushing, pull requests); a directory on the machine needs none.
- Tailscale for remote access.

## Design

The reasoning behind every piece — Durable over imitations, why the agent never holds a GitHub push credential, how
compaction works, how access is controlled — lives in [DECISIONS.md](DECISIONS.md). The install and
deployment runbooks are in [deploy/](deploy/) and [install.sh](install.sh); the contributor rules are in
[AGENTS.md](AGENTS.md).

PiCloud is MIT licensed.
