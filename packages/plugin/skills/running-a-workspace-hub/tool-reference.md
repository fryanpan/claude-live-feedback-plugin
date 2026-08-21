# Hub tool reference

The call shapes behind `claude-workspaces:running-a-workspace-hub`. The skill
file next to this one carries the judgment — which surface is which, how the
work loop runs, what a goal edit asks of the lead seat. This file is what you
open when you know what you want to do and need the argument list.

**What a task must SAY is not here.** The task standard — title shape, body
length, problem statement, acceptance criteria — is stated once, in
`claude-workspaces:working-in-a-workspace`, and every create and rewrite below
answers to it.

## Stand up the board

```
create_workspace(
  name: "search-revamp",              // required, short handle
)
→ { workspaceId, name, leadAgentId }
```

- **A board's goals are the ordered goal LIST**, written with `set_goal_list`
  below. There is no separate workspace-level goal statement.
- **You become the board's lead agent** unless you pass `leadAgentId`. The lead
  is the addressee for the board's triage asks.
- The call auto-subscribes this session to the workspace event channel
  (`task.*`, `decision.answered`, `triage.requested`,
  `workspace.goals_changed`, …), which arrives on the same channel as thread
  events. Pass `subscribe: false` to skip.
- **If you did not create the board, declare yourself on it** with
  `set_workspace_lead(workspaceId)` — see "The work loop" in the skill file.
  That is the whole of your session-start setup.

Then give it sections:

```
set_goal_list(workspaceId, goals: [
  { title: "Cut p95 latency",
    subgoals: [{ title: "Index shape" }] },
  { title: "Hold recall at parity", dueAt: 1767225600000 },
])
→ created: [{ id: "g-7Kf9xQ2mVbNc", title: "Cut p95 latency" }, …]
```

- **You do not name a goal's id — the server does.** Send an entry with NO
  `id` and an opaque one is minted and handed back in `created`; that is the
  only place you learn it, so keep it (or re-read `get_workspace`). To keep a
  band you already have, send its `id` exactly as `get_workspace` reports it.
  An id this board does not hold is **refused** with `unknown-goal-id`,
  because that is how a re-key arrives: nothing here can give an existing band
  a different id, and nothing here lets you choose one. The human-visible
  handle is the **title**, and that is editable — see `rename_goal` below.
- **Order IS priority.** The first goal is the highest band. To CHANGE that
  order, use `reorder_goals` (below) rather than this call — it fires the same
  `workspace.goals_changed` and it cannot lose a goal.
- One subgoal level, maximum. `dueAt` is epoch ms and optional at every
  level — never invent one.
- `"chores"` is **reserved**: it always renders last and must not appear in the
  list you pass. It is the one goal id you can say out loud — every other one
  you look up.
- **Destructive edge, now gated:** this is a full REPLACE, so any id you leave
  out is removed — including a goal another writer added since you last read.
  If a removed id still holds tasks the call is **refused** with
  `would-strand-tasks`, naming each band and how many open and done tasks it
  holds, and nothing is written. Removing a band that holds work is therefore
  a second, deliberate call that lists its id in `drop`; removing an empty one
  needs no ceremony. On success the result reports `movedToChores` (open tasks
  swept to the bottom of Backlog — re-place each with `set_task_goal` rather
  than leaving them piled) and `strandedDone` (done tasks still pointing at
  the removed id, which is what leaves a bare row in `get_workspace`).

### Rename a goal with `rename_goal`, not `set_goal_list`

```
rename_goal(workspaceId, goal: "latency", title: "Cut p95 latency to 200ms")
rename_goal(workspaceId, goal: "index",   title: "Index shape", dueAt: null)
```

- **The id never changes, so nothing moves.** A task's band IS its goal id.
- This is the reason the verb exists: `set_goal_list` is keyed by id, so
  giving a band a new id there is not a rename at all — it is a removal plus
  an addition, and it is refused outright (`unknown-goal-id`) because ids are
  generated and permanent. A title is the only part of a band anyone was ever
  really renaming, and `rename_goal` is where that belongs.
- `dueAt` is optional: a number sets it, `null` clears it, omitting it leaves
  it alone. `chores` is refused — its label is fixed.

### Change priority with `reorder_goals`, not `set_goal_list`

```
reorder_goals(workspaceId, order: ["recall", "latency"])
reorder_goals(workspaceId, order: ["shape", "index"], parent: "latency")
```

- **Permutation only.** `order` must be exactly the goal ids already at one
  scope — the top-level list, or the subgoals of `parent`. Ids, no titles.
- An order that omits, repeats or invents an id is **refused**, naming the
  offending ids. That refusal is the feature: a list that changed under you
  makes you re-read rather than silently dropping somebody's goal.
- Nothing is created, renamed, removed or reparented, and **no task moves** —
  the Backlog hazard above cannot happen here.
- Get the ids from `get_workspace`, whose rows carry `depth` and, on
  subgoals, `parent`. Each row also carries `reorderable`, which is `false` on
  the rows the read *appends* rather than orders — Backlog, and a goal id left
  behind on a done task by an earlier removal. Scope an order as "every row at
  my scope whose `reorderable` is true", never "every depth-0 row".

## Read the board before you decide anything

```
get_workspace(workspaceId)
→ { workspaceId, name, leadAgentId, goals }
```

`goals` is the **ordered** list with per-goal todo / in-progress / done counts,
parent goals followed by their subgoals, Backlog last. `list_tasks` returns goal
**ids** only — without `get_workspace` the ordering is invisible and you will
work the wrong band. It is deliberately cheap (goals and counts, no tasks);
pair it with `next_tasks`, which carries the tasks and their full descriptions.

## File work

`create_tasks` is the create verb, and it always takes a LIST — one task is a
one-row list, so there is never a choice to make about which tool to reach for.

```
create_tasks(workspaceId, tasks: [
  {
    title: "Cache the tokenizer between queries",
    body: "Agent can reuse a warm tokenizer so that p95 drops without a reindex.\n\n"
        + "Done when: a repeated query allocates no new tokenizer, and the "
        + "latency benchmark shows the p95 delta.",
    goal: "latency",          // OMIT to route through triage
    key: "warm-cache",        // so a later ROW can depend on this one
    links: [{ kind: "url", url: "https://example.test/pr/41" }],
  },
  {
    title: "Benchmark the p95 after the cache lands",
    goal: "latency",
    after: ["#warm-cache"],   // a row of this batch, by key; or [0] by index
    afterEnforce: ["#warm-cache"],
  },
])
→ { created: [{ title, taskId, goal, order, status, assignee, placed, … }],
    failures: [{ index, title, error, message }],
    placement?: { unplaced, triageDelivered, goals } }
```

Only `workspaceId` and a `title` per row are required. What matters:

- **`body` — write one on every task**, even though the schema does not demand
  it. A bare title is not pickup-able by an agent that was not in the
  conversation. Write it to the standard in
  `claude-workspaces:working-in-a-workspace`. It renders on the task and comes
  back whole from `next_tasks` — do not create a separate doc to hold it.
- **`goal` — omit it when you have not judged placement yet.** The task lands
  UNPLACED at the bottom of Backlog and a triage request goes to the live
  workspace agent (possibly you). An explicit goal — *even `"chores"`* — is a
  placement and skips triage. The create says which happened: `placed` is
  whether YOU named a goal (not whether the goal is `chores`), `triagePending`
  is whether the request actually reached a live attachment, and `goals` — the
  ordered bands — comes back when nothing placed it, so `set_task_goal` is the
  next call rather than a `get_workspace` first.
- **`key` + `after` — a row can depend on another row of the SAME batch**, by
  key (`"#warm-cache"`) or by index (`0`, or `"#0"`). Backwards only: rows are
  created in order, so a forward reference is refused, and so is a reference to
  a row that failed — a task carrying a dependency that never blocks it is
  worse than a refusal. An entry with no `#` is still a task id you hold.
- **`quote` — the human's VERBATIM words**, for chat-born asks. Kept on the
  task forever. Do not paraphrase it.
- `after` / `afterEnforce`: `afterEnforce` is a **subset** of `after`. An id in
  `afterEnforce` alone is refused rather than silently widening `after`.
- `links` kinds: `{kind:'doc',docId}` · `{kind:'thread',docId,threadId}` ·
  `{kind:'task',taskId}` · `{kind:'diff',workspaceId}` ·
  `{kind:'url',url}`. Use `url` for anything off this server — a pull request,
  a dashboard, a decision page; http(s) only. Refs are not existence-checked; a
  malformed one is dropped into `ignoredLinks` and the task is still created.
- `order` is a fractional position within the goal.

**Thread-born asks use `promote_to_task(docId, threadId, workspaceId)`** instead
— it captures the origin ref, takes the latest **human** comment as the quote
(agent replies never become the quote), and drafts a title and body from it.
Same goal semantics: omit `goal` to route through triage.

### Every task body is a live review doc

A task's description is backed by a real markdown room with
`docId = "task:<taskId>"` (`packages/server/src/task-projection.ts`). So the
normal doc tools work on it: `create_thread` / `post_reply` to have the
conversation next to the work, `get_doc` to read it. (You do **not** need
`watch_doc("task:t-abc123")` to hear its comments — declaring yourself on the
board covers every doc filed there, this one included.) Edits snapshot back into the task body. This is how
"ask for feedback on the task, not in chat" is actually done from an agent —
there is no `comment_on_task` tool.

**Omit `find` to comment on the task itself.** A description you want to
question is often empty, or the thing you want to ask about is the task rather
than a phrase inside it, so `create_thread` takes no anchor text in that case:

```
create_thread(
  docId: "task:t-abc123",
  text: "This assumes the index ships first — is that still true after the reorder?",
)
```

The thread appears in the task's Discussion on the board, and it never
orphans, however the description is later rewritten. Pass `find` when you do
want the comment pinned to a specific line; an EMPTY `find` is an error rather
than a shortcut to this, so a variable that came out blank can't quietly turn
into a comment on the whole task.

## Asking a person something: review items on a ticket

**A ticket HAS review items — it is not itself the question.** A ticket can
carry more than one, and more than one can be open at the same time. The
title names the WORK; each item carries its own blurb (`headline` + `why`)
above its own options, and is answered on its own.

```
create_tasks(workspaceId, tasks: [
  {
    title: "Bryan can keep p95 flat under cold queries",
    assignee: "human",
    goal: "latency",
    body: "The tokenizer cache is the last thing between us and a flat p95.",
    review: {
      shape: "decision",
      headline: "Pick the tokenizer cache eviction policy",
      why: "The latency work is blocked until this is answered",
      lookFor: "Whether a 300ms cold-start stall is acceptable",
      detail: "Memory is the constraint: one-per-index costs ~40MB steady "
            + "state and never stalls; LRU holds ~8MB but can stall a cold "
            + "query by 300ms.",
      options: [
        { id: "o-lru", label: "LRU", detail: "8MB steady, up to 300ms on a cold query" },
        { id: "o-per-index", label: "One per index", detail: "40MB steady, no stall" },
      ],
    },
  },
])
```

A question that comes up **after** the ticket exists hangs on it the same way:

```
add_review_item(taskId, review: { shape, headline, why, lookFor?, detail?, options? })
→ { taskId, reviewItemId, reviewAdvice? }
```

`headline` is one line ≤70 chars and `why` one line ≤90 — the two lines a
phone shows. Over-long or multi-line is **refused** rather than clipped, since
a clipped headline is the unreadable row this replaced. A missing `lookFor`
is accepted and comes back as advisory `reviewAdvice`. `shape: 'decision'`
needs 2–6 options with caller-supplied ids; `shape: 'review'` asks someone to
read or look at something and answer in their own words, and refuses options.

**Answer it verbatim**, naming which item:

```
answer_review_item(taskId, reviewItemId, text: "<their exact words>",
                   answeredWith?: "<option id they picked>")
→ { taskId, reviewItemId, recorded: true, links: [...] }

request_more_info(taskId, reviewItemId, question: "<what they want to know>")
```

`request_more_info` is what keeps the options from being a closed set: the
item stays open, stays counted, and you owe the context. Never paraphrase an
answer — when they picked an option, pass its **label** as `text` and its id
as `answeredWith`. The returned `links` are a ready-made propagation
checklist: act on each, or create a task for it, and prioritize them right
away. Neither verb transitions the ticket — close it with `task_transition`
once the propagation is handled.

### The older one-question-per-ticket decision

A ticket with `needs: 'decision'` and a human assignee IS the decision: the
title has to double as the question and a second open question has nowhere to
go. It still works exactly as it did, and everything already filed this way
keeps answering — a ticket with no review items of its own reads as one
derived item, so it shows up on the same queue.

```
create_tasks(workspaceId, tasks: [
  {
    title: "Pick the tokenizer cache eviction policy",
    assignee: "human",
    needs: "decision",
    goal: "latency",
    body: "Do we evict the tokenizer cache by LRU or keep one per index forever?\n\n"
        + "Memory is the constraint: one-per-index costs ~40MB steady state and "
        + "never stalls; LRU holds ~8MB but can stall a cold query by 300ms.\n\n"
        + "- LRU: cheap memory, occasional cold-start stall\n"
        + "- One per index: predictable latency, 5x the memory\n\n"
        + "The latency work is blocked until this is answered.",
    options: [
      { label: "LRU", detail: "8MB steady, up to 300ms on a cold query" },
      { label: "One per index", detail: "40MB steady, no stall" },
    ],
  },
])
```

**The body is REQUIRED and has a shape**: the question in one line, what is at
stake in two or three, the options with what each one costs, then what is
blocked until it is answered. Only the first part is enforced — a body with no
question mark anywhere is **refused**, because the failure this catches is
filing a progress report as a decision (field populated, every check passes,
and the person asked to decide has nothing to decide from). The other three
come back as advisory `shapeGaps` on a successful create.

`options` are candidate answers: `[{label, detail?}]`. `label` is the text
recorded verbatim if it is picked; `detail` is what picking it costs. Supply
them whenever you have candidates — two or more, or don't bother. They are a
shortcut, never a closed set; writing a different answer stays available.

**Record the answer verbatim** when they tell you in chat or voice (in the UI
they answer directly):

```
answer_decision(taskId, text: "<their exact words>", optionId?: "<option they picked>")
→ { taskId, recorded: true, links: [...] }
```

Never paraphrase. When they picked an option, pass the option's **label** as
`text` and its id as `optionId` — the answer is still the text. The returned
`links` are a **ready-made propagation checklist**: act on each, or create a
task for it, and prioritize them right away. `answer_decision` does **not**
transition the task — close it with `task_transition` once the propagation is
handled. It also takes an optional `reviewItemId` for a ticket carrying
several items; omit it — as every caller written before that field did — and
the answer lands on the ticket's own decision exactly as it always has.

**Say that a decision is blocking work**, or it reads as parked however loudly
its body says otherwise:

```
set_task_dependencies(taskId: "<the BLOCKED task>", after: ["<the decision>"],
                      afterEnforce: ["<the decision>"])
```

That edge is the only record of "this decision is holding work up now" — the
board derives a decision's urgency from what points at it, and there is
deliberately no urgency field. It replaces the whole edge set, so pass the full
list; an empty `after` clears the edges.

## Triage: shape it, then place it

Triage is **two** verbs, and shaping is the one that gets skipped. A row
captured from a pasted paragraph or a dictation keeps its clipped title and its
raw body however well you place it, and every component reports success either
way. Placement alone does not make a row pickup-able.

**Shape first.**

```
rewrite_task(taskId, body: "…", title: "…", reason: "…")
```

- **Read the row's own words.** `next_tasks` carries the full body; `quote`
  carries what was actually said when any of it was dictated.
- **Decide how many tasks it is — zero, one, or several.** *"Anyway, make a
  ticket from this"* is an instruction about neighbouring text, and files
  **zero** tasks. A paragraph holding two complaints is two. This is a
  judgement, and it is why the step is yours: capture makes exactly one row
  per submit and cannot tell an idea from an aside.
- **Write it to the standard** in `claude-workspaces:working-in-a-workspace`,
  and give it a title that names the work rather than starting the sentence.
- **The original words are safe.** The first rewrite of a row copies its
  pre-rewrite words into `quote` automatically, and a quote that is already
  there is never overwritten. So shaping can never be the only record of what
  was said — which is what makes rewriting somebody else's capture a
  reasonable thing to do without asking first.
- **When one capture is several tasks**, the row you were handed keeps the
  first result — retitled and rewritten in place, so any comment thread on it
  stays on the thing it was about. File the rest with `create_tasks` and
  `link_refs` them back to it. **When it is zero tasks**, do not delete the
  row: close it with `task_transition` and say on it what the words were an
  instruction *for*. Nothing here ever destroys a capture.

**Then place.**

```
set_task_goal(taskId, goal: "latency", position: 2.5, batchId?)
```

- **Pick the spot, not just the bucket.** `position` is fractional — there is
  always room between two tasks; omitted means bottom of the goal.
- It stamps `triagedAgainst` with the goal id you judged against and clears
  the triage-pending marker. Every move is recorded and fires `task.regrouped`,
  so regroup freely — the safety is the record, not asking first. When a move
  would cross a human's earlier placement, leave a comment on the task doc
  referencing it.

## Adopting an existing tracker

A hand-maintained markdown tracker (group headings + status tables) moves onto
a board without re-keying:

```
import_tasks_markdown(workspaceId, path: "/abs/path/to/TRACKER.md")   // DRY RUN
import_tasks_markdown(workspaceId, path: "...", apply: true)          // for real
```

**The default is a dry run** — it returns the mapping (headings → goals, rows →
tasks with normalized status, what was skipped, which columns were ignored) and
creates nothing. Review that mapping with the human first. Apply appends new
goals (existing ones matched by title are reused, never clobbered), creates the
tasks as explicit placements (no triage), walks imported statuses through the
transition gate, and **stamps the source file** with a banner + hub link so the
old tracker cannot quietly stay a second source of truth. A stamped file
refuses re-import (409). Headings map to goals; rows before any heading land in
Backlog; a leading H1 is the document title, not a group.
