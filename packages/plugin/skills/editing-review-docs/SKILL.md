---
name: editing-review-docs
description: Use whenever you're about to edit a markdown file that might be under live review via the claude-workspaces plugin, and when an edit tool returned no-match or 409 stale-write and you're deciding what to do next. Every review doc is backed by a file on disk; edits must flow through the MCP tools so the plugin keeps the live editor and the file in sync.
---

# Editing files that are under claude-workspaces review

The claude-workspaces plugin's mental model is one rule:
**every markdown review doc is a file on disk.**

When an agent calls `create_review_doc(docId, path)`, the server reads
the `.md`, parses it into the live editor, and sets up bidirectional
sync. From that point on:

- **Live editor → disk** — every change in the browser editor, every
  MCP edit-tool call, every widget interaction is debounced and written
  back to the `.md` within ~1 second.
- **Disk → live editor** — external edits (VS Code, `git pull`, another
  agent's `Write`) propagate into the live editor within ~1 second via
  `fs.watch`. The agent's typing in the browser stays merged.

**The risk:** if you `Write`/`Edit`/`str_replace` the `.md` while a
reviewer is actively reading, the watcher reflows the whole doc and
blows up their scroll position. Use the MCP edit tools instead — they
land surgically and the reviewer sees the change appear in place.

## Before editing a .md file

1. Call `list_docs`. Look for a doc whose `sourceUrl` field equals (or
   ends with) the path you're about to edit.
2. If you find one — that file is under review. Edit through the MCP
   tools below.
3. If you don't find one (or the claude-workspaces MCP isn't available),
   normal file edits are fine — the file isn't under review.

## Direct edits vs suggestions

**Edit directly by default — even while Bryan is in the doc.** Concurrent
human + agent edits CRDT-merge safely; that real-time co-editing is the
product's whole point, and Bryan has said explicitly he prefers it. Every
`suggest: true` proposal puts an accept/reject task on his plate, so
defaulting to suggestions trades a non-problem (rare conflicts) for
guaranteed extra work.

Reserve `suggest: true` (on `find_and_replace` / `rewrite_thread_region`)
for genuine judgment calls — the edits you would otherwise ask about first:
his voice or framing, a decision he owns, a claim you're unsure of. A
rejected suggestion returns cleanly; a pending one never reaches disk. If
accept/reject returns `not-found`, the region changed under the proposal —
re-read and re-suggest, don't retry.

## How to edit via MCP

Pick the smallest tool that does the job:

- **Text edits inside existing prose** → `find_and_replace(docId,
  find, replace, { contextBefore?, contextAfter?, occurrence? })`.
  Works across all block types including table cells, and a find that
  IS pipe-table row syntax (`| a | b |`) matches rows structurally —
  cells compared by text, whitespace ignored, so a row quoted from the
  `.md` works; the replace must keep the same row/cell shape. Use
  `contextBefore`/`contextAfter` to disambiguate when the same string
  appears more than once. **Gotcha:** `find_and_replace` operates on
  text, not block structure — if your replacement empties a containing
  block (e.g. you delete the only sentence in a blockquote, or all
  items in a list), the empty block stays behind in the doc. There's
  no structural-delete tool today; the workaround is to do a clean
  serialization pass when the .md hits its final destination (e.g. a
  PR that swaps a draft into the canonical file). Track this if
  you're using `find_and_replace` for substantial deletions.
- **Rewrite the range a comment is anchored to** →
  `rewrite_thread_region(docId, threadId, replacement)`. Primary path
  when you're responding to a reviewer's comment — the anchor already
  picks the exact text they pointed at.
- **Comprehensive rewrite / restructure of the whole doc** →
  `set_doc_content(docId, markdown)` — and ONLY that. **Never
  set_doc_content a doc a human has edited since your last read.** A
  scoped request — a comment, one section — gets a scoped edit, never a
  full rewrite: your in-context copy went stale the moment they typed,
  and a rewrite from it destroys their work (this exact escalation has
  done so in the field, unrecoverably). A scoped tool returning
  `no-match` is a signal to re-read with `get_doc` and retry scoped —
  find_and_replace, `edit_at_anchor`, the block tools below — not a
  license to escalate. The server backstops this: a rewrite after an
  untracked human edit gets `409 stale-write` with their edit time;
  the answer is re-read, re-apply onto the current content, and only
  if a full rewrite is truly required retry with
  `confirmOverwriteHumanEdits: true`. Every accepted rewrite first
  backs up the replaced markdown under the server data dir
  (`backups/<docId>/`). Applies as a block-level diff on
  the live doc: untouched blocks keep their identity, so comment
  threads on them survive, and the result flushes to the `.md` like
  any other edit. **Never** `Write` the bound file and
  `reparse_from_disk` after, and **never** do
  `delete_doc → Write → create_review_doc` — both race the ~1s
  write-back (they have clobbered real files), and the latter orphans
  every comment thread.
- **Insert a new block after a comment's block** →
  `insert_blocks_after_thread(docId, threadId, markdown)`. Accepts GFM
  including tables.
- **Delete the block a comment / anchor points at** →
  `delete_block_at_anchor(docId, { threadId | anchorId })`. Use this
  when an empty-string `find_and_replace` would leave a blank block
  element behind.
- **Delete every block between two find strings** →
  `delete_blocks_in_range(docId, startFind, endFind, …)`.
  Block-inclusive — a partial match deletes the whole containing
  block. Useful for trailing template cruft.
- **Delete a whole heading-bound section** →
  `delete_section(docId, heading, { level?, occurrence? })`. Removes
  the heading plus every following top-level block until the next
  heading at level ≤ the start heading's. Highest-leverage tool for
  "delete the X section" requests.
- **Batch edits across the doc** → `create_anchor(docId, find, …)` to
  pin positions, then `edit_at_anchor(docId, anchorId, …)` for each.
  Anchors survive intermediate user edits. **`edit_at_anchor` is
  inline only** — it inserts/replaces text inside the anchor's block.
- **Add new block(s) at an anchor** → `insert_blocks_at_anchor(docId,
  anchorId, markdown)`. Use this — not `edit_at_anchor` with
  `insert_after` — when you want a new heading, paragraph, list, or
  table after the anchor. `edit_at_anchor` would insert the literal
  `## Heading` characters inside the existing block; this routes
  through the markdown parser and produces real sibling blocks.

For external file changes you want to force-load (e.g. a `git pull`
changed the file, or you wrote it directly *before* the doc was under
review): call `reparse_from_disk(docId)` to discard live state and
reload from the file. If an edit-tool response or `get_doc` carries a
`syncError`, read it — it names the conflict and the
`clobber-backups/` file where the overwritten version was saved.

## Posting structured findings (UX issues, review notes, etc.)

When you're not editing prose but adding a finding — a UX critique, a
code-review note, an accessibility issue — post it as a comment thread
anchored to the relevant text or DOM region:

1. `create_anchor(docId, find, { contextBefore?, contextAfter?, label? })`
   to pin a position.
2. `post_reply(docId, threadId, text)` against the thread that
   `create_anchor` returns.

Use this body shape so the panel renders cleanly:

```markdown
**Severity:** moderate · **Page:** /jobs/123

The "Apply" CTA disappears below the fold on iPhone 12 mini —
clipped by the sticky footer at viewport heights under ~700px.

**Suggested fix:** make the footer auto-hide on scroll under 768px,
or move the CTA above the fold in the layout component.
```

Use a label like `"ux-finding"`, `"code-review"`, `"a11y"` in
`create_anchor` so the "All threads" panel groups findings by source.

## Signals the file is under review

- The user said "review", "workspace", "live feedback", or "the editor" — the
  old name still reaches people, so it stays a trigger.
- A message arrived as `<channel source="live-feedback" ...>`.
- `list_docs` returns a doc whose `sourceUrl` matches your target
  path. **Sole-authoritative check** — the others are just hints.
- The user sent you a `/review/<docId>?as=bryan` URL recently.

When in doubt, check `list_docs` before touching a `.md` — one tool
call. The cost of being wrong is a frustrating out-of-sync bug for
the reviewer.

## Creating a new review doc

If a `.md` file isn't under review yet and you want to bring it into
the editor, call `create_review_doc(docId, path, title?, setId?)`. The
doc must not already exist server-side; pick a fresh `docId`. The
server will read the file, parse it, attach the watcher, and return a
`reviewUrl` you can hand to a human. How you spell that link depends on
where you are putting it — inline and relative on a task or a thread,
bare on its own line in terminal chat. See "Use Links Effectively" in
`claude-workspaces:working-in-a-workspace`.

**Reviewing multiple files together:** pass the same `setId` when
creating each doc. Docs sharing a setId show up in each other's
sidebar in the markdown editor (left sidebar on desktop, dropdown
from the doc title on mobile). Hand the human the URL of any one
doc in the set; they hop between siblings via the sidebar.

```
create_review_doc({ docId: "auth-rfc",     path: "/abs/auth-rfc.md",     setId: "feb-2026-rfcs" })
create_review_doc({ docId: "billing-rfc",  path: "/abs/billing-rfc.md",  setId: "feb-2026-rfcs" })
create_review_doc({ docId: "schema-rfc",   path: "/abs/schema-rfc.md",   setId: "feb-2026-rfcs" })
# share /review/auth-rfc?as=bryan — sidebar lists all three.
```

`setId` is just a tag — pick any short string. No setup step needed
before using one. Calling `create_review_doc` again on an existing
docId with a different `setId` re-tags it (handy for rebatching).

**A doc you authored opens with a provenance header:** author and what
they own; the repo as a GitHub URL (never a filesystem path — unusable
on a phone); the specific files behind any number or claim; a run id or
timestamp for pipeline output. Applies to analyses, methodology docs,
research writeups, and reviews. Skip it for a plan the reviewer
co-authors.

## Retiring a doc you're done with

Most review docs are short-lived: you bind a file, get a round of
feedback over ~30 minutes, and then the doc is obsolete. **Retire it
when you're done** instead of leaving it to linger in `list_docs`
forever — orphaned docs pile up fast and make the review list useless.

```
archive_doc({ docId: "auth-rfc", reason: "feedback applied, PR merged" })
```

What it does: takes the doc off the home page and off any board row,
stops its sync and its file poll — and **keeps the document**. The
`.ydoc` moves into the server's archive rather than being deleted, so
every comment in it still feeds the activity analyses, and
`unarchive_doc({ docId })` brings the whole thing back, threads and
board links included. The bound **source `.md` file is left untouched
on disk** either way. Open threads do not block it: archiving strands
nothing, which is the difference that makes this the routine verb.

Because it is reversible, you don't have to be sure. A doc that has
been quiet for a day and *might* still be wanted is exactly the case
to archive — one call brings it back if you were wrong. Use
`list_archived_reviews` to see what is parked (archived docs come back
under `docs`, reviews under `archived`).

Two neighbours worth knowing:

- **`archive_review({ setId, reason })`** for a whole diff review or
  bound folder. `archive_doc` refuses a doc that belongs to one, with
  `error: "review-member"` and the `setId` to call instead.
- **`delete_doc({ docId })`** is the destructive one — it purges the
  `.ydoc` the activity analyses are rebuilt from, and there is no
  undo. It still carries the open-threads guardrail (`{ ok: false,
  error: "has-open-threads", openThreads: N }`, overridable with
  `force: true`). Reach for it only when you mean to destroy the
  record, not as routine cleanup.
