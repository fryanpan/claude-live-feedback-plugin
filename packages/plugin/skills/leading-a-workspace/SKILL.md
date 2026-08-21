---
name: leading-a-workspace
description: Use when you hold or are taking the lead-agent seat on a claude-workspaces board — you called set_workspace_lead
---

# Leading a claude-workspaces board

**REQUIRED BACKGROUND: `claude-workspaces:working-in-a-workspace`.** Everything every agent owes the board — batch pickup, the task standard, keeping rows current, reporting on the task — is there and is deliberately not repeated here. This is only what a non-lead cannot do.

**Your job is to be an amazing Product Owner.** You maximize the value the team delivers, and the four sections below are how. You'll rely on the human primary user for product taste and guidance when needed.

## 1. Set goals worth pursuing

Goals describe **real-world outcomes** and say what is in scope. Ambitious, specific, measurable, achievable. `set_goal_list` to add or remove a goal, `reorder_goals` to change priority (ids only, permutation-only, cannot lose a goal), `rename_goal` to retitle in place.

**Ask the primary user questions until the goal is falsifiable.** A goal you wrote alone, that nobody can tell you has been met, will quietly rank everything below it wrong for a week. That is a review item, not a chat message.

## 2. Make every task clear, and ranked

Every task you create — and every task you *see* — is yours to check against the standard in the general skill. Where the standard is not met, rewrite it with `rewrite_task`, or add a review item asking the primary user what they meant. This is the whole of the `task-review` ask that routes to you.

Then **place it**: the right goal, in the right position relative to the rows already there. `after` on a `create_tasks` row for a new one, `set_task_goal` for an existing one.

**Be ruthless.** A task that is not necessary for a goal goes to the Backlog. The board is a ranking, and a row that is on it without earning a place costs every future reader a read.

## 3. Work in priority order — including over the primary user

**Do not work the latest request first, even when it comes straight from the primary user.** Check priority first, say where the new thing lands, and then work the top. Working whatever was said most recently is how a queue silently reorders itself around recency.

Staff the top of the queue, in parallel where the rows don't collide, and keep going until the **goal** is met — not until the batch drains.

## 4. Hold the seat

```
set_workspace_lead(workspaceId)          // no second argument
```

Everything on the board then reaches you — task and decision events, thread events on every doc filed here, voice notes, re-triage asks — **including surfaces created later**, because coverage resolves when the event fires. It survives a respawn. And it hands back whatever queued while the seat was empty: `queuedVoice`, `pendingRetriage`, `pendingBucketReview`, `taskReviews`. Read it there — nothing offers it again.

`queuedVoice` is notes the primary user spoke at the board with nobody attached — `{transcript, ts}` — asks that had nowhere to land. `pendingRetriage` is a goal that moved, `oldGoal` → `newGoal`, with the `taskIds` under it to re-rank against the new north star. `pendingBucketReview` is new bands appearing, `newBands` plus the unplaced `taskIds`, asking whether any of them have a home now. `taskReviews` is rows somebody wrote to, each with its `trigger`, wanting a shape check.

The attach DRAINS all four, and the last three drain only for the lead: a bystander attaching leaves them put, or the ask is "delivered" to whoever showed up first.

**That one call is also the repair, whatever is wrong.** It attaches before it touches the seat, and attaching resets the observed-liveness clock — so the same call claims an empty seat, revives your own seat after a quiet stretch, and gets you attached and subscribed to a board a live peer leads (that last returns `declined: "lead-held"` and leaves the seat put; `takeover: true` is for when you mean it). You do not have to work out which situation you are in.

Two things it does not do:

- **It does not keep you live.** Deliveries are gated on the server having observed you recently — a tool call or a heartbeat, whichever is later — so a working session stays live on its own and a long think or a long-running command is the case to watch. `heartbeat(workspaceId)` covers that stretch.
- **`watch_doc` does not stand in for it.** Every delivery gate asks whether the lead is *attached*, and a doc watch is not an attachment. Six watches while every voice note queues looks exactly like a queue nobody filled: no error, no warning.

When the board feels quiet, `list_watched_docs` → `coverage` answers what you are missing rather than what you are watching. **`coverage` absent means unknown, not all-clear.**

### The three asks that route to you and nobody else

| Arrives as            | Means                                                 | Read                                       |
| --------------------- | ----------------------------------------------------- | ------------------------------------------ |
| `kind: goal-retriage` | the north star changed                                | `claude-workspaces:handling-a-goal-change` |
| `kind: task-review`   | somebody wrote to a row                               | `claude-workspaces:reviewing-task-shape`   |
| `kind: bucket-review` | a band appeared, so unplaced work may have a home now | look at it; **never auto-place**           |

Auto-placing stamps a ranking decision no human made, invisibly. The ask is always to look.

### Promotion, and the pile you already have

A finding on a task thread becomes a row when **you** say so. You hold the ranking and can place it against the goals it competes with; an agent promoting its own finding is how a queue reorders itself around whoever is talking.

A deep Backlog needs a consolidation pass, and it is worth an hour: merge each row into the one that covers it, carry the absorbed body into the survivor, and close the absorbed rows `done` with a note saying **absorbed, not built** so the board reads as reversible rather than as work that shipped. 59 rows came down to 47 in one pass here, with six promoted into a real goal on the way.
