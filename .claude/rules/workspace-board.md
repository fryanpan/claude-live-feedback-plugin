# Working From a Live-Feedback Workspace Board

**The contract now ships with the plugin.** How to work a board — priority
order, fanning out on what's parallelizable, what a description owes the next
agent, keeping the board current, asking for feedback on the task, and why
finishing a task is not a reason to stop — lives in the
`live-feedback:working-a-workspace-board` skill
(`packages/plugin/skills/working-a-workspace-board/SKILL.md`). Read it at
session start if this session has a workspace, and follow it.

It moved there because it is not advice about this repo: it is what the
product asks of **anyone** working a board, and the people who need it most
are peers who never read this file. One copy, shipped where the board is.

The two things people look for here by name, so grep finds them: a task
description is a compact user story — **`<persona> can <do x> so that
<goal y>`**, one persona (Agent, Bryan, Collaborator) — and every task
**belongs to somebody**, so the API refuses a create whose owner comes out as
the bare word "agent" (your session needs `FEEDBACK_AGENT_NAME` set). The
reasoning for both, and everything else about writing a task, is in the skill.

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
