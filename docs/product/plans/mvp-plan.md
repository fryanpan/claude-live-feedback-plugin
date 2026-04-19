# MVP Implementation Plan

**Spec:** [../../superpowers/specs/2026-04-17-live-feedback-design.md](../../superpowers/specs/2026-04-17-live-feedback-design.md)
**Approved:** 2026-04-17 by Bryan (autonomous execution authorized).
**Execution:** Single-pass, no mid-build checkpoints per project workflow-conventions.

## Measurable outcomes (from spec)

1. Two clients sync markdown edits in ≤500ms.
2. Text-range comment anchors survive edits elsewhere in the doc.
3. Element comment pins survive full-page reload on the widget demo.
4. Element pins survive Vite HMR on the dev-server demo; broken anchors move to Orphans panel.
5. Widget core ≤40 KB gzipped, CI-enforced.
6. Anonymous viewers see Bryan + agent live changes and can comment as `Anon-N`.
7. Host webhook URL receives standard JSON payload on comment events.
8. `/ux-review` passes Critical-clean on markdown app + mockup demo.

## Work breakdown

### Phase 1 — Foundation (sequential)

**1.1 Monorepo scaffold**
- `package.json` root with Bun workspaces (`packages/*`, `demos/*`, `cookbook/*`).
- `tsconfig.base.json` with strict mode.
- Root `biome.json` (or eslint+prettier) — pick Biome for speed.
- `.github/workflows/ci.yml` running: typecheck, unit tests, bundle-size check.
- `vitest.config.ts` at root.
- Stub READMEs in each package.

**1.2 Core package (`packages/core`)**
- Install: `yjs`, `y-protocols`.
- `src/types.ts` — `Anchor`, `Thread`, `Comment`, `User`, `DocMeta`.
- `src/schema.ts` — helpers to create/read the Yjs schema safely.
- `src/anchor/text-range.ts` — RelativePosition-based resolver.
- `src/anchor/element.ts` — fingerprint generator + resolver (adapted from health-tool).
- `src/anchor/index.ts` — unified `resolve(anchor, env)` that dispatches on `kind`.
- `src/identity.ts` — name + avatar hash from query param or localStorage.
- Unit tests for each resolver. Coverage target 80%+.

**1.3 Server package (`packages/server`)**
- Install: `@modelcontextprotocol/sdk`, `y-protocols`, `ws` (or Bun native WS).
- `src/server.ts` — Bun `Bun.serve()` with HTTP + upgrade for WS.
- `src/rooms.ts` — per-docId Yjs room management; on-disk persistence under `data/`.
- `src/sse.ts` — SSE endpoint that emits thread events.
- `src/webhooks.ts` — fire-and-forget POST to configured URL with retry on 5xx.
- `src/mcp.ts` — MCP server wiring the 7 tools to Yjs operations.
- `src/bin.ts` — CLI entry: `bun run packages/server/src/bin.ts --port 8787`.
- Unit tests for webhook dispatch, room lifecycle, MCP tool handlers.

### Phase 2 — Surfaces (parallelizable)

**2.1 Markdown app (`packages/markdown-app`)**
- Install: `@tiptap/core`, `@tiptap/starter-kit`, `@tiptap/extension-collaboration`, `@tiptap/y-tiptap`, `tiptap-markdown`, `@tiptap/pm`. (Original plan was CodeMirror 6 + remark preview; switched to a single WYSIWYG pane during review.)
- `src/app.ts` — entry, mounts into `#app`.
- `src/editor.ts` — Tiptap Editor + Collaboration extension (y-prosemirror under the hood).
- `src/thread-decorations.ts` — ProseMirror Decoration plugin for thread-range highlights.
- `src/preview.ts` — remark→HTML render side-by-side; mermaid pass.
- `src/threads/panel.ts` — right-rail thread list (open + orphans).
- `src/threads/pin.ts` — inline gutter pin on commented text.
- `src/threads/composer.ts` — new-comment popover.
- `src/presence.ts` — awareness-based cursor/selection rendering.
- HTML bootstrap, served by the server at `/review/:docId`.
- Unit tests on preview pipeline; integration test on thread flow.

**2.2 Widget (`packages/widget`)**
- Vanilla: no framework dep. Web Component `<claude-feedback-widget>`.
- Install: `yjs`, `y-protocols`. (Peer dep — see bundle discussion below.)
- `src/widget.ts` — Custom Element definition, Shadow DOM root.
- `src/selector.ts` — crosshair/hover outline mode for picking elements.
- `src/fingerprint.ts` — re-export from core (compiled into bundle).
- `src/ui/*.ts` — FAB, thread panel, comment popover (all in Shadow DOM).
- `src/bundle.ts` — ESM + IIFE entry.
- `scripts/check-widget-size.js` — hard-fail CI if `dist/widget.iife.js.gz` > 40KB.
- Integration test: inject widget into a happy-dom page, click element, comment persists.

### Phase 3 — Demos (parallelizable, depend on 2.2)

**3.1 Mockup demo (`demos/mockup`)**
- Single-page static HTML ("Mock checkout page" or similar) with widget script tag.
- Served by the main server at `/demos/mockup`.
- Seed data: one pre-existing open thread to show the UX.

**3.2 Dev-server demo (`demos/dev-server`)**
- Minimal Vite app (vanilla TS) with widget injected.
- README shows: start server, start vite, open, edit source, see HMR + anchor survival.

### Phase 4 — Integration (depends on Phase 1)

**4.1 Webhook cookbook (`cookbook/`)**
- `cookbook/README.md` — how to wire a host project's webhook endpoint.
- `cookbook/linear.ts` — example Linear GraphQL mapping.
- `cookbook/file-log.ts` — trivial reference (writes to a JSON file).
- `cookbook/echo-server.ts` — a Bun server you can run to see payloads during dev.

### Phase 5 — Verification

**5.1 Full test run**
- `bun test` — all packages green.
- `bun run typecheck` — no errors.
- `bun run build:widget && scripts/check-widget-size.js` — within budget.

**5.2 UX review**
- Invoke `/ux-review` skill via claude-in-chrome.
- Surfaces to review:
  - `/review/<docId>` (markdown app) — user goals: "read the doc", "leave a comment on a paragraph", "see agent's edits", "resolve a thread".
  - `/demos/mockup` (widget) — user goals: "leave a comment on a button", "see an open orphan after DOM change", "reply to an existing thread".
- Fix any Critical findings before PR.

**5.3 Code review**
- Run `code-review:code-review` locally on the branch before opening PR.
- Fix issues found.

**5.4 PR**
- `commit-commands:commit-push-pr`.
- PR body: summary of surfaces built, measurable outcomes status, bundle size report, screenshots from UX review.
- Ping conductor via hive with PR URL.

## Commit cadence

- Commit after each completed chunk (1.1, 1.2, 1.3, 2.1, 2.2, 3.x, 4.1, 5.x).
- Conventional commit messages: `feat(core): ...`, `feat(server): ...`, `test(widget): ...`.
- Single squashable series — don't amend.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Widget bundle > 40KB | First measure. If over: (a) mark Yjs as peer dep served from same origin, (b) tree-shake unused y-protocols, (c) if still over, document and propose next-session fix rather than hide it. |
| Tiptap collab ySyncPluginKey mismatch with y-prosemirror imports | Always import `ySyncPluginKey`, `absolutePositionToRelativePosition`, `relativePositionToAbsolutePosition` from `@tiptap/y-tiptap`, not `y-prosemirror`. Documented in decisions.md 2026-04-19. |
| Bun + MCP SDK ABI issues | Fallback plan: run MCP server as a separate Node process that talks to Bun server over localhost WS. |
| Mermaid SSR issues in Shadow DOM | N/A for MVP — mermaid only used in markdown app, which is NOT inside a Shadow DOM. |
| Anchor fingerprint false positives | Score threshold 40 matches health-tool's tested value. Log all low-score resolves for inspection. |
| HMR breaks widget state | Widget must re-resolve anchors on every mutation-observer tick; test this explicitly in dev-server demo. |

## Rollback

This is net-new code in a fresh repo. No rollback needed — revert the PR or reset the branch if anything is wrong.

## Out of scope (explicit)

- Linear integration code in this repo (host-side only).
- Redline accept/reject UI for markdown edits (stretch; skip if time-constrained).
- Multi-doc concurrent review UI (one doc at a time for MVP).
- Authentication beyond query-param identity.
- Mobile responsive polish beyond Fitts's Law compliance.
- Production deployment.
