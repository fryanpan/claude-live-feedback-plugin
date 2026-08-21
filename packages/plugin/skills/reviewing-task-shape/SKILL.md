---
name: reviewing-task-shape
description: Use when a task-review request reaches you — a `triage.requested` channel line with kind task-review, or `taskReviews` rows on attach_agent. You lead this workspace, a row was just created, renamed, or rewritten, and the ask is to judge its title and body against the standard and either leave it, rewrite it with rewrite_task, or ask the filer. Covers the standard itself, when rewriting is yours to do, and when it is not.
---

# Reviewing a task's shape

You are the workspace's lead agent, and a row was just written — created,
renamed, or its body rewritten. The server routed it to you because **it does
not judge titles or bodies; you do.** A regex can check a title's length; only
a reviewer with the project's context can tell whether the title names the
work, whether the body says when it is done, and whether the row is really two
tasks wearing one title. That judgment is this skill.

Every review has exactly three honest outcomes:

1. **Fine as-is.** Say nothing, change nothing, move on. Expect this often —
   a review pass that always "finds" something is rewriting for its own sake.
2. **Rewrite it**, with `rewrite_task`, when you have the context to do it
   well.
3. **Ask the filer**, in a comment on the task, when you don't.

## The standard

The standard itself is stated once, in
`claude-workspaces:working-in-a-workspace` ("Writing Clear Tasks"): title
**`<persona> can <do x> so that <goal y>`** — one persona (Agent, Bryan,
Collaborator), 20 words or less — and a body under 250 words that opens with
a **Problem Statement** and carries specific, falsifiable **Acceptance
Criteria**. What this skill adds is how to judge a row against it:

- The failure the title shape exists to stop is a title that states an
  OBSERVATION ("A decision-answered event promises a link checklist" names
  something somebody noticed): ten of those in a column give no sense of the
  plan, and the board cannot be prioritised.
- Never clipped mid-word — *"For tasks, I get dumped o…"* is a machine
  artifact, not a name.
- **Phone-readable brevity is part of the standard, not polish.** Bryan
  reviews on his phone, and a body that needs scrolling to find the point
  has buried it.
- A body written from measurement names a probe, a port, or a number, and
  dates its claim. A body written from inference reads as confident prose —
  and this project has shipped a week where three of those premises were
  false. If the body asserts how the system behaves with no method and no
  date, that is worth a question even when the prose is tidy.

**Decision rows** (`needs: 'decision'`) are **exempt from the story shape** —
a decision's title is a question, and its body is the question, the stakes,
the options with costs, and what is blocked until it is answered. They still
route to you, because a muddy question is exactly what a reviewer with
context can sharpen. Judge clarity, not story shape.

## The procedure

1. **Read the row itself** — `get_doc` on `task:<taskId>` for the full body,
   or the body already in hand from `next_tasks`. Read `quote` if present:
   it holds the filer's original words, which is what the title must still
   answer to.
2. **Read the context that makes judgment possible** — `get_workspace` for
   the goals and the neighbouring tasks. A title is good relative to the
   board it sits on: if three rows already say "improve search", the fourth
   needs to say which part.
3. **Judge honestly.** Fine as-is is a real answer.
4. **Rewrite when you have the context**, in one call:

   ```
   rewrite_task(taskId, title: "…", body: "…", reason: "…")
   ```

   Both halves in one attributed act; pass only the half you are changing.
   The `reason` is required and rendered in the activity feed — say what was
   wrong, not just that you rewrote. The row's original words are preserved
   to `quote` automatically on the first body rewrite, so a rewrite is never
   the only record of what was said.
5. **Ask instead of rewriting** when you lack the context — post a comment on
   the task (`create_thread` on docId `task:<taskId>`), addressed to whoever
   filed it, asking the specific thing you cannot infer. The question lives
   on the task because filer sessions end; a question asked in a terminal
   evaporates with it.

## What is never yours to do

- **Never silently rewrite a human's deliberate words.** A machine-clipped
  fragment title is fair game — the machine wrote it. A title or body a
  person visibly *chose* — phrasing that reads intended, a body that is a
  dictated transcript — gets a question or a suggested rewrite in a comment,
  not a replacement. When unsure which it is, ask; the cost of asking is one
  comment, the cost of guessing wrong is a person's words gone.
- **Never block or delay the write.** The capture has already landed by the
  time you see the request — that ordering is the design, not an accident.
  Your pass improves rows; nothing about it may make filing slower or
  riskier.
- **Don't re-review your own writes.** The server already suppresses them;
  if you see your own rewrite echoed back through some other path, that is a
  bug to report, not a loop to follow.

## How the requests reach you

- **Live**: a `triage.requested` channel line, `kind: task-review`, naming
  the taskId, its current title, what just happened (`trigger`: created /
  renamed / edited), and who did it. Requests are addressed to the lead — an
  FYI naming another agent is not yours to act on.
- **After being away**: `attach_agent` returns `taskReviews` — the rows
  written while no lead was live, coalesced one per task, each with its
  trigger and writer. Draining them is part of coming home, the same as
  `pendingRetriage`.
- Unplaced creates do NOT arrive here — the shape-and-place triage ask
  already covers them, and its contract includes the same rewrite step.
