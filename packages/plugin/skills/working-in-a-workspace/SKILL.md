---
name: working-in-a-workspace
description: Use when this session is working from a claude-workspaces workspace — you have a workspaceId, you are calling next_tasks / task_transition, or someone told you "the board is your task list"
---

# Working in a claude-workspaces board

A workspace helps a team of humans and agents work together to deliver on goals.

## How to Work in a Workspace

The purpose of a workspace is to provide a significantly better agent and human interface than chatting in Claude Code.

1. The workspace is your plan, task list, and decision repository.
   1. If you are in a workspace, stop using harness' tools. Do not use `TaskCreate` / `TaskUpdate` / `TaskList` (formerly `TodoWrite`) and `EnterPlanMode` / `ExitPlanMode`. A task or plan in harness becomes invisible and confusing to workspace users.
2. The workspace is where you share status and ask for human help.
   1. DO NOT use regular chat messages to share progress or ask for a decision
   2. DO NOT use `AskUserQuestion`, create a review item instead
   3. Ask for human help
      1. Ways to ask for review
         1. `add_review_item(taskId, review)` adds a review item to a task as the last comment
         2. Use the `review` payload on `create_thread` or `post_reply`
      2. Payload Types
         1. `review_type: "decision"` offers 2–6 options to pick between
         2. `review_type: "question"` asks for a look and an answer in their own words
      3. Where the ask goes
         1. A question that arose mid-work belongs on the task that raised it — `add_review_item(taskId, review)`
         2. A decision that stands alone as a unit of work may be its own row
         3. Either way the ask carries the context of the work it came from. Ten decisions filed as ten fresh rows, each severed from the work behind it, read as a quiz instead of a plan
3. Share progress in the workspace on the most appropriate task or doc using comments

## Picking Up Work

`next_tasks(workspaceId)` is the queue, already filtered to what you can do.

**Take the whole ready set, not the top row.** Start every ready row that does
not collide with another; holding one task while the rest of the queue waits is
the slowest way to work a board. Each row carries its full description, and
whether two rows touch the same code is a judgment you make from that text —
there is no field for it. Call it again whenever a line of work finishes,
because priorities move while you work.

**Read `bodyWrittenAt` and `premise` before trusting a description.** A body is
a measurement taken on the day it was filed and rendered ever after in the
present tense, on a codebase that moves several times a day. `premise` appears
when a description has stood still for over a day while people kept commenting,
and carries those comments verbatim in `notes` — a previous reader may already
have reproduced the thing for you, and what they found routinely changes the
size of the work. It says nothing about whether the task is done. Clear it by
rewriting the body once you know what is true, dating and attributing the
correction and keeping what the row originally claimed.

**Check who is already on a row.** Two fields carry it: `ownerSession`, the
session behind the row's owner, and `claimedBy`, the session that last moved it
to in-progress. `claimedBy` is the one that exists on a row nobody assigned,
since a transition never touches `assignee` — read the owner instead and you
learn who FILED the ticket, not who is working it.

`state: "active"` on a session that is not you means DO NOT START THAT ROW.
Message that session over claude-hive, agree which of you has it, and take
something else if they do — starting it anyway is how two sessions each build a
complete answer to one task and neither finds out until a PR.
Nothing refuses a second taker, because two agents on one row is occasionally
right; it just has to be a decision rather than a collision neither side can
see. `away` is an
owner in name only and `unresponsive` is a wedged session somebody probably
should take over from. These are recency reads, never identity: a session that
thinks for an hour produces nothing and still holds its row.

**Skip a row carrying `parked`.** It is listed rather than hidden so you can see
the deferral and disagree with it, not so you can pick it up — nothing else
about the row says so, since parking is not a status. If the reason no longer
holds, un-park it and say why on the task.

**Triage rows never appear here.** That is the answer to "I filed a task and my
queue does not show it": an agent filed it and nobody has vetted it, so it is
not yet agreed to be work. Read those with `list_tasks(status: "triage")`.

File a batch of rows in ONE `create_tasks` call rather than one call per row.
A bad row comes back in `failures` by index instead of rejecting the batch.

Your session needs an agent name before it can own anything: a create whose
owner resolves to the bare word `agent` is refused, and that refusal means the
session was launched without `CW_AGENT_NAME`. When you hand a row to somebody
else by name, pass `assigneeKind` — nothing can tell a person from an agent of
the same name, and an unclassified owner shows as "not recorded".

## Writing Clear Tasks

Someone who was not in the conversation should be able to see a task, know why it's valuable, and go do the task efficiently and deliver on the problem statement.

- **Title —** `<persona> can <do x> so that <goal y>`**.**
  - Must be easy to quickly scan and know what outcome will happen
  - One persona (Agent, Bryan, Collaborator)
  - 20 words or less so it fits in all screens on mobile and desktop
- **Task Description**
  - Keep the whole description under 250 words
  - Use the clearest presentation in markdown, tables, diagrams
  - Start with a **Problem Statement** that describes outcome and why it's valuable
  - Then have **Acceptance Criteria** in a numbered list (good for workflow steps) or bullet points. The criteria should be specific and falsifiable.
  - The problem should tie to the top level goal the task is assigned to
- **Ask Questions**
  - If you can't write a clear task, write what you can and then ask the primary user questions using `add_review_item(taskId, review)`

## Keep the Lead and Primary User Up to Date

- Update task status as you work
  - `in-progress` when you **start**, not when you report.
  - `done` means **delivered** — all acceptance criteria are met
  - Work sitting in an unmerged PR stays `in-progress`
  - Work you have decided to come back to LATER is `park_task(taskId, until, reason)` — it stays `todo` and the board stops treating it as work nobody got to. Never move a row to `in-progress`, invent an `after` edge, or hand it to a person to quiet the ready-work nudge; all three make the board say something untrue.
- Evidence goes in the transition `note` — the commit, the PR, what you verified and what you couldn't. `amend_evidence(taskId, evidence, note?)` fixes a move you already made; re-sending the transition refuses.
  - **Record a commit that will still resolve after the work merges** — the one on the default branch, not the branch commit you are sitting on. A squash-merge replaces a branch's commits with one new commit and discards the originals, so a branch sha resolves for you today and for nobody afterwards while the row goes on reading as proven. Not merged yet? Record what you have and amend once it is.
- Share progress on a task by writing brief comments (100 words or less) in the task when you start, when you hit a blocker, when a PR opens, and when it merges.
- **Your final message is a pointer, not the report.** Post the full report as a task comment FIRST — the harness drops final messages routinely, so the board comment is the copy that survives — then write the message from the `threadUrl` that comment returns. Three parts, 150 words or less all together:
  1. The outcome, in one line.
  2. The `threadUrl` of the comment holding the full report, formatted for wherever the message lands (below).
  3. Any blocker, in one line.

## Use Links Effectively

- Each resource (task, workspace, document, mockup, folder diff) has a unique identifier and URL.
- When you share links in a workspace, use relative URLs and make them inline using appropriate link text instead of the Raw URL
  - e.g. `[this link](/review/board-skill-one-row-per-pass?thread=nsk4yl4m6sqn)`
- In terminal chat, send the absolute URL bare on its own line, with no markdown around it — autolinkers mangle a wrapped URL.
