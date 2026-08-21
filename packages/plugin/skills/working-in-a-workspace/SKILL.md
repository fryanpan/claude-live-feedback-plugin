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
- Evidence goes in the transition `note` — the commit, the PR, what you verified and what you couldn't. `amend_evidence(taskId, evidence, note?)` fixes a move you already made; re-sending the transition refuses.
- Share progress on a task by writing brief comments (100 words or less) in the task when you start, when you hit a blocker, when a PR opens, and when it merges.

## Use Links Effectively

- Each resource (task, workspace, document, mockup, folder diff) has a unique identifier and URL.
- When you share links in a workspace, use relative URLs and make them inline using appropriate link text instead of the Raw URL
  - e.g. `[this link](/review/board-skill-one-row-per-pass?thread=nsk4yl4m6sqn)`
