---
name: pr-writing
description: Protocol for writing upstream pull requests — short titles and bodies in the project's own voice, one concern per PR, and nothing claimed in the body that was not directly verified. Use before creating any pull request, drafting PR text, or deciding PR scope. Produces PRs a stretched-thin maintainer can review in minutes and merge without edits.
---

# PR writing protocol

## What this skill produces

Pull requests that read like they were written by a long-time project contributor:

- A title that states the fix in one line, in the project's own commit-message style, with the issue reference.
- A body of 2-5 sentences: `Fixes #NNNN`, then what was broken (mechanism, not symptoms) and what the change does. Nothing else.
- One concern per PR, smallest diff that fixes the root cause, repo's own conventions for changelog/tests/style.

The reviewer is the audience, not a search engine and not a manager. Stretched-thin maintainers merge short, obvious, convention-matching PRs and stall on everything else.

## Non-negotiables

- No AI-flavored scaffolding: no `## Summary` / `## Changes` / `## Testing` headers, no checklists, no tables, no "This PR improves…", no marketing adjectives ("clean", "robust", "modern"), no restating the title in the body, no thanking anyone, no next-steps section.
- Never claim anything in the body that was not directly verified (test run, rendered output, cascade trace). If something is unverified, say what and why, or leave it out.
- No `Generated with`, agent attribution, or Co-Authored-By lines.
- One concern per PR. If a second bug was found while fixing the first, it gets its own branch/PR/issue — mention it to the user, do not fold it in.
- Do not open the PR until the user explicitly asks for it to be opened.

## Before writing any PR text — read the project first

Steal the project's voice; never bring your own template:

1. `git log --oneline -30` — copy the maintainer's commit-title grammar exactly (e.g. `Fix bug where … (#NNNN)`, `Component: Fix …`, conventional-commit prefixes). The PR title usually equals the commit title.
2. Read 3-5 recently merged PRs by the maintainer — note body length, structure, tone. The target is their median, not a formal spec.
3. Check the changelog (`CHANGELOG.md` or equivalent): if user-visible, add one line under the unreleased section in the file's established phrasing, with the issue number.
4. Find the repo's gates (CI config) and run locally what you can: style fixer, linter, static analysis, focused tests. A PR that fails CI costs the maintainer a round trip and costs you credibility.
5. Check how tests are written for the touched area and add a regression test if the repo's norms support it — the test asserts the fixed behavior, not the implementation.

## The PR body formula

```
Fixes #NNNN

<2-4 sentences: what the bug is (the mechanism, in file/symbol terms),
what this change does about it, and — only if non-obvious — one sentence
on why this approach over the alternative.>
```

Rules for the body:

- "What the bug is" = the causal mechanism (which rule wins, which check is missing, which unit was wrong), not a user complaint retelling.
- Name real files, functions, and symbols. No vague references ("the code", "some places").
- Numbers and measured outcomes are welcome when they exist ("label column 267px → 110px"); adjectives are not.
- Mention a rejected alternative only when a future reviewer would plausibly re-introduce it.
- A `Follow-ups` or `Notes` line is allowed for at most one item that the PR deliberately does not cover — a pre-existing adjacent defect, out of scope, found during review.

## Scope discipline

- Fix the root cause at the natural ownership boundary. Adjacent defects observed on the way are reported to the user, not absorbed.
- Smallest idiomatic diff. If a "nicer" redesign exists, it needs the maintainer's explicit appetite for it — leave it as a suggested alternative in the body, or as a separate proposal.
- Build artifacts: commit only what the project tracks. If generated files are build outputs (untracked in the repo), do not commit them — regenerate locally to verify, then keep only sources.

## Validation before opening

- Every claim in the body must be backed: run the focused tests, compile the assets, render the output, trace the cascade — whatever the change's nature requires.
- If the environment cannot run something (missing DB, browser harness), say so explicitly in the final report to the user and validate by static tracing; never let the PR body imply execution that did not happen.
- For risky changes (unit-contract changes, cascade/specificity work, anything with a wipe/data-loss flavor): request adversarial review before opening, verify its findings yourself before acting on them, and fix what it catches. A review that finds nothing wrong is information; a review that finds a CI-breaking test is the whole point.

## Mechanics

- One branch per PR off the upstream default branch, named after the fix (`fix-<issue>-<slug>`).
- Rebase/keep branches current with upstream; if the PR will be squash-merged, follow-up commits on the branch are fine and cleaner than amending pushed history.
- `Fixes #NNNN` in the body for auto-linking and close-on-merge.
- Announce/link PRs in the community thread only when the user asks.

## Good and bad

Good (real example shape):

```
Title: Fix bug where toolbar was hidden after resizing the window from small to normal/large mode (#9085)

Fixes #9085

Closing a popup menu in small-screen mode adds the `hidden` class to the menu
element (popup hide handler). When the window is then resized back to
normal/large, `screen_resize_small_none()` removes `popupmenu` but not
`hidden`, so the toolbar stays blank. Remove both classes.
```

Bad (every line of this is a rejection risk):

```
Title: 🎨 Fix UI issue with disappearing toolbar after window resize

## Summary
This PR comprehensively addresses a longstanding usability issue where the
toolbar would sometimes disappear. I've implemented a robust solution that
ensures the toolbar remains visible across all viewport transitions.

## Changes
- Updated ui.js with improved logic

## Testing
Manually verified the fix works as expected. ✅

🤖 Generated with [tool]
```

## Hand-off to other skills

- Commits on the PR branch follow the `git-workflow` skill.
- Investigation before any change follows the `plan-investigation` skill, where the project carries it; its "smallest idiomatic repair at the existing ownership boundary" rule is the scope contract for every PR written under this skill.
