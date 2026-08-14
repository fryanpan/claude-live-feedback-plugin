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
you can actually do (hard-blocked rows are omitted), each row carrying the
first line of its description so you can pick it up without a second call.

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

## Parallelism: `wave` says what MAY run together, not what is safe

Each queue row carries a `wave`. Rows sharing a wave have **no declared
conflict** — that is weaker than "independent", and the gap is where merge
conflicts come from. `after` models "don't start yet"; nothing in the model
ever said "these two rewrite the same file."

- `lane` is where you declare it. Set it on `create_task` whenever you can
  name the area a task rewrites (`hub-render`, `mcp`, `styles`,
  `server-routes`). Two tasks sharing a lane never enter the same wave.
- `laneDeclared: false` on a row means the queue had nothing to go on. Before
  fanning out across such rows, decide for yourself whether they collide — and
  if they do, set lanes so the next agent doesn't have to re-derive it.
- Fan out within a wave; finish a wave before starting the next.

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

## Don't route around the tools

Every board mutation goes through the MCP tools. No `curl` at the REST API, no
hand-editing data files. If a tool you need doesn't exist, that is a **blocker
to report and a task to file** — not a reason to reach for the layer beneath
it. A workspace built by curl looks identical to one built properly and proves
nothing about whether the product works.
