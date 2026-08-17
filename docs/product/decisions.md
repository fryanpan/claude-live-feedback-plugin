# Product Decisions

Big decisions that future sessions should respect or revisit deliberately.

## 2026-04-17 — Public repo, branch protection on main
- All changes via PR, even single-file fixes.
- Bryan authorized public visibility because the tool is broadly useful (similar to notion-channel-mcp, github-claude-channel).

## 2026-04-17 — Lightweight widget injection
- The widget that ships into mockups and dev servers must be vanilla JS / web components only.
- Reason: it has to inject into anyone's site without conflicting with their framework choice.
- Bundle size is a hard constraint — measure and report on every PR that touches widget code.

## 2026-04-17 — Server stack: TypeScript + Bun
- Same pattern as notion-channel-mcp and github-claude-channel.
- No public tunnel. The server binds to localhost; reviewers reach it
  over the host's Tailscale or LAN hostname. See the 2026-04-19 entry
  below.

## 2026-04-17 — Realtime collaboration framework: Yjs
- Chosen over Liveblocks (SaaS lock-in), Automerge (weaker editor ecosystem), and building minimal (NIH).
- Transport: y-websocket over the project's Bun server (not a separate y-websocket-server process — we own the WS endpoint).
- Persistence: Yjs docs serialized to `data/<docId>.ydoc` on disk. Crude but works for MVP.
- Editor binding: y-codemirror.next for Surface 1's markdown editor.
- Revisit if: (a) Yjs alone blows the widget bundle budget beyond recovery, or (b) we need auth semantics Yjs can't represent naturally.

## 2026-04-17 — Widget runtime: Vanilla Custom Elements + Shadow DOM (no Lit)
- Confirmed over Lit (even though Lit is tiny). CLAUDE.md's "no framework deps" rule applies to the widget; vanilla is the safest interpretation.
- If DX hurts badly once we're mid-build, revisit — Lit would be an acceptable fallback with a small bundle hit.

## 2026-04-17 — Anchor strategy: layered
- Text-range anchors use Yjs `RelativePosition` — auto-adjusts across edits, free with the CRDT.
- Element anchors use a multi-attribute fingerprint scored against DOM (port of the health-tool algorithm, score ≥40/100 required).
- Broken anchors → Orphan panel. Users re-anchor by clicking a new target.
- Explicitly rejected: semantic/AI reanchoring (overkill for MVP), pure CSS selector (fragile), pure pixel coords (fragile to layout).

## 2026-04-17 — Linear / ticket integration is host-side
- This repo ships a generic webhook dispatch. The integrating project (health-tool, family-bike-map, whatever) supplies a URL and handles Linear/other side-effects there.
- Reference implementation lives under `cookbook/` — not imported by core, just copy-paste fodder.
- Reason: different projects have different ticket workflows; keeping this repo opinion-free makes it reusable.

## 2026-04-17 — Identity model for MVP
- `?as=bryan` and `?as=agent` query params pick a known identity.
- No param → `Anon-<short-random>` stored in localStorage.
- No real auth. Security boundary is Tailscale (only tailnet members
  can reach the host) or the LAN (only same-wifi devices). Shared-link
  obscurity within that boundary is fine.

## 2026-04-17 — Widget bundle budget: 40 KB gzipped
- Enforced via `scripts/check-widget-size.js` in CI. Builds fail above the limit.
- Yjs alone is ~40KB; we may need to split Yjs out as a CDN peer-dep if the budget breaks. Document the break rather than silently exceeding.

## 2026-05-07 — Cloudflare Access share for explicit external-team review (overrides the 2026-04-19 stance for this case)
- Default access remains Tailscale/LAN (the 2026-04-19 decision below
  still holds for normal review). What's new: an explicit, agent-driven
  publish step (`share_doc` MCP tool / `bun share` CLI) that creates a
  per-share Cloudflare Access app gated by email domain (e.g.
  `@partner-org.example`) for a bounded window (default 72h).
- Driver: Bryan started working with an external team that doesn't share
  a tailnet and needs to review markdown docs / interactive mockups /
  dev servers for a few days at a time. Adding everyone to the tailnet
  is the wrong tool for ephemeral external review.
- Architecture: MCP-first (the share command runs against the
  long-running live-feedback server, not as a foreground bun process);
  cloudflared runs as a launchd service alongside the existing
  notion-bridge / sentry-bridge tunnels; per-repo team config in
  `.claude/live-feedback.json`; TTL-based persistent shares with
  manual `unshare` for early teardown.
- See `docs/product/plans/cf-access-share-plan.md` for the plan and
  `docs/product/sharing.md` for the user-facing guide.

## 2026-04-19 — Access model: Tailscale or LAN, no public tunnels
- The feedback server binds to `localhost:<port>`. Reviewers reach it
  via the host's Tailscale hostname (e.g. `mac-mini.tailb53801.ts.net`)
  or its `.local` / LAN IP on the same wifi.
- `bun run scripts/serve.ts` prints all three URL forms on startup.
- Rejected: Cloudflare Tunnel (added complexity — named tunnel,
  DNS zone, cert, a local reverse-proxy router — for a private preview
  use case that doesn't need public-internet reachability). The
  trade-off is that reviewers must be on the tailnet or same LAN.
- Team expansion path: add teammates to the same Tailscale tailnet.
  No code changes needed; `serverUrl` is already a hostname the widget
  uses as-is.
- Public exposure remains an explicit user opt-in they can layer on
  themselves (tunnel, reverse proxy, whatever) — outside this repo's
  scope.

## 2026-04-19 — Editor: Tiptap (ProseMirror) + y-prosemirror, not CodeMirror
- Initial MVP used CodeMirror 6 + y-codemirror.next with a split raw /
  rendered preview. Bryan asked for WYSIWYG markdown on the first
  review pass — editing the rendered output directly, with standard
  keyboard and toolbar interactions for headings/lists/etc.
- Switched to Tiptap 3 with StarterKit (headings, lists, blockquote,
  inline code, code blocks, link) + tiptap-markdown for import/export
  + @tiptap/extension-collaboration for Yjs sync.
- Content storage moved from `Y.Text content` to
  `Y.XmlFragment prose`; legacy docs are migrated on first open via a
  `meta.seeded` sentinel so we never double-seed across reloads.
- `ySyncPluginKey` must be imported from `@tiptap/y-tiptap`, NOT from
  `y-prosemirror` — Tiptap's Collaboration extension registers its
  plugin under the @tiptap/y-tiptap key, and using y-prosemirror's
  gets a different key instance, so getState() always returned
  undefined and the Comment button always reported "no selection".
  This footgun cost two debug sessions; noting for future sessions.

## 2026-06-06 — Concurrent-edit safety: merge (CRDT) + non-destructive disk reconcile
- A peer reported an agent's `find_and_replace` clobbering a human's
  in-progress browser edits on a bound doc. Root-cause investigation
  showed the in-memory path is already safe: every agent edit
  (`findAndReplace`, `rewriteRange`, `insertAfterRange`,
  `insertBlocksAfterAnchor`) runs as a targeted Yjs transaction on the
  same live doc the browser syncs to, so concurrent edits CRDT-merge —
  they do not overwrite. Pinned by a ws.test.ts test (browser edits one
  paragraph while the agent rewrites another; both survive on disk).
- Chose **merge over lock/reject** for the agent-vs-human contract.
  Locking or reject-on-conflict would fight the product's core goal
  (real-time co-editing); CRDT merge already delivers it.
- The real server-side data-loss vector was `reconcileFromDisk`, which
  destructively replaced the whole live fragment whenever the file
  diverged on disk — clobbering un-flushed live edits if an external
  write collided with them. Centralized the policy in a pure, unit-tested
  `decideReconcile()`: when an external change collides with un-flushed
  live edits, **keep the live edits** (the editor is the runtime source of
  truth) and reassert them to disk; record a `syncError` so the dropped
  external change is observable and recoverable via `reparse_from_disk`.
- Nested-list serialization uses a **2-space-per-level indent** convention,
  read back by leading-space count, so the serialize→parse round-trip is
  lossless. Picked 2 spaces (vs 4) to match the editor's typical output;
  the parser accepts any indentation increase as a deeper level so
  human-authored 4-space markdown still nests correctly.

## 2026-07-10 — Editor link-open (Cmd+Click) + table editing UI
- **Links stay non-navigable on a plain click** (`openOnClick:false`) so the
  cursor can be placed inside a link to edit it; a **Cmd/Ctrl+Click opens** the
  link in a new tab instead. Bound as a DOM `click` listener on the editor view
  (works in both edit and view mode) rather than via the Link extension's
  built-in open, which has no modifier-gated mode. Script-bearing schemes
  (`javascript:`/`data:`/`vbscript:`) are filtered by a pure `safeLinkHref()`;
  everything else (http(s), mailto, tel, relative, anchors) opens.
- **Table create/edit uses `@tiptap/extension-table` (prosemirror-tables)** —
  the framework was already a dependency and wired into the editor; only UI was
  missing. Per Bryan's constraint we did NOT hand-roll a table engine. Added a
  `▦` format-bar button opening a contextual popover: "Insert table" (3×3 with
  header row) always, plus row/column add + delete-row/column/table when the
  cursor is inside a table. Items come from a pure `tableMenuItems(inTable)`
  helper; each dispatches the matching Tiptap chain command. The popover is a
  fixed-position element in `<body>` so it escapes the format bar's
  `overflow:hidden`. Tables round-trip to disk as GFM via the existing
  `serializeTable`/`mkTable` path in `packages/core/prose.ts`.

## SPA navigation: MountScope.listen() over raw `{ signal }` (2026-07-17)

- **Decision:** `MountScope` exposes a `listen(target, type, handler, opts)`
  helper that registers the DOM listener with `{ signal }` AND records an
  explicit `removeEventListener` cleanup, rather than the plan's original
  "register listeners with `{ signal: scope.signal }` directly."
- **Why:** The test env (happy-dom 15.11.7) ignores `options.signal` in
  `addEventListener` (`EventTarget.js` only reads `once`/`capture`), so
  signal-based teardown is untestable there — and Tasks 3/5/6 tests all assert
  "no fire after dispose." Upgrading happy-dom risks a ripple across 27 test
  files. The helper makes teardown work identically in happy-dom, old browsers,
  and modern ones; the redundant remove is a harmless no-op where the signal
  already fired. `signal` stays public for fetch/AbortController-aware libs.
- **Impact:** Every per-doc listener in Tasks 3/5/6 uses `scope.listen(...)`
  instead of `{ signal: scope.signal }`. Reversible.

## SPA navigation: single setActiveFile in diff-nav.ts (2026-07-17)

- **Decision:** `setActiveFile(docId)` lives only in diff-nav.ts (not also
  workspace-tree.ts as the plan's Task 4 listed). The router imports it from
  there.
- **Why:** Both nav surfaces render into the SAME containers (#set-pane-list
  and the mobile #doc-menu) with the same `/review/<docId>` href shape, so the
  active-marker move is one identical DOM operation. Duplicating it (or
  re-exporting) adds code without behavior. It also no-ops when the target
  docId isn't present, so it's safe to call regardless of which surface
  rendered the tree.
- **Impact:** Reversible. If the two surfaces ever diverge in container/href
  shape, split then.

## 2026-08-03 — Diff-review live editors: companion doc for `.md`, editable flat for code

Chose approach C (companion `type:'markdown'` doc per changed `.md` member +
editable flat `content` for code members) over flipping member doc types or
dual-surface docs. Rationale: `contentKind` drives every server branch
(`get_doc`, thread find paths, reconcile), so changing a member's type
silently rewires the agent API and orphans content-offset threads; a
companion doc reuses the whole prose sync stack and the only new machinery —
flat write-back with a conflict arm — is required for code editing anyway.
`.md` members do NOT get flat write-back (single-writer per file: edits flow
through the companion doc). Reversible; revisit if the two-doc UX confuses.

## 2026-08-17 — A workspace is the unit of sharing; per-doc sharing is removed

**Decision (Bryan, verbatim):** "Remove all code for sharing docs, reviews and
so on individually. Share a workspace. And for anything already shared, please
work with owning agent to attach it to a workspace or work with the agent to
wind down the share."

**What went:** the `share_doc` MCP tool, `POST /api/share/doc`, `share_link`'s
`docId` argument, `Shares.createShareDoc`, `CreateShareDocReq`, and
`ShareSurface`'s `'doc'` member. `Share.workspaceId` is now required, and
`shareScopeAllows` refuses everything — including the app shell — for a target
that names no workspace. The "target.docId is always in scope" base case in
the gate WAS the per-doc grant; removing it is what makes the removal
structural rather than cosmetic.

**What stayed, and why it is not per-doc machinery:** visitor identity, the
private-meta sidecar and `redactMetaForVisitor`, `redactHubEvents`, the
Access-mode gate and `cf-api`, TTL enforcement, `link-session`, the
`sharing.json` master switch, `set_share_ttl` / `unshare` / `list_shares` /
`set_sharing_enabled`. Every one of them is needed *more* by workspace
sharing, which reaches more content per grant. They sit in
`packages/server/src/share/` because that is where sharing lives, not because
they were doc-scoped.

**Nothing had to be wound down.** Measured before removing anything: prod's
`data/shares.json` was `[]`, `sharing.json` was `{"enabled": false}`, and the
launchd service sets only `CF_SHARE_PUBLIC_HOSTNAME` — no `CF_ACCOUNT_ID` or
`CF_ACCESS_TEAM_DOMAIN`, so `cfApi` is null and no Cloudflare Access app could
ever have been created to outlive the local registry. The registry file is the
only place a share was ever persisted.

**Legacy records are dropped, not honoured.** `Shares.load` filters out any
record with no `workspaceId` and rewrites the file, because the gate reads the
registry rather than the code that wrote it — removing the mint path alone
would have retired the feature everywhere except where it is exercised.

**Older callers get a sentence, not a 404.** Every peer keeps calling the
shared `:8787` routes with the payload ITS bundle sends. `POST
/api/share/doc` and a `docId` in `POST /api/share/link` both answer 410
`per_doc_sharing_removed` with the replacement named. The guard tests for the
`docId` KEY rather than a truthy value, because the old bundle sends the same
five-field body for a workspace share with `docId: undefined` — which
`JSON.stringify` drops, so an old peer's workspace shares keep working.

**Not settled here, deliberately:** whether a folder bind / diff review
*grouping* counts as a "workspace" for sharing, or whether only a hub board
does. The product's own vocabulary calls groupings "doc groupings" and
reserves "workspace" for a hub board, which would read "reviews … individually"
as covering them too — but that change requires every review to be reachable
through a board first, and that is a product prerequisite rather than a
deletion. Tracked separately.
