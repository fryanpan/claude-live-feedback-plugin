---
name: working-a-workspace-board
description: Use when this session is working from a live-feedback workspace — you have a workspaceId, you are calling next_tasks / task_transition, or someone told you "the board is your task list". Covers priority order, fanning out in parallel, what a description owes the next agent, keeping the board current, and why finishing a task is not a reason to stop.
---

# Working a live-feedback workspace board

If this session is working a live-feedback workspace, **the board is your task
list** — not the harness's todo tool, and not a plan in your head. This applies
to whoever is working the board: a lead agent, a peer picking up one task, a
subagent handed a workspaceId. If you are touching the board at all, this is
the contract.

## Always work in priority order

Before you pick up anything, call `get_workspace(workspaceId)`. It returns the
goal list **in priority order** with per-goal counts — parent goals then their
subgoals, Chores last. The first row is the highest band.

Then call `next_tasks(workspaceId, {assignee: "<your name>"})`. It gives you
the queue already sorted by goal band → task order, already filtered to what
you can actually do (hard-blocked rows are omitted), each row carrying its
full description so you can pick it up without a second call.

**Work from the top of that list.** Not the thing you were already holding,
not the thing that's easiest, not the next id in a list you built earlier in
the session. The owner's ordering of the goals *is* the priority, and an agent
working a lower band while a higher one has open work is doing the wrong thing
well.

Re-run `next_tasks` after every task you finish — priorities move while you
work, and a queue you read an hour ago is a queue about a board that no longer
exists.

You have latitude over the ordering itself: propose a reorder with
`set_goal_list` when the sequence is wrong, and say why. What you don't have
is latitude to ignore it silently.

## Take the top *set*, not the top row

Don't read one row and start. Read the whole ready queue, decide **which tasks
are worth running at the same time**, and start all of them. One agent working
one task at a time is leaving the machine idle; the board exists so that
several things can be in flight without anyone losing track of them.

`next_tasks` returns each row's **full description**. That is enough to tell
whether two tasks touch the same code — read them and decide. Fan out on the
ones that don't collide; sequence the ones that do. Give each parallel line of
work its own worktree so they can't overwrite each other, and put every one of
them `in-progress` before you start, so the board shows what's actually
running.

There is deliberately no field for this. A first cut added a `lane` label with
computed parallel batches, and it earned nothing: the judgment takes seconds
from the text, and a lane would have to be set at CREATION time — the moment
its author knows least about what the task will end up touching — so the
schema would have frozen a guess made at the worst possible moment and invited
you to trust it later. Dependencies are different: `after` is something someone
stated on purpose, so `blockedBy` is real data and you should respect it.

If you find yourself unable to judge a collision from the descriptions, the
descriptions are too thin. Fix those, not the schema.

## Every task gets a description

Not schema-required — write one anyway, on every task. A bare title is not
pickup-able by an agent that wasn't in the conversation, and reconstructing
intent from a title is how the wrong thing gets built.

Shape: a compact user story, **`<persona> can <do x> so that <goal y>`**, one
persona only. Add falsifiable "done when" criteria for anything handed to
someone else or parked beyond today. Work you'll finish within the hour needs
the story line and nothing more.

Put it in the task's `body`. **Do not create a separate doc to hold it** — the
description renders on the task itself, and a second artifact is one more
thing to open.

## Keep the board current as you go

- Transition to `in-progress` when you start, not when you report.
- `done` means **delivered**, not "committed on a branch". Work sitting in an
  unmerged PR stays `in-progress`, and the note says where it is. Marking it
  done because the code exists is reward-hacking your own board.
- Put the evidence in the transition `note` — the commit, the PR, what you
  verified and what you couldn't.
- File what you find as you find it. A defect discovered mid-task becomes its
  own task with its own story line, not a paragraph in a chat message.
- Leave comment threads **unresolved** unless asked. The owner reads the
  discussion, and resolving hides it from the default Open tab.

## Ask for feedback on the task, not in chat

You will want to ask "does this work as expected?" or "anything here feel
clunky?" — ask it, but ask it **in a comment on the task**, where it sits next
to the work it's about and the owner answers on their own schedule. A question
in the terminal is a question that only exists while someone is watching the
terminal, and it costs them a round trip to answer.

Same for everything you'd otherwise report: what you found, what you deployed,
what took two attempts. Those are task comments. The board is the channel.

## Finishing a task is not a reason to stop

When a task closes, re-run `next_tasks` and start the next set of work.
That is the whole loop. **Yield the turn only for one of three things:** a
decision that is genuinely the owner's to make, a blocker you cannot route
around, or an empty queue.

"Empty" means empty of work worth doing now. A task someone deliberately
parked — "this can wait", a "done when" that depends on something that hasn't
happened, a row explicitly left for later — is not available work, and picking
it up because nothing else was left is how a session ends up doing the one
thing its owner said not to do yet. If everything remaining is parked, say so
and stop; that's a genuinely empty queue.

Everything else you might want to say is a comment on a task, not a stop.

This is written down because the default pull is the other way. A chat
assistant's instinct is: complete a unit of work → report → wait. On a board
that reflex fires after every single task and turns a queue into a
conversation.

Context compaction is the other trigger: coming back holding a summary rather
than a running thread makes reporting look like the safe move. It isn't.
Re-run `next_tasks` and pick up where the board says you are.

## Don't route around the tools

Every board mutation goes through the MCP tools. No `curl` at the REST API, no
hand-editing data files. If a tool you need doesn't exist, that is a **blocker
to report and a task to file** — not a reason to reach for the layer beneath
it. A workspace built by curl looks identical to one built properly and proves
nothing about whether the product works.
