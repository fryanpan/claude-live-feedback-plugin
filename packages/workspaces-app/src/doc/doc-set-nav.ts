/**
 * The sidebar and the topbar dropdown for the set a document belongs to: a
 * diff review, a bound folder, or a legacy hand-grouped set.
 *
 * One module because the navigation path and the refresh path have to pick
 * the SAME renderer. They did not once, and the mismatch cost a full
 * scroll-resetting rebuild on every navigation: the heartbeat wrote a `tree:`
 * signature while navigation wrote `diff:`, so the shared signature never
 * matched. Keeping the choice in one place is what stops that recurring.
 */
import { escapeHtml, readDocMeta } from '@feedback/core';
import type * as Y from 'yjs';
import { renderDiffNav, setActiveFile } from '../diff-nav.ts';
import { docHref, workspaceIdFromPath } from '../doc-path.ts';
import type { MountScope } from '../mount-scope.ts';
import { type SetDoc, selectSetSiblings, setDocsUrl } from '../set-nav.ts';
import {
  beginSidebarRender,
  commitSidebarColumn,
  isCurrentSidebarRender,
  resetSidebarSignature,
  setSidebarSignature,
  sidebarShowsSignature,
} from '../sidebar-nav-key.ts';
import { renderWorkspaceTree } from '../workspace-tree.ts';

interface LegacyDocs {
  docs: SetDoc[];
}

export interface DocSetNavOptions {
  docId: string;
  /** The docId the sidebar marks active — differs from `docId` only for the
   *  editable File view of a `.md` diff member. */
  navDocId: string;
  ydoc: Y.Doc;
  scope: MountScope;
}

export interface DocSetNav {
  /** Re-render the sidebar and dropdown from the doc's current meta. */
  render: () => Promise<void>;
}

export function mountDocSetNav(opts: DocSetNavOptions): DocSetNav {
  const { docId, navDocId, ydoc, scope } = opts;

  // ---- Attachment-set navigation ----
  // If the doc has a setId/workspaceId, render its siblings into the sidebar
  // and topbar dropdown. The sidebar renderers are idempotent per nav key, so
  // navigating between files in the same review keeps the sidebar (and its
  // scroll) intact — only the active marker moves.
  const setPaneList = document.getElementById('set-pane-list');
  const docMenu = document.getElementById('doc-menu');
  const docSwitcher = document.getElementById('doc-switcher') as HTMLButtonElement | null;
  let openedOnce = false;

  async function renderSetNav(): Promise<void> {
    // Claim the sidebar so any concurrent/stale render (e.g. two legacy-set
    // meta ticks resolving out of order, or a previous workspace's in-flight
    // render) can detect it was superseded and bail before overwriting.
    const token = beginSidebarRender();
    const m = readDocMeta(ydoc);
    const workspaceId = m.workspaceId ?? '';
    const setId = m.setId ?? '';
    // The sidebar grid shows whenever the doc is part of a workspace OR a
    // legacy hand-grouped set. workspaceId implies a folder bind → tree;
    // setId-only stays on the flat list.
    const navKey = workspaceId || setId;
    // Nothing reserves the column here. Knowing the doc names a set is not
    // knowing the set has anything in it — each renderer below commits once it
    // has a list, and `commitSidebarColumn` explains what that cost when this
    // line toggled `has-set` from meta instead.
    if (!navKey) {
      commitSidebarColumn(false);
      if (setPaneList) setPaneList.innerHTML = '';
      if (docMenu) docMenu.innerHTML = '';
      docSwitcher?.setAttribute('aria-expanded', 'false');
      resetSidebarSignature();
      return;
    }
    if (workspaceId) {
      // Same chooser as the code/diff mount: diff reviews + browse workspaces
      // get the diff-nav; only data-less workspaces fall back to the folder
      // tree. `scope` lets a superseded navigation's late fetch bail instead of
      // clobbering the current sidebar.
      const ok = await renderDiffNav(navDocId, workspaceId, false, scope);
      if (scope.disposed) return;
      if (!ok) await renderWorkspaceTree(navDocId, workspaceId, false, scope);
      return;
    }
    // ---- Legacy flat setId path ----
    // Re-fetch /api/docs on every renderSetNav so the list self-heals: a
    // transient failure or an incomplete initial-sync snapshot is corrected on
    // the next meta tick, and a sibling added mid-review appears in place. The
    // shared signature check below means an unchanged list costs only the small
    // fetch, not a scroll-resetting DOM rebuild. (Do NOT memo this per mount —
    // that froze a failed/partial snapshot for the whole mount.) `scope.disposed`
    // guards the superseded-navigation race after the await.
    try {
      const res = await fetch(setDocsUrl(setId));
      // Bail if the mount was torn down OR a newer sidebar render superseded us
      // (e.g. a later meta tick's fetch already resolved) — an earlier,
      // possibly smaller snapshot must not overwrite it.
      if (scope.disposed || !isCurrentSidebarRender(token)) return;
      if (!res.ok) return;
      const data = (await res.json()) as LegacyDocs;
      if (scope.disposed || !isCurrentSidebarRender(token)) return;
      const siblings = selectSetSiblings(data.docs, setId);
      // The list is known now, so the column can be decided. A set whose
      // members are all non-markdown lands here with zero rows and gives the
      // width back rather than rendering an empty labelled panel.
      commitSidebarColumn(siblings.length > 0);
      if (siblings.length === 0) {
        if (setPaneList) setPaneList.innerHTML = '';
        if (docMenu) docMenu.innerHTML = '';
        docSwitcher?.setAttribute('aria-expanded', 'false');
        resetSidebarSignature();
        return;
      }
      const sig = `set:${setId}:${siblings.map((d) => d.docId).join(',')}`;
      if (sidebarShowsSignature(sig)) {
        setActiveFile(navDocId);
        return;
      }
      const items = siblings
        .map((d) => {
          const isActive = d.docId === docId;
          const label = d.title ?? basename(d.sourceUrl ?? d.docId);
          const sub = d.sourceUrl && d.title ? d.sourceUrl : '';
          const params = new URLSearchParams(location.search);
          const href = docHref(d.docId, workspaceIdFromPath(location.pathname), params.toString());
          return `<li><a href="${href}" class="${isActive ? 'active' : ''}"${
            isActive ? ' aria-current="page"' : ''
          }>${escapeHtml(label)}${sub ? `<small>${escapeHtml(sub)}</small>` : ''}</a></li>`;
        })
        .join('');
      if (setPaneList) setPaneList.innerHTML = items;
      if (docMenu) docMenu.innerHTML = `<ol>${items}</ol>`;
      setSidebarSignature(sig);
      // On mobile, the desktop sidebar is hidden — the dropdown is the ONLY
      // surface that shows the attachment set. Open it on first render so the
      // reviewer sees siblings without discovering the doc-switcher tap
      // target. The scroll-to-close handler dismisses it once they engage.
      const isMobile = window.matchMedia('(max-width: 1100px)').matches;
      if (isMobile && docMenu && docSwitcher && !openedOnce) {
        openedOnce = true;
        docMenu.classList.remove('hidden');
        docMenu.setAttribute('aria-hidden', 'false');
        docSwitcher.setAttribute('aria-expanded', 'true');
      }
    } catch {
      // Fetch failure — skip; not load-bearing for the editor itself.
    }
  }

  // ---- Workspace (folder) file tree ----
  // A doc bound via bind_folder carries a workspaceId. renderSetNav (above)
  // renders it; here we wire the focus + ~30s heartbeat refresh so badges
  // reflect newly-opened/resolved threads. Scoped so navigation drops it.
  const workspaceId = readDocMeta(ydoc).workspaceId;
  if (workspaceId) {
    // The heartbeat/focus refresh MUST use the same renderer the navigation
    // path (renderSetNav) picks — renderDiffNav first, the folder tree only as
    // the fallback — otherwise it writes a `tree:` signature while navigation
    // writes `diff:`, and the shared-signature mismatch forces a full
    // scroll-resetting rebuild on the next navigation (finding #1).
    const refresh = () => {
      void (async () => {
        const ok = await renderDiffNav(navDocId, workspaceId, true, scope);
        if (scope.disposed) return;
        if (!ok) await renderWorkspaceTree(navDocId, workspaceId, true, scope);
      })();
    };
    window.addEventListener('focus', refresh);
    const timer = setInterval(refresh, 30_000);
    scope.onCleanup(() => {
      window.removeEventListener('focus', refresh);
      clearInterval(timer);
    });
  }

  return { render: renderSetNav };
}

function basename(p: string): string {
  const m = p.match(/[^/]+$/);
  return m ? m[0] : p;
}
