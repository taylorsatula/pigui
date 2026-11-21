# pi-pocket: assessment

Repo `TannerMidd/pi-pocket` v0.30.1, reviewed 2026-11-21 from a full clone at `/home/user/refs/pi-pocket`. Architecture
detail is in `05-pi-pocket-architecture.md`. This file covers history, issues, and the verdict. Its install and tests
were **not run**, because the session's auto-mode check blocked executing the repo's scripts.

## History and activity
- 2,776 commits between 2026-10-03 and 2026-11-21. About 2,440 are by one author (two names). The peak was
  1,075 in week 44, and the busiest days had 230 to 266 commits.
- 81 tags (v0.30.1 is current). There is a beta cadence for each minor release.
- Commit subjects read like an agent's work log: "Round log: third held-out set", "Merge fix round 1, part 1", and
  branches like `r028/b5-fix-s`.
- `AGENTS.md` is written for Pi editing pi-pocket from inside itself while it runs: "a syntax error blanks the screen
  for everyone, including you".
- The most-churned files are docs (`features.md` 400 edits, `map.md` 249), `web/style.css` (299) and
  `src/server/app.ts` (189).

## Issues and users
- 136 issues (118 closed, 18 open), opened by about 30 distinct accounts. There are 189 merged PRs and 11 open.
  Real outside users and contributors exist, and issues are answered and closed within days.
- Issue #222 (external contributor): pi-pocket added about 8.6k tokens of sections and tool schemas to every request
  before Pi's base prompt. After #224 and #225 that fell to about 4.7k. First requests in a full setup measured
  about 21k, then 16k after #224.
- Open issues are mostly feature requests (i18n, OIDC sign-in, remote runners, session goals). Recently closed bugs
  include:
  - #334: the SSE stream dies silently on iOS backgrounding.
  - #344: a 502 in one conversation stalls other sessions on the same model.
  - #345: withdrawing a held message during a send can still send it.
  - #265: an EACCES in `readdirSync` crashed the server.

## Scope
- The design-system toolchain is about 42k lines across `src` and `web`: Figma `.fig` scans, PPTX, design lint,
  docsite. That is larger than the core harness.
- Other peripheral subsystems: relay connectors (about 7k), galleries (about 7k), PiP (about 5k), built-in
  Chromium browser (about 5k), self-update, launcher and tunnels, cache keeper, multiplayer roles and invites.
- Tests are about 91k lines in 258 files, roughly 1,950 cases. Many cover the design toolchain.

## Things worth borrowing
- The `ask` tool schema (`src/server/extensions/ask.ts`). It allows 1 to 4 questions, each with a 12-char header
  and 2 to 4 options, a "(Recommended)" first option, and free-text "Other". The prompt guidance is good: ask only
  when a decision changes the work, and batch questions.
- SSE projection with per-tab diffing, a reconnect cursor, back-pressure rules and a long-poll fallback
  (`src/server/room.ts`, `src/server/http/events.ts`). Also the iOS background fix from #334.
- Secret masking by value in tool output (`src/server/secrets.ts`).
- `SECURITY.md` as a model of stating plainly what is and isn't a boundary.

## Things to avoid
- **Waiting in memory.** `ask` and tool approvals wait on an in-memory promise (`extension-points.ts:63`,
  `host.ts:352-377`). After a restart the question is asked again. Subagents poll every 3 s
  (`subagents.ts:137`). There are zero `defineSignal` parks anywhere. Durable's park-on-signal is the right tool
  for "phone answers hours later".
- **One `PocketApp` class.** It is about 4,000 lines with about 135 methods and is imported by 53 modules.
  `web/style.css` is a single 22k-line file, and the web JS has no type checking.
- **Approval guard off by default.** Lancet Guard is a separate package, off by default, with a 109 MB classifier
  downloaded by hand. A fresh install has no gate.
- **Fragile coupling.** It imports other packages' internals (Lancet via jiti, Pi's skills and prompts copied
  in), and has five wrappers around `models.streamSimple`.

## Verdict
pi-pocket is not broken, and the coding loop itself is sound. It is Durable's own read, write, edit and bash tools
behind a mobile-tuned prompt, and it works once a provider is signed in. The problem is scope. It is a self-modifying
personal platform that has grown into a design studio, browser, marketplace and multiplayer chat. That growth adds
prompt weight to every request and makes the core hard to extract. It also skipped Durable's park and signal
mechanism, which is the feature an "ask, then run unattended" product most depends on. Use it as a source of
specific patterns, not as a base or a dependency.
