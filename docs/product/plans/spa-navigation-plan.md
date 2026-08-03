# In-Place File Navigation (no-reload SPA) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. This plan is self-contained — it assumes no memory of the conversation that produced it.

**Goal:** Clicking a file in a review's sidebar swaps the open document in place — new URL via `history.pushState`, editor + comments rebuilt for the new file — with **no full-page reload** and the **sidebar left untouched** (scroll position and all). Back/forward work.

**Architecture:** The app is currently a multi-page app: one docId = one page = one Yjs WebSocket + one editor, wired by a ~990-line `boot()` in `app.ts` (plus `bootCode` / `bootRedline`) that registers ~15 global `document`/`window` listeners as closures over a single `docId`. Today the only teardown is `beforeunload`. This plan splits each boot path into (a) a **persistent shell** mounted once (keyboard inset, sidebar, router) and (b) a re-runnable **per-doc mount** that registers every listener against an `AbortController` and returns a teardown. Navigation = `pushState` → teardown old mount → mount new docId. The sidebar renders once and only its `active` marker moves.

**Tech Stack:** TypeScript (strict), Bun, Yjs, Tiptap 3 / ProseMirror, CodeMirror, vitest + happy-dom, biome.

## Global Constraints

- TypeScript strict. No `any` (`unknown` + narrowing).
- Tests: `bun run test:vitest` (vitest, happy-dom) and `bun run test:server` (`bun test packages/server/test`). CI job is `verify`. **Never run `bun test` against a vitest suite** — it needs happy-dom.
- Lint/format: `bun run lint` (biome). Typecheck: `bun run typecheck`.
- **Verify with real exit codes**, never `cmd | tail` (a pipe hides the exit code — this bit twice in the prior feature). Use `cmd && echo OK || echo FAIL`, or `set -e`.
- Mobile is load-bearing — verify at 430px per `docs/product/design-mobile.md`. On mobile the sidebar is an overlay; a file click must also close the drawer.
- Work in a git worktree so the prod checkout at `/Volumes/Data/Users/bryanchan/dev/claude-live-feedback-plugin` stays clean on `main`. Do NOT touch the uncommitted `.claude/rules/security-posture.md` or the untracked `demos/` files there.
- Do NOT develop against the fleet-shared prod server on `:8787`. Use an isolated dev instance (`bun run packages/server/src/bin.ts --port 8796`).
- The three boot paths (`app.ts` markdown, `code/code-app.ts`, `redline/redline-app.ts`) must all become teardown-safe. A partial conversion leaks listeners on the paths left behind.

## Key facts established before writing this plan

- **Layout already supports it.** `packages/markdown-app/index.html`: `#shell` contains `#set-pane` (sidebar, line 81), `#editor-pane` (line 85, holds `#editor`), and `#threads-pane` (line 162) as siblings. The sidebar is already outside the editor region — it does not need to move in the DOM, only to stop being re-rendered on navigation.
- **`connect()` cleans up after itself.** `packages/core/src/ws-client.ts:33` creates the `Y.Doc` + awareness and registers `ydoc.on('update')` / `awareness.on('update')`; `close()` (line 147) sets `closed = true` and closes the socket. **Gap to fix (Task 2):** `close()` does not call `ydoc.off` / `awareness.off` / `awareness.destroy()` / `ydoc.destroy()`, so a torn-down client's handlers linger. Must be fixed or every navigation leaks a Y.Doc.
- **Global listeners that must tear down:** `app.ts` has 15 (`document.addEventListener` / `window.addEventListener` / `beforeunload`); `code-app.ts` 1; `redline-app.ts` 1; `review-chrome.ts` has a persistent `document.addEventListener('keydown')` at line 561 (the pointermove/pointerup at 654-655 are inside a drag handler and self-remove on pointerup — leave them). Every one in the per-doc region must be registered with `{ signal }`.
- **The sidebar links are plain `<a href="/review/<docId>?...">`** with no click handler (`diff-nav.ts:158`, `:239`; `workspace-tree.ts:59`). The browser navigates natively. Interposing a capturing click handler on the sidebar container is the whole router entry point.
- **`el<T>(id)`** (`review-chrome.ts`) is `getElementById` + assert. Safe to call repeatedly.

## File Structure

**Create:**
- `packages/markdown-app/src/mount-scope.ts` — the `MountScope` lifecycle primitive (AbortController + ordered cleanups).
- `packages/markdown-app/src/router.ts` — sidebar click interception, `pushState`/`popstate`, and the mount/teardown swap loop.
- `packages/markdown-app/test/mount-scope.test.ts`
- `packages/markdown-app/test/router.test.ts`

**Modify:**
- `packages/core/src/ws-client.ts` — `close()` fully detaches Yjs handlers.
- `packages/markdown-app/src/review-chrome.ts` — `mountReviewChrome` accepts a `MountScope`, registers its keydown with the signal, and returns a `destroy()` on `ReviewChrome`.
- `packages/markdown-app/src/app.ts` — split `boot()` into one-time `main()` + per-doc `mountMarkdown(ctx)`; every listener uses the scope signal; return teardown.
- `packages/markdown-app/src/code/code-app.ts` — `bootCode` → `mountCode(ctx)` with scope + teardown.
- `packages/markdown-app/src/redline/redline-app.ts` — `bootRedline` → `mountRedline(ctx)` with scope + teardown; drop the toggle's `location.reload()` in favour of a router navigation.
- `packages/markdown-app/src/diff-nav.ts`, `workspace-tree.ts` — render once; expose a `setActive(docId)` that moves the `active`/`aria-current` marker without re-rendering; preserve `#set-pane-list` scroll.

## The shared type (referenced by every task)

```ts
// The context every per-doc mount receives. Assembled once by main() per
// navigation.
export interface MountContext {
  docId: string;
  scope: MountScope;           // Task 1
  docType: 'markdown' | 'code' | 'diff';
  sourceUrl: string;
  workspaceId: string;
  relPath: string;
}

// Every mount function returns nothing; it registers its teardown on the scope
// (scope.onCleanup(...)). The router calls scope.dispose() to unwind.
export type MountFn = (ctx: MountContext) => Promise<void> | void;
```

---

### Task 1: `MountScope` — the lifecycle primitive

**Files:**
- Create: `packages/markdown-app/src/mount-scope.ts`
- Test: `packages/markdown-app/test/mount-scope.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class MountScope {
    readonly signal: AbortSignal;
    /** Register a teardown, run LIFO on dispose(). */
    onCleanup(fn: () => void): void;
    /** True once dispose() has run — guards late async work. */
    get disposed(): boolean;
    /** Run all cleanups (LIFO) then abort the signal. Idempotent. */
    dispose(): void;
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { MountScope } from '../src/mount-scope.ts';

describe('MountScope', () => {
  it('aborts its signal on dispose', () => {
    const s = new MountScope();
    expect(s.signal.aborted).toBe(false);
    s.dispose();
    expect(s.signal.aborted).toBe(true);
    expect(s.disposed).toBe(true);
  });

  it('runs cleanups in LIFO order', () => {
    const s = new MountScope();
    const order: number[] = [];
    s.onCleanup(() => order.push(1));
    s.onCleanup(() => order.push(2));
    s.dispose();
    expect(order).toEqual([2, 1]);
  });

  it('is idempotent — a second dispose runs nothing again', () => {
    const s = new MountScope();
    const fn = vi.fn();
    s.onCleanup(fn);
    s.dispose();
    s.dispose();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('runs a cleanup immediately if registered after dispose', () => {
    // A late async callback that registers teardown must not leak.
    const s = new MountScope();
    s.dispose();
    const fn = vi.fn();
    s.onCleanup(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('removes an addEventListener registered with its signal', () => {
    const s = new MountScope();
    const el = document.createElement('div');
    const fn = vi.fn();
    el.addEventListener('click', fn, { signal: s.signal });
    el.dispatchEvent(new Event('click'));
    expect(fn).toHaveBeenCalledTimes(1);
    s.dispose();
    el.dispatchEvent(new Event('click'));
    expect(fn).toHaveBeenCalledTimes(1); // no new call
  });

  it('keeps running later cleanups even if one throws', () => {
    const s = new MountScope();
    const after = vi.fn();
    s.onCleanup(() => after());
    s.onCleanup(() => {
      throw new Error('boom');
    });
    expect(() => s.dispose()).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `bunx vitest run packages/markdown-app/test/mount-scope.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * A per-mount lifecycle scope. Everything a single document's mount sets up —
 * event listeners, the Yjs client, the editor, observers — is tied to one
 * scope, so navigating to another file is `scope.dispose()`: no leaked
 * listeners, no lingering sockets, no double-bind on the next mount.
 *
 * Register DOM listeners with `{ signal: scope.signal }` and imperative
 * teardown (client.close(), editor.destroy()) with `onCleanup`.
 */
export class MountScope {
  private readonly controller = new AbortController();
  private readonly cleanups: Array<() => void> = [];
  private _disposed = false;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get disposed(): boolean {
    return this._disposed;
  }

  onCleanup(fn: () => void): void {
    // A callback registered after dispose (e.g. a resolved fetch on a
    // navigated-away page) must run now, not linger forever.
    if (this._disposed) {
      runSafely(fn);
      return;
    }
    this.cleanups.push(fn);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    // LIFO: last thing set up is first torn down.
    for (let i = this.cleanups.length - 1; i >= 0; i--) {
      runSafely(this.cleanups[i]);
    }
    this.cleanups.length = 0;
    this.controller.abort();
  }
}

function runSafely(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    // One bad teardown must not strand the rest — a leaked socket is worse
    // than a logged error.
    console.error('[mount-scope] cleanup threw', err);
  }
}
```

- [ ] **Step 4: Run, verify pass (6 tests)**

Run: `bunx vitest run packages/markdown-app/test/mount-scope.test.ts`

- [ ] **Step 5: Commit**

```bash
bun run lint && bun run typecheck
git add packages/markdown-app/src/mount-scope.ts packages/markdown-app/test/mount-scope.test.ts
git commit -m "feat(nav): MountScope — per-document lifecycle for teardown-safe mounts"
```

---

### Task 2: `connect().close()` fully detaches the Yjs doc

Every navigation disposes the old client. Today `close()` closes the socket but leaves `ydoc.on('update')` / `awareness.on('update')` attached and the `Y.Doc` alive, so each navigation leaks a doc + handlers. Fix it before anything calls close() in a loop.

**Files:**
- Modify: `packages/core/src/ws-client.ts`
- Test: `packages/core/test/ws-client-close.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { connect } from '../src/ws-client.ts';

describe('connect().close()', () => {
  it('detaches doc + awareness update handlers so a closed client leaks nothing', () => {
    // happy-dom provides a WebSocket stub that never connects; connect()
    // stays in 'connecting' and never sends, which is fine for this test.
    const client = connect('ws://localhost:0/y/test');
    const ydoc = client.ydoc as Y.Doc;
    // Sanity: handlers are attached while open.
    expect(ydoc._observers.get('update')?.size ?? 0).toBeGreaterThan(0);
    client.close();
    // After close, no doc-update observers remain.
    expect(ydoc._observers.get('update')?.size ?? 0).toBe(0);
  });

  it('is safe to call close() twice', () => {
    const client = connect('ws://localhost:0/y/test');
    client.close();
    expect(() => client.close()).not.toThrow();
  });
});
```

Note: `ydoc._observers` is Yjs-internal but stable and used elsewhere in this codebase's tests; if it proves flaky, assert instead that a post-close `ydoc.transact(() => ytext.insert(...))` triggers no send (spy on the socket) — but the observer count is the direct assertion.

- [ ] **Step 2: Run, verify it fails** (observers still attached after close).

Run: `bunx vitest run packages/core/test/ws-client-close.test.ts`

- [ ] **Step 3: Implement**

In `packages/core/src/ws-client.ts`, find the `close()` method (~line 147). It currently reads roughly:

```ts
    close() {
      closed = true;
      // ... clears reconnect timer, closes ws ...
      if (ws) ws.close();
    },
```

Add handler detachment. The named handlers `docUpdate` and `awareUpdate` are in scope (declared at the top of `connect`):

```ts
    close() {
      closed = true;
      ydoc.off('update', docUpdate);
      awareness.off('update', awareUpdate);
      // Any status/ready callbacks are dropped so a late reconnect attempt
      // can't fire into a disposed surface.
      readyCbs = [];
      if (ws) {
        try {
          ws.close();
        } catch {
          // already closing/closed
        }
      }
      awareness.destroy();
      ydoc.destroy();
    },
```

`readyCbs` is already `let` (line 39). Confirm `docUpdate` / `awareUpdate` are the exact names bound at lines 63/66 (they are).

- [ ] **Step 4: Run, verify pass. Then run the whole ws suite** so no reconnect test regressed:

Run: `bunx vitest run packages/core/test/ws-client-close.test.ts && bunx vitest run packages/core`

- [ ] **Step 5: Commit**

```bash
bun run lint && bun run typecheck
git add packages/core/src/ws-client.ts packages/core/test/ws-client-close.test.ts
git commit -m "fix(ws): close() detaches doc/awareness handlers so navigation leaks nothing"
```

---

### Task 3: `mountReviewChrome` becomes teardown-safe

`ReviewChrome` is mounted per document and binds a persistent `document` keydown (`review-chrome.ts:561`) plus panel state. On navigation it must stop listening and clear its rendered threads, or the next mount double-binds and stale threads flash.

**Files:**
- Modify: `packages/markdown-app/src/review-chrome.ts`
- Test: `packages/markdown-app/test/review-chrome-teardown.test.ts`

**Interfaces:**
- `ChromeOpts` gains `scope?: MountScope`.
- `ReviewChrome` gains `destroy(): void`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { MountScope } from '../src/mount-scope.ts';
import { mountReviewChrome } from '../src/review-chrome.ts';
// This test needs the review-chrome DOM skeleton. Reuse the helper the other
// chrome tests use, or build the minimal element set (#threads-list,
// #composer, #thread-view, #toggle-threads, #threads-count, #close-threads,
// #threads-scrim, #shell, #doc-title, composer bits). See how
// packages/markdown-app/test/*.test.ts that touch chrome set up the DOM;
// mirror that. If none exists, add a `mountChromeDom()` helper in the test.

describe('mountReviewChrome teardown', () => {
  it('stops handling the ⌘M hotkey after destroy', () => {
    mountChromeDom();
    const scope = new MountScope();
    const ydoc = new Y.Doc();
    const surface = fakeSurface(); // a minimal ReviewSurface stub
    const chrome = mountReviewChrome({
      docId: 'd1',
      user: { id: 'u', name: 'U', kind: 'known', color: '#000' },
      ydoc,
      surface,
      selectHint: '',
      reanchorHint: '',
      getSelection: () => null,
      scope,
    });
    // ⌘M toggles the drawer; capture the shell state before/after.
    const shell = document.getElementById('shell') as HTMLElement;
    const before = shell.classList.contains('threads-open');
    scope.dispose();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', metaKey: true }));
    expect(shell.classList.contains('threads-open')).toBe(before); // no toggle
    void chrome;
  });

  it('destroy() empties the threads list so the next mount starts clean', () => {
    mountChromeDom();
    const scope = new MountScope();
    const chrome = mountReviewChrome({ /* …as above… */ } as never);
    document.getElementById('threads-list')!.innerHTML = '<li>stale</li>';
    chrome.destroy();
    expect(document.getElementById('threads-list')!.innerHTML).toBe('');
  });
});
```

(Provide `mountChromeDom()` and `fakeSurface()` in the test file. `fakeSurface` returns an object implementing `ReviewSurface` with no-op methods and `resolveRel: () => null`.)

- [ ] **Step 2: Run, verify it fails** (no `scope` / no `destroy`).

- [ ] **Step 3: Implement**

In `review-chrome.ts`:
1. Add `scope?: MountScope;` to `ChromeOpts` (import `MountScope`).
2. Change the persistent keydown registration (~line 561) to pass the signal:
   ```ts
   document.addEventListener('keydown', onKeydown, { signal: opts.scope?.signal });
   ```
   (Name the handler if it's currently inline, so `destroy` is coherent.)
3. Add a `destroy()` to the returned `ReviewChrome`:
   ```ts
   destroy() {
     // Signal-bound listeners are already gone via scope.dispose(); clear the
     // rendered UI so the next document's mount doesn't briefly show this
     // one's threads.
     threadsListEl.innerHTML = '';
     hideComposer();
     closeThreadView();
   }
   ```
4. If `scope` is provided, self-register: `opts.scope?.onCleanup(() => chrome.destroy())` right before returning `chrome` (so the router only needs `scope.dispose()`).

Add `destroy(): void;` to the `ReviewChrome` interface.

- [ ] **Step 4: Run, verify pass. Run full markdown-app suite** (chrome is widely used):

Run: `bunx vitest run packages/markdown-app`

- [ ] **Step 5: Commit**

```bash
bun run lint && bun run typecheck
git add packages/markdown-app/src/review-chrome.ts packages/markdown-app/test/review-chrome-teardown.test.ts
git commit -m "feat(nav): ReviewChrome accepts a MountScope and destroys cleanly"
```

---

### Task 4: Sidebar renders once — `setActive` moves the marker, scroll survives

On navigation the sidebar must NOT re-render (that's what loses scroll). Split "render the tree" from "mark which file is open", and expose the latter for the router to call.

**Files:**
- Modify: `packages/markdown-app/src/diff-nav.ts`, `packages/markdown-app/src/workspace-tree.ts`
- Test: `packages/markdown-app/test/diff-nav-active.test.ts`

**Interfaces:**
- Each module exports `setActiveFile(docId: string): void` — finds the `<a>` whose href resolves to that docId, moves `.active` + `aria-current="page"` to it, and does nothing else (no innerHTML write).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { setActiveFile } from '../src/diff-nav.ts';

describe('diff-nav setActiveFile', () => {
  it('moves the active marker without rewriting the list', () => {
    const list = document.createElement('ol');
    list.id = 'set-pane-list';
    list.innerHTML =
      '<li class="diff-file"><a href="/review/a" class="active" aria-current="page">a</a></li>' +
      '<li class="diff-file"><a href="/review/b">b</a></li>';
    document.body.appendChild(list);
    const before = list.innerHTML.length;

    setActiveFile('b');

    expect(list.querySelector('a[href="/review/b"]')?.classList.contains('active')).toBe(true);
    expect(list.querySelector('a[href="/review/b"]')?.getAttribute('aria-current')).toBe('page');
    expect(list.querySelector('a[href="/review/a"]')?.classList.contains('active')).toBe(false);
    // Structure length unchanged bar the class/attr moves — no re-render.
    expect(Math.abs(list.innerHTML.length - before)).toBeLessThan(40);
    list.remove();
  });

  it('is a no-op when the docId is not in the list', () => {
    const list = document.createElement('ol');
    list.id = 'set-pane-list';
    list.innerHTML = '<li><a href="/review/a" class="active">a</a></li>';
    document.body.appendChild(list);
    expect(() => setActiveFile('zzz')).not.toThrow();
    expect(list.querySelector('a[href="/review/a"]')?.classList.contains('active')).toBe(true);
    list.remove();
  });
});
```

Note the href→docId match must tolerate the real href shape (`/review/<docId>?<params>` and absolute `reviewUrl`s). Match by testing whether the href's `/review/<seg>` path segment `decodeURIComponent`-equals the docId, not by string equality.

- [ ] **Step 2: Run, verify it fails.**

- [ ] **Step 3: Implement** `setActiveFile` in both `diff-nav.ts` and `workspace-tree.ts`:

```ts
/** Move the "open file" marker to `docId` without re-rendering the tree — the
 *  render is what loses the reviewer's scroll position, so navigation must not
 *  trigger it. */
export function setActiveFile(docId: string): void {
  const list = document.getElementById('set-pane-list');
  if (!list) return;
  for (const a of list.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const match = docIdOfHref(a.getAttribute('href')) === docId;
    a.classList.toggle('active', match);
    if (match) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

/** Extract the docId from a /review/<docId>[?...] href (absolute or relative). */
function docIdOfHref(href: string | null): string | null {
  if (!href) return null;
  const m = href.match(/\/review\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
```

(`workspace-tree.ts` uses `#doc-menu` or `#set-pane-list` — match the container id it actually renders into; grep its `renderWorkspaceTree` target and use the same.)

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit**

```bash
bun run lint && bun run typecheck
git add packages/markdown-app/src/diff-nav.ts packages/markdown-app/src/workspace-tree.ts packages/markdown-app/test/diff-nav-active.test.ts
git commit -m "feat(nav): setActiveFile moves the sidebar marker without re-rendering"
```

---

### Task 5: Convert the three boot paths to scope-based mounts

This is the bulk. Each boot function becomes a `mount*(ctx: MountContext)` that (a) uses `ctx.docId` / `ctx.scope` instead of reading the path and connecting itself, (b) registers EVERY `document`/`window` listener with `{ signal: ctx.scope.signal }`, and (c) registers `client.close()` / `editor.destroy()` / `surface.destroy()` via `ctx.scope.onCleanup(...)` instead of `beforeunload`.

Do the three sub-tasks in order; each is independently testable by mounting then disposing and asserting no residual listener fires. **Do them one path at a time and run the suite between** — this is where a missed listener hides.

**5a — `redline-app.ts` (smallest, do first as the pattern):**

- [ ] Change `bootRedline(opts)` → `mountRedline(ctx: MountContext)`. Take `ydoc` from a `client` that `main()` now owns (passed on `ctx`? No — see Task 6: `main()` creates the client and passes it in). Add `client: FeedbackClient` to `MountContext`.
- [ ] Every listener in the file uses `{ signal: ctx.scope.signal }`.
- [ ] Replace the `beforeunload` teardown (if any) and the surface lifetime with:
  ```ts
  ctx.scope.onCleanup(() => surface.destroy());
  ```
  The client is owned by `main()`/router now, so the mount does NOT close it (the router disposes the client per navigation — see Task 6).
- [ ] The view toggle's `location.reload()` (in `wireToggle`) becomes a router navigation: import and call `navigateTo(url)` from `router.ts` (Task 6) instead of reloading. Redline↔Diff↔File still swap surfaces, but now via the same in-place mechanism.
- [ ] Pass `ctx.scope` into `mountReviewChrome`.

**5b — `code/code-app.ts`:** same transformation. `bootCode(opts)` → `mountCode(ctx)`. One global listener → signal. `surface.destroy()` → `onCleanup`. Pass scope to chrome.

**5c — `app.ts` (the 990-line monolith):** `boot()` splits:
- A new top-level `main()` (Task 6) keeps the one-time work: `wireKeyboardInset()`, resolving the user, mounting the sidebar + router.
- `mountMarkdown(ctx: MountContext)` keeps everything docId-specific: `createEditor`, `mountReviewChrome`, the format bar, edit-mode toggle, comment pill, selection tracking, hotkeys. All ~15 listeners get `{ signal: ctx.scope.signal }`. The `beforeunload` block's `client.close(); editor.destroy()` becomes `ctx.scope.onCleanup(() => editor.destroy())` (client owned by router).
- `renderSetNav()` stays reachable but is called by `main()` once, not per-mount.

**Files:** all three boot modules + a mount smoke test.
**Test:** `packages/markdown-app/test/mount-teardown.test.ts` — for each surface: build the DOM skeleton, mount with a scope over a Y.Doc, dispose, then dispatch the events the mount listened for and assert nothing throws / no state changes. At minimum assert the editor DOM is torn down and a post-dispose `document` keydown does not toggle anything.

- [ ] After each of 5a/5b/5c: `bunx vitest run packages/markdown-app` green before moving on.
- [ ] Commit each sub-task separately (`feat(nav): mountRedline …`, `mountCode`, `mountMarkdown`).

---

### Task 6: The router — persistent shell, pushState, popstate, swap loop

**Files:**
- Create: `packages/markdown-app/src/router.ts`
- Test: `packages/markdown-app/test/router.test.ts`
- Modify: `packages/markdown-app/src/app.ts` (entry becomes `void main()`).

**Interfaces:**
```ts
export function navigateTo(url: string): void;   // pushState + swap
export function startRouter(opts: {
  mountFor: (ctx: MountContext) => Promise<void>;  // picks markdown/code/redline by docType
  fetchMeta: (docId: string) => Promise<{ docType; sourceUrl; workspaceId; relPath }>;
  connectFor: (docId: string, docType: string) => FeedbackClient;
}): void;
```

**Behaviour:**
- `startRouter` mounts the initial docId (from `location.pathname`), then installs:
  - A **capturing click listener on `#set-pane`** (the sidebar): if the target is an `<a>` whose href resolves to a `/review/<docId>` on the same origin, `preventDefault()` and `navigateTo(href)`. Modifier/middle clicks (`metaKey`/`ctrlKey`/`button===1`) fall through to the browser (open-in-new-tab must still work).
  - A `popstate` handler → swap to the docId in the new URL (no pushState).
- `navigateTo(url)`:
  1. `history.pushState(null, '', url)`.
  2. `swap(docIdOf(url))`.
- `swap(docId)`:
  1. Dispose the current `MountScope` and `client.close()` (the previous mount's teardown).
  2. `setActiveFile(docId)` on both nav modules (harmless if one is inactive), and on mobile close the drawer.
  3. `fetchMeta(docId)` → new `MountScope` → `connectFor(...)` → `mountFor(ctx)`.
  4. Guard every await against `scope.disposed` (a fast second click mid-fetch must win — see the `disposed` guard in Task 1).
- Concurrency: keep a `currentScope`; at the top of `swap`, capture a local `token = currentScope = new MountScope()`; after each await, `if (currentScope !== token) return;` so a superseded navigation abandons cleanly.

- [ ] **Step 1: Write the failing test** (jsdom/happy-dom `history` is available):

```ts
import { describe, expect, it, vi } from 'vitest';
import { startRouter } from '../src/router.ts';

function sidebar(html: string) {
  const pane = document.createElement('aside');
  pane.id = 'set-pane';
  const list = document.createElement('ol');
  list.id = 'set-pane-list';
  list.innerHTML = html;
  pane.appendChild(list);
  document.body.appendChild(pane);
  return pane;
}

describe('router', () => {
  it('intercepts a sidebar file click, pushes state, and swaps without reload', async () => {
    history.replaceState(null, '', '/review/a');
    sidebar('<li><a href="/review/b">b</a></li>');
    const mounted: string[] = [];
    const disposed: string[] = [];
    startRouter({
      fetchMeta: async () => ({ docType: 'diff', sourceUrl: '', workspaceId: 'w', relPath: 'b.md' }),
      connectFor: () => ({ close: () => {}, ydoc: {}, awareness: {}, onReady: () => {} }) as never,
      mountFor: async (ctx) => {
        mounted.push(ctx.docId);
        ctx.scope.onCleanup(() => disposed.push(ctx.docId));
      },
    });
    await Promise.resolve(); // let the initial mount settle
    expect(mounted).toEqual(['a']);

    document.querySelector('a[href="/review/b"]')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(location.pathname).toBe('/review/b');
    expect(mounted).toEqual(['a', 'b']);
    expect(disposed).toEqual(['a']); // old mount torn down
  });

  it('lets a ⌘-click through to the browser (open in new tab)', async () => {
    history.replaceState(null, '', '/review/a');
    sidebar('<li><a href="/review/b">b</a></li>');
    startRouter({ /* …stubs… */ } as never);
    await Promise.resolve();
    const a = document.querySelector('a[href="/review/b"]')!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true });
    a.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false); // browser handles it
  });

  it('handles popstate (back button) by swapping to the URL docId', async () => {
    // navigate a→b, then popstate back to a; assert b disposed, a mounted.
    // (build with the same stubs; dispatch new PopStateEvent('popstate') after
    // history.replaceState to /review/a)
  });
});
```

- [ ] **Step 2–4:** implement `router.ts`; run until green.

- [ ] **Step 5: Wire `main()` in `app.ts`.** Replace `void boot()` with `void main()`, where `main()`:
  1. `wireKeyboardInset()`, resolve user.
  2. `startRouter({ fetchMeta, connectFor, mountFor })` where `mountFor` switches on `docType` + `.md` (mirrors the current `app.ts:109` branch): `diff` + `.md` → `mountRedline`, `code`/`diff` → `mountCode`, else `mountMarkdown`.
  3. The sidebar first render happens inside the initial mount's `renderSetNav`, exactly as today — only subsequent navigations skip the re-render and use `setActiveFile`.

- [ ] **Step 6: Commit** `feat(nav): in-place file navigation via history router`.

---

### Task 7: End-to-end verification against a real server

Unit tests can't prove the sockets and editors actually swap. Verify live.

- [ ] **Step 1:** Start an isolated server: `bun run packages/server/src/bin.ts --port 8796 &`. Create a diff review over a branch with ≥3 changed files (mix of `.md` and non-`.md`) via `POST /api/diffs`.
- [ ] **Step 2:** Open the entry URL against `:8796`. Then, in the browser (or via the Chrome MCP tools):
  - Scroll the sidebar down, click a file lower in the list → **URL changes, no reload, sidebar scroll unchanged, correct file opens.**
  - Click a `.md` file → redline renders; a non-`.md` → code view. The toggle still works and no longer reloads.
  - Leave a comment, navigate away, navigate back → the doc reloads its threads correctly; no duplicate comment pills; no console errors about a closed socket.
  - Browser Back → returns to the previous file in place.
  - ⌘-click a file → opens in a new tab (unaffected).
  - Rapidly click three files → the last wins, no half-mounted state, no leaked "connecting" socket (check the Network panel / console).
- [ ] **Step 3:** 430px width: a file click also closes the sidebar drawer; no horizontal scroll.
- [ ] **Step 4:** State in the ship report exactly what was verified in the browser vs. only unit-tested. Note memory: after 10 navigations, the tab should not be accumulating Y.Docs (Task 2) — spot-check with the memory profiler if feasible, else note it as unverified.

---

### Task 8: Ship

- [ ] `bun run lint && bun run typecheck && bun run test` — all green (real exit codes).
- [ ] Invoke `team-lead-fleet:ship-guarded` — this touches the core review surface used daily, so the regression gate is the right one. In the risk assessment, name the **user-facing-flow** surface (all file navigation) and the smoke test from Task 7.
- [ ] **Report honestly:** the three boot paths are now teardown-dependent; a listener added in future WITHOUT the scope signal silently leaks on navigation — call this out as the maintenance hazard the change introduces.

## Self-Review Notes

- **Coverage:** no-reload nav → Tasks 5+6; sidebar stability → Task 4; leak-safety → Tasks 1+2+3; back/forward → Task 6; the redline toggle's reload → folded into 5a.
- **Biggest risk:** a per-doc listener left without the scope signal in Task 5 leaks and double-binds. Mitigation: Task 5's teardown test dispatches the listened events after dispose; grep each boot file for `addEventListener` and confirm every one either has `{ signal }` or is inside a self-removing drag handler.
- **Ordering hazard:** Task 2 (client close detaches handlers) MUST land before Task 6 starts disposing clients in a loop, or every navigation leaks a Y.Doc.
- **Type consistency:** `MountContext` / `MountScope` / `MountFn` are defined once (Tasks 1, 5) and consumed unchanged in 5+6. `setActiveFile` is the name in both nav modules and the router.
- **Out of scope:** prefetching the next file; animating the swap; persisting sidebar scroll to storage (unnecessary once the sidebar stops re-rendering).
