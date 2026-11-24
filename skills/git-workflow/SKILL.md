---
name: git-workflow
description: "Runbook for inspecting, staging, writing, validating, and committing Git changes, and for reporting the result. Load before every commit and whenever you draft or revise a commit message. Carries the authorization gate, path-scoped staging, the message schema with its four prose fields and trailer block, the absence-as-claim contract, the prose gate that catches session-local language, and the post-commit report shape."
---

# Git Workflow

## The reader you are writing for

An agent that runs `git show <hash>`, reads the tree, and holds none of your session. A human who reads one message and holds none of your session either.

Three channels, no overlap:

| Channel | Holds |
|---|---|
| Code and its comments | The mechanism as it stands, beside the behavior it causes |
| The diff | The transition, symbol by symbol |
| The commit message | What existed only while the session was open |

Never restate the diff in the message. Never restate a document the commit lands. Anything a reader can get from `git show` is dead weight in the message and gets cut.

## Authorization gate

Do not commit unless the user explicitly asked, in this session, for this change. A green test run, a finished edit, and a "looks good" are not authorization.

Read repository-local instructions before staging. Local rules override this skill when stricter. Where a repo's map mandates headers this skill retires, follow the map and say so in your report.

Never amend, rebase, reset, restore, clean, force-push, or discard work without separate explicit authorization for that operation.

## Sequence

### 1. Inspect

```bash
git status --short
```

Diff only paths whose contents are not already in your context:

```bash
git diff -- <unseen-paths>
```

Files you created or edited this session are already in context. Skip their diff and verify against what you know.

Separate the requested change from pre-existing and unrelated work. Pre-existing changes are not permission to include them. Resolve ambiguous scope with the user before staging.

### 2. Stage

```bash
git add <explicit paths>
git status --short
git diff --cached --check
git diff --cached --stat
```

Stage explicit paths. `git add .` and `git add -A` require explicit authorization for that operation.

Confirm the staged set contains exactly the intended paths. Check for credentials, tokens, host addresses, debug artifacts, generated files, unrelated edits, and accidental deletions.

One logical change per commit. Split independent concerns unless the user directed otherwise. A commit whose requirement will not compress to two sentences is two commits, or you do not yet understand the requirement well enough to ship it.

### 3. Write the message

Schema:

```
type(scope): the effect a person or operator observes

REQUIREMENT:
  <who asked, in their words, or the observed failure and its channel>

DECISIONS:
  <each call nothing forced, the alternative it beat, your confidence>

CONSTRAINTS:
  <directives to whoever modifies this next>

OPEN:
  <unverified surface and who accepted it; work noticed and not done>

Rejected: <alternative> | <why it failed here>
Deferred: <work noticed and not done> | <why it was left>
Fixes: <12+ char hash> ("<oneline subject>")
Related: <hash>, <hash>
Session: <harness> <session uuid> <host>
```

Write it with literal newlines in the `git commit -m` argument. No heredoc.

**Subject.** `type(scope):`, imperative mood, no trailing period, 72 characters or fewer. Types: `feat`, `fix`, `refactor`, `perf`, `security`, `docs`, `chore`, `style`, `revert`, `test`, `build`, `ci`. Scope is mandatory: the smallest stable area that owns the change, using the repository's canonical term so it is searchable. One scope per commit. Name the resulting behavior, not the editing action, and never "updates", "improvements", "cleanup", "misc", "minor", or "fixes". Include the triggering condition when it distinguishes the change. A reader scanning `git log --oneline` must be able to decide whether to open the commit.

`!` before the colon marks a breaking change and requires a `BREAKING-CHANGE:` trailer describing what callers, schemas, configuration, persisted data, or operations must change. Use the hyphenated form: `git interpret-trailers --parse` returns nothing for a key containing a space.

**Prose fields.** Four, in this order. Omit a field only when its absence is a true claim, per the contract below.

| Field | Write | Never write |
|---|---|---|
| `REQUIREMENT` | The requester by role or name and their ask in their words, or the failure observed and the channel it arrived through. Include the exact searchable observable: error string, probe id, log line, HTTP status. State the prior behavior in present tense, as if the diff did not exist yet | A restatement of the subject. A symptom without its mechanism. "Currently" |
| `DECISIONS` | Every place the requirement underdetermined the code, the alternative it beat, and your confidence in the call. Name a guess as a guess | The mechanism, which the diff carries. A design essay with no fork in it |
| `CONSTRAINTS` | Invariants that span files, modules, or the request lifecycle. Traps. What to check before narrowing or widening. Write as an instruction to the next modifier | Anything local to one function, which belongs in that function's comment. A description of what the code does |
| `OPEN` | What was not verified and why. Who accepted the gap. Work you noticed and deliberately left | A blanket claim of full verification. Silence where a gap exists |

**Trailers.** Machine-readable, last, preceded by a blank line. Keys are ASCII alphanumerics and hyphens only. Values may contain spaces and fold onto following lines that begin with whitespace.

| Trailer | Value |
|---|---|
| `Rejected:` | The alternative, then ` \| `, then why it failed in this codebase |
| `Deferred:` | Work noticed and not done, then ` \| `, then why it was left |
| `Fixes:` | At least 12 hash characters plus the oneline subject in quotes. One line, exempt from wrapping |
| `Related:` | Comma-separated hashes this commit chains to or depends on |
| `Session:` | Harness name, session UUID, host |
| `BREAKING-CHANGE:` | What must change downstream |

Get the session values from the environment at commit time:

```bash
echo "${PI_SESSION_ID:-$CLAUDE_CODE_SESSION_ID} $(hostname -s)"
```

If `CLAUDE_CODE_CHILD_SESSION=1`, you are in a nested harness and that variable names the child session. Prefer the id of the session that holds the reasoning.

**Where the value resolves.** The session UUID names a conversation that usually exists only on the author's machine, under the harness's local session store, and resolves against nothing shared. A project that runs a transcript archive can make the trailer resolvable for its own sessions; absent one, treat the trailer as a local pointer, useful for the author and meaningless to everyone else.

### 4. Absence as claim

Every omitted field and trailer is a falsifiable statement. Verify each before you commit.

| Omitted | Asserts |
|---|---|
| `REQUIREMENT` | The change is mechanical and the diff states it |
| `DECISIONS` | The implementation followed from the requirement with no room for choice |
| `CONSTRAINTS` | No future modifier needs to know anything before changing this |
| `OPEN` | Everything claimed was exercised and nothing was left undone on purpose |
| `Rejected:` | No fork was weighed worth recording |
| `Deferred:` | The commit is complete |
| `Fixes:` | The defect has no originating commit to point at |
| `Session:` | No session context is worth recovering, which is true of a mechanical change and of nothing that involved a decision |

If an assertion is false, write the field.

### 5. Prose gate

Name the reader before checking anything: someone holding the repository at this commit and none of the conversation. They can run `git show`, read the tree, and grep. They cannot load your session. They are reconstructing a moment they were not present for, usually while debugging something this commit caused. Every term whose key died with your session makes them redo work you already did, with less information than you had.

Run these three checks mechanically. You cannot inspect your own draft for them, because you still hold the context that makes it readable.

1. Every capitalized name, coined term, and project-local handle either appears in the repository or carries a clause defining it in place.
2. No definite article on a noun whose referent is not in the message. "The big merge", "the earlier attempt", "the second pass" fail. Name the thing or delete the reference.
3. Every pronoun resolves to a noun in the same message.

Then reject each shape on sight:

| Shape | Specimen | Fix |
|---|---|---|
| Session coinage, no key | "the metal-roof segment" | Decode it in place or delete it |
| Context-only referent | "per the handoff", "the big merge", "the usual pattern" | Put the referent on the page or drop the pointer |
| Unnamed actor | "it was rejected", "you asked to pull only the new directory" | Name who decided |
| Noun pile | "gates ready", "claiming a queue position" | Restore the verb and its object |
| Garden path | "neither reads code to synthesize them" | Restate until only one parse exists |
| Telegraphic rule | "traced on mechanism, suspected on trigger" | Full clauses with verbs; the reader must obey it, so they must not have to decode it |
| Ambiguous-polarity word | "sanctioned", which means both approved and penalized | Use a synonym with one sense |
| Inverted logic | "anything outside the out-of-scope list is reverted" | A correctness bug, not a style item; repair the polarity |
| Metaphor before definition | "below the surface", used three times, defined never | Gloss at first use; later uses inherit it |
| Unearned term of art | "the idempotency guard holds" | Carry its one-line decode in place |
| Compressed disjunction | "gets a rotation sample or a different instrument" | Collapse to the real option and flag the collapse |

Also reject: em dashes; `we`, `our`, `I`, and second person; session narration such as "we discovered", "during debugging", "as discussed"; unstable time references such as "today", "recently", "the earlier version"; line numbers as durable references; subjective claims like "cleaner" or "better" without a mechanism; attribution trailers that contradict the repository's disclosure policy.

Use paths, symbols, schema objects, configuration keys, and endpoint names as references. When you cite a prior decision, cite the exact commit hash, issue, ADR, migration, or version, and state which prior assumption became invalid.

Restraint: the bar is not plain style. Dense register is correct wherever the reader holds the key, and a repository's own vocabulary needs no gloss. What fails is text whose key existed only in the session that wrote it.

### 6. Length

Target 150 words of prose, ceiling 400. Past the ceiling the change is doing more than one thing; split it. Wrap prose at 72 columns. Trailer values are exempt from both the word ceiling and the wrap, so a parser can read them, and fold onto continuation lines indented by two spaces.

### 7. Commit and inspect

```bash
git commit -m '<message>'
git status --short
git show --stat --oneline --decorate --no-renames HEAD
git rev-parse --short HEAD
```

Confirm the commit contains only the intended paths and that unrelated work is untouched.

If a repository hook rejects the message, fix the message. Do not bypass the hook with `--no-verify` without explicit authorization.

## Report

Report, and nothing else:

- Commit hash and subject.
- The resulting behavior or the changed paths, in one or two lines.
- Where you deviated from a repository-local rule, and which rule.
- Remaining uncommitted changes.

No celebratory filler, no generic benefits, no invented next steps.

## Worked example

The message for the commit that produced this file. Read it for shape, register, and density, and for how confidence and absence are stated. Its facts belong to that change, so take the form and leave the content.

```
feat(git-workflow)!: carry only session knowledge in commit messages

REQUIREMENT:
Three operator instructions, in order. A commit message carries
what the code did not, meaning the back-and-forth lost when the session
closes, written for a reader who already has the whole diff in one tool
call. Replace this file wholesale, with runbook efficiency and no
sidebars, no freeform prose, and no record of rejected approaches,
because the model reads the skill immediately before committing. Embed
the resulting message as the file's worked example, since an example
carries register that rules cannot state. The file this replaces spends
11454 bytes and mandates the headers ROOT CAUSE, SOLUTION RATIONALE,
CHANGES, INSIGHT FROM THE SESSION THIS COMMIT WAS CREATED IN, and
PRESERVES.

DECISIONS:
Four prose fields and a trailer block, over a flat trailer vocabulary
for every field. Confidence: moderate. Bare enum values for confidence
and blast radius get written without thought, and no commit has
exercised the prose fields either.

Absence as claim rather than mandatory fields, so a short message stays
auditable. Confidence: high on the mechanism, unverified on writer
compliance, since a false assertion is caught only by a reader who
checks it.

Three mechanical prose checks rather than a general instruction to write
clearly. Confidence: high. An author who still holds the session's
context cannot detect the terms that only that context defines, so the
checks are byte-level and runnable.

Attribution left to each repository rather than decided here.
Confidence: high. The operator owns the policy call.

CONSTRAINTS:
The four field names and the trailer keys are the parsing contract. A
rename here breaks every commit-msg hook and every repository map
written against them, so change both in one commit.

A repository map at the project root mandates two of the retired
headers in its Git Workflow section and anti-pattern table. This skill
defers to repository maps and reports the deviation, so commits in that
repository keep the old headers until the map is edited.

No field can become mandatory without deleting its row from the table of
what each omission asserts, since a mandatory field's omission asserts
nothing.

OPEN:
No commit has been written in this schema and no hook enforces it. No
acceptance of that gap is recorded; the operator directed the
replacement without a verification step.

Whether a reader holding one of these messages plus a single git show
decides better than one holding a diff summary is unmeasured. No benefit
is claimed.

Rejected: keeping the five retired headers and adding fields | those names
  admit mechanism narration that the diff already carries
Rejected: a flat trailer vocabulary for every field | confidence and blast
  radius as bare enum values get filled in without thought
Deferred: aligning that repository map with the retired headers | the
  operator scoped this change to the skill file
Session: pi 01a18ead-6450-76cd-aee0-92e4b10c1577 workstation
BREAKING-CHANGE: commits written under ROOT CAUSE, SOLUTION RATIONALE,
  CHANGES, INSIGHT FROM THE SESSION THIS COMMIT WAS CREATED IN, or PRESERVES
  no longer satisfy the schema. Repository maps that mandate those headers
  must be edited, or their local precedence keeps producing them.
```

Second example, a runtime defect fix. It shows the observed-failure branch of `REQUIREMENT`, `Fixes:` in use, and the division of labor: the message carries the causal chain and the invariants, and the diff carries the signatures, the named tuple, and the call sites.

```
fix(segments): a failed first turn no longer strands the conversation

REQUIREMENT:
A segment is a span of conversation the system later summarizes, and its
boundary sentinel is a placeholder row written when the span opens. The
segment timeout service logged "no committed messages yet" three times
against a sentinel that had no messages, then tombstoned the segment.
The conversation was left with no active segment, so every later turn
failed to open one and memory extraction never ran. The trigger was the
proactive context-overflow check raising on the first message of a new
session, before the turn committed anything.

DECISIONS:
Defer sentinel persistence from request entry to commit time, over
guarding the entry write with a cleanup sweep. Confidence: high. A row
that cannot be written before its precondition holds needs no sweeper,
and a sweeper races the next turn.

Source the segment id from the request contextvar at commit time, over
threading a pending id through the persistence call stack. Confidence:
high. Both transports already set the contextvar at entry and it is
visible at commit, so threading would add a second channel for one value
read once.

Stamp the sentinel one microsecond before its first message, over
relying on insertion order. Confidence: moderate. The chronological
filters compare created_at, and insertion order is not queryable.

CONSTRAINTS:
Sentinel construction must stay inside save_messages_batch, which runs
only from uow.commit(). Moving it earlier reopens the orphan window this
closes.

The one-microsecond offset is load-bearing. Queries filter on created_at
greater than the sentinel's own created_at, so a sentinel stamped at or
after its first message hides that message from the segment it opens.

The contextvar holds nothing outside a request, so the sentinel helper
must keep allocating a fresh id when it reads none. Fixture loaders and
batch scripts run without request context and depend on that fallback.

OPEN:
Only the overflow-check path was reproduced. Every other failure between
request entry and commit produced the same orphan, and none were
enumerated.

Not exercised: a database rejection mid-batch, after the sentinel row is
written. That both writes share one transaction was read from the code
rather than forced to fail.

Rejected: sweep orphan sentinels on a timer | the sweep races the next
  turn, which can adopt the orphan as its own active segment
Rejected: thread a pending segment id through the persistence stack | six
  signatures carry one value that is read once, and the request contextvar
  already holds it at both entry points
Fixes: f7cc96759073 ("feat: replace topic-drift overflow remediation with
  live context compaction")
```
