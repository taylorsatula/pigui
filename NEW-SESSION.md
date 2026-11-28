# Starting a session

## The idea

When you open pigui you already know what you want done. The only thing the app should ask is what that is. Where it
happens and on which branch are things the app can usually work out, so it should show its guess and get out of the
way.

## What it was like before

The old first screen was a menu. It had two tiles, then lists of starred repositories, pinned sessions and recent
branches. Every row had already decided whether the work went on a new branch or continued an old one. You had to read
the lists, work out which row meant what, and tap one, and only then did a screen appear where you could type.

So before you could say what you wanted, you had to make two decisions that usually didn't need making:

- **Where?** Nearly always the repository you were just in.
- **New branch or old one?** Nearly always a new one.

That is friction at the worst moment. The thought is fresh, you're on a phone, maybe one-handed or between other
things, and the app makes you sort through a list before you can get it down.

## What it is like now

You open the app and the text field is waiting with the keyboard up. Above it, two small chips say where the work will
go: the repository, and "New branch". They are almost always already right, so you type the task and send. Nothing to
scan, nothing to pick, and the second screen is gone.

When the guess is wrong, changing it is one tap on the chip and one tap on the right row. Because the chips stay
visible the whole time, you never send work somewhere you didn't mean to. The default is shown, not hidden.

## Why this is better

**The task comes first.** The page is built around saying what you want, which is the reason you opened it. Where and
how are settled on the side, without getting in the way.

**The common case costs nothing.** Most sessions start in the same place as the last one, on a fresh branch. That case
now takes zero decisions. The rare cases (another repository, continuing old work) take a tap or two, and only when you
need them.

**You can see what will happen.** The old screen had its decisions baked into rows you had to decode, such as
"continue X" versus "new branch from Y". Now the plan sits in plain words right above the field.

**One screen instead of two.** No menu leading to a blank page leading to the field. Opening the app and getting a
thought into it are the same step.

**It suits a phone.** One thumb, the keyboard already up, and choices tucked into sheets you can swipe away. Less
reading, fewer targets to hit, nothing to scroll past.

**Picking up old work is easier, not harder.** "Start a fresh session on the work I haven't pushed yet" used to be
buried, and it didn't actually carry the unpushed work over. Now it is a row in the branch list, showing which session
the branch came from and how much hasn't been pushed. A tap gives you a clean conversation with the code exactly where
you left it.

**Less to keep tidy.** Stars, pins and recent lists on the front page were upkeep that cluttered every visit. Pinned
sessions now live at the top of the session list, where you go to find a session anyway. Starred repositories sit
first in the repository list, where you go to choose one.

## What it gives up

You can no longer glance at the front page to see your favourites and recent work. That view now lives in the
Sessions list, one tap away. The front page is for starting work, not for browsing it.
