# Home pane — mockup notes

Interactive mockup for `t-gHuA16z99o3m` ("Bryan can open a task and see what is
being asked of him without reconstructing it"). Static HTML, synthetic data,
nothing wired to the server.

**Open `index.html` in a browser.** One file, no external requests, no build —
though every check below was run over a local http server, not over `file://`.
`_frame.html` is the 430px harness (Chrome will not make a window narrower than
~500px, so a phone viewport is only reachable inside a same-origin iframe);
`_frame.html#scale=0.86` shrinks the raster so the whole 932px screen fits in a
short window, while the page still lays out at a true 430×932.

## What is here

| Screen | Route | Screenshot |
|---|---|---|
| Home — catch up, then decide | `#/home` | `01-home-430.png`, `06-home-desktop.jpg` |
| Walkthrough, decision item | Start review → item 1 | `02-walkthrough-decision-430.png` |
| Walkthrough, open-ended item | Start review → item 2 | `03-walkthrough-reply-430.png` |
| Task detail, where it lands | `#/task/threading` | `04-task-reply-landed-430.png` |
| Task detail, scrolled up | same | `05-task-comments-430.png` |
| Task detail, decision variant | `#/task/unread-marker` | `07-task-decision-desktop.jpg` |
| Board pane with review removed | `#/board` | `08-board-stub-desktop.jpg` |

Five review items, so the walkthrough is judgeable: three decisions with preset
options, one open-ended reply, one 15–30 minute read. It was 2/2/1 until a
writing pass pointed out that the pane-naming item was a binary choice with both
arms already costed in its prose — an AskUserQuestion payload typed as an essay,
and on a phone that makes the cheapest item the most expensive to answer. It is
options now. The one that stayed open-ended stayed because it genuinely is: 11
of the 14 replies are uncontroversial and the ask is what to do with the other 3,
which is not a two-way pick.

## The choices, and why

**Home is a reading column at 720px, not the board's 1280px.** Its content is
prose and a queue, both of which are unreadable at 1280. The board keeps its
own width.

**The summary clips at half a screen instead of scrolling inside its card.**
The ceiling is `44vh`, so whether it clips is a fact about the window rather
than about the text — which is why it can't be settled when the summary is
written. Measured at 146 words: at 430×932 it runs 536px against a 410px
ceiling, so on a phone the clip is the normal case rather than the edge case;
on a 1500×757 desktop window it runs 338px against 333px and clips by a hair,
and it needs a viewport about 769px tall to fit whole. An inner scrollbar would
hide its own overflow and let a 400-word summary sit there looking like 200. It
clips with a fade and a "Read the rest", and the ceiling exists so the review
queue stays above the fold — the queue is what he came for.

**Numbers are computed, sentences are written.** Every count in the summary —
how many decisions are blocking, how many quick items are left, how long the
read is, the word count — is read off the same `ITEMS` array the queue renders
from. It did not start that way, and the reason it is worth the code in a
mockup is that three of the review's five blocking findings were the same bug:
a number typed into the summary that the page underneath computed differently.
Deriving them makes the contradiction unrepresentable instead of fixed once.
The prose around the numbers stays hand-written — derive that too and the
summary becomes a template, which is the half of it worth keeping.

**One duration per item, rendered the same way everywhere.** `minutes: 20` feeds
the queue row's chip, the summary's "20 minutes" and the ask's "20 minutes".
Three hand-typed spellings of one duration ("about 20 minutes", "15–30 min",
"twenty minutes") were three chances to disagree, and they had already taken
two of them.

**The word count is on the card.** `146 words` next to "Mark read". It is the
one number that tells you whether the generator is behaving, and if it is not
visible nobody will ever notice it drifting to 400.

**"Tune this summary" is a standing-instructions textarea, not a settings
page.** The spec asks for "a way to test out how to improve this summary
process and iterate on it". The shortest honest version is: edit the
instructions, rewrite this summary, compare against the one it replaced. Keeping
the last four versions is what makes "compare" mean anything.

**The queue row leads with the ask, not the title.** Each row is
`kind badge · title · the ask's first sentence · who, how long, priority,
blocks-N`. The asks are written inverted-pyramid, so the first sentence is
already the summary of the summary and the row can take it mechanically.

**Both orderings are on the same screen.** "Start review" walks the agent's
ranking; the list under it is the same items, numbered, tappable at any point,
with an "Ordered by" select (agent's ranking / longest waiting / blocks the
most). Disagreeing with the ranking costs one tap, not a navigation.

**One ask component, two surfaces.** The walkthrough card and the bottom of the
task page render the *same* ask text with the *same* options and the *same*
reply box. The walkthrough is not a different question — it is the same
question without the scroll. That is what makes the walkthrough safe to skip.

**Decisions mirror AskUserQuestion.** Up-to-5-line markdown context, then each
option as a card: bold 1–3 word title on its own line, markdown underneath
saying what choosing it *costs*. Every option names its downside, because an
option list where only one has a cost is a recommendation wearing a choice's
clothes. "Something else" is always last and opens a free-text box.

**The open-ended task opens scrolled to the bottom.** Document order is title →
description → comments → ask → reply box. The page lands on the ask, so the
≤200-word statement of what you have to answer is the first thing on screen and
the reply box is directly under it. Scrolling *up* is how you get the
description and the comments — which is what the task asked for, and it also
means the reply box needs no sticky positioning to stay next to the ask.

**The landing line carries the task title.** `↑ <title> — full description and 4
comments above`. Landing 1,200px down means the title is a screen away, so the
one line at the landing point has to say which task you are in.

**Comments are one flat thread, Asana-style.** Avatar, author, `agent` / `you`
badge, timestamp on the right, hairline between each. No nesting. The comment
that contains the open ask gets a blue rail so scrolling up from the reply box
shows you where the question was actually made.

**"Original words" is the first comment, collapsed.** Not a banner at the top of
the task. It reads `▸ Original words — Bryan, Aug 14, 8:55 PM` and expands to
the verbatim text. Secondary and hidden by default, per your comment.

**The description is the doc.** Same editor chrome as `/review`: a presence bar
("You · Beacon editing · saved 4s ago") over an editable body. Full length, no
"Shortened here" note, no "Edit the task doc" link — there is nothing else to
open. In the mockup it is a `contenteditable`; in the product it would be the
real markdown editor on `task:<id>`.

**Skipping is honest.** Reaching the end of the walkthrough with items skipped
says "End of the queue — 4 answered, 1 skipped, still on Home, still waiting",
not "Queue clear". The count in the Home tab agrees with it.

**The Board pane keeps one banner.** `5 items need you. Decisions and the
catch-up summary live on Home now. [Go to Home]` — and nothing else about
status or decisions.

## Verified in a real browser

Chrome, against `http://127.0.0.1:8912`.

- **430×932 (a true 430px layout viewport, measured `innerWidth === 430`)** —
  Home, walkthrough on a decision item, walkthrough on an open-ended item, task
  detail landed, task detail scrolled to comments.
  `document.documentElement.scrollWidth` is 415 against a 430 viewport at every
  one, i.e. no horizontal overflow anywhere.
- **1440×829 desktop** — Home, task detail (decision), board stub.
- The open-ended ask **plus its reply box fits one 430×932 screen** with no
  scrolling (`03-walkthrough-reply-430.png`). That is the design's main claim
  and it is the thing worth disputing if the real asks run longer.
- **Every interactive element is ≥36px tall**, measured by walking every visible
  `button, select, summary, textarea, a` at 430px and listing anything under 36.
  The list is empty on Home, in the walkthrough and on a task page. Inline prose
  links needed vertical padding to get there — a short link in prose is a 39×20
  target otherwise, and "brief as possible inline links" is exactly what produces
  short ones. The footer link needed 10px rather than 9 because it sets a smaller
  font; that came out of re-running the walk, not out of reading the CSS.
- **The derive has a positive control**: splice an item out of `ITEMS`,
  re-render, and the summary moves from "Three more" to "Two more" while the
  header moves from "Needs you (5)" to "(4)" in the same pass — then splice it
  back and both return. Asserting the numbers are currently right would only
  prove they were typed correctly, which is exactly what was wrong before.
- The escaped `re: &lt;quoted line&gt;` in the threading ask renders as literal
  angle brackets, checked in a rendered browser view rather than by grep — an
  over-eager unescape there would make the browser swallow the phrase as an
  unknown tag and leave a clean-looking `re: ` with nothing after it. It is
  visible intact in `03-walkthrough-reply-430.png`.
- Flows exercised end to end: mark read → undo; re-sort the queue by longest
  waiting (order changes); walk all five items answering each; "Not now" on the
  read item; end-of-queue copy and the Home count agree (1 left, 1 row).
- Two bugs found and fixed during the pass: the walkthrough panel opened
  mid-card because it kept the previous card's scroll position, and it stayed
  on screen over the task page after "Open full task" because it is
  `position: fixed` and nothing closed it on a route change.

## What a second reader found, and what changed

The draft went to a reviewer briefed to read it as you — landing cold, on a
phone, wanting to answer and leave. Three of its findings were data errors I
could confirm in the file, and they mattered more than any of the prose:

- The summary said **4 items need you** while the tab badge, the queue header and
  the board banner all said 5. One scroll apart on a phone.
- **Every link in the "shipped overnight" paragraph pointed at an unrelated open
  task**, as did three links inside the asks. A link that lands somewhere other
  than what it names costs more trust than a missing link. Shipped items are
  plain text now, and the five remaining links each point at the item they name.
- **Three surfaces disagreed about what the unread-marker decision blocks** — the
  summary said the presence strip, the ask said the summary card and review-flow
  ordering, and the row said "blocks 2". It is the summary card and the presence
  strip, said the same way in all three places.

On the prose: the read item's ask led with "this one needs a real sitting, not a
tap" and buried the actual request (answer Atlas's four inline questions) in the
third bullet — which is what the queue row was quoting, so the highest-value item
had the least informative row. The flag decision's options were "Ship it" /
"Flag it", which do not contrast on the axis being chosen: flagging *is*
shipping, to this board. They are "All boards" / "This board only". Every ask now
also says what happens if you do nothing, and the two decisions where we have a
view say so ("we lean per account", "we lean all boards") instead of laying out
three costed options and going quiet.

## What I could not verify

- Real iPhone Safari. Everything above is Chrome at a 430px layout viewport.
  `100dvh`, the safe-area insets and iOS momentum scrolling inside the
  walkthrough panel are the three things most likely to differ.
- Whether real generated asks stay ≤200 words. Every ask here was written by
  hand to the budget. Nothing in the mockup proves a model will hit it — that
  is the acceptance criterion the real build needs a test for, and the word
  count on the card is the cheapest place to see it fail.

## Where the spec and the design pulled against each other

**"Half a screen at most" and "well-formatted markdown" fight on a phone.**
Six short paragraphs with bold leads is the right shape for skimming and it is
about 570px tall at 430px wide — more than half of 932. I kept the formatting
and clipped the overflow rather than compressing to one dense block. If you
would rather always see the whole thing, the summary has to drop to ~110 words
and lose either the "shipped" or the "slipped" section.

**"Ordered by task priority and by what is blocked on human feedback" is two
sort keys.** I made priority primary and used "blocks N tasks" as a visible tie-
breaker rather than folding both into one hidden score, so you can see why a row
is where it is. Open question below.

**"Link to a doc for a 15–30 minute review" does not fit in a modal.** The read
item gets a handoff card inside the walkthrough — doc name, time estimate, "Open
the doc" / "Not now" — rather than trying to render 1,900 words in the flow.

## Open questions for you

1. **Does the summary earn the top of the page every time?** Once you have read
   it, "Needs you" is 700px down on the phone. An alternative is queue-first
   with the summary collapsed to its lede — but that inverts "catch up first,
   then decide". I built it your way; say if the second visit of the day should
   look different from the first.
2. **What breaks the priority tie — priority or waiting time?** Right now a P1
   asked 5 hours ago outranks a P3 that has waited 2 days. The board's review
   strip sorts oldest-first inside a band precisely so the tail does not starve.
   Which do you want on Home?
3. **Should a skipped item drop down the queue, or hold its place?** Today it
   holds its place, so skipping the same thing three nights running shows it to
   you three times. Holding is right if skipping means "not now"; dropping is
   right if it means "not this".
4. **Is "Mark read" per device or per account?** It is item 1 in the mockup
   because I had to pick one to draw and the honest answer is that it is a real
   decision. Reading on the phone and then the desktop is the case that
   decides it. The mockup's ask leans per-account, which is also a claim about
   how these asks should be written — if you would rather they stayed neutral
   and just laid out the options, say so and I will take the leans out.
5. **How much of the walkthrough should the "read" item interrupt?** Right now a
   15–30 minute doc sits in the same queue as a 30-second decision, at rank 3.
   It could instead be lifted out into a separate "when you have twenty minutes"
   shelf so the walkthrough is only ever quick calls.
6. **Does the "Original words" comment need a marker on the collapsed row when
   the description has since been rewritten?** It is hidden by default now, which
   is what you asked for; the cost is that you cannot tell from the thread
   whether the current description still says what you said.
