# Server-side stall detection

**Goal:** every open ticket on every board is moving or names its blocker
where the owner can see and answer it — without the owner poking, and
without agents polling. The server watches; leads get woken only when there
is something to do.

Shipped 2026-08-27/28 across PRs #404 (detection loop), #405 (parked state
removed), #406 (20-minute threshold), #407 (board-level wake dedupe),
#409 (repeat-window knob), #411 (growth-only firing). This doc is the
summary; the design reasoning lives in the file headers of
`packages/server/src/stall-gate.ts` and `stall-nudge.ts`.

## What counts as a finding

The loop runs every 60s and sorts every open row into three lists, one
frame per board:

| List | Meaning | Gate |
|---|---|---|
| `stalled` | todo/in-progress, not dependency-blocked, no pending human review item, quiet ≥ threshold | 20 min quiet (`CW_STALL_NUDGE_MINUTES`) |
| `unfiled` | waiting on the owner but with NO review item on their queue — an ask that exists nowhere they read; a protocol violation | same 20-min quiet (#411) — a fresh ask gets a grace window for the lead to file it |
| `undetermined` | rows whose review data could not be read — the one thing that could have explained the silence | none; unreadable is always reported |

Deliberate exclusions: **triage** rows (unvetted work shouldn't nag),
rows with a **pending review item** (that's legitimately waiting on the
owner — their Home queue is the surface), and the **backlog** on boards
with goal bands. Boards without goal bands carry whole columns as
stall-eligible; structure the board to scope the watcher.

**Task notes count as movement.** A row's quiet time is measured from the
newest of: its status change, its last workspace event, its last thread
activity, and its newest note in `task.notes` — the end-of-turn message the
Stop hook posts, an explicit `post_status`, or a denial. Notes are read from
the row itself: `task.noted` is deliberately kept out of the workspace event
stream and the board trail, so a talking agent resets its own task's stall
clock without lighting up every board it is attached to. The board-level
ready-idle clock (`ready-nudge.ts`) ignores notes on purpose — that wake
exists to catch a session that keeps talking without moving anything.

Known gap, deliberately open: nothing ages review items sitting unanswered
on the owner's queue. That is a different signal (ask-aging, not
row-stalling) and gets its own design if it proves needed. The one kind of
review item the loop DOES age is the held one, below — an ask the reader
cannot see is not waiting on the reader.

**A held review item is a finding of its own.** Every filing path that can
put a row on the reader's queue passes a quality gate: a Haiku judge reads the board's
`reviewItemCriteria` (a natural-language prompt; `set_review_item_criteria`,
or `PUT /api/workspaces/:id/settings`) and the item, and answers
`{ok, reason}`. Not ok → the item is HELD: it stays on the ticket with the
reason, leaves the Home queue and the answerable count, and the filer is
told in the tool result and on the channel (`workspace.review_item_held`).
A judge that has no key, times out, errors, or answers unparseably PASSES
the item — the gate is a nudge toward better asks, never a door that
closes when the API does (`decisions.md`, 2026-08-29). Held state is
stored on the item (`judge: {at, verdict, reason}`) and the filer's agent id
beside it, store-only; the item is `pending` — off the queue, nothing on
the ticket — from the moment it is filed until the verdict lands, and a
`pending` still on disk at boot becomes `unavailable`. `stallSnapshot` lists the holds older than
`CW_HELD_ITEM_MINUTES` (default 5) as `held`; the nudger wakes the FILER
once per item per process (`filersTold`), and the frame to the lead carries
them as `heldItems` — a board with nothing else wrong still wakes on one.
Held rows enter the stall stamp under their ticket's id, so a later stall
or unfiled finding on the same ticket while it stays held re-wakes nothing:
one complaint per item, not per pass. Revising re-judges; a pass clears
the hold, keeps the original filing time, and forgets the filer stamp, so
a fresh hold on the same item is nudged afresh.

**Every filing path, not one of them.** The gate shipped applying only inside
`taskReviewItems`' branch, while `.claude/rules/workspaces-default.md` tells
the fleet to file asks with `create_thread(review=…)` / `post_reply(review=…)`
— so the documented path reached the queue with the judge called zero times
(measured 2026-08-29, both calls in one run). A gate the standard path
bypasses is worse than no gate, because it produces confidence it has not
earned. One implementation now serves all THREE surfaces (`runReviewGate` in
`server.ts`, with one adapter each for a ticket item, a comment-borne payload
and a ticket's own decision), so the order of operations, the failure policy
and the shape of a hold cannot drift apart:

| Filing path | Where the row lands | Judged? | How a hold is lifted |
|---|---|---|---|
| `add_review_item` → `POST /api/tasks/:id/review-items` | `task-review` | yes | `revise_review_item(taskId, reviewItemId)` |
| `create_tasks` / `POST …/tasks` with `review` | `task-review` | yes (batched, bounded concurrency) | same |
| `revise_review_item` ticket form | `task-review` | yes, on every revision | same |
| `create_thread(review)` → `POST /api/docs/:id/threads` | `task-thread` / `doc-thread` | yes | `revise_review_item(docId, threadId, commentId)` |
| `POST /api/docs/:id/threads/by_find` with `review` | `doc-thread` | yes | same |
| `post_reply(review)` → `…/threads/:id/comments` | `task-thread` / `doc-thread` | yes | same |
| `revise_review_item` doc form → `…/threads/:id/revise` | as above | yes, on every revision | same |
| `…/threads/:id/withdraw/undo` (reinstate) | as above | **exempt** — no new words | the hold placed on those words still stands, so a reinstated held item stays off the queue and is not announced |
| `…/review-items/:id/release` (the reader overruling) | `task-review` | **exempt by design** — see below | n/a |
| `create_tasks` / `POST …/tasks` with `needs: 'decision'` — the ticket that IS the ask (`r-legacy`) | `task-review` | yes | `revise_review_item(taskId)`, no item id |
| `rewrite_task` / `POST …/tasks/:id/body` / `…/title` on a decision row | `task-review` | yes, on every words edit | same |
| The allow-rule filer (`allow-rules.ts`, `store.addReviewItem` direct) | `task-review` | **exempt** — the words are the PRODUCT's, built by `buildAllowRuleReview` from a fixed template, and no agent authored them. Holding one would be the dead end this design forbids: the "filer" is the server, which cannot revise, and a held finding is a finding silently dropped | n/a |
| Meeting research capture (`meeting-task-capture.ts`, same door) | `task-review` | **exempt**, same reason — template text the assistant fills in, with no author to send it back to | n/a |
| An `unreplied` row (prose the server INFERRED asks a person) | thread rows | **exempt** — nobody declared it, so there are no authored words to judge; a held declaration's own comment is excluded from this band so a hold cannot leak back through it | n/a |

**The ticket that is itself the decision.** A `needs: 'decision'` row reaches
the queue through the row `legacyReviewItem` DERIVES at read time, whose id is
the fixed `r-legacy` — so it was the last path that put a row in front of the
reader with the judge never called (measured 2026-08-31: one `create_tasks`
decision row, zero judge calls, one queue row). It is gated now by the same
`runReviewGate`, through a third adapter, with two differences that both fall
out of the row having nothing of its own:

- **The verdict lives on the TASK** (`Task.decisionJudge`), because the item is
  rebuilt on every read and a stamp on it would vanish. `listReviewItems` hangs
  it back on the derived row, so `isReviewItemGated` — the one predicate the
  queue consults — is unchanged.
- **The version is `wordsRevisionOf`**, not a count of revisions, because the
  words being judged are the row's own title, body and options. Every door that
  writes those already moves that counter, which is what makes a verdict that
  outlived them refusable.

The same fact is why the hold is not a dead end and why lifting it needed no
new verb: revising the decision means rewriting the ticket's words, so
`revise_review_item(taskId=…)` — `reviewItemId` omitted, the shape
`answer_decision` has always taken for this row — delegates into
`reviseTaskDecision`, which writes through the ordinary title/body doors. The
`r-legacy` REST address delegates the same way, exactly as `answerTaskReview`
delegates it into `answerDecision`. And because those words have other writers,
`rewrite_task` and the board's inline title edit re-judge too: a filer who
fixed a held decision the obvious way would otherwise leave the stale hold
standing with nothing left that could clear it.

The item's verdict lives on `TaskReviewItem.judge` for a ticket item and on
`ReviewPayload.judge` for a comment-borne one — the payload IS the item there,
the same reason `revisions` lives on it. `reviewFromBody` strips `judge` from
anything a caller sends: it is written by the gate and restored from the CRDT,
and accepting it at the door would be a one-key bypass. Both surfaces' holds
are enumerated for the stall loop (`taskStore.heldReviewItems` +
`heldThreadReviewItems`), and the row, the filer's wake and the filing route's
result all carry the same paste-ready `revise_review_item(…)` call — three
copies of an address is how one of them ends up naming a verb that refuses.

**The reader can overrule the judge.** The held note on the ticket names
who filed the item and how long the hold has stood, and carries "Ask me
anyway" — `POST /api/tasks/:taskId/review-items/:itemId/release`, which
records an `ok` verdict naming the person and puts the item on the queue
the way any passed item reaches it. The gate is not disarmed by it: the
next revision goes past the judge like any other. Added after a UX review
found the note had no interactive element at all, so a reader looking at a
question they could answer in ten seconds could only wait for an agent.

It takes a ticket's own decision too (`r-legacy`), where the verdict lands on
the task instead of on an item. That row is worth releasing precisely because
the reader CAN see it: a held decision is still a ticket on the board, and the
held note renders on it.

Known limit: the release door does not reach a COMMENT-borne item. One can be
lifted by its filer revising it (and by the gate being turned off, which
releases it on the next revision), but there is no "ask me anyway" for the
reader — a held comment is not on the queue, so the reader has no surface to
press it from. Giving one means rendering held declarations in the doc, which
is a UI decision rather than a gate one.

A release can be issued while the judge is still out, and it wins. The
verdict a judge comes back with is refused unless the `pending` stamp it
placed before asking is still on the row: a release does not change the
item's words, so the version check alone would have let a late `held`
overwrite it and take the item off the queue seconds after the reader was
told it was on.

## Wake economics — the number that shaped everything

**A wake is not a notification; it is a lead session's whole turn** —
measured ~800k tokens, because a woken lead takes several turns to read,
act, and stand back down. Every design decision below exists to price
wakes correctly:

- **One frame per board**, never per row. The frame carries the full lists;
  the plugin renders the top rows plus "and N more". (Pre-0.1.116 bundles
  render a single task id — an updated plugin, then a session restart,
  fixes the rendering.)
- **A stamp per board dedupes wakes.** The stamp is the board's repeat
  bucket plus the sorted finding-row ids. Stamps persist to disk, so a
  server restart does not re-bill every board. (Any stamp FORMAT change
  re-bills each board exactly one wake on the first tick after deploy —
  expected, one-off, not a rate.)
- **Wakes fire on growth only** (#411): a new finding row, a bucket
  escalation, or a newly unreadable row. Never on shrink — before this, a
  lead FILING the ask changed the set and re-armed the wake, a
  self-sustaining loop measured at 6 wakes on one board in an evening,
  3 inside 5 minutes. A lead's response can only shrink the set, so the
  loop is now structurally impossible. Per-row bucket transitions also
  left the stamp: a lead's own dispatch moves a row's classification, and
  that must not read as growth.
- **The repeat window escalates a board that stays bad**: the oldest quiet
  row's silence, quantized by `CW_STALL_REPEAT_HOURS` (default 4h), so an
  unchanged board is re-said at most once per window. The default repeat
  floor across a 9-board fleet prices at roughly 43M tokens/day — the knob
  exists because that floor has to be tunable faster than a release.
- **An unreachable lead escalates, and only then costs nothing**: the wake
  goes to any other session holding a stream on that board, carrying
  `escalatedFrom: <lead>` so the stand-in knows why it was told. The frame
  says UNREACHABLE, never "gone": holding no stream is also what a
  reconnecting session looks like, and deciding a session is dead takes
  evidence over a window — that call belongs to `leadSeatHealth`, which is
  what the board's presence strip and the attach result read. With nobody
  at all attached the wake stays owed and fires when someone reattaches.
  Before this, the monitor addressed one identity it could not verify: a seat
  held by a session that had stopped listening turned every wake on that
  board into silence, and that silence read exactly like a healthy board (a
  lead respawned under a new name on 2026-08-29, and for four and a half
  hours nothing reached a live session). Healthy board = silence; there is
  no "all clear" frame.
- Every successful wake logs
  `[stall] wake ws=<id> lead=<agent> stalled=<n> unfiled=<n> undetermined=<n>`
  — billed turns, not decided wakes. `lead=` always names the SEAT HOLDER;
  an escalated wake adds `to=<agent>` for who actually got it.

## Field results (first night, 2026-08-28)

9 wakes across 4 boards. The stall class worked (a board woken for 2
genuinely stalled rows; next frame showed them cleared). The unfiled class
caught 2 real protocol violations (asks done-but-unfiled; both filed, both
answered same night) — and also exposed the shrink-loop and the missing
grace window that #411 fixed.

## Knobs

| Env (server launch) | Default | Meaning |
|---|---|---|
| `CW_STALL_NUDGE_MINUTES` | 20 | quiet time before a row is a finding |
| `CW_STALL_REPEAT_HOURS` | 4 | how often an unchanged bad board is re-said |
| `CW_HELD_ITEM_MINUTES` | 5 | how long a held review item may stand before its filer, then the lead, is told |
| `CW_REVIEW_GATE` | on | `0` turns the judge off; every item passes unjudged (also the state with no summary API key) |

Both accept fractions; zero, negative, or unreadable values fall back to
the default rather than firing every tick (`positiveEnvDuration` in
`packages/core/src/env-names.ts`).

## Where things live

`packages/server/src/stall-gate.ts` (classification) ·
`packages/server/src/stall-nudge.ts` (stamps, wakes, logging) ·
`packages/server/src/review-judge.ts` (the Haiku judge; prompt in
`packages/core/src/review-judge-prompt.ts`) ·
`packages/server/src/keep-moving.ts` (shared row classifier — the report
counts unfiled asks with NO age gate on purpose; only the wake path has
the grace) · `packages/mcp/src/nudge-line.ts` (frame rendering) ·
protocol: `docs/product/plans/g2-keep-moving-plan.md`.
