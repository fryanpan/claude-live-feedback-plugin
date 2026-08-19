---
name: working-a-workspace-board
description: Use when this session is working from a claude-workspaces workspace — you have a workspaceId, you are calling next_tasks / task_transition, or someone told you "the board is your task list". Covers priority order, taking a whole batch in parallel by default, what actually forces a sequence, what a description owes the next agent, keeping the board current, and why finishing a task is not a reason to stop.
---

# Working a claude-workspaces workspace board

If this session is working a claude-workspaces workspace, **the board is your task
list** — not the harness's todo tool, and not a plan in your head. This applies
to whoever is working the board: a lead agent, a peer picking up one task, a
subagent handed a workspaceId. If you are touching the board at all, this is
the contract.

This is the discipline. For the **tool shapes** — creating a workspace,
ordering goals, filing a task, triaging, transitions, decisions, the
lead-agent seat — read `claude-workspaces:running-a-workspace-hub`. Don't
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

Re-run `next_tasks` whenever a line of work finishes — priorities move while
you work, and a queue you read an hour ago is a queue about a board that no
longer exists.

That ordering settles **what** you work on. **How much of it you take is the
next section, and the answer is never "one".**

You have latitude over the ordering itself: propose a reorder with
`reorder_goals(workspaceId, order, parent?)` when the sequence is wrong, and
say why. It takes ids only — no titles — and it refuses any `order` that is
not exactly the goals already there, so it cannot lose one to a list you read
a while ago. To change a band's TITLE, use `rename_goal(workspaceId, goal,
title)` — it changes the title in place and cannot move a task. Reach for
`set_goal_list` only to add or remove a goal; it is a full replace keyed by
id, so reordering with it means restating every title. A new band goes in
with no `id` — goal ids are generated and permanent, so you cannot choose one
and an id the board does not hold is refused. A removal that would strand
work is refused until you name the id in `drop`. What you don't have is latitude to ignore
the ordering silently.

## The unit of pickup is a batch, not a task

**Default: read the whole ready queue and start everything in it that can run
now.** Not the top row. One agent holding one task while eight others sit
ready is the slowest way to work a board — and it is what an agent does
unprompted, which is why this is a rule rather than an option.

The exception is narrow, and you have to be able to name it: take fewer than
the ready set when the rows you're dropping would **collide** with one you're
starting (below), and for no other reason. "Cleaner one at a time", "I'll see
how the first goes", and "the next one depends on what I learn here" are not
collisions. The last is a dependency — and if it is real it belongs in `after`,
where the queue can see it, not in your head.

**One `next_tasks` call is enough to plan the batch.** Every row carries:

- its **full description** — which is what tells you whether two tasks touch
  the same code. That judgement is made from the text. There is no
  parallelism field to look up, and there is not going to be one.
- **`blockedBy`**, each entry flagged `enforce`, and **`ready`**. An enforced
  open edge is a real stop somebody stated on purpose; an advisory `after`
  edge leaves `ready` true and is a hint about sequence, not a wall.

Then: group the ready rows by what they touch, start one line of work per
group, and move **every one of them to `in-progress` before you begin**, so
the board shows what is actually running. Give each line its own worktree and
its own runner — a subagent per line, working from the task body — so two
lines cannot overwrite each other's files. Priority still governs *within* the
batch: if you can only staff three lines, they are the top three, not the
three that look fun.

Each line still owes the project's full verification set before its PR — and
**look that set up, don't recite it**. Briefing several runners at once is
exactly when a check falls off the list from memory, and an omission made once
reaches every line in the batch at the same time.

### What actually forces a sequence

Four things — and it matters enormously which part of the work each one
sequences:

- **Two tasks editing the same file.** Genuinely serial, or split them so they
  aren't. Watch for the files everyone appends to (a long stylesheet, a
  registry, a barrel export): two branches that both append at the end
  conflict every time, so put a change in the section it belongs to instead of
  at the bottom.
- **A version or manifest bump every PR has to make.** Concurrent branches all
  move the same number, and the last to push is the one that's wrong. The fix
  is to re-read that number off `origin/main` immediately before each push —
  never to hold the other branches back. Eight PRs can be **developed at once
  and land one at a time**, each re-reading before it pushes; that is the
  normal shape, not a special case. A CI run that went green *before* a
  colliding merge landed is not evidence your number is still ahead.
- **Merges.** They land one at a time, in an order somebody chooses, each
  branch taking a fresh `main` merge before its final commit.
- **An open decision.** It gates the **forward transition** — the moment the
  work becomes real. It does not gate reading the code, reproducing the
  problem, writing the branch, or opening the PR. (A `yellow` or `red` risk
  tier belonged in this line until 2026-08-18; that gate is gone, and judging
  when a move needs a person is your own call again.)

Only the first is a reason to serialise the **work**. The next two sequence
the **merge**, and sequencing merges is entirely compatible with every branch
being written at the same time. The last gates a **transition**, which happens
after the work is already done. Getting this backwards — treating merge
contention as proof that the work can't overlap — is how a whole session ends
up serial with a good-sounding reason.

If you can't judge a collision from two descriptions, the descriptions are too
thin; fix those. (A first cut of this modelled parallelism as a `lane` field
with computed waves, and it earned nothing: a lane has to be set at CREATION
time, when its author knows least about what the task will end up touching, so
the schema would have frozen the worst-informed guess and invited you to trust
it later. Dependencies are different — `after` is something someone stated on
purpose, which is exactly why `blockedBy` is real data.)

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
actually true, **rewrite the description** with `rewrite_task`, which
clears the notice. Keep what the body originally claimed and add the
correction with your name and the date: the original measurement is evidence
about when it was taken, not a mistake to erase.

None of this replaces reproducing before you build. It tells you where
somebody already did.

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

## Present the work itself in context — the workspace is the primary surface

The rule above covers questions and reports. It covers **deliverables** too:
a mockup, a staging build, a redesigned page, a doc to look over. Present each
one where its feedback conversation lives — a reply on the task thread or doc
comment it answers, with the URL — not in chat. (Bryan, 2026-08-18, verbatim:
*"Chat is so weird and out of context — I'd like you to start showing me
review items tied to tasks or doc comments or wherever they are in context,
instead of making me figure it out from a funny chat screen."*)

Concretely:

- **Reply on the thread that asked.** If the work answers a comment, the URL
  goes in a `post_reply` on that thread. If nothing asked yet, open a subject
  thread on the task (`create_thread(docId="task:<taskId>", …)`).
- **Pass `review` when you are asking the owner to look or decide.** Both
  `create_thread` and `post_reply` take a `review` payload; that is what makes
  the reply a Review Item and puts it on the owner's Home queue with your
  blurb, instead of a comment they have to notice on their own.
- **A question about a TICKET hangs on the ticket**, with the same payload:
  `add_review_item(taskId, review)` — or `review` on a `create_tasks` row when
  you are filing both at once. A ticket carries **0..n review items and
  several can be open at the same time**, so the blurb goes on the item and
  never into the ticket title: the title names the work, `headline`/`why`
  name the ask. Answer with `answer_review_item(taskId, reviewItemId, text)`,
  ask back with `request_more_info`.
- **Chat gets at most a one-line pointer**, and only when the owner is already
  in the conversation. The artifact, the ask, and the link live on the board.
- URL formatting still applies: bare URL on its own line, no markdown
  wrapping.

## A report to a peer goes on the task too — the message is a link

The two rules above are about the owner, and that is exactly how the largest
source of noise slipped past them. Over one 38-hour window, **52,340 words —
40% of every word in the owner's chat window — were agent-to-agent reports.**
Ninety-nine of them. The two longest ran 3,079 and 4,392 words. **None was
addressed to him.**

Every one of those agents was following the rules as written and still did
this, because a report to a peer doesn't look like either case above. You
aren't asking the owner for feedback, and you aren't handing him a
deliverable — you are answering a coworker who asked you a direct question.
So the whole category reads as out of scope, and goes to chat by default.

It isn't out of scope, for a mechanical reason: **agent-to-agent messages
transit the person's window.** A message you address to a peer is a message
the owner scrolls past. He is paying the full cost of your report and is not
its reader.

So the same rule covers it. **Post the report on the task; send the peer the
link.**

- Post it where the work is: `post_reply` on the thread that asked you, or
  `create_thread(docId="task:<taskId>", …)` when the ask arrived some other
  way.
- **The response hands you the link back** — `url` on the `create_thread` /
  `post_reply` result, absolute and ready to paste. You do not have to
  assemble it, and you do not need to know the server's base URL. That field
  exists so the honest path is the cheap one.
- Then your message to the peer is one or two sentences and that link. The
  findings, the evidence, the gate output, the file list, the reasoning — all
  of it is already on the task, where the next agent to touch that task will
  find it. A report pasted into chat is read once and is gone.

Two things are genuinely messages rather than reports, and both are short by
nature: **a decision the peer must make before either of you can move**, and
**a blocker you need them to clear**. Neither needs 3,000 words. Everything
else — status, results, what you found, what you shipped, what took two
attempts — is a task comment with a link to it.

The test, when you are unsure: if what you are about to send another agent
runs longer than a short paragraph, it is a report. Post it, send the link.

## Finishing a task is not a reason to stop

When a line of work closes, **refill it**: re-run `next_tasks` and start
whatever is ready now. You don't wait for the rest of the batch to land
first, and "my batch is done" is not a stopping point either — a drained
batch is a reason to read the queue again, not to report. That is the whole
loop. **Yield the turn only for one of three things:** a decision that is
genuinely the owner's to make, a blocker you cannot route around, or an empty
queue.

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
