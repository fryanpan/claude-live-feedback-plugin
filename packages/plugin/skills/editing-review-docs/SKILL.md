---
name: editing-review-docs
description: Use whenever you're about to edit a markdown file that might be under live review via the live-feedback plugin (file-backed docs). Edits must flow through the MCP tools so the plugin serializes them back to disk — writing to the .md directly desyncs the live editor and the file.
---

# Editing files that are under live-feedback review

The live-feedback plugin supports **file-backed review docs**: the
user calls `attach_file(docId, path)` once to bind a `.md` file to
a live Yjs doc. After that:

- The live editor is the authoritative surface. Every keystroke
  (from Bryan, from the widget, from an agent) merges via CRDT.
- The plugin serializes the doc back to the file on disk ~1 second
  after each change (`writeFileSync` debounced in
  `rooms.ts:scheduleFileWrite`).
- Disk → doc watching is NOT yet wired up in the plugin. If you
  `Write`/`Edit`/`str_replace` the `.md` on disk, the live doc does
  NOT pick up your change. Bryan keeps seeing the old content in his
  browser and his next edit there will overwrite your file change on
  the next debounced flush.

**Therefore:** before editing any markdown file, check whether it's
under live review. If yes, edit through MCP tools, not the filesystem.

## Before editing a .md file

1. Call `list_docs` (from the live-feedback MCP). Look for a doc
   whose `sourceUrl` field equals (or ends with) the path you're
   about to edit.
2. If you find one: edit via the MCP tools below. Do **not** touch
   the file directly.
3. If you don't find one (or live-feedback MCP isn't available):
   normal file edits are fine — the file isn't under live review.

## How to edit via MCP

Pick the smallest tool that does the job, in this order:

- **Text edits inside existing prose** → `find_and_replace(docId,
  find, replace, { contextBefore?, contextAfter?, occurrence? })`.
  Works across all block types including table cells. Use
  `contextBefore`/`contextAfter` to disambiguate when the same string
  appears more than once.
- **Rewrite the range a comment is anchored to** →
  `rewrite_thread_region(docId, threadId, replacement)`. Primary
  path when you're responding to a reviewer's comment — the anchor
  already picks the exact text they pointed at.
- **Insert a new block (paragraph / heading / list / table) after a
  comment's block** → `insert_blocks_after_thread(docId, threadId,
  markdown)`. Accepts GFM including tables.
- **Freshly populate an empty doc** → `seed_doc(docId, markdown)`.
  Fails if the doc already has any content.
- **Batch edits across the doc** → `create_anchor(docId, find, …)`
  to pin positions, then `edit_at_anchor(docId, anchorId, …)` for
  each. Anchors survive intermediate user edits.

Do NOT:

- `Write` / `Edit` / `str_replace` on the `.md` while it's attached
  — your change silently loses to the live editor's next flush.
- `git checkout` / `git stash pop` a file that's attached — same
  divergence problem.
- Run a formatter / linter that rewrites the file on disk. Run it
  AFTER the review is complete, when no browser session is open.

## Signals the file is under review

- Bryan said the words "review", "live feedback", "the editor".
- A message arrived as `<channel source="live-feedback" ...>`.
- `list_docs` returns a doc whose `sourceUrl` matches your target
  path. Sole-authoritative check.
- Bryan sent you a `/review/<docId>?as=bryan` URL recently.

When in doubt, check `list_docs` before touching a `.md` — it's
one tool call and the cost of being wrong is a frustrating
out-of-sync bug for Bryan.

## What the plugin does on its side

For context, so the "edit via MCP" constraint feels grounded:

- `attach_file(docId, path)` binds the doc to the file. Seeds the
  Yjs fragment from disk if the fragment is empty.
- Every prose change (browser, agent, widget) schedules a debounced
  (800ms) write of the serialized markdown back to the file.
- Writes are skipped when the serialized output matches the last
  thing we wrote — idempotent on repeated transactions.
- Disk → doc watching (external edits flowing into the live doc) is
  on the roadmap but not shipped. Until then, disk is effectively
  write-only from the plugin's perspective.
