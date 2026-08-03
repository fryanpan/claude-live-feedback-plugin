# Pre-share review: why LF clobbers files on disk (and what else to clean up)

**Date:** 2026-08-03 · **Trigger:** Bryan's report that "the LF server is clobbering what's on disk somewhat regularly," plus health-tool having repeated LF trouble. Two weeks of fleet transcripts reviewed; two confirmed clobber incidents reconstructed (2026-07-15 and today, 2026-08-03, both in health-tool — both on bound personal notes; doc ids/paths redacted here because this repo is public). No other fleet project hit LF problems in the window.

## 1. What actually happened (today's incident, reconstructed from the transcript)

1. **18:12–18:14** — agent makes ~12 `find_and_replace` edits (the *correct* method). Each schedules an 800ms write-back; `lastWritten` ends up holding the serializer's output.
2. **18:15:58** — agent wants a *comprehensive restructure* of the doc. There is **no MCP tool for a whole-doc rewrite**, so it falls back to `Write` on the bound file directly.
3. The mtime poll picks the write up and applies it — but sets `lastWritten` to the **raw disk bytes**, while the live fragment now serializes to the **normalized** form. From this moment `currentSerialized ≠ lastWritten` permanently, even though there are zero un-flushed live edits.
4. **18:20:33** — agent `Write`s the file again. Reconcile runs `decideReconcile`: disk ≠ lastWritten, disk ≠ currentSerialized, currentSerialized ≠ lastWritten → **`conflict`** (a false positive — the "divergence" is just serializer normalization). The conflict path "keeps live edits and reasserts them to disk": **LF flushes its stale in-memory copy over the agent's rewrite.**
5. **18:20:37** — agent calls `reparse_from_disk` to force disk in — but disk now holds LF's stale flush, so **the reparse pulls the stale version back into the live doc.** ("The LF write-back clobbered my rewrite — its stale in-memory copy flushed to disk and the reparse pulled that back.")
6. **18:24** — agent gives up and does the workaround that also appears verbatim in the 07-15 incident: `delete_doc` → `Write` → `create_review_doc`. Unbind, write freely, rebind.

The 2026-07-15 incident is the same shape: "live-feedback's background flush overwrote my rewrite on disk with the old version… the reliable fix is to unbind the doc, write the file freely, then rebind."

## 2. Root causes (three, compounding)

### RC1 — Serializer-space drift makes `conflict` fire falsely, chronically

`decideReconcile` compares raw strings, but its three inputs live in two different spaces: `disk` and (after an apply/reparse) `lastWritten` are raw file bytes; `currentSerialized` is the serializer's normalized output. Parse→serialize is not byte-identity (bullet style, escaping, spacing, setext→ATX…), so after **any** external edit is applied, the binding sits in a permanent pseudo-diverged state. Every subsequent external write is then judged a `conflict`, and the conflict policy — *live wins, reassert to disk* — becomes a clobber machine. The agent's own defensive `reparse_from_disk` makes it worse: reparse also sets `lastWritten` to raw bytes (rooms.ts:1314) and **does not cancel a pending conflict-scheduled write timer**, so the stale flush lands *after* the reparse.

### RC2 — The write-back is blind

`scheduleFileWrite` (rooms.ts:1435) serializes and `writeFileSync`s **without checking whether disk changed since we last read it**. Any external write landing inside the ~800ms debounce window is silently overwritten — no conflict decision, no log. Also: `writeFileSync` is not atomic (no temp+rename), and there is no backup of content being overwritten, so a clobber is unrecoverable.

### RC3 — There is no legitimate whole-doc rewrite path

The MCP surface offers surgical edits (`find_and_replace`, thread/anchor edits) but nothing for "replace the whole document." Agents doing restructures therefore reach for `Write` — the exact move the docs forbid — and then `reparse_from_disk`, which walks straight into RC1+RC2. The recurring `delete_doc → Write → create_review_doc` dance in transcripts is agents re-inventing the missing tool, at the cost of orphaning every comment thread.

### Secondary defects found in the same review

- **Observer leak:** `attachFile` adds a fresh `observeDeep` on every call and nothing ever `unobserveDeep`s (there is no `unobserve` anywhere in server/core). Re-attach (hydrate, re-run `create_review_doc`) stacks observers → duplicate write-backs on stale binding state, widening the RC2 window.
- **Hydrate gap:** for prose docs, `attachFile` only seeds when the fragment is empty and re-baselines the mtime poll — so **edits made while the server was down are never picked up**, and the next live edit overwrites them on disk. This violates the plugin's own contract ("the file is the source of truth at rest"). `attachReadonlyFile` handles this case; `attachFile` doesn't. Also `lastWritten` is left `undefined` on re-attach, which biases the next reconcile toward `conflict`.
- **`syncError` is invisible:** conflicts are recorded on the binding and surfaced only via `get_doc` — which nothing checks. No event is pushed to watchers; the human editor shows nothing.

## 3. Fix plan (in priority order)

| # | Fix | Closes |
|---|-----|--------|
| 1 | After every disk→doc apply / reparse, set `lastWritten = serialize(fragment)` (serializer-space, the fixed point) instead of raw disk bytes; `reparse_from_disk` cancels any pending write timer | RC1 |
| 2 | `scheduleFileWrite` stats before writing: if disk mtime moved since our baseline, reconcile first instead of blind-writing | RC2 |
| 3 | Safety net: if the bytes about to be overwritten ≠ `lastWritten`, snapshot them to `<dataDir>/clobber-backups/` and say so in the log + syncError | RC2 (recovery) |
| 4 | Atomic write-back: write temp file + `rename` | RC2 (partial writes) |
| 5 | New `set_doc_content` MCP tool (+ route + rooms method, HTTP-level test, rebuilt plugin bundle): whole-doc rewrite through the live doc via the existing block-level diff — anchors on untouched blocks survive, browser updates live, write-back flushes normally. Kills the `Write`+`reparse` and unbind/rebind workarounds | RC3 |
| 6 | `attachFile`: unobserve the previous observer on re-attach; on attach with a non-empty fragment, if disk ≠ live, apply disk (block-diff) — disk wins at rest | leak + hydrate gap |
| 7 | Return any pending `syncError` in edit-tool responses so agents see trouble at the moment they act | visibility |

Docs/skill follow-through (flagging explicitly since skills are behavior-bearing): `editing-review-docs` skill + MCP server instructions should say "for a full rewrite use `set_doc_content`" instead of documenting the unbind dance.

## 4. Broader pre-share review (beyond sync)

**Architecture**
- `rooms.ts` is 1,933 lines mixing room lifecycle, sync policy, edit ops, and workspace trees. Extract a `FileSyncManager` owning binding/observer/poll/reconcile — the observer leak becomes structurally impossible, and sync policy gets one testable home.
- The route layer still hand-copies params (learnings: "the route layer silently drops params"). A shared zod schema per endpoint, used by both the MCP tool and the route, would end that class.
- Two docs bound to the same file path is representable and would ping-pong write-backs. Index bindings by path; reuse or refuse.

**UX (things a new user will hit in the first hour)**
- **Read-mode trap:** in read mode, clicks and typing do nothing, silently. (This misled an agent-driven browser session into a wrong bug diagnosis this week.) Clicking into the page in read mode should hint "Read-only — tap ✎ to edit."
- **Sync trouble is invisible in the editor.** When a `syncError` is pending, the human should see a banner with a one-tap "Reload from disk" (human-facing `reparse_from_disk`).
- Orphaned-comment recovery and the outdated-comments flow are good — keep surfacing them.

**Functionality gaps observed in transcripts (non-clobber)**
- Whole-doc rewrite (fix #5 above) — by far the most demanded missing primitive.
- Known `find_and_replace` limitations (can't split list items, can't add inline marks) are already in learnings; they push agents toward raw `Write` too. Worth a backlog pass after #5 lands, since `set_doc_content` covers most of those cases as well.
