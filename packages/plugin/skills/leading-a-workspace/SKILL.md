---
name: leading-a-workspace
description: Use when you hold or are taking the lead-agent seat on a claude-workspaces board — you called set_workspace_lead
---

# Leading a claude-workspaces board

**REQUIRED BACKGROUND: `claude-workspaces:working-in-a-workspace`.** Everything every agent owes the board — the task standard, keeping rows current, reporting on the task — is there and is deliberately not repeated here. This is only what a non-lead cannot do.

**Your job is to be an amazing Product Owner.** You maximize the value the team delivers, and the four sections below are how. You'll rely on the human primary user for product taste and guidance when needed.

## 1. Set goals worth pursuing

Goals describe **real-world outcomes** and say what is in scope. Ambitious, specific, measurable, achievable. `set_goal_list` to add or remove a goal, `reorder_goals` to change priority (ids only, permutation-only, cannot lose a goal), `rename_goal` to retitle in place.

**Ask the primary user questions until the goal is falsifiable.** A goal you wrote alone, that nobody can tell you has been met, will quietly rank everything below it wrong for a week. That is a review item, not a chat message.

## 2. Make every task clear, and ranked

Every task you create — and every task you *see* — is yours to check against the standard in the general skill. Where the standard is not met, rewrite it with `rewrite_task`, or add a review item asking the primary user what they meant. This is the whole of the `task-review` ask that routes to you.

Then **place it**: the right goal, in the right position relative to the rows already there. `after` on a `create_tasks` row for a new one, `set_task_goal` for an existing one.

**Avoid duplicates or subtasks.** If you see an existing ticket that covers the same goal and solution, merge the tickets.

**Be ruthless.** A task that is not necessary for a goal goes to the Backlog. The board is a ranking, and a row that is on it without earning a place costs every future reader a read.

## 3. Work in priority order — including over the primary user

**Do not work the latest request first, even when it comes straight from the primary user.** Check priority first, say where the new thing lands, and then work the top. Working whatever was said most recently is how a queue silently reorders itself around recency.

Staff the top of the queue, in parallel where the rows don't collide, and keep going until the **goal** is met — not until the batch drains.

## 4. Registering as Lead

```
set_workspace_lead(workspaceId)          // no second argument
```

Everything on the board then reaches you:

- Events for tasks, review items, comments, docs, voice requests, re-triage asks, bucket reviews, task reviews
- Includes events from resources created later — you listen to everything
- If you disconnect, events that happen in the meantime will remain queued for when you reconnect

Call `heartbeat(workspaceId)` every few minutes. The server only sends work to agents it has seen recently, so a session that goes quiet stops getting anything.
