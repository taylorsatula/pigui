# Design decisions

Each entry says what was chosen, the alternatives considered, and why. Written for whoever maintains pigui next;
when a decision changes, change its entry. This file records the choices of the cleanroom reimplementation; behavior
is specified in [MANIFEST.md](MANIFEST.md).

## Architecture

**One process, one Harness, one SQLite storage; a session is a Durable conversation.** `startApp()` opens a single
Pi Durable Harness over `pigui.sqlite` and serves HTTP from the same process. Each session is an ownerless
conversation with its own working directory, model and compaction settings in its `pi.agent` document. *Alternatives:*
a Harness per session isolates sessions but breaks "one writable process per storage" as soon as anything looked
across them; a worker process per run rebuilds what Durable already does.

**The server runs its TypeScript directly** (Node ≥ 22.19, type stripping); no server build, no compiled JavaScript.
Erasable syntax only (`erasableSyntaxOnly`), imports name `.ts` files. *Alternative:* `tsc` to `dist/` — one more
artifact to forget to rebuild.

**Module boundaries.** `src/shared` holds every shape both sides use. `src/server/agent` is everything pigui adds to
Pi (tools, prompt, spend cap, handoff) and knows nothing of HTTP. `sessions.ts` owns the lifecycle and every action
the person takes; `supervisor.ts` owns what happens when a run ends; `delivery.ts` owns pushes, pull requests and the
diff; `notify.ts` and `webpush.ts` own notifications; `maintenance.ts` owns cleanup and backups; `http.ts` is only
the boundary. Each talks to the others through small typed interfaces.

**Names follow the domain** and stay consistent across server, client and tests.

## (further entries are added as the implementation proceeds)
