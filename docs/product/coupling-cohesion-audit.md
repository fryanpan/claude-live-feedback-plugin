# Coupling & cohesion audit — the six review surfaces

What live-feedback shares across its surfaces today, what's implemented twice,
and where the cheap simplifications are. Surfaces considered: **markdown doc**,
**file folder** (code docs), **git diff** (live + pinned), **HTML mockup**,
**dev server**, **production site**.

## TL;DR

- The **data plane is genuinely unified**: one Yjs doc shape, one thread REST
  API, one SSE/watch channel, one identity module. Every surface speaks the
  same wire. This is the architecture's real asset — don't touch it.
- The **client plane is two parallel worlds**: the markdown-app SPA
  (markdown/code/diff) and the injectable widget (mockup/dev/production)
  re-implement the same concepts — websocket client, thread panel, composer,
  helpers — with zero shared rendering code (~350–400 duplicated lines).
- The **server has one god object**: `rooms.ts` (2,148 lines) mixes seven
  concerns, and doc-kind behavior is scattered across 16 `type === '…'`
  branch sites instead of one derived concept.
- **Two things are fictional**: `type:'dev'` is dead code (the dev-server
  surface actually runs as `mockup`), and the production-site flow (Linear
  tickets) has no code in this repo at all — it's vision-doc prose.

## 1. The concept × surface matrix

| Concept | markdown | code (folder) | diff | mockup | dev server | production |
|---|---|---|---|---|---|---|
| Room / persistence / SSE / webhooks | shared | shared | shared | shared | =mockup | — none in repo |
| Content storage | `prose` XmlFragment | `content` Y.Text | `content` Y.Text | none (page is host) | none | — |
| File binding | 2-way (write-back + poll) | read-only poll | live: read-only poll · pinned: none | serve HTML per request | none | — |
| Anchors | text-range (rel-pos) | text-range, line-snapped | text-range, line-snapped | element fingerprint | element | element (aspirational) |
| Orphan / re-anchor | persisted + auto-reanchor + UI | same | same | **transient, client-only, no re-anchor** | same | — |
| Threads data + REST | shared | shared | shared | shared | shared | — |
| Threads UI | ThreadPanel (SPA) | ThreadPanel | ThreadPanel | **widget's own panel** | widget's | — |
| Composer / pill | SPA (app.ts) | **duplicated in code-app.ts** | =code | **widget's own** | widget's | — |
| WS client | markdown-app/client.ts | same | same | **widget/client.ts (admitted copy)** | same | — |
| Multi-page context (url/view) | n/a | n/a | n/a | AnchorContext | AnchorContext | — |
| Grouping | setId | workspace (bind_folder) | workspace (bindDiff) | none | none | — |
| Agent edit tools | find_and_replace + thread-region tools | none (edit via repo) | none | none | none | — |
| Agent find→thread | prose resolver | flat-text resolver (new) | flat-text | n/a (element) | n/a | — |

Bold = the coupling/duplication hot spots.

## 2. The shared kernel (keep, protect)

1. **`@feedback/core` schema + types** — `meta`/`content`/`threads` Y.Doc
   shape, `createThread`/`postReply`/`setStatus`/`markOrphan`, the `Anchor`
   union. Every surface reads and writes the same structure.
2. **Thread REST routes** — create/reply/resolve/reopen are docId-keyed and
   never branch on doc type (`server.ts:407-473`). The widget and both
   editors post byte-identical bodies; only `anchor.kind` differs.
3. **SSE `/events/:docId` → MCP channel** — one watch mechanism for every
   surface; `watch_doc`, webhooks, and the activity log are kind-agnostic.
4. **`identity.ts`** — `resolveUser`/`hashToColor` used verbatim by both
   front-ends.
5. **`ReviewSurface`** (markdown-app) — the 6-method seam that let the code
   surface, and now the diff surface, reuse the whole thread flow. This
   abstraction earned its keep twice; it's the model to extend.

## 3. Parallel implementations (the duplication inventory)

**Across the two front-ends (widget vs markdown-app):**

| What | Where × where | Size |
|---|---|---|
| Yjs websocket client | `widget/src/client.ts` vs `markdown-app/src/client.ts` — the widget file's header admits it's a copy; they've already drifted (awareness-on-open exists in one only) | ~120 lines |
| Thread panel (open/orphan/resolved grouping, rows, reply, resolve) | `widget.ts:579-728` vs `threads.ts` ThreadPanel | ~80 vs ~150 lines |
| Composer | `widget.ts:424-458` vs `app.ts` composer wiring | ~35 vs ~70 lines |
| `formatTime`, HTML-escape, status→color palette | both, near-verbatim | ~40 lines |
| Stylesheets | `widget/styles.ts` (310 L shadow DOM) vs `styles.css` (1,700+ L) — overlapping thread/row/status styling, no shared tokens | conceptual |

**Inside the markdown-app:**

- `app.ts` (1,473 L) and `code-app.ts` (652 L) duplicate the composer,
  comment pill, threads drawer, mobile full-screen thread view, toast,
  `formatTs`, and doc-label logic (~450 overlapping lines). `ReviewSurface`
  abstracts the *editor*, but the *boot wiring* around it was forked when
  the code surface landed and forked again would be the default for any
  next surface.

**Inside the server:**

- `rooms.ts` (2,148 L) holds seven concerns: room lifecycle/persistence,
  markdown 2-way file binding, read-only binding, folder scan/bind, diff
  bind + git, thread ops + find/edit tools, workspace tree/triage, activity.
- 16 sites branch on `meta.type`. Most encode one derived concept —
  *which content surface does this doc use* — re-derived ad hoc each time
  (`getDoc`, `wireEvents`, `reparseFromDisk`, `reconcileFromDisk`,
  `hydrateFromDisk`, `createThreadByFind`, `withReviewUrl`, `POST /api/docs`
  validation…).
- `bindFolder` and `bindDiff` duplicate the accept/skip/guardrail/
  deterministic-docId/getOrCreate loop with different file-list sources.
- `createThreadByFind` now contains two find implementations (prose walk vs
  flat text) selected by type — the second added during the diff build
  because the first silently no-matched on flat docs.

## 4. Concept debt

- **`DocType` conflates two axes.** What renders (markdown editor / code
  viewer / diff viewer / host-page widget) and how content binds (2-way
  file, read-only poll, pinned git blob, served HTML, none) are independent,
  but both hide inside one enum plus inference (a diff doc's live-vs-pinned
  mode is inferred from `diffTarget` presence; a code doc vs a live diff
  doc differ only in rendering). Each new surface multiplies the branch
  sites instead of filling in a 2-axis table.
- **`type:'dev'` is dead.** The widget hardcodes `type:'mockup'`
  (`widget.ts:247`); nothing produces `'dev'`; `withReviewUrl` has no branch
  for it. The mockup/dev distinction is real in *workflow* but not in code.
- **Element-anchor orphans are half-built relative to the type system.**
  `OrphanAnchor` persistence, auto-reanchor, and the re-anchor UI exist only
  for text-range anchors; the widget's orphan state is transient and has no
  re-anchor affordance. The "outdated comments" story is only true on the
  text surfaces today.
- **Production-site flow is vision-only.** No Linear/health-tool code here;
  reuse is aspirational. Fine — but the docs should say so explicitly.
- **Legacy leftovers**: `editor.ts` still migrates the pre-Tiptap
  `content` Y.Text on every markdown boot; comments in `review-surface.ts` /
  `workspace-tree.ts` still describe the old CodeMirror path.

## 5. Ranked opportunities

| # | Change | Value | Effort | Risk |
|---|---|---|---|---|
| 1 | **Share the Yjs WS client** — move to `@feedback/core` (tree-shakeable, no DOM deps) and consume from both bundles; reconcile the awareness-on-open drift | High — 120 actively-drifting protocol lines | S | Low |
| 2 | **`contentKind(meta)` helper** in core → `'prose' \| 'flat' \| 'none'`; collapse the ~16 server branch sites to one lookup each | High — makes the next doc kind a table-row, not a grep-hunt | S | Low |
| 3 | **Extract shared review-boot wiring** in markdown-app: one boot that takes a `ReviewSurface` factory; `app.ts`/`code-app.ts` shrink to their genuinely different parts | High — stops the 450-line fork from tripling | M | Med |
| 4 | **Split `rooms.ts`** into modules (bindings, workspace-binds, thread-ops, edit-tools, persistence) — mechanical, no behavior change | Med — reviewability, safer future diffs | M | Low |
| 5 | **Unify `bindFolder`/`bindDiff`** around a shared bind-file-set core (file-list source becomes a parameter) | Med | S–M | Low |
| 6 | **Delete `type:'dev'`** (or implement it for real; deleting is right until a dev-specific behavior exists) + drop the legacy pre-Tiptap migration after checking persisted docs | Low–Med — removes standing traps | S | Low |
| 7 | **Trivial helper sharing** — `formatTime`, escape, status-color tokens into core | Low | XS | ~0 |
| 8 | **Element-anchor orphan parity** — persist element orphans, add fingerprint re-match (the element twin of `autoReanchorDoc`) + widget re-anchor UI | Med–High for mockup/dev UX | L | Med |
| 9 | **Thread-panel unification across widget ↔ SPA** | High in theory | L | **High** — shadow-DOM pins vs sidebar tabs are different UX models; bundle-size constraint. Do #7/#1 first; revisit only if both UIs need the same new feature again |

**Suggested sequencing:** 7+1 (one small PR), 2+6 (one small PR), then 3, then
4+5 (one PR). 8 and 9 are product decisions, not cleanups — they should ride
on real demand for mockup-surface review quality.

**The hard constraint** on all of it: the widget must stay a small,
dependency-free IIFE injectable into any host page. Anything hoisted into
core for sharing must be tree-shakeable and free of Tiptap/CodeMirror/server
imports.

## 6. What NOT to do

- Don't merge the two front-ends or introduce a shared UI framework — the
  widget's injection constraint and the SPA's editor richness genuinely
  differ; the wire-level sharing is the right coupling point.
- Don't build a doc-type plugin registry / interface hierarchy. Five kinds
  with a `contentKind` helper is the right altitude; a registry is
  speculative generality.
- Don't chase element/text anchor lifecycle unification into one abstraction
  — the mechanics (DOM fingerprints vs CRDT relative positions) share only
  vocabulary. Parity of *behavior* (opportunity 8) beats unity of *code*.
