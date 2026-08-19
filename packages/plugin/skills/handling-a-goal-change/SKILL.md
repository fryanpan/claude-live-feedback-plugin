---
name: handling-a-goal-change
description: Use when the north-star goal of a claude-workspaces workspace changes while you are working it — a "[triage.requested] goal changed" message arrives in your channel, attach_agent hands you a pendingRetriage, or you see workspace.goal_updated. Covers what the lead agent owes: re-read the goal, re-triage every open task, reorder priorities safely, flag what the new goal makes obsolete without destroying it, and report on the board.
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
`rename_goal`, the lead-agent seat — read
`claude-workspaces:running-a-workspace-hub`. For the
ordinary work loop this interrupts, read
`claude-workspaces:working-a-workspace-board`.

**Vocabulary, because the rest of this depends on it:** a workspace has one
north-star **goal** (a sentence or two of prose) and an ordered list of
**goals** you place tasks into — rows like "2.1 Delivery" with optional
subgoals. This skill calls a row a **band**, to keep it distinct from the
north-star text. A placement names one band. Chores is the reserved band for
work that serves no band.

## The order to do this in

1. Is the request yours? (below)
2. If you are mid-task, stop where you are — do not start anything new.
3. Get the task list out of the request, and save it.
4. Re-read the goal in full.
5. Re-place every open task, echoing the `batchId`.
6. Reorder the bands if the new goal changed which comes first.
7. Flag what the goal made obsolete — without closing it.
8. Report on the board, then go back to the queue.

## 1. Is it yours?

The re-triage request rides a channel **every attached agent hears**, so it
names its addressee:

- `[triage.requested] goal changed — re-triage N open task(s)…` — this is
  addressed to you. Act.
- `[triage.requested] FYI — … addressed to lead agent <name>. Act only if that
  is you.` — it is someone else's sweep. Do not re-place anyone else's tasks;
  two agents re-triaging the same edit produces a board where neither
  placement is anybody's judgment. You still owe yourself two things: re-read
  the goal (`get_workspace`), and re-judge the task in your own hands against
  it. The lead's sweep will fix the ordering; it cannot tell you to stop
  building something the new goal no longer wants.

A request that names **no** lead keeps the imperative on purpose: an empty seat
means the edit has no addressee at all, and an edit that reaches nobody has no
recovery path. If you are attached and nobody is named, it is yours.

## 2. If it lands mid-task, the sweep comes first

The default instinct — finish this, then look — is wrong here often enough to
name. The task you are holding was chosen by a ranking that just changed.

- **Finish the atomic step you are inside** (an edit half-applied, a commit
  half-made). Do not start the next one.
- **Re-judge the task in your hands first**, against the new goal. It may be
  the one the edit obsoletes, and nearly-finished is not a reason to ship work
  the workspace no longer wants.
- **Do not pick up anything new before the sweep.** Choosing off a queue you
  have not re-triaged is choosing against the old goal.
- If you stop mid-flight, leave the task `in-progress` and say where the work
  sits — branch, PR, what is verified — in a comment on `task:<taskId>`.
  `in-progress` with no note reads as an agent still working.

## 3. Get the task list out of the request — both paths carry it

Whichever way the request reached you, it names the tasks to re-place and the
sentence they were last judged against. Save `batchId`, `taskIds` **and
`oldGoal`** somewhere that survives you — your todo list, a scratch file, a
note on the task you are holding.

- **On your attach** (`attach_agent` returned `pendingRetriage`) they arrive as
  a payload: `{ batchId, oldGoal, newGoal, taskIds, contract }`.
- **Live in your channel** they arrive in the message: the count and `batchId`
  in the first line, then a `tasks:` line naming every id, then the previous
  goal in full.

Two reasons to write them down, both of which have burned somebody:

- **The request is delivered exactly once, on either path.** `attach_agent`
  drains the queued one as it hands it to you and nothing will ever offer it
  again. (`get_workspace` shows it too, but reading there does not drain it.)
  The live one is a channel message: it scrolls past and is not replayed. An
  agent that takes the delivery, gets compacted, and comes back holding a
  summary has silently eaten a person's goal edit — and the board will say it
  was delivered.
- **`oldGoal` is not recoverable from anywhere else.** It is the sentence every
  current placement was judged against, which is the input to "does this task
  still belong where it is". Once the message is behind you, `get_workspace`
  will only ever show you the new text.

**If the request reaches you with no `tasks:` line**, rebuild the set yourself
— an agent on an older plugin bundle gets the count-only wording, and peers sit
on different versions for days:

```
list_tasks(workspaceId)   → every row whose status is not "done"
```

That is exactly the filter the server counted with, so your set should be the
size the message named; if it is not, someone is editing the board while you
sweep — re-read rather than guess. Judging against the new text alone is the
fallback there, not the contract.

## 4. Re-read the goal — the whole goal

```
get_workspace(workspaceId)
→ { goal, goalUpdatedAt, leadAgentId, pendingRetriage?, goals: [ … ] }
```

`goal` is the full north-star statement. **Read it from here, not from the
event.** The `workspace.goal_updated` line carries a 120-character clip of the
new goal, and the re-triage line carries the *previous* goal, not the new one.
Re-triaging against the first 120 characters of a paragraph is how the second
half of an edit gets ignored.

`goals` is the **ordered** list of bands — priority order, parents followed by
their subgoals, each with todo / in-progress / done counts. That list is the
vocabulary you are about to place tasks into, and its ids are what
`reorder_goals` needs. Read it in the same call.

Two traps in that list:

- **Chores appears only when something is already in it.** Its id is the
  literal string `"chores"`, it is reserved, and it is not a row you can read
  out of `goals` on a board where nothing is parked. Do not conclude from its
  absence that you cannot park anything there.
- **Not every row is a band.** Each row carries `reorderable`. It is `false` on
  the rows the read *appends* rather than orders — Chores, and a goal id left
  behind on a done task by an earlier removal — and those look exactly like a
  band otherwise. They matter in step 6.

## 5. Re-place every open task

The sweep covers open tasks only — `done` stays where it is, and re-judging
delivered work is noise. For each id, decide which of three things is true:

**1. It still serves the same band.** Re-place it anyway:

```
set_task_goal(taskId, goal: "<the same band id>", batchId: "<batchId>")
```

This is not a no-op. It restamps the task's `triagedAgainst` with the **new**
goal text and clears the triage-pending marker; with the same band id and no
`position`, the task does not move and no `task.regrouped` fires, so
re-affirming is silent on the board. Skip it and the task's "Triaged against"
row keeps quoting the old goal, and the next reader — human or agent — cannot
tell *judged and kept* from *never looked at*.

**2. It belongs under a different band now.** Move it, with a position:

```
set_task_goal(taskId, goal: "<new band id>", position: 2.5, batchId: "<batchId>")
```

Positions are fractional, so there is always room between two tasks. Pick the
spot, not just the bucket — dropping five re-triaged tasks at the bottom of a
band is a placement decision you did not make.

**3. No band serves it any more.** That is the obsolete case — step 7. It still
gets a placement and a `batchId`.

**Echo the `batchId` on every one of them.** It ties each placement to the edit
that asked for it, so the activity view reads N moves as one goal change rather
than N unexplained regroupings by an agent nobody asked.

**Done-when, and it is checkable:** `list_tasks(workspaceId)` returns
`triagedAgainst` on every row. After the sweep, every open row's
`triagedAgainst.goal` equals the current `goal`. Any row still quoting the old
text is a task you missed.

## 6. Reorder with `reorder_goals`, never `set_goal_list`

A new goal usually changes which band should be worked first. Order **is**
priority, so say it in the order:

```
reorder_goals(workspaceId, order: ["<id>", "<id>", …])              // top level
reorder_goals(workspaceId, order: ["<id>", "<id>"], parent: "<id>")  // subgoals
```

Permutation only: `order` must be exactly the ids already at that scope. It
creates nothing, renames nothing, moves no task, and **refuses** an order that
omits, repeats or invents an id — naming the offending ids so you re-read
instead of guessing.

**Scope it as "every row at my scope whose `reorderable` is true", never
"every depth-0 row".** Chores and orphaned goal rows sit at depth 0, look
exactly like a band, and are not in the ordered list. That one filter is the
whole rule; send either kind back and you get a 400 that tells you which it
was — `chores` in `reservedIds` (a permanent bucket you drop from the order),
an orphaned id in `unknownIds` (the band really was removed).

`set_goal_list` is a full **replace** keyed by ID, and that is the whole hazard:
any band id you leave out is removed, and its open tasks land at the bottom of
Chores while its done tasks orphan onto an id that no longer exists. Including a
band another writer added since you last read the list — which is exactly the
case a goal change makes likely, because a goal edit usually means somebody is
on the board right now. So:

- To change priority: `reorder_goals`, always.
- To change a band's TITLE: `rename_goal(workspaceId, goal, title)`. It edits in
  place and cannot move a task. Renaming through `set_goal_list` by giving the
  band a new id is not a rename and no longer even lands — goal ids are
  generated and permanent, so an id the board does not hold is refused
  (`unknown-goal-id`).
- To genuinely add / remove a band: `set_goal_list`, with the ids read
  **immediately** before the call. A NEW band goes in with no `id` at all and
  the server mints one, returned in `created`. A removal that would strand work is now
  REFUSED (`would-strand-tasks`) until you name that id in `drop`, so read what
  the refusal says the band holds before you acknowledge it. Then re-place every
  id it reports in `movedToChores` rather than leaving them piled, and decide
  whether the `strandedDone` rows should be re-placed too.
- Adding or removing bands changes the owner's structure, not a placement. If
  the new goal seems to need a band that does not exist, ask for it as the
  decision task described in step 7 instead of restructuring the board.

A goal-list edit is not a north-star change and fires no re-triage of its own.
But if a `workspace.goals_changed` line in your channel reported N tasks moved
to Chores, those N have lost their band just as surely — sweep them too.

## 7. Flagging what the new goal makes obsolete

This is the sentence that matters most in this skill, so it is the blunt one:

**You do not get to delete or close another party's task because the goal
changed.**

- There is no `delete_task`. That is deliberate, not an oversight.
- **Do not transition it to `done`.** `done` means delivered. Closing
  undelivered work to clear it out writes a false row into the audit trail, and
  the trail keeps both the close and the reopen — so the mistake is not
  erasable, and every "done" on the board gets a little less trustworthy.
- **Do not silently re-place it into Chores and move on.** Chores is where
  unbanded work lives, so the move itself is right — it is the *silence* that
  turns a judgment into a disappearance.
- **Leave `assignee` and `status` alone.** A task another agent has
  `in-progress` is somebody mid-flight. Re-place it and comment; let them
  decide whether to stop.

What flagging actually is, concretely — all three parts:

1. **Park it in Chores**, with the `batchId`, like any other move:

   ```
   set_task_goal(taskId, goal: "chores", batchId: "<batchId>")
   ```

   `"chores"` is the literal id. It is reserved and never appears in the
   `goals` list, so pass the string — do not go looking for its row. The task
   stays on the board, in the queue, findable.

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

The asymmetry is the point: every action above is reversible by the person who
disagrees with it, and none of them loses the work. A goal edit is a statement
about priorities. It is not evidence that the person who filed the task was
wrong about the thing they knew and the goal text does not say.

## 8. Report on the board, not in chat

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

- **Re-triaging `done` tasks.** They are not in the sweep. Leave them.
- **A sweep on a display-only edit.** Changing just the goal's short summary
  line fires no event and no re-triage; nothing was re-aimed.
- **Rewriting task bodies** to use the new goal's vocabulary. Re-triage places
  work; it does not re-litigate how it was written. Fix a body only when the
  new goal makes its acceptance criteria actually wrong — and then say so on
  the task.
- **A stop.** Finishing the sweep is not a reason to hand the turn back. Re-run
  `next_tasks` — against the ordering you just corrected — and keep going.
