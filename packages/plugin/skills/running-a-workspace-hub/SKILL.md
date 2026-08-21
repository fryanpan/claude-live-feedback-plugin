---
name: running-a-workspace-hub
description: Use when you need to stand up or drive a claude-workspaces workspace hub with the MCP tools — create_workspace, set_goal_list, create_tasks, set_task_goal, set_workspace_lead, attach_agent, task_transition, add_review_item, answer_review_item, answer_decision, link_refs.
---

# Running a claude-workspaces workspace hub

A hub workspace is an **ordered goal list + a task board + linked docs**,
rendered at `/workspaces/<workspaceId>`. Everything on it is reachable from
MCP tools: you can create the board, order its goals, file work as tasks a
person can read, hang questions on a ticket and record verbatim answers, and
hand the whole thing to the next agent with no chat handoff.

**Do it all with the tools, not `curl` at the REST layer.** A hand-built REST
call looks identical to a working board and proves nothing about whether the
product works. If a tool you need does not exist, that is a blocker to report
and a task to file.

**The call shapes are in `tool-reference.md`, next to this file** — standing up
a board, the goal verbs, filing work, review items, triage, adopting an
existing tracker. Open it when you know what you want to do and need the
argument list. This file is the part you need before that: which surface is
which, how the loop runs, and what a goal edit asks of the seat.

**REQUIRED BACKGROUND:** `claude-workspaces:working-in-a-workspace` and
`claude-workspaces:leading-a-workspace`. The first is the discipline every
agent owes an existing board — including the task standard every create and
rewrite here answers to; the second is what the lead seat adds.

## First: two different things are called "workspace"

| | Hub workspace (this skill) | Grouping workspace |
|---|---|---|
| Made by | `create_workspace` | `bind_folder` / `create_diff_review` |
| Id called | `workspaceId`, `hubWorkspaceId` | `workspaceId`, `reviewId` |
| Is | a goal + task board + doc links | a set of review docs over files |
| URL | `/workspaces/<id>` | the review's `entryUrl` |

`delete_workspace`, `refresh_workspace` and `set_workspace_groups` take the
**grouping** id — never a hub id. Link a grouping workspace onto a board with
`attach_doc(workspaceId, docId)`; `docId` there accepts a doc id *or* a
review/bind id, and the whole review attaches as one unit.

**`share_workspace` and `share_link` are the exception: they take the HUB id,
and only the hub id.** A board is the unit of sharing — a review must be filed
on a board before it can be shared — so a grouping id comes back
`410 grouping_sharing_removed`. `bind_folder` and `create_diff_review` already
report the board they filed onto as `hubWorkspaceId` — that is the id to share.
Everything filed on that board travels with the share, so when a review should
not carry the rest of the board, give it its own: `create_workspace` makes an
empty one in about a second.

## The work loop

### Declare yourself once, and stop subscribing to things

```
set_workspace_lead(workspaceId)          // no second argument
→ { workspaceId, changed, leadAgentId, previousLeadAgentId?, declined?,
    subscribed, subscriptionPersisted, subscriptionWarning?,
    lead, gating, untriaged, queuedVoice,
    pendingBucketReview?, taskReviews? }
```

**What the seat then covers is the lead skill's contract; this is how the call
behaves and how it fails.** One call at session start, and the wiring is done:
there is no per-surface subscribe to remember and nothing to redo. The reason
it reaches docs created later is that coverage is resolved when an event
fires, against what the board holds at that moment — so a doc filed on the
board an hour from now needs no second call.

**It survives a respawn.** The subscription is persisted against your agent
identity (`CW_AGENT_NAME`) and re-wired when your session comes back, so the
next context does not spend its opening turns rebuilding a watch list. The
restore now **re-attaches** you too, on boards you already led or were attached
to whose heartbeat came back stale — re-wiring the key puts events back on the
wire, and only the attachment makes you *addressable*, so both repairs have to
land for you to be reachable.
Check with `list_watched_docs`, whose `restore.status` says whether the re-wire
happened, failed, or was never possible (no stable identity).

Because it also attaches you, the same response carries the **backlog** the
seat accumulated — same fields, same meaning as `attach_agent` below, and
**drained by this call**, so read them here or lose them.

- **Read `subscribed`, don't assume it.** It reports whether the event stream
  actually opened, so `false` is a real outcome: something reached the server
  but the listening half did not come up, and a `subscriptionWarning` says
  which. Call again. `subscriptionPersisted: false` is the *other* failure —
  today works, the next respawn does not, usually because this session has no
  `CW_AGENT_NAME`. They fail independently, which is why they are two fields.
- **Declaring does not evict a live peer.** If a different agent already leads
  the board and is live, the seat stays with them and you get
  `declined: "lead-held"` plus `previousLeadAgentId`. You are still attached
  and subscribed — nothing on the board is hidden from you, only the seat did
  not move. Coordinate with them; pass `takeover: true` when you genuinely
  mean to take it. (A seat whose holder has gone quiet is *not* protected —
  recovering an abandoned board is exactly what declaring is for.)
- **Use the bare one-argument form to declare yourself.** Passing
  `leadAgentId` is a *handover* to somebody else:
  `set_workspace_lead(workspaceId, leadAgentId)` moves the seat and does
  nothing else, because attaching on an absent agent's behalf would make the
  board report a live lead that is not there.
- **`watch_doc` is for docs OUTSIDE your board** — a peer's review you want to
  observe, a doc nobody filed here. It is no longer how you cover your own
  board, and a pile of `watch_doc` calls is not a substitute for declaring:
  every delivery gate asks whether the lead is **attached**, and a doc watch is
  not an attachment. That gap is silent by construction — a queue nobody is
  draining looks exactly like a queue nobody filled.
- **Declaring once is not staying live.** The declaration attaches you; it
  cannot keep you attached. Delivery is gated on the server having observed
  you recently — a heartbeat or a tool call, whichever is later — so a session
  that goes quiet stops receiving lead-addressed work while every surface
  still says it is subscribed. Tool
  calls refresh it, so a working session is fine; a thinking one is not. See
  "Stay live" below.
- **When the board feels quiet, don't assume it is.** Call
  `list_watched_docs` and read `coverage.unattachedBoards`: each row is a board
  you follow — through a watched doc **or through the board's own `ws:` key** —
  where you are not **live**, with what is queued for its lead. "Not live"
  covers two different states and the row says which: no attachment at all, or
  `attached: true, heartbeatFresh: false` (a record exists, the window lapsed,
  and every gate reads the window). The remedy differs, and each row carries
  the right one:
  - seat empty or its holder gone → `set_workspace_lead(workspaceId)`
  - the seat is already yours, only the heartbeat lapsed → `heartbeat(workspaceId)`
  - a **live peer** leads it (`leadLive: true`) → `attach_agent(workspaceId)`,
    which makes you addressable without evicting them. The queue there is
    addressed to *them*; ask rather than take.

  An **absent** `coverage` means the server did not answer — unknown, never
  all-clear.

### Attach and read the briefing, if you are not the lead

A peer picking up one task, or a subagent handed a workspaceId, uses this door
instead: it subscribes and briefs you, but it does not take the seat.

```
attach_agent(workspaceId)
→ { workspaceId, agentId, gating, lead, untriaged, queuedVoice,
    pendingBucketReview? }
```

Defaults: `agentId` = this agent's MCP identity, `runtime` =
`claude-code-local`. This is the fresh-context briefing:

- `gating` — a one-line summary of open decisions gating tasks.
- `untriaged` — task ids to sweep. Sweeping one means **shaping it and then
  placing it**, not filing it under a goal and moving on. See "Triage: shape
  it, then place it" in `tool-reference.md`.
- `queuedVoice` — voice change-requests that arrived while no agent was live.
  Act on each transcript **verbatim**.
- `lead` — whether you hold the lead seat. An **empty** seat is claimed by the
  first agent to attach; an occupied one is a standing decision and a second
  agent attaching is not a reassignment.
- `pendingBucketReview` — only if you lead. A goal **band** that appeared
  while you were away, and the unplaced tasks worth re-looking at against
  it. See below.

**All of these are drained by this call.** Nothing offers them again.

**Stay live.** `heartbeat(workspaceId)` every few minutes. After ~5 minutes of
silence the hub shows you as **away**; what actually parks a triage request is
the server having observed nothing from you at all — no heartbeat and no tool
call. A fresh heartbeat with a stale `toolCallAt` renders as "process
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
whenever a line of work finishes** — priorities move while you work.

**How wide to run the fan-out is the lead's call**, per
`claude-workspaces:leading-a-workspace`. Two readings only the board can give
you, so they are here rather than there:

- **Make the board judgeable.** A batch is planned by reading descriptions
  against each other, so thin bodies are what forces a session to run serial.
  Same for a real ordering constraint left in somebody's head instead of in
  `after` / `afterEnforce` — the queue can only respect an edge that exists.
- **Watch what the board says is running.** Several `in-progress` rows with
  one agent attached is a batch nobody is actually working; one `in-progress`
  row with a long ready queue behind it is the failure the parallel default
  exists to prevent. `list_attachments` and the per-goal counts are the reading.

`assign_task` is also how a line gets an owner — a staffed batch is several
tasks each assigned to the agent running it, so `next_tasks(assignee: …)`
answers for each of them.

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
- **Got the evidence wrong, or forgot it? Don't re-send the transition** — it
  refuses with `same-status`. `amend_evidence` APPENDS a correction to the move
  that already happened: the original row keeps what it said (a wrong sha is
  struck, not deleted), your correction sits beside it attributed and
  timestamped, and the `unproven` shading clears. A false sha is the case worth
  caring about — it reads as proof, so nothing looks wrong until someone tries
  to follow it. Nothing validates that a sha resolves; this server has no
  checkout to look it up in.
- Open `after` dependencies come back in `blockers`; an edge marked **enforce
  refuses the transition (409)** until the blocking task closes. Read the
  message, it names what to unblock.
- **Moving back to `todo` is never blocked** — undoing work must not be
  gateable.
- There is no risk gate here. The server never refuses a forward move for
  being risky: when to stop and ask a person is already your fleet's own
  judgement, and a second copy of it on this server would be one mechanism too
  many. **Deciding when a move needs a human is still yours to make.** Old
  bundles may still send `riskTier` and `confirmed`; both are accepted and
  ignored.

**Hand off what isn't yours** with `assign_task(taskId, assignee)` —
`'human'`, `'agent'`, or a named identity — the moment you discover it, rather
than leaving it parked in your column. Status is untouched (re-assigning is not
progress) and the direction of every hand-off is recorded.

## A new band asks the bucket to be re-looked-at

Tasks nobody could place sit in the unknown-goal bucket (`untriaged`) at the
bottom of Backlog. That is a fine place for them — until a goal **band** appears
that one of them might belong to. So ADDING a band to the goal list asks the
lead to look:

```
set_goal_list(workspaceId, goals: [...])
→ { ..., bucketReview: { requested, queued, taskIds, newBands, batchId } }
```

The ask is **addressed to the lead agent**, not to whoever happens to be
connected. `requested` means it reached the lead live; `queued` means the lead
was away (or the board has no lead) and it is waiting for their next
`attach_agent`, where it arrives as `pendingBucketReview`. It does not expire.
`get_workspace` shows it without draining it — only `attach_agent` drains.
A **reorder or a rename reveals no new destination and asks
nothing** — use `reorder_goals` and `rename_goal` for those and no one is
interrupted.

When you receive one:

```
for each taskId in pendingBucketReview.taskIds:
    read the task, and IF one of pendingBucketReview.newBands is its home:
        set_task_goal(taskId, goal: "<the band>",
                      batchId: pendingBucketReview.batchId)
```

**Nothing has been placed for you, and leaving a task unplaced is a real
answer.** The ask is to LOOK; placing everything because you were asked is how
the bucket stops meaning anything. It is deliberately not auto-assigned —
that would stamp a ranking decision no human made, invisibly, and the bucket
exists precisely because nobody has made that call yet.
