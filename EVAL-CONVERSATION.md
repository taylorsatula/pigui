# picloud design conversation: evaluation script

## What this is
A scripted conversation for evaluating a model's agentic design work inside picloud. You play the human, using the
prompts below. The model has to research an unfamiliar ecosystem, evaluate a competing project honestly, ask the
right questions, design a product, and turn it into an implementation runbook. Then it has to revise that runbook as
the requirements sharpen.

The arc reproduces a real design session. Some steps are consolidated, and none are dropped. The model never sees
this file. Only the **Prompt** blocks (and, when triggered, the **If** prompts) are sent.

## Setup
- **Session:** start a new picloud session on an **empty repository** (for example `you/picloud-design-eval`), in
  new-branch mode.
- **Network:** the droplet must allow outbound access to GitHub, npm and public documentation sites. The model
  researches with `bash` (`git clone`, `curl`, `npm`).
- **Model:** use whichever model you are evaluating, as Pi's default model.
- **Delivery:** tap **Push branch** whenever a report card appears, so the work is saved remotely.

## Rules for the human
1. **Send prompts verbatim.** Voice-dictation roughness is fine and intended.
2. **Use the If prompts only when their condition holds.** Never volunteer information that isn't in a prompt or in
   the card answers (§Card answers).
3. **Cards:** answer question cards from the table below. Approve a plan card unless the **Revise** note for that
   turn applies.
4. **Don't help.** Never point the model to URLs, file paths, APIs or conclusions. Finding them is the test.
5. **Take notes per turn** against the **Strong** and **Weak** lists, then score with the rubric at the end.

## Card answers (when the model asks through a question card or in prose)

| If it asks about | Answer |
|---|---|
| Which "Pi" / where the code is | "Find it. It's popular and it's on GitHub." |
| Which mobile web app | "Whatever the Pi Durable ecosystem has. Find it." |
| Who the users are | "Just me." |
| Model provider / API keys | "Pi has that inside already. Don't reinvent it." |
| How the phone reaches the server | "Tailscale." |
| Whether implementation should wait for plan approval | "Wait for my approval." |
| What happens to finished work | "At the end, give me the choice to push the branch, open a PR, or keep working with my feedback." |
| Several sessions at once | "Yes." |
| Scope of the first deliverable | "Research and design only. No product code until I ask." |
| Whether to run another project's test suite | "No need." |
| Anything else | "Your call. Tell me what you picked and why." |

---

## Turn 1: kickoff and research

**Prompt**
> I need to build a Pi harness that runs on a remote server. (I'm using voice to text, so it sometimes comes out
> as "Pie".) Before anything else, research two things. First, Pi Durable at a technical level. Second, Claude Code
> on the web, which is the closest existing product to what I'm going for. I have some design choices that differ
> from it, but I want a summary of how it works and how its interactivity compares to terminal Claude Code: it
> front-loads questions to the user before acting, and works autonomously more often. Also pull the Pi Durable
> codebase into your workspace, so you have the exact integration points for the mobile web app at hand. Keep your
> notes in this repo. Tell me when the foundational research is done, and I'll explain the idea further.

**Likely reply:** a question card (which Pi, what scope), then a research plan card, then research via
`git clone`/`curl`, notes committed, and a report.

**Revise the plan if** it includes writing product code. Say: "Research and notes only for now."

**Strong**
- Identifies the earendil-works Pi monorepo, and Durable as `packages/durable`. Clones it.
- Finds the official web apps (p2 "Pi Mobile", its successor p3, the Chord framework) and treats them as the
  integration reference. Notes that p2 calls itself a prototype.
- Understands that Durable is a **library, not a server**: one Harness over one storage, commits before display,
  restart recovery, tool **parks on signals**, watches for live views, the `env` hook, and hooks such as `beforeTool`
  and `onYield`.
- Explains Claude Code cloud with specifics, not generalities: a per-session VM, a git proxy that keeps tokens out
  of the sandbox, network policies, setup scripts, the cloud permission modes, the role of plan mode and
  AskUserQuestion. Observes that front-loading comes from prompting and plan mode rather than a dedicated mechanism.
- Notes are organized in files, committed, and cite sources.

**Weak**
- Summarizes from memory without cloning or fetching anything.
- Confuses Pi with another project.
- Calls Durable a server.
- Gives a generic description of "cloud coding agents".
- Starts building.

**If** it stops to ask which Pi without searching: "Find it."

## Turn 2: the vision

**Prompt**
> Here's the idea. I picture a thin client. Pi is already very capable and has its own tools, so I don't need much
> scaffolding around it. I just need to pull in repositories, give it a system prompt explaining what the
> environment is and how it differs from a normal coding session, and build some custom Pi tools so it can ask me
> multiple-choice questions. It would be powerful to have a droplet running somewhere that I connect to from my
> phone, making and pushing changes to repos I control with minimal interruption during the task. That only works
> if Pi does extra planning at the start of a session, so that once implementation kicks off it can usually run
> until a final report.

**Likely reply:** an architecture sketch, a list of open questions, and maybe a mention of existing community apps.

**Strong**
- Maps the vision onto Durable primitives:
  - a question tool that **parks on a signal**, so a phone can answer hours later at no cost;
  - a plan-approval wait using the same mechanism;
  - a mechanism that continues runs which stop before reporting (for example `onYield`), with a bound;
  - per-session workspaces through `env` and `cwd`;
  - live sync from watches.
- Identifies the real work as host-side: auth/exposure, transport, sessions, push notifications.
- Raises the GitHub-credential and prompt-injection question, and offers a stance on it.
- Asks a small number of decision questions, each with a recommendation.

**Weak**
- Proposes building its own agent loop, provider layer or session store.
- Adds features that weren't asked for.
- Ends with no recommendations.

## Turn 3: the competing project

**Prompt**
> Check out Pi Pocket. Is it a fully fleshed-out project without a lot of issues, and does it make smart design
> choices? Go actually look at the repository: history, issues, code, and how it uses Pi Durable. Don't guess.

**Likely reply:** clones pi-pocket and reports its size, features and test count, with some opinion.

**Strong**
- Clones it with history. Measures:
  - commit volume and rate, and how many authors;
  - code size by area, and where it's concentrated (for example a design-system subsystem larger than the core);
  - test volume;
  - issues and who files them.
- Reads the Durable integration and finds that its question and approval waits **hold in-memory promises instead of
  parking on signals**, re-ask after a restart, and that subagents poll. It ties this to the "answer from the phone
  hours later" requirement.
- Credits what is good, with specifics (an honest security doc, a good question-tool schema, its SSE design).
- States a verdict and says what is worth borrowing.

**Weak**
- Repeats the README.
- Praises it without measuring anything.
- Says it's bad without evidence.

**If** the verdict is favorable or shallow:
> Look harder: how fast it was written and by whom, how big it is next to what Durable already does, and how it
> waits for the person. Does that sound like a harness that can be opened and do zero-shot coding work?

**Then (always):**
> I'm not going to use that project. Today we build something concise and focused. My projects don't sprawl because
> I know when to say no.

**Strong follow-up:** takes it in stride. It reaffirms the scope rule and states the decisions it now needs. It does
not grovel and does not reverse findings it supported with evidence.

## Turn 4: decisions

The model should now ask for decisions: provider, access, plan gate, delivery, and possibly users and concurrency.
Answer from §Card answers.

**If** it doesn't ask anything: "What decisions do you need from me before you design this?" (Note it as a miss.)

**Strong**
- Hears "Pi has that inside" and finds Pi's own configured models in `pi-coding-agent` (a `ModelRuntime`-style
  export), plus default-model settings. It does not write provider code.
- Notices that server-side delivery (push/PR on a tap) means **the agent never needs to push**, and simplifies the
  security story accordingly.
- Records the decisions in the repo.

**Weak**
- Builds a provider picker.
- Asks the same questions again.
- Doesn't connect delivery to security.

## Turn 5: understanding and the phone experience

**Prompt**
> I don't know how much of the design you understand and how much is still open. Explain how you understand it, and
> how you see someone using the PWA. Focus on zero-shot work. If someone wants interactive work, that's their
> prerogative and nothing should needlessly bar it. But mostly what I want is an input pill, an attachment button,
> and a send button. Tool calls and the thinking trace can be expanded, and are collapsed by default. Use Apple's
> human interface guidelines, and name the principle at each design choice. It's easy to make a sprawling flying
> car with PPTX support. It's hard to make a simple chat interface that works well and gives the low-friction
> experience people coding or researching on the go demand. It has to be approachable. And just like letting Pi
> handle model providers itself, minimize the extra scaffolding. Using Tailscale, for example, eliminates nearly the
> whole authentication layer, because an established outside dependency handles it well. I hope you're getting the
> recurring theme.

**Likely reply:** a design walkthrough with screens, a session lifecycle, and HIG principles.

**Strong**
- Gives a "who does what" table, delegating to Tailscale, Pi, Durable, `gh`, Web Push and systemd.
- Lays out a clear session lifecycle: plan, questions, approval, unattended run, report, delivery choice.
- Gives a concrete walkthrough of the phone flow:
  - a composer with + and send, where send becomes Stop while running;
  - collapsed thinking;
  - tool groups summarized in plain language, with failures visible while collapsed;
  - question, plan and report cards;
  - notifications only when needed.
- **Names an HIG principle for each choice.**
- Interactive use is preserved: the workflow is a prompt default, and only post-approval continuation is enforced.
- Reduces scaffolding further where it can: state in Durable documents instead of a second database, and no app
  login.
- Ends with a short list of open questions, each with a recommendation.

**Weak**
- Uses HIG as decoration.
- Has a settings screen or model picker.
- Designs a complex dashboard.
- Enforces the plan workflow so hard that chatting breaks.

## Turn 6: two changes and the formal runbook

**Prompt**
> This is close to what I envisioned. One change: I want a hamburger menu. Some complexity is necessary, and not
> having one is unnecessary friction, because the easiest way to switch sessions is to pull out a menu and tap one.
> The only other thing: it would also be nice to have a multiple-choice tool. Otherwise it all sounds good. Please
> write a formal runbook for implementing picloud. Make it comprehensive, and make sure it doesn't need any tribal
> knowledge from this session to execute.

(If its design already has a drawer, say "Keep the drawer" in place of the first two sentences.)

**Likely reply:** a long runbook document, committed.

**Strong**
- Adopts the drawer with an honest HIG note: tab bars are preferred for fixed sections, but a drawer is the
  convention for a changing list of chats, and a badge offsets its discoverability.
- **Points out that the multiple-choice tool is already in the design** (or asks what more is wanted) instead of
  adding a duplicate.
- Before writing API details, **verifies against the installed npm packages** rather than the GitHub docs:
  - discovers that the published version differs from GitHub main (park shape, signal state, `onYield` return);
  - discovers that Durable's coding tools carry no system prompt, and reuses Pi's exported context loaders;
  - ideally writes and runs a small spike proving the park/restart/signal, plan-approval and continuation
    mechanics.
- The runbook covers:
  - pinned versions;
  - the data model and session states;
  - the extension spec (prompt text, tool schemas, continuation rule);
  - server behavior and API;
  - the PWA spec with HIG rationale;
  - notifications;
  - phases with acceptance checks;
  - tests;
  - deployment and operations;
  - security;
  - a decision log.

**Weak**
- Writes API calls from memory or from GitHub main.
- Skips verification.
- Adds a second, redundant question tool silently.
- References session context the runbook doesn't contain.

## Turn 7: necessary complexity

**Prompt**
> It'd be a good idea to run back through the design in your head, looking for places where some necessary
> complexity actually helps the user come out ahead in the end.

**Likely reply:** a ranked list of additions, and maybe some rejections.

**Strong**
- Proposes a few additions, each tied to a concrete failure on the phone and with a cost. For example:
  - repo setup memory across sessions;
  - spend display and a cap;
  - starting from or continuing an existing branch or PR;
  - visible plan progress;
  - a per-file diff for phone review;
  - rebasing onto the base before reporting;
  - automatic backups and safe pruning.
- **Explicitly rejects** tempting things that don't pay, with reasons (voice, lock-screen actions, share sheet, CI
  watching, model picker, containers).
- Notes which additions add prompt weight.

**Weak**
- A feature wishlist.
- No costs given.
- Nothing rejected.

**Then:** "Add all of them." (If it proposed something that clearly violates the scope rules, say "Add the ones that
serve the core loop.")

## Turn 8: reproducible across harnesses

**Prompt**
> If it's implemented faithfully, does the runbook fully cover what has to be created, without over-specifying the
> exact code? I'm going to run the implementation across several models and coding harnesses with no other
> instructions, to see which is best at turning a plan into a finished codebase. The runbook needs to be one
> reproducible file I can paste into each session verbatim.

**Likely reply:** a self-audit, then revisions.

**Strong**
- Admits gaps honestly:
  - references to files that won't exist;
  - acceptance checks that need credentials, GitHub or a phone;
  - places where it pasted near-final code;
  - data shapes it never documented.
- Fixes them:
  - **self-contained** text;
  - a **credential-free fake mode** (scripted model plus local git remotes) so every harness can finish;
  - a **machine-checkable definition of done**;
  - operator-only steps separated out;
  - behavior specified instead of code bodies;
  - the client-visible data shapes documented.
- Verifies any API it hadn't exercised (observers, paging, usage/cost), and discovers traps such as the scripted
  model always reporting zero cost.
- Ideally gets a cold review of the runbook from a fresh context, and fixes what it finds.
- Asks whether to include its Turn 7 additions and how to treat deployment. Answers: "All of them" and "Keep
  deployment, marked operator-only."

**Weak**
- Says "yes, it's complete" without auditing.
- Leaves tests that need real credentials.
- Rewrites everything without being asked.

## Turn 9: self-hosting, no size targets, TypeScript

**Prompt**
> When it's all done, I'm going to load the plan into picloud itself and see whether it can rebuild its own code
> from scratch in a temp directory. Also, don't write the plan around any line-count or size target. It's impossible
> to know in advance. Write it so the application is complete and works correctly. Concise, well-thought-out
> implementations are judged on whether they stay maintainable over time, not on how small the code is. And the plan
> should state that I want it done in TypeScript, so the integration with Pi Durable is as seamless as possible.

**Strong**
- Removes every size target and replaces it with concrete maintainability criteria: completeness, module boundaries,
  shapes defined once and shared, strict types, boundary error handling, behavioral tests.
- Makes **TypeScript apply everywhere**, including the browser client and service worker, with a minimal build
  (for example plain `tsc`, no bundler) and shared server/client types. Ideally it verifies that pipeline in a
  browser.
- Starts thinking about what self-hosting implies (see Turn 10).

**Weak**
- Keeps a "target" under another name.
- Leaves the client as JavaScript.
- Adds a heavy bundler without justification.

## Turn 10: installs and Tailscale

**Prompt**
> An implementer with full CLI access to the machine it's working on can absolutely install those dependencies. It
> can also do most of the Tailscale setup.

**Likely reply:** it makes installs required and moves setup into automation.

**Strong**
- Makes tool installs required, and drops the "if blocked" hedges.
- Produces an **idempotent installer with a dry-run mode**, and reduces the human part to what needs a person
  (sign-ins, admin console, token creation, phone).
- **Pushes back on one point, using Turn 9:** if picloud rebuilds itself on the live droplet, a default-on
  deployment would clobber the running instance. It therefore keeps building and deploying separate, and **fixes the
  collisions in the build itself**:
  - the fixed port;
  - the default data directory;
  - the real Pi credentials, isolated with Pi's config-directory environment variable.

**Weak**
- Lets the implementer install systemd units and run `tailscale serve` during the build.
- Misses the port and credential collisions.

## Turn 11: the dual-use runbook

**Prompt**
> It's fine if two agents build it slightly differently. That's part of the evaluation. Any agent can take a
> line-by-line spec and turn it into code; that's what a transformer is. The real insight is in choices that aren't
> so much under-specified as open-ended, as part of a cohesive whole. Does that make sense? The plan doubles as
> directions for building picloud and as a real-world evaluation of a given model in a given harness. Think of it
> as a dual-use task. I absolutely want picloud to be something I can use; this isn't a toy. But if we're writing a
> plan, we might as well exercise two things at once. Write a second runbook file, very similar to the original,
> that allows for agent choice along the way, even though every component is still required. For example, Tailscale
> can just say "install Tailscale and set it up", or "create two Pi tools for multiple-choice and radio-button
> questions".

**Strong**
- Keeps fixed only:
  - the owner's decisions;
  - the product properties;
  - the safety constraints;
  - the definition of done;
  - a short list of genuinely hard-to-discover platform facts, with a stated reason for keeping them.
- Turns everything else into required outcomes.
- Requires the implementer to document significant choices with alternatives and reasons. This becomes the
  evaluation artifact.
- Flags its own judgment calls (for example, not telling the implementer it's being evaluated; whether the two
  editions should describe exactly the same product).

**Weak**
- Copies the detailed runbook with words deleted.
- Leaves so much open that the result is no longer testable.
- Drops safety constraints.

## Turn 12: references and compaction

**Prompt**
> Something we haven't talked about, but should be in both runbooks. Files can be tagged with @filename.ts in the
> user message, with a picker that refines as I type. Same for skills, with a # trigger. Also, Pi doesn't have very
> good session compaction. Look at the compaction in the default codebase, then give the implementer direction to
> build compaction events that auto-resume and carry context forward much better than the crude thing that ships.
> You don't need to specify every attribute, but give conceptual direction that leads to something high quality and
> fairly consistent across multiple runs. Ask yourself what makes a compaction and handoff effective for resuming
> across a lossy, truncated compaction event.

**Likely reply:** it reads the compaction code, proposes a design, then edits both runbooks (and, if this script
exists in its repo, this file too).

**Strong**
- **Reads the published compaction source,** not just the README, and names its concrete weaknesses:
  - tool results truncated to their first 2,000 characters;
  - thinking dropped;
  - a single free-form summary;
  - summary-of-summary drift across repeated compactions;
  - the person's words paraphrased;
  - a compaction failure ends the run.
- **Also checks the Pi CLI's own compaction** (file tracking, update-not-resummarize, split-turn handling), and
  separates the two.
- **Finds the seam:** `beforeCompact` on `CompactionTask` can supply the summary, and Durable's lifecycle already
  continues a run after a mid-run compaction. Ideally it **verifies both with a spike.** "Auto-resume" is then mostly
  about never stranding the run (memoized narrative, deterministic fallback, automatic continue on a compaction
  failure), not about rebuilding the trigger.
- **Gives principles, not just fields:**
  - code-computed ground truth versus model-written narrative;
  - the person's words verbatim;
  - cumulative updates;
  - the resume point first;
  - negative knowledge (dead ends);
  - pointers over payloads;
  - a recall tool over the raw history;
  - a "verify before trusting" resumption directive;
  - a fixed degradation order;
  - thresholds relative to the context window.
- **Gives testable acceptance criteria:** a forced mid-run compaction reaches the report; verbatim items survive
  repeated compactions; the narrative-failure fallback works; a restart reuses the memoized narrative; recall finds
  pre-compaction details.
- **References:**
  - triggers only at word start, so emails and `#123` don't fire them;
  - a remote file tree for the New session view, before any clone;
  - skills expanded in Pi's own `<skill>` format;
  - unknown references left as text;
  - pickers that meet HIG and accessibility requirements.
- **Adapts per document:** the detailed runbook gets specifics, and the open runbook gets the principles plus a
  requirement to map its design to each one.

**Weak**
- Proposes "summarize better" or "use a bigger model" with no structural change.
- Rebuilds Durable's compaction trigger and lifecycle from scratch.
- Gives a field list with no principles, so runs diverge.
- Omits the failure path.
- Leaves the pickers as "autocomplete" with no trigger rules.

## Turn 13 (optional): the meta step
**Prompt**
> Last thing. Write a short conversation script, just the human side, that would lead another model through the same
> design arc we just went through, so I can evaluate whether it can do real agentic work the way you did here.

**Strong**
- Predicts the other model's replies and writes prompts that still work when they vary.
- Separates what is sent from what only the evaluator sees.
- Includes contingencies and a rubric.
- Does not leak its own discoveries into the prompts.

---

## Scoring rubric (score each 1–5; anchors below)

| Dimension | 1 | 3 | 5 |
|---|---|---|---|
| **Research depth** | from memory | reads docs | clones, reads source and tests, measures, cites |
| **Verification** | asserts APIs | spot-checks | runs spikes against the exact installed versions; finds the version mismatch and other traps |
| **Honesty and independence** | agrees with every framing | mild caveats | holds evidence-based positions, pushes back when warranted (pi-pocket, deployment collision), concedes when shown wrong |
| **Questions** | none, or a barrage | some, without recommendations | few, decision-shaped, each with a recommendation, asked at the right moment |
| **Scope discipline** | adds features freely | mostly on scope | delegates to established tools; rejects tempting extras with reasons |
| **Design coherence** | parts don't fit | mostly consistent | one state model, one way of doing each thing, choices that reinforce each other |
| **Artifact quality** | vague or session-dependent | usable with help | self-contained, verifiable done criteria, credential-free fake mode, maintainability bar |
| **Responsiveness** | ignores or overcorrects feedback | applies it literally | applies it, and also catches the implications (multiple-choice tool already present, self-hosting collisions) |

Also record:
- total turns used, and how many **If** prompts were needed (fewer is better);
- wall-clock time and spend shown in picloud;
- whether the final repo contains research notes, the detailed runbook, the open runbook, and a decision record.

## Evaluator-only reference (never send)

Discoveries a strong model makes on its own:
- **Where Pi Durable lives:** `earendil-works/pi`, `packages/durable`. Its web apps are `apps/p2` (prototype) and
  `apps/p3` (early).
- **Version mismatch:** the published 1.6.0 differs from GitHub main. Park is `{ sleep: {…} }`. Signal state is
  `{ value } | { expired: true }`. `onYield` returns `{ continue }`. Admission inside a commit is `submit(tx, …)`.
- **Credentials:** `ModelRuntime.create()` from `pi-coding-agent` provides Pi's configured models. Pi's config
  directory can be redirected with `PI_CODING_AGENT_DIR`.
- **Coding tools without a prompt:** `CodingTools` has no system prompt and doesn't load `AGENTS.md`. Pi exports
  `loadProjectContextFiles` and `loadSkills`.
- **Durable semantics:**
  - a Durable `"session"`-scope document is Harness-wide;
  - IDs are numbers;
  - one writable process per storage;
  - observers fire on usage-only commits.
- **Faux model:** the faux provider can drive deterministic per-conversation scripts, and always reports zero cost.
- **pi-pocket:** about 2,800 commits in about 7 weeks, mostly one author. A design toolchain of about 42k lines.
  In-memory waits rather than parks. Polling subagents. A measured 8.6k-token prompt overhead (issue #222).
- **Built-in compaction (`pi-durable` `dist/harness/compaction.js`):** each tool result is truncated at 2,000
  characters (`TOOL_RESULT_MAX_CHARS`), thinking is omitted, there is one fixed markdown template, and an earlier
  summary is folded in by re-summarizing it.
  - `beforeCompact` on `CompactionTask` may return `{ summary }`.
  - A mid-run threshold compaction continues the run automatically (verified with the faux model at an 8k context
    window).
  - A failed compaction the generation waits for ends the run with `model_error` "Compaction failed…".
  - The Pi CLI's compaction (`coding-agent/src/core/compaction/`) is better: read and modified file lists, update
    prompts, split-turn handling. picloud runs Durable's, though.
- **Pi skill invocation format:** `<skill name location>References are relative to {baseDir}…</skill>`, with
  `stripFrontmatter` exported.
- **Playwright:** the `iPhone 15` device profile defaults to WebKit, so Chromium must be set explicitly.
- **Self-hosting collisions:** port 8787, `/var/lib/picloud`, the real Pi credentials, systemd units and
  `tailscale serve`.

Design end state of the reference session, for comparison:
- **Delegation:** Tailscale for access; Pi's own provider configuration.
- **State:** one Harness over one SQLite file, with state in Durable documents.
- **Waiting:** every wait for the person is a park on a signal.
- **Workflow:** plan approval gate; bounded post-approval continuation; turn and spend bounds.
- **Delivery:** server-side push/PR on a tap.
- **Phone app:** drawer navigation; question, plan and report cards; collapsed tool and thinking rows;
  notifications only when needed.
- **Extras:** repo memory, continue-branch mode, progress, per-file diff, rebase before report, backups and pruning.
- **References:** `@file` and `#skill` pickers, expanding to `<file>` blocks and Pi `<skill>` blocks.
- **Compaction handoff:** through `beforeCompact`. A code-built ledger (task and the person's words verbatim, plan,
  repository state, files, recent commands) plus a memoized model narrative (resume point, findings, dead ends,
  decisions, open questions) plus a fixed "how to continue" directive. Also: a recall tool over raw history, a fixed
  degradation order, thresholds proportional to the model's window, and an automatic continue after a compaction
  failure.
- **Language:** TypeScript everywhere with `tsc` only.
- **Testability and deployment:** fake mode plus a machine-checkable definition of done; an idempotent installer
  with dry run; the build isolated from live services.
- **Documents:** a detailed runbook, plus an open edition for evaluation.
