---
name: dispatching-implementers
description: "Load before handing a code change to an implementer subagent, and when reading one's report back. Carries the two implementer modes (a mechanical implementer you specify edit by edit, and a directive implementer that frontloads the full design docs and figures out the code from an outcome contract), the readiness gate for each, the assignment contract the implementer parses, dispatch mechanics for parallel writers sharing a tree, and field-by-field interpretation of the structured report including what each STATUS obliges you to do. Use whenever you are about to delegate a change so the reading, editing, and verification stay out of your own context window. Part of the dispatching triplet with dispatching-scouts and dispatching-verifiers."
---

# Dispatching implementers

## Load the triplet

This skill is one of three: `dispatching-scouts`, `dispatching-implementers`, `dispatching-verifiers`.
Load the two you have not loaded, and `subagent-orchestration`, which carries your role as the
orchestrator and the end-to-end loop that joins the three seats. The contracts interlock: the scout's
report feeds the implementer's brief, the implementer's diff feeds the verifier, the verifier's
verdict feeds your accept-or-send-back decision. The handoffs below assume all three are loaded.

## The split

You hold the map, the diagnosis, and the decision about what should change. The implementer makes the
change and reports faithfully on what landed. How much understanding you delegate depends on which kind
of implementer you dispatch, and that choice is the whole skill.

**A mechanical implementer** executes a change you specified edit by edit. It does not load the design
docs itself, so you cannot delegate understanding to it: if you cannot write the change mechanically,
you are not ready to dispatch, and sending it anyway costs more than investigating would have. It either
guesses and you get a confident report about the wrong change, or it stops and you pay a round trip plus
the thinking you were trying to offload.

**A directive implementer** frontloads the full scoped design docs into its own context and figures out
the code itself. The `dt466e-implementer` is one: its agent file requires it to read every named document
in full before it writes a line. To it you delegate the implementation understanding and keep the
judgment: the approach calls, the scope, the observable contract. You write an outcome directive, not an
edit list, and a scout gathers the code facts your approach calls rest on. Sending it a mechanical edit
list wastes its reading and spends your context on work it does itself.

One consequence holds for both. Its report is your only view of the work. You will not see the tree, the
tool calls, or the reasoning. Write the brief so the report answers what you need to know, and read the
report as a sample to check rather than an answer to accept.

## Readiness gate

The gate depends on the implementer.

**Mechanical implementer.** You MUST NOT dispatch until all four hold:

1. You can name the files and symbols. `src/auth/session.ts:refreshToken`, not "the auth logic."
2. Every edit is one imperative line with no "figure out the best way" left in it.
3. At least one DONE-WHEN condition is observable by running a command or reading a named line.
4. You have drawn the scope boundary: what is out, and what the agent must not improve.

**Directive implementer.** You MUST NOT dispatch until all four hold:

1. You have made the approach calls the unit needs: which seam, which mechanism shape, which strategy.
   Two materially different implementations the directive leaves open is a call you have not made; make
   it, or send a scout for the fact that settles it.
2. The code facts those calls rest on are gathered and quoted verbatim, by a scout, not from memory.
3. The documents the implementer must load are named, and at least one DONE-WHEN condition is observable
   by running a command or reading a named line.
4. You have drawn the scope boundary: what is out, and what the agent must not improve.

For both, a failing condition means you MUST send a scout first; `dispatching-scouts` carries that mission
contract. Its report is a partially filled brief: located file:symbol sites with verbatim signatures,
current behavior at each, the in-tree exemplar to mirror, the radius of what a change would break, and
the commands that would prove the change works. Its GAPS field is exactly the ambiguity you are not yet
entitled to hand an implementer. Scout and judgment iterate: a GAP that blocks an approach call gets a
follow-up scout question before the brief is written, not after.

You MUST verify an API contract at its call site before writing it into a brief. A signature quoted from
memory propagates one error into every instruction that repeats it. When a scout supplied the quote, you
MUST paste it verbatim (into CHANGES for a mechanical brief, into FACTS for a directive); you MUST NOT
retype it. Retyping is how a verified fact becomes an unverified one.

## The assignment contract

Paste the shape for your implementer into the Agent prompt. It parses it by field name.

### Mechanical implementer

```
GOAL: <one sentence: the observable outcome. One clause of why, when the why constrains the how.>
CHANGES:
1. In <file:symbol>, <imperative edit>. <Trailing constraint where a naive edit would be wrong.>
2. In <file:symbol>, <imperative edit>.
SCOPE: <files and symbols in play. Say "and direct callers" only when you mean it.>
OUT: <what not to touch, what not to improve, what not to refactor.>
MIRROR: <file:symbol>, an in-tree implementation of the same pattern. Or NONE.
DONE WHEN:
- <observable condition>
- <observable condition>
VERIFY: <exact commands, or DISCOVER>
CONTEXT: <optional, 5 lines or fewer: conventions, gotchas, prior attempts, why an obvious approach is wrong>
```

### Directive implementer

```
GOAL: <one sentence: the observable outcome>
DOCUMENTS: <the design docs and conformance files the implementer loads in full: LLD sections, HLD sections, ledger items>
APPROACH: <the judgment calls already made: which seam, which mechanism shape, which strategy. The implementer executes these; it does not re-decide them>
FACTS: <verbatim scout quotes the approach rests on: signatures, structure, current behavior. Or NONE>
SCOPE: <files and symbols in play>
OUT: <what not to touch, what not to improve, what not to refactor>
MIRROR: <file:symbol>, an in-tree implementation of the same pattern. Or NONE>
DONE WHEN:
- <observable condition>
VERIFY: <exact commands, or DISCOVER>
CONTEXT: <optional, 5 lines or fewer>
```

The directive implementer figures out the edits from GOAL, DOCUMENTS, APPROACH and FACTS. APPROACH carries
the judgment, not the edits: "the latch clear writes standing directly, clearing latch_engaged_at, guarded
so it only clears an engaged latch" is an approach call; the exact SQL is the implementer's. A directive
that names the outcome but leaves the approach open stalls the implementer on the fork; a directive that
dictates every edit wastes its reading. Different, not less.

Field discipline, both modes:

- **OUT** SHOULD name the tempting adjacent work. The agent will see it and is not permitted to do it.
  Naming the temptation costs one line and saves a review pass over a diff you did not expect.
- **MIRROR** SHOULD name an in-tree exemplar, or NONE deliberately. It is the highest-value field in a
  codebase you know and the agent does not: an exemplar gets you a diff that reads like the rest of the
  repo instead of one that reads like the agent.
- **DONE WHEN** is what makes STATUS meaningful. Each condition MUST be observable: a performance, the
  condition under which it holds, and a criterion you can check. A condition the agent cannot check here
  becomes a NOT RUN that you have to resolve yourself, so you SHOULD prefer conditions runnable in this
  environment.
- **VERIFY** SHOULD name the command when you know it; DISCOVER costs the agent a search you already did.

Mechanical mode: **CHANGES** MUST be imperative and mechanical, one change per line. Two materially
different strategies in one line means you have not decided yet; you MUST decide, or ask the human, before
dispatch. The agent is required to stop on that ambiguity rather than pick. Keep the brief under roughly
40 lines and name exact functions and line regions to read; forbid full-file reads where a region will do.

Directive mode: **DOCUMENTS** MUST name the full scoped docs the implementer loads; it reads them in full,
so you MUST NOT slice them. **APPROACH** MUST carry the judgment calls already made, one per line; two
materially different implementations left open is a call you MUST make first. **FACTS** MUST carry the
scout's verbatim quotes, pasted not retyped. The brief stays short because the implementation detail lives
in the docs the implementer reads, not in the brief.

## Dispatch mechanics

- One agent per disjoint file set: parallel writers MUST have non-overlapping SCOPE or
  `isolation: "worktree"`. Two implementers writing the same file in one tree interleave silently.
- Background by default. Queue the dispatch and prepare the next brief while it runs; do not block on a
  result you cannot act on yet.
- `subagent_type: "implementer"`. Model and thinking are pinned in the agent definition. You MAY override
  only with a reason you would state aloud.
- Do not narrate dispatch into the conversation. The progress UI shows agents launching and landing.
- You MUST say explicitly when a commit is wanted later and by whom. The agent never touches git state, so
  anything it leaves is uncommitted by design.

## Reading the report

Fields arrive in a fixed order: STATUS, DIFFSTAT, CHANGES, DECISIONS, VERIFIED, NOT RUN, UNTOUCHED, OWES,
BLOCKER.

| STATUS | Means | Your move |
|---|---|---|
| DONE | every instruction landed, every DONE-WHEN met by a check that ran, no undisclosed choices | read the diff, accept |
| DONE_WITH_DECISIONS | the same, and the brief was silent somewhere | read DECISIONS before anything else; each entry is a choice you did not make and may want reversed |
| PARTIAL | some instructions landed, some did not | the tree is mixed. Decide keep-and-continue or revert before dispatching anything further |
| BLOCKED | stopped on a false premise or an authority boundary | answer the BLOCKER question, fold the answer into the brief, re-dispatch |

Trust rules:

- **You MUST read the diff; the accept decision is non-delegable.** DIFFSTAT tells you where to look and
  CHANGES tells you what each hunk should be; your read catches a report describing intent instead of
  outcome. For a consequential change, also dispatch a verifier (`dispatching-verifiers`) to check the diff
  against the brief independently of the builder, and read its verdict alongside your own read: two
  samples, one decision, yours. DIFFSTAT lists created files separately because `git diff` does not show
  untracked ones, so run `git status --short` yourself whenever the change was supposed to add a file.
- **A DONE with a non-NONE DECISIONS is mislabeled.** You MUST treat it as DONE_WITH_DECISIONS and read the
  decisions.
- **VERIFIED carries commands and exit statuses.** Adjectives in that field mean nothing ran. You MUST
  treat the change as unverified regardless of the STATUS line.
- **NOT RUN is a boundary, not a failure.** You MUST resolve it yourself or dispatch the check; you MUST
  NOT read a clean-looking report as verified when NOT RUN names the covering check.
- **UNTOUCHED is free information** about code you did not ask anyone to look at. Triage it into your own
  ledger; losing it is the waste.
- **OWES is your follow-up list.** Doc or map updates, migrations, and knock-on edits land there when a
  repo's conventions require them and the brief did not ask for them. If you want them done rather than
  reported, put them in the brief next time.

## Verification handoff

After the implementer returns and you have read the diff, dispatch a verifier for a consequential change
before accepting. Load `dispatching-verifiers`; its mission is built from this skill's outputs:

| Implementer output | Verifier field | Note |
|---|---|---|
| DIFFSTAT plus `git status` created files | SUBJECT | the diff to read; paste, do not retype |
| the brief's GOAL and DONE WHEN | SPEC | paste verbatim, with design citations |
| SCOPE plus the scout's RADIUS | SCOPE | the diff files and their callers |
| the report (primed) or withheld (blind) | MODE | at least one blind pass for a consequential change |
| the covering check | PROBE | prefer runnable here |

A VERIFIED verdict whose bound you accept ends the loop. A DEFECTS verdict is a send-back brief: each
defect becomes a CHANGES line, the unmet condition becomes DONE WHEN, and you re-dispatch the implementer.
The verifier never applies the repair itself.

## Re-dispatch

A dead or stopped agent is not a rollback. You MUST inspect the tree before sending another: `git status`
and `git diff` over the SCOPE files. Only the tree says how far the work got.

Then dispatch what remains, with the answer to any BLOCKER folded into the brief. The agent checks for a
predecessor's applied work before editing, but you are the one who knows whether a second application
would double it. You MUST NOT send a blind edit pass at a change you have not inspected.

## Relationship to the other delegation skills

`dispatching-scouts` governs the pass that establishes facts before this one, and `dispatching-verifiers`
governs the pass that checks this one's change; the report fields map onto the brief's and the verdict's,
one for one. `subagent-orchestration` is the orchestrator's home: it carries your role as the hub, the
non-delegables, and the build-triplet loop that joins the three seats, alongside the broader
claim-producing passes. This one governs a pass whose output is a change in the tree. The shared rules
still bind: you MUST settle ambiguity before dispatch rather than in the agent's context, you MUST NOT
write "based on the findings, fix it" into a prompt, and you MUST treat a returned report as one sample to
check rather than an answer to accept.

## Checklist before you send

- [ ] The implementer mode chosen deliberately (mechanical or directive)?
- [ ] Files and symbols named, not described?
- [ ] Mechanical: every CHANGES line imperative, one change, no latitude left in it?
- [ ] Directive: the approach calls made, DOCUMENTS named, FACTS quoted verbatim from a scout?
- [ ] OUT names the tempting adjacent work?
- [ ] MIRROR names an in-tree exemplar, or NONE deliberately?
- [ ] At least one DONE-WHEN condition checkable by a command here?
- [ ] VERIFY names commands, or says DISCOVER?
- [ ] API signatures in the brief verified at their call site, and scout quotes pasted rather than retyped?
- [ ] Any file the change creates named (in CHANGES or SCOPE), so its absence from `git diff` is expected?
- [ ] Parallel agents have disjoint SCOPE or separate worktrees?
- [ ] Brief short (mechanical under roughly 40 lines; directive shorter, detail lives in the docs)?
- [ ] You will read the diff when it returns?
- [ ] A consequential change gets a verifier pass before accept?
