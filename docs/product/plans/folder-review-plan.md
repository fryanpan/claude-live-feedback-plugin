# Plan: Remote folder/worktree review (file tree + markdown + syntax‑highlighted source)

## Context

Today live‑feedback can bind **one markdown file** at a time (`create_review_doc`) and serve it as a WYSIWYG review surface; it can also bind HTML mockups and dev servers. Bryan wants to make a **whole folder/worktree** available for remote review from a Claude Code session, where the human sees:

- a **file tree on the left** showing the number of **unresolved comments per file** (rolled up per folder),
- **markdown** rendered WYSIWYG exactly as today,
- **source files** (TypeScript/JS, Java, Kotlin, Python, JSON) shown **read‑only with IDE‑style syntax highlighting**, with line‑anchored comments.

The unifying vision: from one Claude Code session, a reviewer can use live‑feedback on a **folder**, a **single file** (any supported type), an **interactive mockup**, or a **live dev server** — each appears in the project's list of artifacts to review, and the existing daily cleanup applies.

**Decisions locked with Bryan:**
- **Milestone 1 = the full review experience**: folder bind → file tree with counts → markdown WYSIWYG + read‑only syntax‑highlighted source. The landing‑page "project → artifacts" redesign and workspace cleanup tooling are a **fast follow (Milestone 2)**.
- **Source files are read‑only** (comment‑only; the agent edits code via Claude Code and the view re‑renders). Markdown stays WYSIWYG‑editable.
- **Verification target**: this repo (`claude-live-feedback-plugin`) — it has `.md`, `.ts`, and `.json` files.

**Key reuse opportunities found during exploration:**
- **CodeMirror 6 core is already a dependency** (`@codemirror/{state,view,commands,lang-markdown}`, `y-codemirror.next`) — leftover from the pre‑Tiptap MVP. Use it for the read‑only code surface; no new editor framework.
- The **`setId` sidebar** (`renderSetNav`, `#set-pane`, `body.has-set` grid) and the **landing‑page open‑count logic** (`rooms.listThreads(docId,{status:'open'})`) are the backbone for the file tree.
- The entire **thread/comment stack** is editor‑agnostic and reused unchanged: `ThreadPanel` (threads.ts), the REST thread routes, the text‑range anchor + auto‑reanchor machinery, and the doc→panel scroll fix (#52).

---

## Architecture (recommended approach)

### 1. Data model — `packages/core/src/types.ts`, `schema.ts`
- `DocType`: add `'code'` → `'markdown' | 'mockup' | 'dev' | 'code'`.
- `DocMeta`: add
  - `workspaceId?: string` — the bound folder's id (equals `setId` for folder members),
  - `relPath?: string` — POSIX path relative to the workspace root (drives the tree),
  - `workspaceRoot?: string` — absolute folder root (stored on every member so the tree is derivable without a registry).
- Persist exactly like `setId`/`owner` today (`initDocMeta`/`readDocMeta`). No separate workspace registry in M1 — derive workspaces from member docs (mirrors how the landing page derives its list from `rooms.list()`).

### 2. Folder binding — `bind_folder` (MCP) + `POST /api/workspaces`
- **MCP tool** `bind_folder(folderPath, workspaceId?, title?, include?, maxFiles?, subscribe?)` in `packages/mcp/src/mcp.ts` (mirror the `create_review_doc` case). After binding, it loops the returned files and `watch_doc`s markdown+code docs (cap by `maxFiles`).
- **Server route** `POST /api/workspaces` → new `rooms.bindFolder(...)` in `packages/server/src/rooms.ts`.
- **Scan strategy** (established `spawnSync` pattern already used in keychain.ts/public-host.ts):
  1. If folder is in a git repo: `git -C <folder> ls-files --cached --others --exclude-standard` → respects `.gitignore` for free (skips `node_modules`/`dist`/etc).
  2. Else: recursive `readdirSync(..., {withFileTypes:true})` with a hardcoded skip set (`.git`, `node_modules`, `dist`, `build`, `.next`, `coverage`, dotdirs).
- **Allowlist**: `.md`→`markdown`; `.ts .tsx .js .jsx .mjs .cjs .java .kt .kts .py .json`→`code`. `include[]` extends it. Skip files >512 KB or containing a NUL byte in the first 8 KB (binary sniff).
- **Guardrail**: if post‑filter count > `maxFiles` (default 300), return `{ok:false, error:'too-many-files', count}` **without creating docs** (don't melt the server with thousands of polls).
- **docId scheme** (docIds forbid `/`, allow `:`): `` `${workspaceId}:${relPath.replaceAll('/','~')}` ``. Deterministic ⇒ idempotent re‑bind preserves threads. If the encoded id would exceed the 100‑char cap, fall back to `` `${workspaceId}:${shortHash(relPath)}` `` (the tree reads `relPath`, not the docId).
- **Per file**: `getOrCreate(docId, {type, sourceUrl, setId:workspaceId, owner:cwd, workspaceId, workspaceRoot, relPath, title:relPath})`; markdown → existing `attachFile`; code → new `attachReadonlyFile` (below).
- **Idempotent/incremental**: re‑binding re‑scans; new files added; removed files flagged `missing:true` in the tree (not auto‑deleted — may hold unresolved comments). Returns the full tree each call.

### 3. Read‑only source surface — reuse the markdown‑app SPA
**One SPA, branch on `meta.type`.** No separate `code-app` (would duplicate `client.ts`, all of `threads.ts`, the composer/drawer/iOS‑keyboard code, and `styles.css`).
- **New files** under `packages/markdown-app/src/code/`:
  - `code-editor.ts` — `createCodeEditor(opts): ReviewSurface` (CodeMirror 6, `EditorState.readOnly` + `EditorView.editable.of(false)`, `lineNumbers()`, `syntaxHighlighting`, gutter markers). One‑way bind: observe the Yjs `content` Text → update the CM doc on change (no y‑codemirror two‑way; it's read‑only).
  - `languages.ts` — extension→language map with **lazy** `import()` of lang packs (only the opened file's language downloads).
  - `code-anchor.ts` — CM selection ↔ anchor ↔ CM range helpers.
- **Dependency additions** (`packages/markdown-app/package.json`): `@codemirror/lang-javascript` (TS+JS+JSX/TSX), `@codemirror/lang-java`, `@codemirror/lang-python`, `@codemirror/lang-json`, `@codemirror/legacy-modes` (Kotlin via `StreamLanguage` clike; plaintext fallback for anything unmapped).
- **Build** (`scripts/build.ts`): set `splitting:true` so lazy lang packs become separate chunks. **Risk to validate early**: confirm the hashed chunk URLs resolve under the `/app/*` static route; if not, pin `naming.chunk` flat. (Biggest unknown in the plan.)
- **`app.ts` boot**: define a slim `ReviewSurface` interface = the subset of `EditorHandle` the thread paths call (`getSelectionRel`, `resolveRel`, `scrollToPos`, `pulseRange`, `setThreadRanges`, `destroy`). Branch on `meta.type`: `code` → `createCodeEditor`; else → existing Tiptap `createEditor`. Gate out the format bar / edit‑mode toggle / Tiptap‑pill specifics behind `type === 'markdown'` (add a `body.code-mode` class for CSS).
- `ThreadPanel`, `client.ts`, the REST thread routes, the composer, and the #52 scroll‑to‑comment all work unchanged.

### 4. Anchoring source comments — reuse `text-range`/`RelativePosition`
Load the source file into the schema's flat `content` Y.Text (read‑only) and **reuse the existing `'text-range'` anchor** rather than inventing a `'line-range'` kind. This buys the whole re‑anchoring stack (orphan flow, snippet recovery, panel UI) for free, and the wire shape (`{kind:'text-range', startRel, endRel, snippet}`) is unchanged so the REST routes + panel need no edits.
- Selection → anchor (`code-anchor.ts`): CM `state.selection.main` gives `{from,to}` as offsets into the doc string, which is **byte‑identical** to the `content` Y.Text (seed CM from `content.toString()`, never from disk, to guarantee identity). Snap to line boundaries (`doc.lineAt`) so comments anchor to whole lines; build `Y.createRelativePositionFromTypeIndex(content, from/to)`; send as `number[]` (match the existing wire shape exactly — avoid the Uint8Array‑in‑plain‑object mangle noted in rooms.ts).
- Anchor → range: `Y.createAbsolutePositionFromRelativePosition` → CM offsets → highlight/scroll.
- **Gutter markers**: a CM `gutter()`/`StateField<DecorationSet>` keyed off resolved open‑thread ranges (the CM analog of `thread-decorations.ts`); active thread highlighted; clicking a marker calls `threadsPanel.revealThread(id)` + `scrollIntoView` + pulse — mirroring markdown.
- **Re‑anchor on agent edits**: add `autoReanchorCodeDoc(doc)` in `prose.ts` — the flat‑text twin of `autoReanchorDoc` (snippet `indexOf` on `content.toString()`; rebuild rel positions if unique). `wireEvents` branches by type to call the prose vs flat‑text sweep.

### 5. Read‑only file binding — `rooms.ts`
- `attachReadonlyFile(docId, abs)`: read file → `getContent(ydoc).insert(0, text)` (raw, no markdown parse) → arm the existing **mtime poll** (`armFileWatcher`) for disk→doc refresh. **Do NOT** wire the `observeDeep`→`scheduleFileWrite` write‑back (browser never edits; the file is never rewritten by LF).
- `reconcileFromDisk`/`reparseFromDisk` branch on `type`: for code, `currentSerialized = content.toString()` and on `apply` do `content.delete(0,len); content.insert(0, disk)` under a `'file-watch'` transact. `decideReconcile` (pure string compare) is reused as‑is; the `conflict` branch is effectively unreachable (no live edits) but harmless.
- `wireEvents`/`hydrateFromDisk` branch on `type` (call `autoReanchorCodeDoc`; rebind `code` rooms whose `sourceUrl` exists, like markdown today).

### 6. File tree UI + counts — `GET /api/workspaces/:id/tree`
- New endpoint generalizes the landing count logic into a reusable `buildWorkspaceTree(rooms, workspaceId)`: filter `rooms.list()` by `workspaceId`; per file compute `openCount = listThreads(docId,{status:'open'}).length`; build a nested dir tree from `relPath`; folders carry rolled‑up `openCount`; each file carries `{docId, name, relPath, fileType, openCount, threadCount, reviewUrl, missing?, lastActivityAt}`. Sort folders‑first, then open‑count desc.
- **`renderSetNav` (`app.ts`)** branches on `meta.workspaceId`: fetch the tree endpoint and render a **collapsible tree** into `#set-pane` using native `<details>/<summary>` (open/closed persisted in `localStorage` per `workspaceId:relPath`). File rows = `<a href={reviewUrl}>` + an open‑count badge (reuse the landing `.badge-open` pill); active = current docId; carry `?as=…` params. The flat `setId` path stays for legacy hand‑grouped sets. Reuse the `body.has-set` 240px grid unchanged.
- Counts are a navigation‑time snapshot in M1: refetch the tree on window focus and a ~30s interval (live per‑file push deferred).

---

## Files to create / modify

**Create**
- `packages/markdown-app/src/code/{code-editor.ts, languages.ts, code-anchor.ts}` — the read‑only CodeMirror surface + anchoring.
- (helper) `buildWorkspaceTree` + `bindFolder` — in `packages/server/src/rooms.ts` (or a small `workspace.ts`).

**Modify**
- `packages/core/src/types.ts` — `DocType += 'code'`; `DocMeta += workspaceId/relPath/workspaceRoot`.
- `packages/core/src/schema.ts` — read/init the new meta fields.
- `packages/core/src/prose.ts` — add `autoReanchorCodeDoc` (flat‑text snippet sweep).
- `packages/server/src/rooms.ts` — `bindFolder`, `attachReadonlyFile`, type‑branches in `attachFile`/`reconcile`/`wireEvents`/`hydrate`; pass new meta through `getOrCreate`.
- `packages/server/src/server.ts` — `POST /api/workspaces`, `GET /api/workspaces/:id/tree`; accept `type='code'` in the `/y/` WS + `POST /api/docs` attach branch; `withReviewUrl` for code.
- `packages/mcp/src/mcp.ts` — `bind_folder` tool def + dispatcher case + post‑bind `watch_doc` loop.
- `packages/markdown-app/src/app.ts` — editor‑type branch (Tiptap vs CodeMirror); `renderSetNav` tree branch.
- `packages/markdown-app/index.html` — `#set-pane` content → file tree container.
- `packages/markdown-app/src/styles.css` — tree indentation + count badges + `.cm-editor`/gutter + `body.code-mode`.
- `packages/markdown-app/scripts/build.ts` — `splitting:true`; `packages/markdown-app/package.json` — CM lang deps.

---

## Execution strategy (one PR)

Land the whole milestone as **one PR** (Bryan's call), built in this internal order as logical commits so the history is reviewable and each step is verified as it lands:
1. **Core model** — `DocType 'code'` + `DocMeta` fields + schema read/init (+ tests).
2. **Read‑only code doc plumbing** — `attachReadonlyFile`, reconcile/wireEvents/hydrate branches, `autoReanchorCodeDoc`, `type='code'` accepted by server/WS (+ server tests). Verifiable via API before any UI.
3. **Code surface in the SPA** — CodeMirror read‑only editor + languages + `app.ts` type branch + gutter/anchor; deps + `splitting:true` (validate chunk serving first). Verify a single `.ts`/`.json` file renders highlighted with line comments.
4. **Folder bind** — `bindFolder` + `bind_folder` MCP + `POST /api/workspaces` (+ tests, guardrails).
5. **File tree UI** — `GET …/tree` + `renderSetNav` tree + styles.

CI green + full verification (below) before requesting review; deploy via server restart after merge.

**Milestone 2 (fast follow, not in this plan's scope):** redesign the landing page into project → artifacts (folder/file/mockup/dev) with counts; `delete_workspace` MCP tool + `DELETE /api/workspaces/:id` (loop `deleteDoc` with the per‑file open‑thread guardrail); update `doc-triage-prompt.md` to treat a workspace as one cleanup unit (until then, triage will list code/folder docs per file — acceptable interim).

---

## Verification (end‑to‑end, against this repo)

Use `claude-live-feedback-plugin` itself as the test worktree.
1. **Per‑surface, via MCP + browser** (after PR 3): `create_review_doc` on a `.ts` file → open `/review/<docId>` → confirm syntax highlighting, read‑only, line numbers; select lines → leave a comment → confirm the gutter marker + that clicking the panel scrolls to the line and clicking the marker reveals the comment (mirrors #52). Repeat for `.json`. Open a `.md` file → confirm WYSIWYG still works.
2. **Agent‑edit re‑anchor**: edit the `.ts` file via the Edit tool → confirm the view re‑renders and the comment re‑anchors (or orphans cleanly) like markdown.
3. **Folder + tree** (after PR 5): `bind_folder` on `packages/core` (or `docs/`) → confirm the tree lists files grouped by directory with per‑file unresolved‑count badges and folder rollups; leave comments in two files → confirm counts update on refocus; click files to navigate between the markdown and code surfaces.
4. **Guardrails**: `bind_folder` on the repo root → expect the `too-many-files` guard (or a sane filtered count); confirm `node_modules`/`dist` are skipped.
5. **Tests**: new vitest (core: schema fields, `autoReanchorCodeDoc`, languages map; code‑anchor offset round‑trip) + server tests (`bindFolder` scan/allowlist/guardrail, tree counts, read‑only attach reconcile). Run full `vitest` + `bun test packages/server/test`, typecheck, biome; build all bundles; restart the supervised server and re‑verify in the browser.

## Risks
- **Lazy‑chunk serving** under `/app/*` with `splitting:true` — validate before building the surface on top of it.
- **Offset identity** (CM doc ⟺ `content` Y.Text) — seed CM from `content.toString()`, normalize CRLF/trailing‑newline once at attach.
- **`autoReanchorDoc` must not run on code rooms** (it walks the prose fragment) — the type branch in `wireEvents` is load‑bearing.
- **Kotlin** has no first‑party CM pack — `legacy-modes` clike is a degraded‑but‑acceptable highlight; plaintext fallback otherwise.
- **fs‑watch/SSE scale** at N files — 300‑file cap for M1; a single workspace‑level SSE channel is the deferred real fix.
