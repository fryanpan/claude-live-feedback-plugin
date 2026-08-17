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

This is the discipline. For the **tool shapes** — creating a workspace,
ordering goals, filing a task, triaging, transitions, decisions, the
lead-agent seat — read `live-feedback:running-a-workspace-hub`. Don't
reconstruct the API from the server source.

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

## A description is a measurement with a date on it

Every task body was written on some particular day and reads ever after in the
present tense, about a codebase that moves several times a day. So a row that
says "there is no route that does X" is telling you what somebody measured
then, not what is true now — five times in one week a task on this project
claimed something was missing that had already shipped, twice within hours of
the task being filed. Building against a premise that has moved usually
produces the wrong **size** of fix: a whole second path beside one that
already worked.

`next_tasks` gives you two things to read before you trust a description:

- **`bodyWrittenAt`** — when the description was last written. On every row.
- **`premise`** — present only when that description has stood still for over
  a day while people kept commenting on the task. Its `notes` carry those
  comments verbatim, which is where a previous reader recorded what they found
  when they reproduced it. Read them first; they have often already done the
  reproducing, and they routinely shrink the work.

`premise` is not a status and never appears on a done task — most rows
carrying it still have real work left. When you have established what is
actually true, **rewrite the description** with `update_task_body`, which
clears the notice. Keep what the body originally claimed and add the
correction with your name and the date: the original measurement is evidence
about when it was taken, not a mistake to erase.

None of this replaces reproducing before you build. It tells you where
somebody already did.

You have latitude over the ordering itself: propose a reorder with
`reorder_goals(workspaceId, order, parent?)` when the sequence is wrong, and
say why. It takes ids only — no titles — and it refuses any `order` that is
not exactly the goals already there, so it cannot lose one to a list you read
a while ago. To change a band's TITLE, use `rename_goal(workspaceId, goal,
title)` — it changes the title in place and cannot move a task. Reach for
`set_goal_list` only to add or remove a goal; it is a full replace keyed by
id, so reordering with it means restating every title, and renaming through
it by giving a band a new id is a removal plus an addition that strands
everything the band held. A removal that would strand work is now refused
until you name the id in `drop`. What you don't have is latitude to ignore
the ordering silently.

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

## Every task belongs to somebody

Omit `assignee` and the task is yours — the API records your own name. Pass
`'human'` for work only a person can do, or another identity to hand it over.
What it will not accept is the bare word `agent`: that names a category, and a
board where every row is owned by "agent" cannot answer who is doing what, or
give you your own queue from `next_tasks(assignee: <your name>)`.

The same rule holds when you hand a task over later: `assign_task` takes a
person, `'human'`, or an agent's name, and refuses the bare word too. A gate
that only guards creation can be walked back one hand-off at a time.

If a create comes back `assignee-required`, your session was launched without
`FEEDBACK_AGENT_NAME`. That is a launcher setting, read once at session start —
you cannot fix it from inside the session, so say so and pass an explicit
`assignee` meanwhile.

## One way to file work, and it takes a list

`create_tasks` is the create verb. It always takes a list, and **one idea is a
one-row list** — so there is never a moment where you have to decide which of
two tools to reach for. Filing 24 things one at a time measured 78s against 13s
for the same rows in one call, and that gap is a tooling choice rather than a
floor.

Every rule above still applies per row — omit `assignee` and that row is yours,
give it a `goal` and it lands there instead of in Chores. It returns the created
tasks **in board order**, so you see the ranking you just produced without a
second read.

A bad row never rejects the batch: it comes back in `failures` by index, its
neighbours are created, and you re-send that one row. So don't hold ideas back
waiting until you're sure of all of them — capture the burst, then fix the row
the API argued with.

(The single-row form this replaced is gone as of 0.1.41. A session running an
older bundle still has it — its own copy, calling the same REST route — and
keeps working until it restarts, at which point it gets `create_tasks`
instead.)

### A row can depend on another row of the same batch

Give a row a `key`, and a later row can name it in `after` / `afterEnforce`:

```
create_tasks(workspaceId, tasks: [
  { title: "Rebuild the index", goal: "g-index", key: "reindex" },
  { title: "Flip the read path", goal: "g-index", after: ["#reindex"] },
  { title: "Delete the old path", goal: "g-index", after: [0, 1] },
])
```

`"#<key>"` names a row by its key; a bare number (or `"#0"`) names it by index.
Anything without the `#` is still a task id you already hold. Three rules, all
of them refusals rather than silent drops, because an `after` edge that resolves
to nothing does not error — it just never blocks:

- **Backwards only.** Rows are created in order, so a row can only depend on a
  row above it. Reorder the batch rather than pointing forward.
- **If the row you depend on failed, you fail too.** A task created with its
  dependency quietly missing looks unblocked and nothing ever says otherwise.
- **Keys are unique in the batch, and can't be all digits or start with `#`.**

### An unplaced task says so, and hands you the bands

A create with no `goal` comes back with `placed: false` and `goals` — the
ordered bands, so the next call is `set_task_goal` rather than a `get_workspace`
first. (In a batch it's one `placement` block for the whole call, naming the
unplaced ids.) Don't let it sit: you are the party that still knows why the task
exists, and placement is cheapest right now.

## Keep the board current as you go

- Transition to `in-progress` when you start, not when you report.
- `done` means **delivered**, not "committed on a branch". Work sitting in an
  unmerged PR stays `in-progress`, and the note says where it is. Marking it
  done because the code exists is reward-hacking your own board.
- Put the evidence in the transition `note` — the commit, the PR, what you
  verified and what you couldn't. If you dropped the `evidence` field or sent
  a sha you wrote from memory, `amend_evidence(taskId, evidence, note?)`
  attaches the right one to the move you already made; re-sending the
  transition just refuses.
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
