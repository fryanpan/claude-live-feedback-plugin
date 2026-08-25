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
3. Share progress in the workspace on the most appropriate task or doc using comments

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
