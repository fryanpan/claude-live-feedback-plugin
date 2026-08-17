---
name: handling-a-goal-change
description: Use when the north-star goal of a live-feedback workspace changes while you are working it — a "[triage.requested] goal changed" message arrives in your channel, attach_agent hands you a pendingRetriage, or you see workspace.goal_updated. Covers what the lead agent owes: re-read the goal, re-triage every open task, reorder priorities safely, flag what the new goal makes obsolete without destroying it, and report on the board.
---

# When the goal changes under you

A goal edit is the one event that invalidates work you have already judged.
Every open task on the board was placed against a sentence that no longer
describes what this workspace is for, and every queue you read — including the
one you are working from right now — is sorted by that stale sentence.

So the re-triage is not paperwork after the real work. Until it is done, you do
not know what the real work is.

This skill is the **contract**: what the lead agent owes when the goal changes.
For the tool shapes — `set_workspace_goal`, `set_task_goal`, `reorder_goals`,
the lead-agent seat — read `live-feedback:running-a-workspace-hub`. For the
ordinary work loop this interrupts, read
`live-feedback:working-a-workspace-board`.

## First, is it yours?

The re-triage request rides a channel **every attached agent hears**, so it
names its addressee:

- `[triage.requested] goal changed — re-triage N open task(s)…` — this is
  addressed to you. Act.
- `[triage.requested] FYI — … addressed to lead agent <name>. Act only if that
  is you.` — it is someone else's. Do not sweep the board behind them; two
  agents re-placing the same tasks against the same edit produces a board where
  neither placement is anybody's judgment.

A request that names **no** lead keeps the imperative on purpose: an empty seat
means the edit has no addressee at all, and an edit that reaches nobody has no
recovery path. If you are attached and nobody is named, it is yours.

## Take the payload out of the message before you do anything else

**A queued re-triage is delivered exactly once.** `attach_agent` drains
`pendingRetriage` as it hands it to you; nothing will ever offer it again.
(`get_workspace` shows it too, but reading there does not drain it.)

So the first action is to write `batchId` and `taskIds` somewhere that survives
you — your todo list, a scratch file, the note on the task you are holding. An
agent that receives the drain, gets compacted, and comes back with a summary
has silently eaten a person's goal edit, and the board will say it was
delivered.

## Re-read the goal — the whole goal

```
get_workspace(workspaceId)
→ { goal, goalUpdatedAt, leadAgentId, pendingRetriage?, goals: [ … ] }
```

`goal` is the full north-star statement. **Read it from here, not from the
event.** The channel line for a goal edit carries a 120-character clip and the
re-triage line carries no goal text at all — only a count. Re-triaging against
the first 120 characters of a paragraph is how the second half of an edit gets
ignored.

`goals` is the **ordered** goal list — priority order, parent goals followed by
their subgoals, Chores last, each with todo / in-progress / done counts. That
list is the vocabulary you are about to place tasks into, and its ids are what
`reorder_goals` needs. Read it in the same call.

## Re-triage every open task in the request

The request covers open tasks only — `done` stays where it is, and re-judging
delivered work is noise. For each id in `taskIds`, decide which of three things
is true:

**1. It still serves the same band.** Re-place it anyway:

```
set_task_goal(taskId, goal: "<the same goal id>", batchId: "<batchId>")
```

This is not a no-op. It restamps the task's `triagedAgainst` with the **new**
goal text and clears the triage-pending marker; with the same goal id and no
`position`, the task does not move and no `task.regrouped` fires, so
re-affirming is silent on the board. Skip it and the task's "Triaged against"
row keeps quoting the old goal, and the next reader — human or agent — cannot
tell *judged and kept* from *never looked at*.

**2. It belongs under a different goal now.** Move it, with a position:

```
set_task_goal(taskId, goal: "<new goal id>", position: 2.5, batchId: "<batchId>")
```

Positions are fractional, so there is always room between two tasks. Pick the
spot, not just the bucket — dropping five re-triaged tasks at the bottom of a
band is a placement decision you did not make.

**3. No band serves it any more.** That is the obsolete case — see below. It
still gets a placement and a `batchId`.

**Echo the `batchId` on every one of them.** It ties each placement to the edit
that asked for it, so the activity view reads N moves as one goal change rather
than N unexplained regroupings by an agent nobody asked.

**Done-when, and it is checkable:** `list_tasks(workspaceId)` returns
`triagedAgainst` per row. After the sweep, every open row's
`triagedAgainst.goal` equals the current `goal`. Any row still quoting the old
text is a task you missed.

## Reordering is part of it — and `set_goal_list` is not the tool

A new goal usually changes which band should be worked first. Order **is**
priority, so say it in the order:

```
reorder_goals(workspaceId, order: ["<id>", "<id>", …])          // top level
reorder_goals(workspaceId, order: ["<id>", "<id>"], parent: "<id>")  // subgoals
```

Permutation only: `order` must be exactly the ids already at that scope. It
creates nothing, renames nothing, moves no task, and **refuses** an order that
omits, repeats or invents an id — naming the offending ids so you re-read
instead of guessing.

`set_goal_list` is a full **replace**, and that is the whole hazard: any goal id
you leave out has its open tasks dumped at the bottom of Chores. Including a
goal another writer added since you last read the list — which is exactly the
case a goal change makes likely, because a goal edit is usually somebody
actively working on the board. So:

- To change priority: `reorder_goals`, always.
- To genuinely add / rename / remove a band: `set_goal_list`, with the ids read
  **immediately** before the call, and then re-place every id it reports in
  `movedToChores` rather than leaving them piled there.
- Adding or deleting bands is a change to the owner's structure, not a
  placement. If the new goal seems to need a band that does not exist, propose
  it on the board before you restructure it.

Note that a goal-list edit is not a north-star change: `workspace.goals_changed`
fires no re-triage. But tasks somebody else's `set_goal_list` dropped into
Chores have lost their band just as surely, and they deserve the same pass.

## Flagging what the new goal makes obsolete

This is the sentence that matters most in this skill, so it is the blunt one:

**You do not get to delete or close another party's task because the goal
changed.**

- There is no `delete_task`. That is deliberate, not an oversight.
- **Do not transition it to `done`.** `done` means delivered. Closing
  undelivered work to clear it out writes a false row into the audit trail, and
  the trail keeps both the close and the reopen — so the mistake is not
  erasable, and every "done" on the board gets a little less trustworthy.
- **Do not silently re-place it into Chores and move on.** Chores is where
  unbanded work lives, so the move itself is fine — it is the *silence* that
  turns a judgment into a disappearance.

What flagging actually is, concretely — all three parts:

1. **Place it in Chores** with the `batchId`, like any other re-triage move.
   The task stays on the board, in the queue, findable.
2. **Say why, on the task.** A task body is a live doc, so comment on it:

   ```
   create_thread(
     docId: "task:<taskId>",
     text: "Goal changed <date>. This was placed under <band> to serve "
         + "<old aim>; the new goal does not cover that. Parked in Chores "
         + "rather than closed — reopen it under a band, or say it can go.",
   )
   ```

   Omit `find` and the comment attaches to the task itself. **Leave it
   unresolved** — it is a question, and a resolved thread drops out of the
   default view.
3. **Escalate the batch, not each row.** If the edit obsoletes several tasks,
   file **one** decision task for the set — `assignee: 'human'`,
   `needs: 'decision'`, the question in one line, what is at stake, and options
   with what each costs (drop them; keep them parked; the goal list is missing
   a band). N comments is not an escalation; it is a pile.

Leave `assignee` and `status` alone throughout. A task another agent has
`in-progress` is somebody mid-flight — re-place it and comment, and let them
decide whether to stop. If the task is not yours and the judgment is not
obvious, `assign_task` it back to whoever filed it rather than ruling on it.

The asymmetry is the point: every action above is reversible by the person who
disagrees with it, and none of them loses the work. A goal edit is a statement
about priorities. It is not evidence that the person who filed the task was
wrong about the thing they knew and the goal text does not say.

## When it lands mid-task

The default instinct — finish this, then look — is wrong here often enough to
name. The task you are holding was chosen by the ranking that just changed.

1. **Finish the atomic step you are inside** (an edit half-applied, a commit
   half-made). Do not start the next one.
2. **Re-judge the task in your hands first**, against the new goal. It may be
   the one the edit obsoletes, and nearly-finished is not a reason to ship work
   the workspace no longer wants.
3. **Then do the sweep**, before picking up anything new. Picking the next task
   off a queue you have not re-triaged is picking against the old goal.
4. If you stop mid-flight, leave the task `in-progress` and put where the work
   sits — branch, PR, what is verified — in the transition note or a comment.
   `in-progress` with no note reads as an agent still working.

## Report on the board, not in chat

The mechanical part reports itself: the placements carry the `batchId` and the
activity view renders them as one goal change. What that cannot carry is your
reasoning, so put it where the work is:

- A comment on every task you **moved** or **flagged**, saying what changed and
  why — one or two lines, on `task:<taskId>`.
- Nothing on the ones you re-affirmed. The restamp is the record.
- The decision task, if the edit obsoleted a set.

Do not write the summary into the terminal and call it reported. A message in a
terminal exists only while somebody is watching that terminal; the person who
edited the goal is asking what it did to the board, and the board is where they
will look.

## What you do not owe

- **Re-triaging `done` tasks.** They are not in the request. Leave them.
- **A sweep on a display-only edit.** Changing just the goal's short summary
  line fires no event and no re-triage; nothing was re-aimed.
- **Rewriting task bodies** to use the new goal's vocabulary. Re-triage places
  work; it does not re-litigate how it was written. Fix a body only when the
  new goal makes its acceptance criteria actually wrong — and then say so on
  the task.
- **A stop.** Finishing the sweep is not a reason to hand the turn back. Re-run
  `next_tasks` — against the ordering you just corrected — and keep going.
