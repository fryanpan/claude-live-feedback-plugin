import { escapeHtml } from '@feedback/core';

/**
 * Sidebar navigation for DIFF REVIEWS (renders into #set-pane / #doc-menu,
 * same slots the folder workspace-tree uses). Two views, toggled at the top:
 *
 *  - "Show Grouped Diffs" (default): the CHANGED files organized into their
 *    logical groups (agent-supplied at bind time or heuristic) — a flat,
 *    compact list per group instead of a deep folder tree.
 *  - "Show All Files": a collapsible folder tree of EVERY file in the repo,
 *    changed files marked, unchanged ones openable on demand as read-only
 *    context docs.
 */

interface GroupedFile {
  docId: string;
  name: string;
  relPath: string;
  openCount: number;
  reviewUrl?: string;
  diffStatus?: 'added' | 'modified' | 'deleted' | 'renamed';
  diffAdditions?: number;
  diffDeletions?: number;
}
interface GroupedModel {
  groups: Array<{ title: string; openCount: number; files: GroupedFile[] }>;
}
interface RepoFile {
  relPath: string;
  changed: boolean;
  docId?: string;
  reviewUrl?: string;
}

type NavView = 'grouped' | 'all';

function viewKey(workspaceId: string): string {
  return `lf:diff-nav:${workspaceId}`;
}

function appendParams(url: string): string {
  const qs = new URLSearchParams(location.search).toString();
  if (!qs) return url;
  return url.includes('?') ? `${url}&${qs}` : `${url}?${qs}`;
}

/** Try to render the diff-review nav. Returns false when the workspace has
 *  no diff members (caller falls back to the folder tree). */
export async function renderDiffNav(docId: string, workspaceId: string): Promise<boolean> {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/grouped`).catch(
    () => null,
  );
  if (!res || !res.ok) return false;
  const grouped = (await res.json()) as GroupedModel;
  if (!grouped.groups.length) return false;

  document.body.classList.add('has-set');
  document.getElementById('set-pane')?.setAttribute('aria-hidden', 'false');

  let view: NavView = 'grouped';
  try {
    if (localStorage.getItem(viewKey(workspaceId)) === 'all') view = 'all';
  } catch {}

  const render = async () => {
    const header = `
      <div class="diff-nav-toggle" role="group" aria-label="Sidebar view">
        <button type="button" data-nav="grouped" class="${view === 'grouped' ? 'active' : ''}">Show Grouped Diffs</button>
        <button type="button" data-nav="all" class="${view === 'all' ? 'active' : ''}">Show All Files</button>
      </div>`;
    const body =
      view === 'grouped' ? renderGrouped(grouped, docId) : await renderAllFiles(workspaceId, docId);
    const html = header + body;
    const setPaneList = document.getElementById('set-pane-list');
    const docMenu = document.getElementById('doc-menu');
    if (setPaneList) setPaneList.innerHTML = html;
    if (docMenu) docMenu.innerHTML = html;
    for (const rootEl of [setPaneList, docMenu]) {
      if (!rootEl) continue;
      wireToggle(rootEl);
      if (view === 'all') wireContextOpen(rootEl, workspaceId);
    }
  };

  const wireToggle = (rootEl: HTMLElement) => {
    for (const b of rootEl.querySelectorAll<HTMLButtonElement>('.diff-nav-toggle button')) {
      b.addEventListener('click', () => {
        view = (b.getAttribute('data-nav') as NavView) ?? 'grouped';
        try {
          localStorage.setItem(viewKey(workspaceId), view);
        } catch {}
        void render();
      });
    }
  };

  const wireContextOpen = (rootEl: HTMLElement, wsId: string) => {
    for (const a of rootEl.querySelectorAll<HTMLElement>('[data-context-path]')) {
      a.addEventListener('click', async (ev) => {
        ev.preventDefault();
        const relPath = a.getAttribute('data-context-path');
        if (!relPath) return;
        a.classList.add('loading');
        try {
          const r = await fetch(`/api/workspaces/${encodeURIComponent(wsId)}/context-file`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ relPath }),
          });
          if (!r.ok) return;
          const data = (await r.json()) as { meta?: { reviewUrl?: string } };
          if (data.meta?.reviewUrl) location.href = appendParams(data.meta.reviewUrl);
        } finally {
          a.classList.remove('loading');
        }
      });
    }
  };

  await render();
  return true;
}

function fileRow(f: GroupedFile, activeDocId: string): string {
  const isActive = f.docId === activeDocId;
  const href = f.reviewUrl ? appendParams(f.reviewUrl) : '#';
  const dir = f.relPath.includes('/') ? f.relPath.slice(0, f.relPath.lastIndexOf('/')) : '';
  const letter = f.diffStatus ? (f.diffStatus[0]?.toUpperCase() ?? '') : '';
  const counts =
    f.diffAdditions != null || f.diffDeletions != null
      ? `<span class="tree-diff-counts">+${f.diffAdditions ?? 0} −${f.diffDeletions ?? 0}</span>`
      : '';
  const open = f.openCount > 0 ? `<span class="tree-badge badge-open">${f.openCount}</span>` : '';
  return `<li class="diff-file"><a href="${href}" class="${isActive ? 'active' : ''}"${
    isActive ? ' aria-current="page"' : ''
  } title="${escapeHtml(f.relPath)}">
    ${letter ? `<span class="tree-diff-status tree-diff-${letter}">${letter}</span>` : ''}
    <span class="diff-file-name">${escapeHtml(f.name)}${
      dir ? `<small class="diff-file-dir">${escapeHtml(dir)}</small>` : ''
    }</span>${counts}${open}</a></li>`;
}

function renderGrouped(model: GroupedModel, activeDocId: string): string {
  return model.groups
    .map(
      (g) => `
      <section class="diff-group">
        <div class="diff-group-title">${escapeHtml(g.title)}${
          g.openCount > 0 ? `<span class="tree-badge tree-badge-dir">${g.openCount}</span>` : ''
        }</div>
        <ul class="diff-group-files">${g.files.map((f) => fileRow(f, activeDocId)).join('')}</ul>
      </section>`,
    )
    .join('');
}

interface DirNode {
  dirs: Map<string, DirNode>;
  files: RepoFile[];
}

async function renderAllFiles(workspaceId: string, activeDocId: string): Promise<string> {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/files`).catch(
    () => null,
  );
  if (!res || !res.ok) return '<div class="diff-nav-empty">File list unavailable.</div>';
  const data = (await res.json()) as { files: RepoFile[]; truncated?: boolean };

  const root: DirNode = { dirs: new Map(), files: [] };
  for (const f of data.files) {
    const parts = f.relPath.split('/');
    let cursor = root;
    for (const part of parts.slice(0, -1)) {
      let next = cursor.dirs.get(part);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        cursor.dirs.set(part, next);
      }
      cursor = next;
    }
    cursor.files.push(f);
  }

  const renderNode = (node: DirNode, depth: number): string => {
    // Directories first (sorted), then files. Top level opens by default;
    // deeper levels start collapsed so a big repo stays scannable.
    const dirs = Array.from(node.dirs.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(
        ([name, child]) => `<li class="tree-dir"><details${depth === 0 ? ' open' : ''}>
          <summary><span class="tree-name">${escapeHtml(name)}</span>${
            hasChanged(child)
              ? '<span class="diff-changed-dot" title="contains changes"></span>'
              : ''
          }</summary>
          <ul>${renderNode(child, depth + 1)}</ul></details></li>`,
      )
      .join('');
    const files = node.files
      .map((f) => {
        const name = f.relPath.split('/').pop() ?? f.relPath;
        const isActive = f.docId === activeDocId;
        if (f.reviewUrl) {
          return `<li class="tree-file"><a href="${appendParams(f.reviewUrl)}" class="${
            isActive ? 'active' : ''
          }"><span class="tree-name">${escapeHtml(name)}</span>${
            f.changed ? '<span class="diff-changed-dot" title="changed"></span>' : ''
          }</a></li>`;
        }
        return `<li class="tree-file"><a href="#" data-context-path="${escapeHtml(
          f.relPath,
        )}" title="Open for context"><span class="tree-name">${escapeHtml(name)}</span></a></li>`;
      })
      .join('');
    return dirs + files;
  };

  const notice = data.truncated
    ? '<div class="diff-nav-empty">List truncated at 10,000 files.</div>'
    : '';
  return `<ul class="tree-root">${renderNode(root, 0)}</ul>${notice}`;
}

function hasChanged(node: DirNode): boolean {
  if (node.files.some((f) => f.changed)) return true;
  for (const child of node.dirs.values()) if (hasChanged(child)) return true;
  return false;
}

/** Focus + ~30s heartbeat refresh, same contract as the workspace tree. */
export function wireDiffNavRefresh(docId: string, workspaceId: string): void {
  const refresh = () => void renderDiffNav(docId, workspaceId);
  window.addEventListener('focus', refresh);
  setInterval(refresh, 30_000);
}
