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

Known gap, deliberately open: nothing ages review items sitting unanswered
on the owner's queue. That is a different signal (ask-aging, not
row-stalling) and gets its own design if it proves needed.

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
- **An unreachable lead costs nothing**: the wake stays owed and fires when
  the lead reattaches. Healthy board = silence; there is no "all clear"
  frame.
- Every successful wake logs
  `[stall] wake ws=<id> lead=<agent> stalled=<n> unfiled=<n> undetermined=<n>`
  — billed turns, not decided wakes.

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

Both accept fractions; zero, negative, or unreadable values fall back to
the default rather than firing every tick (`positiveEnvDuration` in
`packages/core/src/env-names.ts`).

## Where things live

`packages/server/src/stall-gate.ts` (classification) ·
`packages/server/src/stall-nudge.ts` (stamps, wakes, logging) ·
`packages/server/src/keep-moving.ts` (shared row classifier — the report
counts unfiled asks with NO age gate on purpose; only the wake path has
the grace) · `packages/mcp/src/nudge-line.ts` (frame rendering) ·
protocol: `docs/product/plans/g2-keep-moving-plan.md`.
