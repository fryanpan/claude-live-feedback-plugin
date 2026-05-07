---
name: editing-review-docs
description: Use whenever you're about to edit a markdown file that might be under live review via the live-feedback plugin. Every review doc is backed by a file on disk; edits must flow through the MCP tools so the plugin keeps the live editor and the file in sync.
---

# Editing files that are under live-feedback review

The live-feedback plugin's mental model is one rule:
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
3. If you don't find one (or the live-feedback MCP isn't available),
   normal file edits are fine — the file isn't under review.

## How to edit via MCP

Pick the smallest tool that does the job:

- **Text edits inside existing prose** → `find_and_replace(docId,
  find, replace, { contextBefore?, contextAfter?, occurrence? })`.
  Works across all block types including table cells. Use
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
- **Insert a new block after a comment's block** →
  `insert_blocks_after_thread(docId, threadId, markdown)`. Accepts GFM
  including tables.
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

For external file changes you want to force-load (e.g. you wrote a
file directly because the doc isn't under review yet, then created
the review doc): call `reparse_from_disk(docId)` to discard live
state and reload from the file.

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

- The user said "review", "live feedback", or "the editor".
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
`reviewUrl` you can hand to a human.

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
