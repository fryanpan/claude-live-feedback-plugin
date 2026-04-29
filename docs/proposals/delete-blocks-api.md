# Proposal: Block-deletion API

> Status: draft, awaiting Bryan's review
> Triggered by: agent had to issue 12 separate `find_and_replace` calls to clear a section template, leaving 11 zero-width orphan blocks behind. `find_and_replace` is text-only and refuses cross-block ranges; nothing in the API removes a whole block.

## What's missing today

Current edit surface (in order of intended use):

| Tool                          | Granularity              | Cross-block? |
|-------------------------------|--------------------------|--------------|
| `find_and_replace`            | text within ONE block    | no — `cross-node` |
| `rewrite_thread_region`       | range anchored to thread | within block only — `cross-block` |
| `insert_after_thread`         | inline append            | n/a |
| `insert_blocks_after_thread`  | new blocks               | n/a |
| `edit_at_anchor` (replace)    | range at agent anchor    | within block |
| `seed_doc`                    | one-shot bulk write      | only on empty doc |

There is no way to **remove an entire block** (heading, list item, blockquote, paragraph, table) — let alone a range of blocks. Empty-string replace inside `find_and_replace` empties the block's text but leaves the empty block element behind, which the editor still renders as a blank line.

## How other editors solve it

| Editor       | Block-delete primitive |
|--------------|------------------------|
| **ProseMirror** | `tr.delete(from, to)` — range-based, doc positions; auto-merges across block boundaries when the range straddles them |
| **Tiptap**    | `editor.commands.deleteRange({ from, to })`, `deleteNode(typeOrName)`, `deleteSelection()` |
| **Slate**     | `Transforms.removeNodes(editor, { at, match })` — `match` is a function or path predicate |
| **Lexical**   | `node.remove()`, `$createRangeSelection().removeText()` |
| **Notion**    | block-id based; "delete block" or section-collapse-then-delete via slash menus |

Common shape: **range-based primitive** (`from` / `to` in some position space) plus convenience helpers for selection / current node. Modern block editors also expose **node-level removal** keyed on a node id or path so callers can delete one block without a range.

## Proposed surface

Three additions, smallest first.

### 1. `delete_block_at_anchor`

Single-block delete keyed on a thread or agent anchor. Direct successor to "I want to delete the thing the user pointed at."

```ts
delete_block_at_anchor({
  docId: string,
  threadId?: string,    // exactly one of threadId / anchorId required
  anchorId?: string,
}) → { ok: true; deleted: { tag, snippet } } | { ok: false; error: 'anchor-orphaned' | 'no-host-block' }
```

Implementation: resolve anchor → find host block via `walkProse` → `block.parent.delete(idx, 1)` inside one Yjs transaction. Same pattern as `insertBlocksAfterAnchor`.

### 2. `delete_blocks_in_range`

Primitive: delete all whole blocks in a range identified by two `find` strings.

```ts
delete_blocks_in_range({
  docId: string,
  startFind: string,           // text in some block — that block is the FIRST deleted
  endFind: string,             // text in some block — that block is the LAST deleted
  contextBefore?: string,
  contextAfter?: string,
  startOccurrence?: number,
  endOccurrence?: number,
}) → { ok: true; deleted: number } | { ok: false; error: 'no-match' | 'ambiguous' | 'inverted-range' | 'no-blocks' }
```

Both `startFind` and `endFind` use the same disambiguation as `find_and_replace`. The range is **block-inclusive** — the entire block containing the start match through the entire block containing the end match. Partial-block matches still cause whole-block deletion (this is intentional and reflects the agent's intent: "blow away the section that contains this string"). Refuses inverted ranges.

Threads anchored inside deleted blocks orphan as usual; `autoReanchorDoc` runs as it does today and the user gets the standard orphan indicator.

### 3. `delete_section`

Heading-aware convenience on top of #2. Highest leverage for "delete the X section" requests.

```ts
delete_section({
  docId: string,
  heading: string,             // exact text of the heading block
  level?: number,              // 1..6, optional disambiguation
  occurrence?: number,
}) → { ok: true; deleted: number; nextHeading: { level, text } | null } | { ok: false; error: 'no-match' | 'ambiguous' | 'not-a-heading' }
```

Behavior: locate the matching heading block; delete it plus all subsequent siblings until the next heading at level ≤ that heading's level (or end of doc). Returns the heading that ended the run (so the agent can confirm what it stopped at) or `null` if it ran to the end.

This is what would have collapsed the 12-call cleanup earlier into one call: `delete_section({ heading: "Specific routes that matter", level: 2 })`.

## Concurrency

All three wrap in `doc.transact(fn, 'agent')` like every other mutation, so a concurrent user edit composes via Yjs CRDT semantics. The concrete cases:

- **User deletes the same blocks first**: our `parent.delete(idx, count)` becomes a no-op for already-removed children; `deleted` count reports actual removals.
- **User splits a block while we're computing the range**: we resolve `startFind` / `endFind` against the current `walkProse` snapshot inside the transaction, so the indices are consistent.
- **User adds blocks between our start and end**: those blocks are within the deletion range and get deleted too. This is consistent with the agent's intent ("delete everything between these markers"); flag in the docstring so callers know.

## Errors

Single shared error vocabulary:

- `no-match` — find string not present
- `ambiguous` — multiple matches, no `occurrence` given
- `cross-block` already exists; remove it from `delete_*` tools (these are explicitly cross-block)
- `inverted-range` — end before start in `delete_blocks_in_range`
- `not-a-heading` — `delete_section` matched a non-heading block
- `no-host-block` — anchor resolves to a Y.XmlText that isn't inside a block (shouldn't happen, but matches existing convention)
- `anchor-orphaned` — anchor lost (existing)

## Where the code lives

- `packages/core/src/prose.ts` — three new exported functions (`deleteBlockAtAnchor`, `deleteBlocksInRange`, `deleteSection`) following the same shape as `rewriteRange` and `insertBlocksAfterAnchor`.
- `packages/server/src/server.ts` — three new POST routes under `/api/docs/:docId/`.
- `packages/mcp/src/mcp.ts` — three new tool definitions + dispatch.

Tests in `packages/core/test/prose.test.ts` (or wherever — happy to follow convention; I haven't looked yet).

## What I'd ship vs. defer

**Ship now:** `delete_section` (top of the list — covers the most common ask). `delete_blocks_in_range` (primitive — useful when no heading bounds the area, e.g. trailing template cruft).

**Defer:** `delete_block_at_anchor` (lowest urgency — `rewrite_thread_region` with empty replacement *almost* covers it; only meaningful gap is the lingering empty block, which `delete_section` workflows avoid anyway). I'd add it later when a user case demands it.

## Open questions for Bryan

1. Comfortable with **block-inclusive** semantics on `delete_blocks_in_range` (partial match → whole block goes), or do you want a stricter `cross-block` error path so the agent can't surprise itself?
2. Should `delete_section` accept a heading level *range* (e.g. "delete this h2 and stop at the next h2 OR h1") or always stop at ≤ same level (current proposal)?
3. Want me to also expose a `delete_blocks_in_range` variant that takes two thread/agent anchors instead of two `find` strings, for the "bracket two specific spots and delete between" workflow?
