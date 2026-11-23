---
name: dispatching-scouts
description: "Load before sending a scout subagent into a codebase to establish facts, and when reading one's report back. Carries the mission contract the scout parses, how to write questions whose answers are quotable facts rather than prose, the SHAPE discipline for catalog missions, and field-by-field interpretation of the report including how each field maps into an implementer brief. Use when you are about to act on a belief about code you have not read, when the dispatching-implementers readiness gate fails, or when you need every site of a shape enumerated with its bound. Part of the dispatching triplet with dispatching-implementers and dispatching-verifiers."
---

# Dispatching scouts

## Load the triplet

This skill is one of three: `dispatching-scouts`, `dispatching-implementers`, `dispatching-verifiers`.
Load the two you have not loaded, and `subagent-orchestration`, which carries your role as the
orchestrator and the end-to-end loop that joins the three seats. The contracts interlock: the scout's
report feeds the implementer's brief, the implementer's diff feeds the verifier, the verifier's
verdict feeds your accept-or-send-back decision. The handoffs below assume all three are loaded.

## The split

Four roles, and keeping them separate is what makes the delegation work.

You hold the map and the decision: what areas exist, what should change, what counts as done. The
scout is the eyes: it establishes what is true in a named place and quotes it back to you. The
implementer is the hands: it makes a change you already specified. The verifier is the check: it
establishes whether the change satisfies its spec, independently of the builder.

A scout is not a general explorer. "How does the payments module work" is an orientation question with
no output contract, and it gets an unbounded essay back; send Explore for that. A scout carries focused
intent: "in `src/payments/`, map the flow from webhook receipt to ledger write, and catalog every site
where an amount is converted without rounding." Named module, named subject, named shape, fixed report.
The difference is that a scout's output is actionable without you reading the code it read.

## When to send one

Send a scout when a judgment call rests on a code fact you do not have. In directive mode that is an
approach call you cannot settle without knowing what the code does (which seam receives a request, what
a method returns, where a mechanism's callers are); in mechanical mode it is the readiness gate failing
(you cannot name the files and symbols or state the edits). Each is a fact about the code, and facts are
what a scout returns. A scout serves your judgment, not the implementer's implementation: you MUST NOT
send one for a detail the implementer will read itself when it loads the docs. Its report is a durable
fact your briefs cite verbatim, reusable across units.

Also send one when:

- You are about to write an API signature, a constant, or a config key into a brief from memory. The
  scout quotes it and you paste the quote. A signature retyped from memory propagates one error into
  every instruction that repeats it; the implementer verifies it against the real code and reports
  BLOCKED on a mismatch, but a wrong fact in the brief costs a round trip you bought.
- A change touches something with callers you have not enumerated. RADIUS is cheaper to buy than to
  discover in review.
- You suspect a defect class rather than a defect instance. A SHAPE mission returns the whole class with
  its bound, which is what lets you decide between fixing one site and fixing the pattern.
- Your premise might be wrong. State it in PREMISE and the scout reports what contradicts it.

You MUST NOT send a scout to decide something. It will not, by design, and a mission that asks it to
returns facts arranged to imply an answer you cannot audit.

## The mission contract

Paste this shape into the Agent prompt. The scout parses it by field name.

```
MISSION: <one sentence: what to establish, and in which part of the codebase>
SCOPE: <files, directories, symbols. The bound on its reading.>
QUESTIONS:
1. <a specific question whose answer is a fact about the code>
2. <another>
SHAPE: <catalog missions: what counts, in positive terms, plus explicit exclusions. Otherwise NONE>
PREMISE: <what you believe going in, stated so it can be contradicted. NONE only if you have none>
NEED: <what the answer feeds: an implementer brief, a decision between approaches, a risk price>
DEPTH: <what to read end to end, what to only locate>
```

Field discipline:

- **QUESTIONS** MUST be answerable by a fact, enumerable or locatable, and something you would act on.
  "How does the auth flow work" fails all three. "Which call sites invoke `refreshToken`, and what does
  each pass as `opts`" passes them. One question per fact you need; a compound question gets a compound
  answer and you cannot tell which half was verified.
- **SHAPE** is a definition, not a vibe. Positive terms for what counts, explicit exclusions for what
  does not, and both written so a site can be classified without judgment.

  ```
  SHAPE: every site in src/parse/ where a Result is discarded.
         Counts: bound to `_`, or dropped without `?`.
         Excluded: anything under #[cfg(test)]; anything whose caller documents the ignore.
  ```

  Without the exclusions you get padding. Without the positive test you get a catalog bounded by the
  scout's taste instead of yours.
- **PREMISE** is the highest-leverage line in the mission. A primed scout inherits your framing error,
  and the usual remedy is a second blind pass. Stating the premise gets you a frame check inside the
  pass you already paid for, because the scout MUST report what contradicts it.
- **NEED** shapes emphasis without widening scope. Naming it is what makes the report quotable rather
  than descriptive.
- **DEPTH** is your reading budget, and it is the efficiency lever. Name the three files to read end to
  end and let everything else be located. Left unstated, a scout reads until it runs out of output.

Keep the mission under roughly 25 lines and the questions under roughly 6. A wider mission returns a
truncated one, since the report is capped at 40 lines and the scout is instructed to put the overflow in
GAPS rather than compress your answers away.

## Dispatch mechanics

- One mission per scout. Parallel scouts MUST have disjoint SCOPE, since two scouts reading the same
  files is one sample with a rounding error, not two.
- Read-only, so no worktree isolation needed. It cannot corrupt a tree another agent is writing.
- Background by default. Queue the dispatch and draft the brief's skeleton while it runs.
- `subagent_type: "scout"`. Model and thinking are pinned in the agent definition; you SHOULD raise
  thinking for a trace where a missed caller costs you a broken diff, lower it for a pure enumeration.
- Split rather than widen. If the answer will not fit in 40 lines, send two scouts with disjoint question
  sets instead of one with a bigger mission.

## Reading the report

Fields arrive in a fixed order: STATUS, ANSWERS, EVIDENCE, CATALOG, RADIUS, PATTERN, CHECKS, COVERAGE,
GAPS, CONTRADICTS.

| STATUS | Means | Your move |
|---|---|---|
| ANSWERED | every question answered, negatives bounded, coverage stated | use it |
| PARTIAL | some answered, rest in GAPS | settle the gaps yourself or send a second scout before dispatching an implementer |
| NOT FOUND | the subject does not exist in SCOPE, with the searches that establish it | the change you were planning may be unnecessary or misdirected. Re-derive before writing a brief |
| BLOCKED | the facts could not be established | read the blocker; usually your SCOPE was wrong or the question needs runtime state |

Trust rules:

- **CONTRADICTS first.** When it is non-NONE, your frame is wrong and every downstream field was gathered
  inside it. You MUST re-derive the premise before acting on anything else in the report.
- **COVERAGE is the bound, not a footnote.** A file it did not open is an assumption you are carrying. An
  ANSWERED resting on located-but-unread sites is weaker than it reads, and the report says so if you look.
- **GAPS MUST be empty before you dispatch an implementer.** The implementer is required to stop on
  ambiguity rather than resolve it, so every gap you forward becomes a BLOCKED and a round trip.
- **EVIDENCE is what you paste into the brief verbatim** (CHANGES in mechanical mode, FACTS in directive
  mode). You MUST NOT retype a quoted signature, constant, or config key. Copy it.
- **A scout's answer is one sample.** The frame check is the implementer reading the real code to
  implement (it reports BLOCKED on a false premise) and your reading the returned diff at review. You do
  not read the source yourself to write the brief; that is the scout's job, and doing it spends the
  context the delegation saves.
- **NONE is data.** A PATTERN of NONE means the repo has no precedent and your brief must supply the
  convention. A RADIUS of NONE with its bounding search means the change is local. An unfilled field
  filled with an estimate would be worse than either.

## Scout to implementer handoff

The report is a partially filled brief. Each field has a destination.

| Scout field | Feeds | Note |
|---|---|---|
| ANSWERS, EVIDENCE | CHANGES (mechanical) / FACTS + APPROACH (directive) | paste the quotes verbatim; they name the file:symbol the scout located and settle the approach calls |
| PATTERN | MIRROR | NONE means you name the convention in CONTEXT instead |
| RADIUS | SCOPE and OUT | members you are not changing belong in OUT, explicitly |
| CHECKS | VERIFY and DONE WHEN | prefer a check runnable in this environment, so it does not come back as NOT RUN |
| GAPS | your decisions, before dispatch | settle them yourself, ask the human, or send a second scout |
| CONTRADICTS | the premise of the change | re-derive; a brief written on a contradicted premise produces a confident wrong diff |
| COVERAGE | your confidence bound | what it never opened is what you have not verified |
| CATALOG | separate briefs | one defect per brief, and one implementer per disjoint file set. Never one brief for a whole catalog |

The same facts feed the verifier downstream: the DONE WHEN your CHECKS informed becomes the verifier's
SPEC, and RADIUS becomes its SCOPE. Naming the covering check and the callers now saves the verifier
from re-deriving them later.

## Checklist before you send

- [ ] Mission names a module and a subject, not a topic?
- [ ] Every question answerable by a fact, one fact each?
- [ ] SCOPE bounds the reading, and DEPTH says what to read end to end?
- [ ] SHAPE has a positive test and explicit exclusions, if this is a catalog mission?
- [ ] PREMISE states what you already believe, so it can be contradicted?
- [ ] NEED says what the answer feeds?
- [ ] Mission under roughly 25 lines, questions under roughly 6?
- [ ] Parallel scouts have disjoint SCOPE?
- [ ] You will read the diff when the implementer returns, not just its report?
