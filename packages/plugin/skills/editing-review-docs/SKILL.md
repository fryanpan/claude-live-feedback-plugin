---
name: editing-review-docs
description: Use whenever you're about to edit a markdown file or post structured findings via the live-feedback plugin. Edits to file-backed docs must flow through the MCP tools so the live editor and the file stay in sync; structured findings (UX issues, code-review notes, etc.) post via the create_anchor + post_reply primitive pattern.
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
- Disk → doc watching is wired both ways: external edits to the
  bound file (VS Code, `git pull`, another agent) propagate into the
  live doc within ~1 second via `fs.watch`. Echo loops are blocked
  by tracking `lastWritten` and the current serialized fragment.

**Therefore:** before editing any markdown file, check whether it's
under live review. If yes, edit through MCP tools so the live editor
shows your change immediately and Bryan sees it land in real time.
Direct file writes still work (the watcher reconciles), but the
agent appears in the live editor only when edits go through MCP.

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

- `Write` / `Edit` / `str_replace` on the `.md` while a reviewer is
  actively reading. The watcher reconciles, but Bryan sees a
  re-flow rather than your edit landing surgically. Use MCP tools
  for any change you want him to see arrive in real time.
- Run a formatter / linter that rewrites the file on disk during a
  live review session — the watcher will diff and reflow the whole
  doc, blowing up Bryan's scroll position. Run formatters after.

## Posting structured findings (UX issues, review notes, etc.)

When you're not editing prose but **adding a finding** — a UX
critique, a code-review note, an accessibility issue, a question
the human should answer — post it as a comment thread anchored to
the relevant text or DOM region. The pattern is two MCP calls:

1. `create_anchor(docId, find, { contextBefore?, contextAfter?, occurrence?, label? })`
   to pin a position in the doc / page.
2. `post_reply(docId, threadId, text)` after creating the thread —
   or use the widget's existing thread-create endpoint with the
   anchor you just minted.

Use this body shape for findings so the panel renders cleanly and
the next agent reading it can parse it without ambiguity:

```markdown
**Severity:** moderate · **Page:** /jobs/123

The "Apply" CTA disappears below the fold on iPhone 12 mini —
clipped by the sticky footer at viewport heights under ~700px.

**Suggested fix:** make the footer auto-hide on scroll under 768px,
or move the CTA above the fold in the layout component.
```

Why this pattern instead of a dedicated `post_finding_at_anchor`
tool: the MCP surface is intentionally small and primitive.
`create_anchor` + `post_reply` already compose into "agent posts a
finding"; adding bespoke tools per use case fragments the API and
hides what's actually a markdown-body convention. From the human
reviewer's panel, your structured finding looks identical to a
human-written comment — which is the design.

Use one of these labels in your `create_anchor` call so the
"All threads" panel groups findings by source: `"ux-finding"`,
`"code-review"`, `"a11y"`, or your agent's own short tag.

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
