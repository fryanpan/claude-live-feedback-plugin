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

**A held review item is a finding of its own.** Every `add_review_item` /
`revise_review_item` passes a quality gate: a Haiku judge reads the board's
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

**The reader can overrule the judge.** The held note on the ticket names
who filed the item and how long the hold has stood, and carries "Ask me
anyway" — `POST /api/tasks/:taskId/review-items/:itemId/release`, which
records an `ok` verdict naming the person and puts the item on the queue
the way any passed item reaches it. The gate is not disarmed by it: the
next revision goes past the judge like any other. Added after a UX review
found the note had no interactive element at all, so a reader looking at a
question they could answer in ten seconds could only wait for an agent.

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
  `escalatedFrom: <lead>` so the stand-in knows why it was told. With nobody
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
