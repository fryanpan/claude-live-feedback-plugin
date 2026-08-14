---
name: running-a-workspace-hub
description: Use when you need to stand up or drive a live-feedback workspace hub with the MCP tools — create_workspace, set_goal_list, create_task, set_task_goal, attach_agent, task_transition, answer_decision, link_refs. Covers the north-star goal, the ordered goal list, story-shaped task bodies, triage, the work loop, decisions, and the lead-agent seat.
---

# Running a live-feedback workspace hub

A hub workspace is a **north-star goal + an ordered task board + linked docs**,
rendered at `/workspaces/<workspaceId>`. Everything on it is reachable from
MCP tools: you can create the board, order its goals, file work as tasks a
person can read, ask a human a decision and record their verbatim answer, and
hand the whole thing to the next agent with no chat handoff.

**Do it all with the tools.** Two agents have reconstructed this API by reading
the server source and got the shapes wrong; a `curl` at the REST layer looks
identical to a proper board and proves nothing about whether the product works.
If a tool you need does not exist, that is a blocker to report and a task to
file.

This skill is the tool contract. The **discipline** of working an existing
board — priority order, fanning out, when to stop — lives in
`live-feedback:working-a-workspace-board`. Read both.

## First: two different things are called "workspace"

| | Hub workspace (this skill) | Grouping workspace |
|---|---|---|
| Made by | `create_workspace` | `bind_folder` / `create_diff_review` |
| Id called | `workspaceId`, `hubWorkspaceId` | `workspaceId`, `reviewId` |
| Is | a goal + task board + doc links | a set of review docs over files |
| URL | `/workspaces/<id>` | the review's `entryUrl` |

`delete_workspace`, `refresh_workspace`, `set_workspace_groups` and
`share_workspace` take the **grouping** id — never a hub id. Link a grouping
workspace onto a board with `attach_doc(workspaceId, docId)`; `docId` there
accepts a doc id *or* a review/bind id, and the whole review attaches as one
unit.

## Stand up the board

```
create_workspace(
  name: "search-revamp",              // required, short handle
  goal: "Cut p95 search latency below 200ms without losing recall.",
)
→ { workspaceId, name, goal, leadAgentId }
```

- `goal` is the **north-star statement every triage decision is judged
  against**. Markdown, a sentence or two. Keep it current with
  `set_workspace_goal`.
- **You become the board's lead agent** unless you pass `leadAgentId`. The lead
  is the addressee for goal-edit re-triage (see the last section). Hand the
  seat over later with `set_workspace_lead(workspaceId, leadAgentId)`.
- The call auto-subscribes this session to the workspace event channel
  (`task.*`, `decision.answered`, `triage.requested`, `workspace.goal_updated`,
  …), which arrives on the same channel as thread events. Pass
  `subscribe: false` to skip.

Then give it sections:

```
set_goal_list(workspaceId, goals: [
  { id: "latency", title: "Cut p95 latency",
    subgoals: [{ id: "index", title: "Index shape" }] },
  { id: "recall",  title: "Hold recall at parity", dueAt: 1767225600000 },
])
```

- **Order IS priority.** The first goal is the highest band; reordering this
  list is the priority gesture (it fires `workspace.goals_changed`, never a
  re-triage).
- One subgoal level, maximum. `dueAt` is epoch ms and optional at every
  level — never invent one.
- `"chores"` is **reserved**: it always renders last and must not appear in the
  list you pass.
- **Destructive edge:** open tasks whose goal id disappears from the list move
  to the bottom of Chores. The result reports `movedToChores` — re-place each
  one with `set_task_goal` rather than leaving them piled.

## Read the board before you decide anything

```
get_workspace(workspaceId)
→ { workspaceId, name, goal, goalUpdatedAt, leadAgentId, pendingRetriage?, goals }
```

`goals` is the **ordered** list with per-goal todo / in-progress / done counts,
parent goals followed by their subgoals, Chores last. `list_tasks` returns goal
**ids** only — without `get_workspace` the ordering is invisible and you will
work the wrong band. It is deliberately cheap (goals and counts, no tasks);
pair it with `next_tasks`, which carries the tasks and their full descriptions.

## File work

```
create_task(
  workspaceId,
  title: "Cache the tokenizer between queries",
  body: "Agent can reuse a warm tokenizer so that p95 drops without a reindex.\n\n"
      + "Done when: a repeated query allocates no new tokenizer, and the "
      + "latency benchmark shows the p95 delta.",
  goal: "latency",          // OMIT to route through triage
  after: ["t-abc123"],      // "don't start yet" is a dependency, not a status
  afterEnforce: ["t-abc123"],
  links: [{ kind: "url", url: "https://example.test/pr/41" }],
)
→ { taskId, goal, order, status, triagePending }
```

Only `workspaceId` and `title` are required. What matters:

- **`body` — write one on every task**, even though the schema does not demand
  it. A bare title is not pickup-able by an agent that was not in the
  conversation. Shape it as a compact user story: `<persona> can <do x> so that
  <goal y>`, **one** persona (Agent / Bryan / Collaborator), plus falsifiable
  "done when" criteria for anything handed to someone else or parked beyond
  today. Work you will finish within the hour needs the story line and nothing
  more. It renders on the task and comes back whole from `next_tasks` — do not
  create a separate doc to hold it.
- **`goal` — omit it when you have not judged placement yet.** The task lands
  at the bottom of Chores and a triage request goes to the live workspace
  agent (possibly you). An explicit goal — *even `"chores"`* — is a placement
  and skips triage.
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
normal doc tools work on it: `watch_doc("task:t-abc123")` to receive comment
events, `create_thread` / `post_reply` to have the conversation next to the
work, `get_doc` to read it. Edits snapshot back into the task body. This is how
"ask for feedback on the task, not in chat" is actually done from an agent —
there is no `comment_on_task` tool.

## Decisions

A decision is a task with `needs: 'decision'` and a human assignee.

```
create_task(
  workspaceId,
  title: "Pick the tokenizer cache eviction policy",
  assignee: "human",
  needs: "decision",
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
)
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
handled.

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

## Triage: placement is the write half

```
set_task_goal(taskId, goal: "latency", position: 2.5, riskTier: "yellow", batchId?)
```

- **Pick the spot, not just the bucket.** `position` is fractional — there is
  always room between two tasks; omitted means bottom of the goal.
- It stamps `triagedAgainst` with the goal text you judged against and clears
  the triage-pending marker. Every move is recorded and fires `task.regrouped`,
  so regroup freely — the safety is the record, not asking first. When a move
  would cross a human's earlier placement, leave a comment on the task doc
  referencing it.
- **`riskTier` is how dangerous EXECUTING the task is, never how important it
  is.** `green` reversible/contained · `yellow` outward-facing or hard to
  reverse · `red` irreversible/one-way. It is keyed to the action's damage.

## The work loop

**Attach, and read the briefing.**

```
attach_agent(workspaceId)
→ { workspaceId, agentId, gating, lead, untriaged, queuedVoice, pendingRetriage? }
```

Defaults: `agentId` = this agent's MCP identity, `runtime` =
`claude-code-local`. This is the fresh-context briefing:

- `gating` — a one-line summary of open decisions gating tasks.
- `untriaged` — task ids to sweep with `set_task_goal`.
- `queuedVoice` — voice change-requests that arrived while no agent was live.
  Act on each transcript **verbatim**.
- `lead` — whether you hold the lead seat. An **empty** seat is claimed by the
  first agent to attach; an occupied one is a standing decision and a second
  agent attaching is not a reassignment.
- `pendingRetriage` — only if you lead. See below.

**All of these are drained by this call.** Nothing offers them again.

**Stay live.** `heartbeat(workspaceId)` every few minutes. After ~5 minutes of
silence the hub shows you as **away and triage requests queue** rather than
reaching you. A fresh heartbeat with a stale `toolCallAt` renders as "process
up, agent unresponsive" — which is why the call stamps the work clock too
unless you pass an explicit earlier `toolCallAt`. `list_attachments(workspaceId)`
shows who is where and whether anyone is wedged.

**Take work from the queue.**

```
next_tasks(workspaceId, assignee: "<your name>")
→ rows in priority order (goal band, then task order)
```

Each row carries its **full description**, plus `blockedBy` (open dependencies;
only `enforce` ones hold it back) and `ready`. Hard-blocked rows are omitted
unless `includeBlocked: true`. Call it at the top of a session **and again
after every task you finish** — priorities move while you work.

**Move status through the one gate.**

```
task_transition(taskId, to: "done", note: "merged in #142",
                evidence: { commit: "<sha>" },
                usage: { inputTokens: 1, outputTokens: 1 })
→ { taskId, status, blockers, unproven }
```

- `todo | in-progress | done`, attributed to you, appended to the task's audit
  trail. **This is the only way status changes.**
- **Attach `evidence` (`{commit}` and/or `{threadRef}`) on forward moves** or
  the move comes back `unproven: true` — allowed, but shaded on the board.
- Open `after` dependencies come back in `blockers`; an edge marked **enforce
  refuses the transition (409)** until the blocking task closes. Read the
  message, it names what to unblock.
- **Risk tier gates the actor, not the task.** An *agent* moving a `red` task
  forward is refused outright — a person has to make the move. A `yellow` one
  needs `confirmed: true`, which means the human said yes after you showed them
  the concrete effect. It is not a retry flag; if they haven't answered, don't
  send it. A person is never gated, and **moving back to `todo` is never
  blocked**.
- The tier binds live-feedback-mediated moves only. Actions your own runtime
  performs never touch this server.

**Hand off what isn't yours** with `assign_task(taskId, assignee)` —
`'human'`, `'agent'`, or a named identity — the moment you discover it, rather
than leaving it parked in your column. Status is untouched (re-assigning is not
progress) and the direction of every hand-off is recorded.

## Goal edits and the lead-agent seat

Editing the north-star goal invalidates every placement that was judged against
the old one, so it asks for a re-triage — **addressed to the lead agent**, not
to whoever happens to be connected:

```
set_workspace_goal(workspaceId, goal: "<new north-star statement>")
→ { workspaceId, changed, retriage: { requested, queued, taskIds, batchId } }
```

- `retriage.requested` — it reached the lead live.
- `retriage.queued` — the lead was away (or the board has no lead), and the
  request is **waiting**. It does not expire; the board shows it as pending
  work.

A queued request is delivered as `pendingRetriage` on the lead's next
`attach_agent` — or immediately, if `set_workspace_lead` hands the seat to an
agent who is already live. When you receive one:

```
for each taskId in pendingRetriage.taskIds:
    set_task_goal(taskId, goal: "<placement against the NEW goal>",
                  batchId: pendingRetriage.batchId)
```

**Echo the `batchId` on every move.** It ties each placement to the goal edit
that asked for it, so the activity view reads N moves as one goal edit instead
of N unexplained regroupings.

`get_workspace` also surfaces `pendingRetriage`, but **reading it there does not
drain it** — only `attach_agent` does.

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
Chores; a leading H1 is the document title, not a group.
