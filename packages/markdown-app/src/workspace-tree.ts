/**
 * Workspace (bound-folder) file tree. A doc created by `bind_folder` carries a
 * `workspaceId`; this renders the folder's files as a collapsible tree into the
 * left `#set-pane` (and the mobile `#doc-menu`), with per-file open-comment
 * badges and folder roll-ups. Shared by both review surfaces — the markdown
 * (Tiptap) boot path and the code (CodeMirror) boot path — so the tree shows
 * regardless of the file type you're viewing.
 *
 * Pure render: call `renderWorkspaceTree(docId, workspaceId)` whenever counts
 * may have changed (initial mount, window focus, a heartbeat). The caller owns
 * the focus/interval wiring (`wireWorkspaceTreeRefresh`).
 */

import { setActiveFile } from './diff-nav.ts';
import { docHref, workspaceIdFromPath } from './doc-path.ts';
import {
  beginSidebarRender,
  isCurrentSidebarRender,
  setSidebarSignature,
  sidebarShowsSignature,
} from './sidebar-nav-key.ts';

interface TreeFile {
  type: 'file';
  docId: string;
  name: string;
  relPath: string;
  fileType: string;
  openCount: number;
  threadCount: number;
  reviewUrl?: string;
  lastActivityAt?: number;
  /** No longer part of the review as of the last refresh — kept because it
   *  still holds comments, shown dimmed so nobody reviews a ghost. */
  stale?: boolean;
  /** Diff-review members: change status + line counts for badges. */
  diffStatus?: 'added' | 'modified' | 'deleted' | 'renamed';
  diffAdditions?: number;
  diffDeletions?: number;
}
interface TreeDir {
  type: 'dir';
  name: string;
  openCount: number;
  children: Array<TreeDir | TreeFile>;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}
function treeDetailsKey(workspaceId: string, relPath: string): string {
  return `lf:tree-open:${workspaceId}:${relPath}`;
}
function appendParams(url: string, params: URLSearchParams): string {
  const qs = params.toString();
  if (!qs) return url;
  return url.includes('?') ? `${url}&${qs}` : `${url}?${qs}`;
}

function renderTreeNode(
  node: TreeDir | TreeFile,
  workspaceId: string,
  prefix: string,
  activeDocId: string,
): string {
  if (node.type === 'file') {
    const isActive = node.docId === activeDocId;
    const params = new URLSearchParams(location.search);
    const href = node.reviewUrl
      ? appendParams(node.reviewUrl, params)
      : docHref(node.docId, workspaceIdFromPath(location.pathname), params.toString());
    const badge =
      node.openCount > 0 ? `<span class="tree-badge badge-open">${node.openCount}</span>` : '';
    // Diff-review files carry an A/M/D/R status letter + line-count badge.
    let diffBadge = '';
    if (node.diffStatus) {
      const letter = node.diffStatus[0]?.toUpperCase() ?? '';
      const counts =
        node.diffAdditions != null || node.diffDeletions != null
          ? `<span class="tree-diff-counts"><span class="add">+${node.diffAdditions ?? 0}</span> <span class="del">−${node.diffDeletions ?? 0}</span></span>`
          : '';
      diffBadge = `<span class="tree-diff-status tree-diff-${letter}" title="${escapeHtml(node.diffStatus)}">${letter}</span>${counts}`;
    }
    const cls = [isActive ? 'active' : '', node.stale ? 'stale' : ''].filter(Boolean).join(' ');
    const staleHint = node.stale
      ? ' title="No longer in this review — the file was removed or its change reverted. Existing comments are kept."'
      : '';
    return `<li class="tree-file"><a href="${href}" class="${cls}"${
      isActive ? ' aria-current="page"' : ''
    }${staleHint}><span class="tree-name">${escapeHtml(node.name)}</span>${diffBadge}${badge}</a></li>`;
  }
  const relPath = prefix ? `${prefix}/${node.name}` : node.name;
  let open = true;
  try {
    if (localStorage.getItem(treeDetailsKey(workspaceId, relPath)) === 'closed') open = false;
  } catch {}
  const badge =
    node.openCount > 0 ? `<span class="tree-badge tree-badge-dir">${node.openCount}</span>` : '';
  const children = node.children
    .map((c) => renderTreeNode(c, workspaceId, relPath, activeDocId))
    .join('');
  return `<li class="tree-dir"><details${open ? ' open' : ''} data-rel="${escapeHtml(
    relPath,
  )}"><summary><span class="tree-name">${escapeHtml(
    node.name,
  )}</span>${badge}</summary><ul>${children}</ul></details></li>`;
}

/** Structural signature of a folder tree: renderer namespace + workspace + the
 *  file identities (relPath + docId + diff status + staleness). Excludes counts
 *  so a new comment doesn't force a scroll-resetting rebuild on navigation; a
 *  file added/removed or a status change flips the signature and rebuilds. */
function treeSignature(workspaceId: string, tree: TreeDir): string {
  const files: string[] = [];
  const walk = (node: TreeDir | TreeFile): void => {
    if (node.type === 'file') {
      files.push(`${node.relPath}:${node.docId}:${node.diffStatus ?? ''}:${node.stale ? 's' : ''}`);
      return;
    }
    for (const c of node.children) walk(c);
  };
  for (const c of tree.children) walk(c);
  return `tree:${workspaceId}:${files.join(',')}`;
}

/** Minimal MountScope view: a render started by a navigation bails after its
 *  fetch if that navigation was superseded, so a stale tree can't overwrite the
 *  current one (finding #5). */
interface Disposable {
  readonly disposed: boolean;
}

export async function renderWorkspaceTree(
  docId: string,
  workspaceId: string,
  force = false,
  scope?: Disposable,
): Promise<void> {
  const token = beginSidebarRender();
  const setPane = document.getElementById('set-pane');
  const setPaneList = document.getElementById('set-pane-list');
  const docMenu = document.getElementById('doc-menu');
  document.body.classList.add('has-set');
  setPane?.setAttribute('aria-hidden', 'false');
  try {
    // Re-fetch on every navigation; the shared signature below decides whether
    // the fetched tree actually needs a DOM rebuild (which resets scroll +
    // collapses folder state), or just an active-marker move.
    const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/tree`);
    if (!res.ok) return;
    const data = (await res.json()) as { tree: TreeDir };
    // Superseded while fetching (mount torn down, or a newer sidebar render
    // claimed the epoch) → don't overwrite the current sidebar.
    if (scope?.disposed || !isCurrentSidebarRender(token)) return;
    if (!force && sidebarShowsSignature(treeSignature(workspaceId, data.tree))) {
      setActiveFile(docId);
      return;
    }
    const html = data.tree.children.map((c) => renderTreeNode(c, workspaceId, '', docId)).join('');
    const treeHtml = `<ul class="tree-root">${html}</ul>`;
    if (setPaneList) setPaneList.innerHTML = treeHtml;
    if (docMenu) docMenu.innerHTML = treeHtml;
    setSidebarSignature(treeSignature(workspaceId, data.tree));
    for (const root of [setPaneList, docMenu]) {
      if (!root) continue;
      root.querySelectorAll('details[data-rel]').forEach((d) => {
        d.addEventListener('toggle', () => {
          const rel = d.getAttribute('data-rel') ?? '';
          try {
            localStorage.setItem(
              treeDetailsKey(workspaceId, rel),
              (d as HTMLDetailsElement).open ? 'open' : 'closed',
            );
          } catch {}
        });
      });
    }
  } catch {
    // Fetch failure — not load-bearing for the editor itself.
  }
}

/** Wire focus + ~30s refresh of the tree (counts are a snapshot otherwise).
 *  Returns a cleanup so a per-doc mount can drop it on navigation. */
export function wireWorkspaceTreeRefresh(
  docId: string,
  workspaceId: string,
  scope?: Disposable,
): () => void {
  const refresh = () => void renderWorkspaceTree(docId, workspaceId, true, scope);
  window.addEventListener('focus', refresh);
  const timer = setInterval(refresh, 30_000);
  return () => {
    window.removeEventListener('focus', refresh);
    clearInterval(timer);
  };
}
