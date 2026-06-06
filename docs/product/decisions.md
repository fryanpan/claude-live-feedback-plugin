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
  `@appdevforall.org`) for a bounded window (default 72h).
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
