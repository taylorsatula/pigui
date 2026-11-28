# Starting a session

This describes how a session gets started in pigui: what the person sees, what each default is and why, and what
"continue a branch" actually does. `DECISIONS.md` records the choice in one paragraph. This is the longer version, for
anyone changing the page who needs to know what it is for before deciding what to touch.

## The problem it replaced

Before, starting a session meant answering questions in the wrong order. The first screen was a menu: two tiles (This
computer, Repository), then Starred, Pinned and Recent lists, each row with its own star or pin. Every row had already
decided whether the work would go on a new branch or continue an old one. Only after picking a row did a second screen
appear with a field to type in. So you had to say where the work would happen, and how it would branch, before you could
say what you wanted. That's backwards from how the decision actually gets made. You know the task first, and most of
the time where it goes is obvious.

The Claude Code iOS app is the model for the fix. It opens on a text field with the keyboard up. Where the work happens
is shown as chips above the field, already set, and you can change them but never have to.

## The shape

`/` is the New session page, and the page is the composer. It has a title bar with the Sessions button, empty space, and
at the bottom the field with its attach and send buttons. Between the empty space and the field sit two chips:

- **The repository chip** names the repository by its short name (`greeter`, with `demo/greeter` as its full label).
  On OnPrem it can instead read **This computer**, meaning the person's home directory.
- **The branch chip** reads **New branch**, or the name of the branch the session will continue. It only appears for a
  repository.

The field is focused on arrival, so on a phone the keyboard is already up. The common case takes no taps before
typing: the chips are already right, so you type the task and send.

Nothing is created until the first send. Opening the page, tapping chips and changing them makes no session, cuts no
branch and clones nothing. The typed draft is kept in the browser under the key `new`, so it survives a reload or
leaving and coming back.

## The defaults

The repository chip starts on where the newest session worked, counting only sessions that aren't archived. If that
session was on this computer (OnPrem only), the chip says This computer. If there are no such sessions, it falls back to
the last repository a session was created in, then on OnPrem to This computer. On a fresh server with none of that, the
chip reads **Choose a repository**. Sending in that state doesn't fail; it opens the Where sheet.

The branch chip starts on **New branch**, cut from the repository's default branch. The page doesn't need to know
the default branch's name: the server looks it up when the session is created. So rendering the page asks GitHub
nothing, and a slow or unreachable GitHub can't make the page slow.

The reasoning behind these defaults: the next session usually goes where the last one went, and new work usually gets
a new branch. Both are visible on the chips, so the default is never hidden. That's the difference from the
"zero-question default" an earlier design rejected for being invisible.

## The Where sheet

Tapping the repository chip opens a sheet from the bottom. Its sections:

1. **On this computer** (OnPrem only): This computer, `~`.
2. **Starred**: the starred repositories, alphabetical, each with its star filled.
3. **Repositories** (or **Other repositories** when there are starred ones): everything else `gh` lists, each with an
   empty star.

The current choice has a check mark. Tapping a star stars or unstars the repository in place, and the sheet stays open.
Starring is kept in the session index on the server, so a star made on the computer shows on the phone. A filter field
appears once there are eight or more rows. If GitHub's repository list fails, the sheet says why and still shows the
starred ones.

Choosing a repository closes the sheet, sets the repository chip, and resets the branch chip to New branch, because a
branch from one repository means nothing in another. Choosing This computer removes the branch chip.

## The Branch sheet

Tapping the branch chip opens a second sheet, with three sections:

1. **New branch**, with "from main" (or whatever the default branch is) underneath. This is the default.
2. **Continue a session's branch**: one row per branch that a non-archived session in this repository has worked on,
   newest first. Each row shows the branch name, then the session's title, how long ago it was active, and how many
   commits on that branch aren't on GitHub ("2 not pushed"), when there are any.
3. **Continue a branch on GitHub**: the repository's other branches as GitHub lists them, minus the default branch and
   minus any already shown in the section above.

As with Where, the current choice has a check, and a filter appears with eight or more rows. If GitHub's branch list
fails, the sheet says so and still shows New branch and the session branches, since those come from pigui's own
records and the clones on disk.

The unpushed count compares the session's clone against what that clone last knew about GitHub. It's exact for
anything pigui pushed itself. It can be stale if someone else pushed to the same branch from elsewhere.

## What continuing a branch means

There are two kinds of continue, and the difference is where the branch comes from.

**Continuing a branch on GitHub** works as it always has. The new session clones the branch from GitHub and works on
top of it. If a pull request is open for that branch, the session knows about it from the start, and a push updates it.

**Continuing a session's branch** takes the branch from that earlier session's clone on disk, not from GitHub. This
is the case for "I want a fresh session on the same unpushed work": a new conversation, without the old transcript,
picking up exactly where the code was left. The setup goes like this:

1. Clone the branch from the earlier session's clone. This brings every commit it has, pushed or not.
2. Point `origin` back at GitHub and fetch, so pushes go to GitHub and the commits already there read as pushed.
3. Take the base (what the work is compared with and merged into) from an open pull request for the branch if there is
   one, otherwise from the earlier session's base.

A few consequences are worth knowing.

- **Only commits travel.** Uncommitted changes in the earlier clone stay there, and so do its attachments. In
  practice Pi commits before it reports, so a finished session has nothing uncommitted.
- **The new session's diff is its own.** It starts counting from the commit it picked up. The carried commits don't
  show in its Changes sheet. A push still sends them, since they're on the branch.
- **Two sessions can now share a branch.** The earlier session isn't stopped or archived. If both push, the second one
  is refused because GitHub has commits it doesn't. The existing message for that case says to ask Pi to merge the
  remote branch and push again.
- **If the earlier clone is gone**, which happens when an archived, fully pushed session is cleaned up, the clone comes
  from GitHub instead. If GitHub doesn't have the branch either, setup fails with "Session N's clone was cleaned up and
  GitHub has no BRANCH, so there is nothing to continue". The session shows that, with a retry.
- **The server checks the pairing.** A request to continue branch X from session N is refused unless session N is in
  the same repository and works on X. A stale page can't graft one session's work onto another's branch.

## Where the choice lives

The chips' state is in the page address:

```
/?place=repo&repo=demo/greeter&mode=new
/?place=repo&repo=demo/greeter&mode=continue&branch=pi/add-shout-3&from=3
/?place=local&dir=~
```

The server renders the chips from the query, or from the defaults when there is no query. A choice in a sheet asks the
server for the chips for the new target (`/ui/target`), swaps them in, and updates the address without reloading. So a
reload keeps the choice, and an address can be bookmarked. A query that doesn't name a
valid target sends you back to `/`. The old `/start?…` addresses from the previous design redirect to `/` with the same
query.

When you send, the composer reads the target from the chips at that moment and creates the session with it, then goes
to the session's page.

## What moved and what went

- **Pinned sessions** are now at the top of the Sessions list, in their own group above Under way. Archived pinned
  sessions stay there, because archiving isn't unpinning. They used to be a section on the splash.
- **Starred repositories** are now the top section of the Where sheet. Starring itself is unchanged.
- **Recent** is gone. The Sessions list already sorts by when each session was last modified.
- **The tiles, the full-screen repository picker, and the separate blank start screen** are gone. Their jobs are done
  by the chips and the two sheets.
- **Starting a new branch from a branch other than the default** isn't offered in the UI anymore. The API still
  accepts `start.base`, and an address with `base=` still works. If it's needed regularly, it belongs as a row in the
  Branch sheet, not as a third chip.
- **OnPrem still has no directory choice.** This computer means `~`, as before.

## Where it lives in the code

- `src/server/ui/render/pages.ts`: `renderNewSessionPage`, `renderStartTarget` (the chips), `renderPlaceSheet`,
  `renderBranchSheet`, and the Pinned group in `renderPickerDialog`.
- `src/server/ui/routes.ts`: reading a target from the query, the defaults (`defaultStartTarget`), the session branches
  for a repository, and the `/ui/target`, `/ui/places` and `/ui/branches` fragments.
- `public/js/dialogs.js`: the sheet controller (`openStartSheet`), choosing a target, and the filter.
- `public/js/composer.js`: reading the target from the chips when sending, and opening Where when there is none.
- `src/server/sessions.ts`: resolving the base for a new branch, checking `from`, and cloning a continued branch from
  the earlier session's clone.
- `src/server/delivery.ts`: the unpushed count shown in the Branch sheet.
- Tests: `test/delivery.test.ts` (carrying unpushed commits, the refusal, the failure once nothing has the branch, the
  default base), `test/ui.test.ts` (the page, the fragments, the redirects, never calling GitHub on load, pinned
  first), `e2e/parity.spec.ts` (the whole flow on a 375 px screen), and `e2e/onprem-parity.spec.ts`.
