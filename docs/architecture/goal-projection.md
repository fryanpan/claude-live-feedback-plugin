# Goal projection — the bar, the remainder and the date

What a goal band prints: how far along it is, how much of Bryan's own
attention is left, and roughly when it lands. The arithmetic is
`packages/core/src/goal-effort.ts` — pure, in `core` rather than the server,
because the board recomputes it in the browser off rows it already holds.

This file is the **product rules**: the questions someone reading a date on
the board would ask, answered once. The mechanics, the priors and the reasons
for each design choice are in that module's own doc comments, which are long
and stay long; nothing here repeats them.

## The chain

```mermaid
flowchart LR
  E["Per-ticket estimate<br/>(Haiku, chunk 2)"] --> C["Calibration<br/>actual ÷ estimate"]
  C --> R["Corrected remainder"]
  P["Closes in the goal's<br/>active window"] --> PA["Pace<br/>estimate-seconds per day"]
  R --> D["Remainder ÷ pace<br/>= projected finish"]
  PA --> D
```

Estimates are on both sides of every fraction. A measured number is never
multiplied — a correction scales the forecast and nothing else.

## Pace is measured over the goal's own active window

The denominator is **the goal's age**, clamped to
`[EFFORT_MIN_PACE_WINDOW_DAYS, EFFORT_PACE_WINDOW_DAYS]` — one day to
fourteen. It used to be a flat fourteen days for every goal, which made the
divisor a fact about the calendar rather than about the goal: a goal three
days old with two closes was reported at `2/14` per day and looked becalmed,
while a goal running since spring read fast because only its last fortnight
counted. Same numerator, and the goal that had earned it in three days got
the smaller rate.

- **The goal's age is its oldest live ticket's `createdAt`.** The goal record
  itself never reaches the module — `summarizeGoalEffort` takes a list of
  tickets so the board can recompute client-side — and the oldest ticket
  filed under a band is the closest honest proxy. It errs the safe way: a
  goal cannot have been running before anything was filed under it, so the
  window can only come out too short, never too long.
- **The ceiling is fourteen days** because a rate learned from what a goal
  was doing two months ago is history, not a rate.
- **The floor is one day** because a goal whose first ticket was filed an
  hour ago would otherwise divide by 1/24 of a day and claim a pace
  twenty-four times anything it has demonstrated.
- **One window, both halves.** The same span decides which closes count and
  what the total is divided by. Deriving them separately is how a rate ends
  up measured over one period and divided by another.
- A band with **no timestamp anywhere** gets the full fourteen days, not the
  floor: nothing is known about its age, and one day is a claim about a young
  goal rather than a neutral answer.

The header sentence names the window it actually used — "on the last 3 days'
pace" — so the number on screen and the number in the arithmetic are the
same one.

## A close with no work behind it is not throughput

A ticket that went **straight to done** — closed without ever entering
`in-progress` — is excluded from **calibration, pace and the projection
floor** alike.

Nobody watched it being worked, so there is no wall-clock actual to learn a
correction from; that half was always excluded. The other two halves were
not, and that was the bug: closing five stale rows in one afternoon added
five closes and their whole estimate to the numerator of a rate that is
supposed to describe throughput, and the goal's projected finish jumped
forward on an afternoon of bookkeeping. Sweeping a backlog is not a
speed-up.

So the rule is one rule, in one direction: **an unobserved close teaches
nothing.** It still counts everywhere it is a plain fact rather than
evidence — the percentage bar moves, the remainder drops, `complete` can
become true. What it does not do is set a rate or unlock a date.

`EFFORT_MIN_CLOSES_FOR_PROJECTION` therefore counts **observed** closes: a
goal whose only three closes skipped `in-progress` gets no date, and the
header says so.

The one thing this does **not** narrow is hands-on calibration. Attention is
measured directly, off the reading time folded onto the row, and needs no
`in-progress` transition to be real: somebody read the ticket or they did
not. Only the wall-clock trail depends on the transition that a sweep skips.

## What a reader is owed

Every absence is a different sentence, and none of them is a zero.

| On screen | Means |
| --- | --- |
| no bar, "not scored yet" | Nothing under this goal has been scored |
| no bar, "scoring failed on N" | The scorer ran and produced nothing |
| `date after 3 closes` | Too little has closed to set a pace |
| `over a year out` | A pace exists; the remainder divides past the horizon |
| `done` | Every scored ticket in this goal is closed |
