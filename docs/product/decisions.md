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
- Cloudflare Tunnel for stable public URLs.

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
- No real auth. Security boundary is the shared-link obscurity + (later) Cloudflare Access on the tunnel.

## 2026-04-17 — Widget bundle budget: 40 KB gzipped
- Enforced via `scripts/check-widget-size.js` in CI. Builds fail above the limit.
- Yjs alone is ~40KB; we may need to split Yjs out as a CDN peer-dep if the budget breaks. Document the break rather than silently exceeding.
