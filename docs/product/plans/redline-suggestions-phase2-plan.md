# Suggested Edits (Phase 2) — implementation plan

Companion to [redline-balloons-plan.md](redline-balloons-plan.md), which defines the model (one editor, three lenses) and ships Phase 1 (balloon margin + editable redline). This plan makes **Suggesting** real: proposals from humans and agents that stay visible-but-unapplied until accepted.

## Measurable outcomes

1. **Proposal isolation:** an edit made in Suggesting mode (human) or via `suggest: true` (agent) is visible in the live doc immediately but NEVER appears in the .md on disk, the working tree, or any agent's file read until accepted.
2. **Accept / Reject:** accept applies the change (and it flows to disk through the normal write-back within ~1s); reject removes the proposal cleanly, restoring exactly the pre-suggestion text. Both work per-suggestion from the balloon/drawer, doc-wide (accept-all / reject-all), and via MCP.
3. **Attribution:** every suggestion shows its author (human name or agent name) and age; adjacent delete+insert by the same author in one operation reads as a single "replace X with Y" proposal.
4. **Concurrency safety:** a human typing in the same paragraph while an agent files a suggestion loses nothing (CRDT merge, pinned by test); two people accepting/rejecting the same suggestion concurrently converges (idempotent, second op reports not-found).
5. **API compatibility:** all existing tools unchanged; additions are `suggest: true` on `find_and_replace` and `rewrite_thread_region`, plus `list_suggestions` / `accept_suggestion` / `reject_suggestion` / `resolve_all_suggestions`. MCP bundle rebuilt + committed in the same PR.

## Data model

Two Tiptap/ProseMirror marks, stored in Yjs like any other mark:

- `suggestInsert` — proposed new text (present in the doc, excluded from serialization until accepted)
- `suggestDelete` — proposed removal (text stays in the doc, included in serialization until accepted)

Attrs on both (strings/numbers only — the Yjs attribute-type learnings apply): `sid` (suggestion id, groups the ranges of one proposal), `authorId`, `authorName`, `authorColor`, `ts`.

A **replace** is one `sid` spanning a `suggestDelete` range plus an adjacent `suggestInsert` range. A **whole-block insertion** is a block whose entire text carries `suggestInsert`. A **whole-block deletion** is a block fully marked `suggestDelete`; accepting it uses the existing block-deletion path so no empty shell is left behind (the `find_and_replace` empty-shell learnings).

## The serializer rule (the crux)

`prose.serializeFragmentToMarkdown` gains suggestion awareness:

- text with `suggestInsert` → **omitted**
- text with `suggestDelete` → **emitted without the mark**

So disk always holds the *accepted state*. Everything downstream — the working tree, git, CI, the diff member's poll, `lastWritten` bookkeeping, `decideReconcile`'s `currentSerialized` — already operates in serializer space, so they inherit the rule for free. That is precisely why the rule lives in the serializer and nowhere else.

**Consequences that need tests, not hope:**

- **Round trip:** parse(serialize(doc-with-suggestions)) equals the accepted state; suggestions never round-trip through disk (disk has no suggestion syntax — proposals live only in the .ydoc CRDT, which already persists and hydrates marks).
- **Reconcile:** an external disk edit to a block *without* suggestions applies normally; a block *with* suggestions whose accepted form matches disk is "unchanged" under the block-level LCS, so its marks survive. An external rewrite of a block that carries suggestions replaces the block — those suggestions are **dropped**; we record a `syncError`-style note listing the dropped sids (same recoverability philosophy as clobber-backups). A snippet-match re-anchor sweep for suggestions is explicitly out of scope for v1.
- **Undo:** suggestion transactions from agents run under a server origin the browser's `Y.UndoManager` doesn't track, so a human's Cmd-Z never reverts an agent's proposal (existing origin discipline covers this — pin with a test).

## Accept / Reject semantics

Ordinary Yjs transactions keyed by `sid`:

- **Accept:** strip `suggestInsert` marks (text becomes real); delete `suggestDelete` text; full-block deletions route through block deletion. The change flows to disk via the normal debounced write-back.
- **Reject:** delete `suggestInsert` text; strip `suggestDelete` marks.
- Both scan for the `sid`'s ranges at execution time (RelativePositions not needed — marks travel with the text through concurrent edits, which is the point of mark-based storage). Missing `sid` → `{ ok: false, error: 'not-found' }`, which is also the correct answer to the double-accept race.

## Surfaces

- **Editor:** a Suggesting toggle next to the existing edit-mode control (persisted per doc+user in localStorage). In Suggesting mode a ProseMirror plugin rewrites input: typed text gets `suggestInsert`; Backspace/Delete/cut over existing text marks `suggestDelete` instead of removing (the one genuinely fiddly client piece — `handleTextInput` + transaction filtering; budget review time here).
- **Rendering:** suggestions render in BOTH lenses (a pending proposal must never be invisible — hiding it in Clean would let "clean" mean "silently ignoring proposals"). `suggestInsert` = author-colored with pending styling; `suggestDelete` = author-colored strikethrough. The git-markup lens toggle affects only base-diff decorations.
- **Balloons (Phase 1 chrome):** one balloon per `sid` — author, age, rendered "replace X with Y", Accept / Reject buttons. Mobile: the `✎ suggestion` chip opens the drawer with the same card. If Phase 2 lands before Phase 1's margin ships, the drawer alone carries accept/reject — the two PRs are decoupled by design.

## Agent & HTTP API (three layers, per learnings — tool, route, rooms — plus route-level tests)

- `find_and_replace(…, suggest?: true)` and `rewrite_thread_region(…, suggest?: true)` → perform the same match, but write marked proposal instead of direct change; return `{ suggestionId }`. (Other edit tools can gain the flag later; these two are the judgment-call tools.)
- `list_suggestions(docId)` → `[{ sid, author, kind: insert|delete|replace, snippet, blockContext, ts }]`
- `accept_suggestion(docId, sid)` / `reject_suggestion(docId, sid)`
- `resolve_all_suggestions(docId, { action: accept|reject, authorId? })`
- SSE/watch events: `suggestion.created` / `suggestion.accepted` / `suggestion.rejected` on the doc channel, so the suggesting agent hears the verdict without polling.

## Execution (own PR, ordered commits)

1. Core: marks in the schema + serializer rule + round-trip/accepted-state unit tests (TDD; includes reverting-the-rule-fails proof).
2. Rooms: suggestion registry over marks (`listSuggestions`, `acceptSuggestion`, `rejectSuggestion`, `resolveAllSuggestions`) + concurrency/reconcile/undo pinning tests.
3. Routes + MCP: `suggest: true` plumbing through all three layers, new tools, HTTP-level tests, **`bun run build:mcp` + committed bundle**.
4. Editor: Suggesting input mode plugin + rendering both marks + toggle persistence.
5. Chrome: suggestion cards in drawer (works standalone) and balloons (when Phase 1 margin present); accept/reject wiring; SSE events.

**Risks:** the input-interception plugin (cut/paste/IME paths are where it will bite); serializer touches the most incident-prone path in the repo — every write-back/conflict/backup test from the flat-sync and sync-clobber suites runs against docs carrying suggestions; dropped-suggestions-on-external-rewrite is accepted-and-surfaced, not silently swallowed.

## Testing & deployment

- Unit: serializer accepted-state + round-trip; accept/reject/idempotency; whole-block accept leaves no empty shell.
- Integration (bun): suggestion never reaches disk pre-accept; accept flows to working tree; reject restores; concurrent human edit + agent suggestion merges; hydrate/restart preserves suggestions; external rewrite drops-and-reports.
- vitest DOM: Suggesting mode input produces marks; both lenses render suggestions; drawer card accept/reject.
- Real-browser + 430px pass before shipping (or post-deploy verification, stated in the PR).
- Deploy: standard + MCP bundle rebuild/commit; notify peer agents that `suggest: true` exists once live.
