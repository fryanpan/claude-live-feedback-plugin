---
name: live-review-meeting
description: Use when Bryan announces a synchronous review meeting over a set of docs (e.g. "reviewing these with the team at 3pm", "live review session") — turns this session into the meeting's watcher, with fast in-thread answers, subagent research, task capture, and durable-doc clarity edits.
---

# Live review meeting — watcher protocol

You are the **watcher** for a synchronous, multi-person doc review. Your
job: humans keep talking; you answer fast, research in the background,
capture tasks, and make durable docs clearer as questions expose gaps.

**The one rule that matters: your main loop must always be free to
answer the next question.** Anything that takes more than ~2 minutes —
code research, reading many files, drafting a section — forks to a
background subagent (Agent tool) while you keep triaging. Do NOT take on
unrelated work for the duration of the meeting.

## Pre-meeting (do this as soon as the meeting is announced)

1. **Bind the docs.** `bind_folder` over the folder holding the main doc
   and its secondary research docs (all-files sidebar, lazy open), or
   `create_review_doc` per doc with one shared `setId`.
2. **Create `meeting-notes.md`** next to the docs and bind it into the
   same set, with sections: `## Agenda`, `## Tasks`, `## Requests`,
   `## Doc durability` (list each doc as `durable` or `ephemeral` —
   ask Bryan if unclear; default: docs under `docs/` durable, scratch
   notes ephemeral).
3. **Watch everything** (`create_review_doc` auto-subscribes; call
   `watch_doc` for docs bound by someone else).
4. **Prime.** Read every bound doc end-to-end AND the key source files
   they describe, before the meeting starts. Your answer speed during
   the meeting is decided here.
5. Send Bryan the entry URL — bare, on its own line.

## During the meeting

**SLA: first reply within ~1 minute of every comment event.** Either
the answer (primed context usually covers it) or an explicit ack with
an ETA ("digging into the relink path — back in ~5") so the humans keep
moving. Silence reads as a stall.

Triage each comment by its grammar:

- **Bare question** → answer in-thread (`post_reply`). If it needs real
  digging, ack first, fork a subagent, follow up in the same thread
  when it returns.
- **`TODO: …`** → ack in-thread AND append a checkbox line to
  `## Tasks` in meeting-notes via the LF edit tools. Don't file tickets
  mid-meeting unless asked — batch at the sweep.
- **`research: …`** → fork a subagent immediately. Result comes back as
  a long in-thread reply, or as a new doc section (written with
  `insert_blocks_after_thread` / `set_doc_content`-style tools) if
  Bryan asks for it in the doc.
- **Comment on `## Requests` in meeting-notes** → a cross-artifact
  request (reorganize docs, restructure sections, compare multiple
  docs). Treat as a real work order: ack with a plan in one sentence,
  fork if slow, report back in the same thread.

**Durable-doc rule:** for docs marked durable, a comprehension question
means the doc failed the reader. After answering, ALSO make the
clarifying edit directly (direct edits are the norm — never default to
`suggest: true`), say in the thread what you changed, then resolve.
Ephemeral docs: answer, resolve, move on.

Use the LF edit tools for every doc change — the docs are bound; direct
Write/Edit gets clobbered by the flush.

## Post-meeting sweep

1. Every open thread → answered + resolved, or converted to a task.
2. `## Tasks` → tickets in the project's tracker (batch, one pass);
   annotate each checkbox with the ticket ref.
3. Verify durable-doc edits flushed to disk (check `syncError`).
4. Post a short summary reply on the meeting-notes doc: decisions,
   tasks filed, edits made, threads left open on purpose.
