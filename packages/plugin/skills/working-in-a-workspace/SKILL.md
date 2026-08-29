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
      4. Writing the ask
         1. The option label is the contract — the reviewer answers the label, not the reasoning under it. Plain words, phone-readable.
         2. The item has to be actionable on its own. The Home card renders the payload and nothing around it, so every link the reviewer needs goes in the payload's `detail` as an inline markdown link (`[the diff](/review/d-xxxx)`) — a link that lives only in the surrounding comment text never reaches the card, and the reviewer is left scrolling the comments for it.
      5. Anything the reviewer still owes an answer to is a filed review item BEFORE your turn ends — answerable where they read, with chat carrying at most a pointer to it. A "still waiting on you" list in chat is the failure mode this rule exists for: audited sessions filed 18 chat-only asks in a day, and 13 died unanswered.
3. Share status on the task's Activity tab, never in its comments. Your end-of-turn message reaches the tab by itself — the Stop hook posts it in full — and `post_status(text, taskId?)` adds a milestone worth naming: started, blocked on what, PR open, done. Comments are for asks (review items, decisions), replies to a person, and anything a person must read and answer.

### What a chat message is

Chat is a pointer surface, not a report surface. **A chat message is 50 words
or less** — unless the person just asked you a question, in which case answer
it properly.

Pick the rung that fits what you have:

| What you have | Where it goes |
|---|---|
| An outcome, a link, a one-line blocker | Chat, 50 words or less |
| Something that needs explaining, or a call you need them to make | A review item on the task it came from |
| Something you and they will both work on, back and forth | A doc — create it, then point to it in 50 words |

The cap is on the chat you produce, not on each message: five short narration
messages spend the same attention as one long one. Tool-by-tool progress does
not belong on any rung. Assume the person reading you is steering several
agents at once, so every line you send competes with the others — and no
other agent needs your progress either.

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

**Triage rows never appear here.** That is the answer to "I filed a task and my
queue does not show it": an agent filed it and nobody has vetted it, so it is
not yet agreed to be work — and it is also where a deliberately-deferred row
sits, since parking a task moves it there. Read those with
`list_tasks(status: "triage")`, and read the task's comments before picking one
up: that is where a park says why it was deferred and when to come back.

File a batch of rows in ONE `create_tasks` call rather than one call per row.
A bad row comes back in `failures` by index instead of rejecting the batch.

Your session needs an agent name before it can do anything on the board: a
create whose owner resolves to the bare word `agent`, a comment or reply
signed by the shared "agent" identity, and a lead-seat claim from it are all
refused with `author-required`, and that refusal means the session was
launched without `CW_AGENT_NAME` (set it, restart the session). Old comments
that were signed that way stay and show as "Unnamed agent". When you hand a row to somebody
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
  - Work you have decided to come back to LATER is `park_task(taskId, until, reason)` — the row moves to `triage` and the tool posts a comment saying when to come back and why, so the board stops treating it as work nobody got to. Write the `reason`, and give an `until` date whenever you have one: triage says a decision was made, and that comment is the only place that says what it was waiting for. There is no un-park — move the row on with `task_transition` when it is ready. Never move a row to `in-progress`, invent an `after` edge, or hand it to a person to quiet the ready-work nudge; all three make the board say something untrue.
  - Say what you did in the transition `note` — the PR, what you verified and what you couldn't. The note is the whole of what the trail keeps, so a move with an empty note is a move nobody can read back.
- Share progress on a task with `post_status` at each milestone — these are
  handover notes, shaped below. A status is movement to the stall clock; a
  comment is a question the person has to read.
- **Your final message is a pointer, not the report.** Post the full report with `post_status` FIRST — the harness drops final messages routinely, so the note on the task's Activity tab is the copy that survives — then point at the task. Three parts, 50 words or less all together:
  1. The outcome, in one line.
  2. The task's link (`?task=<taskId>` on the board URL), formatted for wherever the message lands (below).
  3. Any blocker, in one line.

### Handover notes

Builders die mid-task — some at spawn — and a replacement that restarts from
scratch re-reads everything and can redo finished work. The task's Activity
tab is the handover. At each milestone — worktree created, first commit, tests
green, PR open — and whenever you stop or are blocked, `post_status` three
parts, under 70 words:

1. DONE — what is finished and verified.
2. TRIED — approaches abandoned, and why, so nobody retries them.
3. WHERE — branch name, last commit hash, worktree path.

Picking up a task that already has notes? Read its Activity tab (`notes` on
the row) FIRST and resume from the newest handover instead of restarting.

## When You Are Blocked

A blockage is recorded on the board, never held in your head:

- Blocked on another row → an `after` edge (`set_task_dependencies`), so the
  queue stops offering the task and offers it again the moment the edge
  clears.
- Blocked on a decision or an answer → a review item on the task it blocks,
  naming exactly what is needed (see "ask for human help" above).

When nothing is ready and every blockage is filed, **end the turn and wait
to be woken**. Every resume source pushes — replies, new rows, cleared
edges — so never poll for work: a timed board re-read reloads your whole
context to learn nothing changed. "Never go dark" does not forbid being
idle; it forbids standing down with asks that exist only in chat, which the
filed items prevent.

## When Someone Comments on Your Review Item

A reader can select a phrase in one of your review items and ask about it,
as on a doc. The question arrives as a thread on the task — the channel
frame's `review_item_id` names the item — and the item leaves their queue
until you act, so an answer in chat leaves it stuck. Rewrite the item in
place with `revise_review_item(taskId, reviewItemId, headline?, detail?,
options?, reply?)`, passing only what changes; `reply` is your answer on
the thread, posted by the same call — do not also `post_reply` it, or the
thread carries your answer twice. Write the revision to stand alone: plain
English, no past context needed, why it matters, what each option costs.
The item returns to their queue marked Revised, their question quoted and
the changed span highlighted; the old words stay as history. Use
`post_reply` on its own only when the words need no change — a question
the item already answers.

## Use Links Effectively

- Each resource (task, workspace, document, mockup, folder diff) has a unique identifier and URL.
- When you share links in a workspace, use relative URLs and make them inline using appropriate link text instead of the Raw URL
  - e.g. `[this link](/review/board-skill-one-row-per-pass?thread=nsk4yl4m6sqn)`
- In terminal chat, send the absolute URL bare on its own line, with no markdown around it — autolinkers mangle a wrapped URL.
- Link the thing under review, not the workspace: hand over the `reviewUrl` / `entryUrl` the tool returned, rewriting only the host to the Tailscale name. Link the workspace only when the workspace itself is the subject.
- A workspace URL is not a durable address — the embedded workspace id dies when the workspace is recreated. Durable artifacts (committed docs, exports, anything sent onward) cite repo paths or GitHub URLs; live chat, thread replies, and hand-offs use the URL, because it is being clicked now.
