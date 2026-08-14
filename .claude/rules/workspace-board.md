# Working From a Live-Feedback Workspace Board

If this session is the lead agent on a live-feedback workspace, **the board is
your task list** — not the harness's todo tool, and not a plan in your head.
This rule is what an agent owes the board.

## Always work in priority order

Before you pick up anything, call `get_workspace(workspaceId)`. It returns the
goal list **in priority order** with per-goal counts — parent goals then their
subgoals, Chores last. The first row is the highest band.

Then call `next_tasks(workspaceId, {assignee: "<your name>"})`. It gives you
the queue already sorted by goal band → task order, already filtered to what
you can actually do (hard-blocked rows are omitted), each row carrying its
full description so you can pick it up without a second call.

**Take the top of that list.** Not the thing you were already holding, not the
thing that's easiest, not the next id in a list you built earlier in the
session. Bryan's ordering of the goals *is* the priority, and an agent working
a lower band while a higher one has open work is doing the wrong thing well.

Re-run `next_tasks` after every task you finish — priorities move while you
work, and a queue you read an hour ago is a queue about a board that no longer
exists.

You have latitude over the ordering itself: propose a reorder with
`set_goal_list` when the sequence is wrong, and say why. What you don't have
is latitude to ignore it silently.

## Parallelism: read the descriptions and judge

`next_tasks` returns each row's **full description**. That is enough to tell
whether two tasks touch the same code — read them and decide. Fan out on the
ones that don't collide; sequence the ones that do.

There is deliberately no field for this. A first cut added a `lane` label with
computed parallel batches, and it earned nothing: the judgment takes seconds
from the text, and a lane would have to be set at CREATION time — the moment
its author knows least about what the task will end up touching — so the
schema would have frozen a guess made at the worst possible moment and invited
you to trust it later. Dependencies are different: `after` is something
someone stated on purpose, so `blockedBy` is real data and you should respect
it.

If you find yourself unable to judge a collision from the descriptions, the
descriptions are too thin. Fix those, not the schema.

## Every task gets a description

Not schema-required — write one anyway, on every task. A bare title is not
pickup-able by an agent that wasn't in the conversation, and reconstructing
intent from a title is how the wrong thing gets built.

Shape: a compact user story, **`<persona> can <do x> so that <goal y>`**, one
persona only (Agent, Bryan, Collaborator). Add falsifiable "done when"
criteria for anything handed to someone else or parked beyond today. Work
you'll finish within the hour needs the story line and nothing more.

Put it in the task's `body`. **Do not create a separate doc to hold it** — the
description renders on the task itself, and a second artifact is one more
thing to open.

## Keep the board current as you go

- Transition to `in-progress` when you start, not when you report.
- `done` means **delivered**, not "committed on a branch". Work sitting in an
  unmerged PR stays `in-progress`, and the note says where it is. Marking it
  done because the code exists is exactly the reward-hacking this project
  asks reviewers not to do.
- Put the evidence in the transition `note` — the commit, the PR, what you
  verified and what you couldn't.
- File what you find as you find it. A defect discovered mid-task becomes its
  own task with its own story line, not a paragraph in a chat message.
- Leave comment threads **unresolved** unless asked — Bryan reads the
  discussion, and resolving hides it from the default Open tab.

## A workspace is a shared view — everything in it is available to everyone in it

This is the **default and the point of sharing**: everyone in a workspace has
the same view of its resources and the same shared understanding. Tasks,
descriptions, goals, threads, docs — if it is in the workspace, a member sees
it. Granular roles and permissions may arrive later; until they do, do not
design around a narrower default, and **do not ask whether some field should
be withheld from workspace members.** That question is settled (Bryan,
2026-08-13).

The one thing this does not cover is data that is not workspace content at
all — host-machine facts like a peer's local endpoint or filesystem paths.
Those stay out because they were never workspace resources, not because
members are untrusted.

## Chat is a symptom — put the work in the product

Every conversation in the terminal about how the work should go is a signal
that the product cannot yet carry that conversation. The reflex should be:
what would have to exist for this to have happened on the board instead?

And when an idea does arrive mid-stream, **triage it before you build it**.
The default failure — in this project and on most teams — is to work whatever
was said most recently, which quietly reorders the whole queue around
recency. File the idea, place it against the goals, and then look at what is
actually at the top. Often the honest answer is that the new idea is real and
still below the main flow, and saying so is the work.

Do not spend a session's capacity on an idea that has not been ranked against
the goals it competes with. If an idea is worth exploring but sits below the
top of the queue, spin off a subagent to research it — but only once the
higher-priority work is actually taken care of, not merely started. The point
is that the main flow keeps moving; a background researcher is fine, a
foreground detour is not.

## Don't route around the tools

Every board mutation goes through the MCP tools. No `curl` at the REST API, no
hand-editing data files. If a tool you need doesn't exist, that is a **blocker
to report and a task to file** — not a reason to reach for the layer beneath
it. A workspace built by curl looks identical to one built properly and proves
nothing about whether the product works.
