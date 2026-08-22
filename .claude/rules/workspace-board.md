# Working From a Claude Workspaces Board

**The contract now ships with the plugin.** How to work a board — the task
standard, keeping rows current, sharing progress and asking for review in
the workspace — lives in the `claude-workspaces:working-in-a-workspace`
skill (`packages/plugin/skills/working-in-a-workspace/SKILL.md`), and the
lead seat’s duties — goals, ranking, priority order, registering as lead — in
`claude-workspaces:leading-a-workspace`
(`packages/plugin/skills/leading-a-workspace/SKILL.md`). Read them at
session start if this session has a workspace, and follow them.

It moved there because it is not advice about this repo: it is what the
product asks of **anyone** working a board, and the people who need it most
are peers who never read this file. One copy, shipped where the board is.

The two things people look for here by name, so grep finds them: a task
description is a compact user story — **`<persona> can <do x> so that
<goal y>`**, one persona (Agent, Bryan, Collaborator) — and every task
**belongs to somebody**, so the API refuses a create whose owner comes out as
the bare word "agent" (your session needs `FEEDBACK_AGENT_NAME` set). The
reasoning for both, and everything else about writing a task, is in the skills.

What stays here is the part that is about building this product rather than
about using it.

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

## The keep-moving protocol (Bryan, 2026-08-22)

Adopted after a 24-hour transcript audit of two lead sessions found 18
chat-only asks (13 died unanswered) and ~15 hours of dark stalls, every one
ended by Bryan typing. Full evidence and his verbatim refinements live on the
board task that proposed it; what follows is the operating rule.

- **No unfiled asks.** Any ask to Bryan exists as an answerable review item
  before the turn ends; chat carries a pointer only. A "still waiting on you"
  list in chat is a smell — each entry must already be an item he can answer
  where he reads.
- **Goal bands run automatically.** Work goal-band tasks in priority order
  without being told, unless a task is blocked by a decision or dependency —
  and record that blockage as an `after` edge, never in your head. **Backlog
  is NOT dispatched at all** — *"above all else go in priority order"*
  (Bryan, 2026-08-22, superseding the earlier "obviously useful items only,
  lead's judgment" clause; the judgment call is withdrawn for now). When
  everything above the backlog is blocked or waiting on Bryan, the correct
  state is idle capacity plus filed review items naming what it is blocked
  on — not a backlog pick. A `ready_idle` nudge naming a backlog row is
  awareness, not a dispatch order.
- **Complex tasks clear a human gate first.** When an agent files a task that
  is complex by the usual risk assessment — or includes UI design — its
  acceptance criteria must include "review ticket body (and mocks, for UI)
  with Bryan before implementing", surfaced as a review item when the task
  comes up for dispatch. Small/obvious tasks run without the gate.
- **Never go dark.** A turn that stands every agent down and posts "waiting
  on you" has extinguished all three of a session's resume sources (human
  chat, channel events, agent reports). When genuinely blocked with nothing
  ready, arm a periodic self-wakeup (~20 min) that re-reads the board and the
  agent roster — a wake that finds nothing changed is one cheap read and ends
  there, no fan-out, no re-verifying proven state.
- **Watchdog every dispatch.** An idle notification without a report is the
  known harness bug that drops a subagent's final message (measured at 41% of
  one day's dispatches) — nudge immediately; recovery is ~30s. Probe every
  fresh spawn within a minute: spawns can die instantly while the parent sees
  "spawned successfully".
- **Respect capacity.** Parallelism stays within comfortable limits, and
  resource-exclusive lanes hold ONE agent at a time — a physical device, host
  Gradle builds, this repo's merge/deploy queue. Work needing an occupied
  lane queues behind it. Peers discuss overlap and coordination directly with
  each other over hive messages, not through Bryan.
- **Re-rank the band on a trigger** (Bryan's chosen mechanism for band
  order): when a row is filed above the band's median, a goal is edited, or
  several rows have arrived since the last pass, the lead re-reads the whole
  band against the current goal and rewrites the order — never moving a row a
  person placed without asking, documenting what moved and why, and folding
  duplicates / minor extensions into their covering ticket as it goes.
