---
name: dispatching-verifiers
description: "Load before sending a verifier subagent to check an implementer's change against its spec, and when reading one's report back. Carries the mission contract the verifier parses, the primed/blind independence choice, and field-by-field interpretation of the report including how a verdict becomes an accept decision or a send-back brief. Use after an implementer returns, before accepting a consequential change, or when a report's claims need an independent check against the tree. Part of the dispatching triplet with dispatching-scouts and dispatching-implementers."
---

# Dispatching verifiers

## Load the triplet

This skill is one of three: `dispatching-scouts`, `dispatching-implementers`, `dispatching-verifiers`.
Load the two you have not loaded, and `subagent-orchestration`, which carries your role as the
orchestrator and the end-to-end loop that joins the three seats. The contracts interlock: the scout's
report feeds the implementer's brief, the implementer's diff feeds the verifier, the verifier's
verdict feeds your accept-or-send-back decision. The handoffs below assume all three are loaded.

## The split

You hold the map and the accept decision. The implementer made the change and reported on it. The
verifier is the check: it establishes whether the change satisfies its spec and breaks nothing,
independently of the builder, and quotes the evidence back to you.

The power of the seat is one structural fact: the agent that checks is not the agent that built, so the
check does not inherit the builder's blind spots. A verifier handed the implementer's framing checks the
framing instead of the result. Independence of person is necessary but not sufficient; independence of
framing is the real requirement, and the primed/blind choice below is how you buy it.

The verifier never fixes what it judges and never decides whether to accept. It reports; you decide. A
defect it finds becomes a new implementer brief, not a repair the verifier applies.

## When to send one

Send a verifier after an implementer returns, before you accept a consequential change. The implementer's
report is one sample, and it describes intent as readily as outcome; the verifier is the independent
sample that reads the tree.

Send one when:

- The change touches callers, a wire shape, a shared quantity, or a serving path, where a wrong diff costs
  more than the check.
- The implementer reported DONE_WITH_DECISIONS, and a decision it made needs an independent read.
- You suspect the report describes intent rather than outcome: a VERIFIED with no command behind it, a
  condition claimed met that you cannot see proven.
- The change is consequential enough that a wrong frame would produce a wrong accept. Run a blind pass for
  these; a primed pass alone inherits the frame.

You MUST NOT send a verifier to discover defects open-endedly; that is a hunt, with a different contract.
You SHOULD NOT send one for a trivial change you can read yourself in a minute; the seat earns its cost on
consequential diffs. And you MUST NOT send one to decide whether to accept; it supplies evidence, you
decide.

## The mission contract

Paste this shape into the Agent prompt. The verifier parses it by field name.

```
SUBJECT: <the change under review: the diff to read, named by file>
SPEC: <what the change must satisfy: GOAL, DONE WHEN, design-doc citations>
SCOPE: <the reading bound: the diff files and their callers>
MODE: <primed | blind>
BAR: <what counts as a finding: the evidence bar>
NEED: <what the verdict feeds: an accept decision, a send-back brief>
```

Field discipline:

- **SUBJECT** names the diff. Build it from the implementer's DIFFSTAT plus `git status --short` for created
  files, since `git diff` omits untracked ones. You MUST paste the DIFFSTAT; do not retype it.
- **SPEC** is the brief's GOAL and DONE WHEN, plus the design-doc citations they came from. The verifier
  checks against the spec, not against the implementer's reading of it. You MUST paste DONE WHEN verbatim.
- **SCOPE** is the diff files plus their callers. The scout's RADIUS, if you have it, names the callers;
  paste it.
- **MODE** is the independence choice; see the next section.
- **BAR** defaults to: a defect reachable by a concrete realistic input in the tree today, with the trigger
  path named; no style, naming, or docstring nits, and no implausible reaches. You MAY narrow it with
  run-specific exclusions; you MUST NOT loosen it.
- **NEED** shapes emphasis. An accept decision wants defects priced by consequence; a send-back wants the
  repair constraint named.

Keep the mission under roughly 25 lines. A wider mission returns a truncated verdict, since the report is
capped at 40 lines and the verifier puts the overflow in BOUND rather than compress your conditions away.

## Primed versus blind

MODE is the highest-leverage line in the mission, the same way PREMISE is for a scout.

- **Primed**: the verifier gets the implementer's report plus the spec and the diff. It checks faithfully
  inside the report's frame, catching detail slips: a wrong constant, a missed caller, a condition that
  does not actually hold. It inherits the report's framing errors, so it cannot catch that the frame itself
  is wrong.
- **Blind**: the verifier gets the spec and the diff only, not the report. It re-derives the expected
  behavior independently, which is what catches a wrong frame: the implementer solved the wrong problem,
  or the brief's premise was false.

A primed pass validates details; a blind pass catches framing errors. Anything you will accept on needs at
least one pass that does not know what the builder was looking for. For a consequential change, you MUST
run blind, or primed then blind; a primed pass alone is one frame checked once.

Two verifiers handed the same report are one sample with a rounding error, not two. Parallel verifiers MUST
have different MODE or disjoint SCOPE to be independent.

## Dispatch mechanics

- One mission per verifier. Read-only, so no worktree isolation needed; it cannot corrupt a tree another
  agent writes.
- Background by default. Queue the dispatch; read the implementer's diff yourself while it runs.
- `subagent_type: "verifier"`. Model and thinking are pinned in the agent definition; you SHOULD raise
  thinking for a trace where a missed caller costs a broken accept.
- The verifier reads the actual tree. You MUST dispatch it against the checkout that holds the change,
  after the implementer's work is applied; a verifier run against a stale tree checks the wrong diff.
- Split rather than widen. If the verdict will not fit 40 lines, send two verifiers with disjoint condition
  sets instead of one with a bigger mission.

## Reading the report

Fields arrive in a fixed order: STATUS, CONDITIONS, DEFECTS, CORRECTIONS, CLEAN, PROBE, BOUND.

| STATUS | Means | Your move |
|---|---|---|
| VERIFIED | every condition met by a check that ran, no defect within coverage | read CLEAN and BOUND for what that covers; accept if the bound is acceptable |
| DEFECTS | a concrete defect or an unmet condition | read DEFECTS and CONDITIONS; build a send-back brief |
| PARTIAL | some conditions checked, rest in BOUND | settle the bound yourself or send a second verifier before accepting |
| BLOCKED | the verdict could not be established | read the blocker; usually SUBJECT or SPEC was wrong, or a condition needs runtime you must reach |

Trust rules:

- **VERIFIED is bounded, not absolute.** CLEAN and BOUND state what was checked; a VERIFIED resting on a
  narrow CLEAN is weaker than it reads. "I could not break it" is not "it is correct."
- **CORRECTIONS is a trust hit on the implementer's report.** A report that claimed verified what did not
  run means the rest of that report is suspect; you MUST re-read the diff yourself before accepting anything
  it claims.
- **DEFECTS MUST carry a concrete trigger.** A defect without an input and a path is a shape, not a finding;
  send it back for the trace or drop it.
- **BOUND is your remaining uncovered surface, and it MUST be acceptable before you accept.** A condition
  the verifier could not check is a condition you have not verified; resolve it yourself or dispatch the
  check.
- **PROBE names what execution would prove the change.** If it is runnable here, you SHOULD run it; a verdict
  backed by a probe you ran is stronger than one backed by reading.
- **The verifier is one sample too.** For a consequential accept, you MUST read the diff yourself as the
  backstop; a clean verifier report is not a substitute for your own read.

## Verifier to implementer handoff

A DEFECTS verdict is a partially filled send-back brief. Each defect becomes a CHANGES line.

| Verifier field | Feeds | Note |
|---|---|---|
| DEFECTS | CHANGES (the repair) | one defect per line; the trigger path is the constraint that keeps the repair honest |
| CONDITIONS (not met) | DONE WHEN | the unmet condition is the completion condition for the repair |
| CORRECTIONS | CONTEXT | what the prior report got wrong, so the re-dispatch does not repeat it |
| PROBE | VERIFY | the execution that proves the repair; prefer runnable here |
| BOUND | your decisions | settle before re-dispatch, the same as a scout's GAPS |

Re-dispatch the implementer with the repair brief, then verify again. The loop is implementer → verifier →
accept or send-back, and it terminates on a VERIFIED whose bound you accept. You MUST NOT accept on a
DEFECTS verdict because the defects look minor; price them, and if you accept with a known defect, record
it as a deliberate residual, not a clean pass.

## Checklist before you send

- [ ] SUBJECT names the diff, including created files from `git status`?
- [ ] SPEC carries GOAL and DONE WHEN verbatim, with design citations?
- [ ] SCOPE includes the callers, not just the diff files?
- [ ] MODE chosen deliberately; at least one blind pass for a consequential change?
- [ ] BAR stated (concrete realistic input, no nits)?
- [ ] NEED says what the verdict feeds?
- [ ] Verifier dispatched against the checkout holding the applied change?
- [ ] You will read CLEAN and BOUND before accepting, and read the diff yourself for a consequential accept?
