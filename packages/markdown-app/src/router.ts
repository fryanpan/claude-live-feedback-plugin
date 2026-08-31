import type { FeedbackClient, User } from '@feedback/core';
import { applyBackLink, returnItemFrom } from './back-link.ts';
import { setActiveFile } from './diff-nav.ts';
import { docIdFromPath, docIdFromPathOrNull } from './doc-path.ts';
import { applyHuddleCrumb } from './huddle-entry.ts';
import type { DocMeta, MountContext, MountFn } from './mount-context.ts';
import { MountScope } from './mount-scope.ts';

/**
 * The in-place file router. The review app is a single shell (sidebar +
 * keyboard inset + this router) mounted once; each document is a re-runnable
 * per-doc mount tied to a MountScope. Clicking a file in the sidebar is
 * `pushState` → dispose the old mount → mount the new docId, with NO full-page
 * reload and the sidebar left untouched (only its `active` marker moves).
 *
 * The router owns the per-navigation `MountScope` and `FeedbackClient`:
 * `client.close()` is registered on the scope first, so `scope.dispose()`
 * tears the surface down (LIFO) and only then releases the socket.
 */

export interface RouterOpts {
  /** Picks the surface (markdown / code / redline) from ctx.docType + relPath. */
  mountFor: MountFn;
  /** Resolve a doc's persisted type/paths before connecting. */
  fetchMeta: (docId: string) => Promise<DocMeta>;
  /** Open the Yjs websocket for a doc. Injected for testability. */
  connectFor: (docId: string, docType: string) => FeedbackClient;
  /** The reviewer, resolved once by main() and passed to every mount. */
  user: User;
  /** Whether the server will accept writes from this browser — resolved once
   *  by main() (it awaits `/api/auth/session` before starting the router) and
   *  passed to every mount, for the same reason `user` is: a surface that has
   *  to ask for itself is a surface that is live while it asks. */
  canWrite: boolean;
}

let opts: RouterOpts | null = null;
/** The scope of the currently-mounted (or currently-mounting) document. Every
 *  async step in swap() re-checks it: a superseded navigation abandons. */
let currentScope: MountScope | null = null;

/** Extract the docId from a doc path or full URL — both address shapes. */
const docIdOf = docIdFromPath;

/** Reduce an href to a same-origin path. Sidebar links can be ABSOLUTE
 *  reviewUrls whose host differs from the browsing host (e.g. the server
 *  advertises a tailscale URL but the reviewer opened localhost) — pushState
 *  rejects a cross-origin URL, so we push only the path, which is all the
 *  router needs. */
function toSameOriginPath(url: string): string {
  try {
    const u = new URL(url, location.href);
    return u.pathname + u.search + u.hash;
  } catch {
    return url;
  }
}

/** Reset the shell to a surface-agnostic baseline between mounts — the current
 *  boot paths set body classes / chrome assuming one page load, so navigation
 *  must clear them or a markdown doc inherits a previous code doc's `code-mode`. */
function resetSurfaceChrome(): void {
  document.body.classList.remove(
    'code-mode',
    'diff-mode',
    'redline-mode',
    'view-mode',
    'composer-open',
    'thread-view-open',
  );
  // view-whitespace joins these: it is shown per-FILE (only when that file
  // has whitespace-only changes), so without a reset it would linger with the
  // previous file's count over a doc that has none — or over a markdown doc.
  for (const id of ['view-toggle', 'view-redline', 'view-whitespace']) {
    document.getElementById(id)?.classList.add('hidden');
  }
  document.getElementById('diff-banner')?.remove();
  // Editors remove their own DOM on destroy(); clear defensively so a fresh
  // mount never renders alongside a predecessor's residue.
  document.getElementById('editor')?.replaceChildren();
}

/** Close the mobile file-list drawer (the doc-switcher dropdown). Desktop nav
 *  is inline in #set-pane and unaffected. */
function closeMobileDrawer(): void {
  const docMenu = document.getElementById('doc-menu');
  const docSwitcher = document.getElementById('doc-switcher');
  if (docMenu && !docMenu.classList.contains('hidden')) {
    docMenu.classList.add('hidden');
    docMenu.setAttribute('aria-hidden', 'true');
    docSwitcher?.setAttribute('aria-expanded', 'false');
  }
}

/**
 * Swap the mounted document to `docId`. Disposes the previous mount (which
 * closes its client), then connects + mounts the new one. A concurrency token
 * (`currentScope`) makes the LAST navigation win: a superseded swap bails
 * after any await without leaving a half-mounted surface or a live socket.
 */
async function swap(docId: string): Promise<void> {
  const o = opts;
  if (!o) return;
  currentScope?.dispose();
  const scope = new MountScope();
  currentScope = scope;

  // Immediate, synchronous shell updates so the click feels instant even
  // before the meta fetch resolves.
  setActiveFile(docId);
  closeMobileDrawer();
  resetSurfaceChrome();

  const meta = await o.fetchMeta(docId);
  if (currentScope !== scope) return; // superseded during fetch

  // The back arrow is shell chrome that outlives each per-doc mount, so the
  // router owns it: retarget it here, on BOTH branches, or a doc with no board
  // would inherit the previous doc's board and the arrow would be a live wrong
  // link. After the token re-check, so a superseded navigation cannot repoint
  // the arrow at the doc that lost.
  applyBackLink(document, meta.backTo, returnItemFrom(location.search));
  // Same reasoning, same moment: the word is chrome the next doc must not
  // inherit, and a superseded navigation must not write it.
  applyHuddleCrumb(document, meta.huddle === true);

  const client = o.connectFor(docId, meta.docType);
  // Registered FIRST → runs LAST on dispose, after the surface's teardown.
  scope.onCleanup(() => client.close());

  const ctx: MountContext = {
    docId,
    scope,
    client,
    user: o.user,
    canWrite: o.canWrite,
    ...meta,
  };
  await o.mountFor(ctx);
  // A navigation that superseded us mid-mount already disposed this scope
  // (onCleanup then runs immediately), but dispose again to be certain.
  if (currentScope !== scope) scope.dispose();
}

/** Navigate to a review URL: push history, then swap in place. */
export function navigateTo(url: string): void {
  const path = toSameOriginPath(url);
  history.pushState(null, '', path);
  void swap(docIdOf(path));
}

/** Re-mount the current document in place without touching history. Used by the
 *  redline/source view toggle, which changes the persisted view mode (not the
 *  URL) and needs the surface rebuilt to pick it up. */
export function remountCurrent(): void {
  void swap(docIdOf(location.pathname));
}

/** True for a plain left-click with no modifiers — modifier / middle clicks
 *  must fall through so "open in new tab" still works. */
function isPlainClick(ev: MouseEvent): boolean {
  return !ev.metaKey && !ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.button === 0;
}

/**
 * Start the router: mount the initial doc (from the URL), then intercept
 * sidebar file clicks and browser back/forward. Returns a `stop()` that removes
 * the shell listeners and disposes the live mount — the app never calls it (the
 * router lives for the page's lifetime), but tests use it to isolate cases.
 */
export function startRouter(routerOpts: RouterOpts): () => void {
  opts = routerOpts;

  // Capturing document click: intercept a plain click on a doc link inside
  // either sidebar container (#set-pane on desktop, #doc-menu on mobile) and
  // swap in place instead of letting the browser navigate.
  const onClick = (ev: MouseEvent): void => {
    if (!isPlainClick(ev)) return;
    const a = (ev.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a) return;
    if (!a.closest('#set-pane, #doc-menu')) return;
    const href = a.getAttribute('href') ?? '';
    if (docIdFromPathOrNull(href) === null) return; // e.g. context-file links (href="#")
    ev.preventDefault();
    navigateTo(href);
  };
  const onPop = (): void => void swap(docIdOf(location.pathname));
  // Final page unload: dispose the live mount so the socket closes cleanly.
  const onUnload = (): void => currentScope?.dispose();

  document.addEventListener('click', onClick as EventListener, { capture: true });
  window.addEventListener('popstate', onPop);
  window.addEventListener('beforeunload', onUnload);

  void swap(docIdOf(location.pathname));

  return () => {
    // Explicit removeEventListener (not signal-based): the test env ignores
    // { signal } for listener removal, so unwinding must be explicit here.
    document.removeEventListener('click', onClick as EventListener, { capture: true });
    window.removeEventListener('popstate', onPop);
    window.removeEventListener('beforeunload', onUnload);
    currentScope?.dispose();
    currentScope = null;
    opts = null;
  };
}
