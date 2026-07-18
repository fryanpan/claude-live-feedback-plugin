import { escapeHtml } from '@feedback/core';
import {
  resetSidebarSignature,
  setSidebarSignature,
  sidebarShowsSignature,
} from './sidebar-nav-key.ts';

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
  status?: 'added' | 'modified' | 'deleted' | 'renamed';
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

/** The docId of the file currently being viewed. The Changed/All view toggle
 *  re-renders the sidebar and must mark THIS file active — SPA navigation moves
 *  the marker via setActiveFile without re-running renderDiffNav, so a docId
 *  captured at first render would go stale (finding #5). Kept module-level and
 *  updated on every render + setActiveFile so a later toggle paints the right
 *  file. */
let activeDocId: string | null = null;

/** Structural signature of a rendered diff-nav: renderer namespace + workspace
 *  + view + the changed-file identities. Excludes open-comment counts so a new
 *  comment doesn't force a scroll-resetting rebuild on navigation (the heartbeat
 *  refresh updates counts); includes docId + status so a newly-changed file
 *  (finding #7) changes the signature and rebuilds in place. */
function diffNavSignature(workspaceId: string, view: NavView, model: GroupedModel): string {
  const files = model.groups
    .flatMap((g) => g.files.map((f) => `${f.docId}:${f.diffStatus ?? ''}`))
    .join(',');
  return `diff:${workspaceId}:${view}:${files}`;
}

/** Render the workspace nav. Diff reviews get the Changed/All toggle;
 *  BROWSE workspaces (no diff members) get the all-files tree only.
 *  Returns false when the workspace has no navigable file data at all.
 *  `force` (the heartbeat refresh) rebuilds even when the signature is
 *  unchanged, so open-comment counts refresh. */
export async function renderDiffNav(
  docId: string,
  workspaceId: string,
  force = false,
): Promise<boolean> {
  activeDocId = docId;
  // Re-fetch on every navigation so a file added to the changed set mid-review
  // shows up in place (finding #7); the signature check below decides whether
  // the fetched list actually needs a DOM rebuild.
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/grouped`).catch(
    () => null,
  );
  const grouped =
    res?.ok === true ? ((await res.json()) as GroupedModel) : ({ groups: [] } as GroupedModel);
  const hasDiff = grouped.groups.length > 0;
  if (!hasDiff) {
    // Browse mode is only viable when the all-files endpoint works.
    const probe = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/files`).catch(
      () => null,
    );
    if (!probe || !probe.ok) {
      resetSidebarSignature();
      return false;
    }
  }

  document.body.classList.add('has-set');
  document.getElementById('set-pane')?.setAttribute('aria-hidden', 'false');

  let view: NavView = hasDiff ? 'grouped' : 'all';
  try {
    if (hasDiff && localStorage.getItem(viewKey(workspaceId)) === 'all') view = 'all';
  } catch {}

  // Same content already on screen (shared signature, not a per-renderer key) →
  // skip the rebuild that resets scroll; just move the active-file marker.
  if (!force && sidebarShowsSignature(diffNavSignature(workspaceId, view, grouped))) {
    setActiveFile(docId);
    return true;
  }

  const render = async (v: NavView) => {
    const header = hasDiff
      ? `
      <div class="diff-nav-toggle" role="group" aria-label="Sidebar view">
        <button type="button" data-nav="grouped" class="${v === 'grouped' ? 'active' : ''}">Show Changed Files</button>
        <button type="button" data-nav="all" class="${v === 'all' ? 'active' : ''}">Show All Files</button>
      </div>`
      : '';
    // Always mark the CURRENT file active (module-level activeDocId), not a
    // docId captured when this closure was built (finding #5).
    const marked = activeDocId ?? docId;
    const body =
      v === 'grouped'
        ? renderGrouped(grouped, marked, workspaceId)
        : await renderAllFiles(workspaceId, marked);
    const html = header + body;
    const setPaneList = document.getElementById('set-pane-list');
    const docMenu = document.getElementById('doc-menu');
    if (setPaneList) setPaneList.innerHTML = html;
    if (docMenu) docMenu.innerHTML = html;
    for (const rootEl of [setPaneList, docMenu]) {
      if (!rootEl) continue;
      wireToggle(rootEl);
      if (v === 'all') wireContextOpen(rootEl, workspaceId);
      // Persist each group's open/closed state.
      for (const d of rootEl.querySelectorAll<HTMLDetailsElement>('details.diff-group')) {
        d.addEventListener('toggle', () => {
          const title = d.getAttribute('data-group') ?? '';
          try {
            localStorage.setItem(groupKey(workspaceId, title), d.open ? 'open' : 'closed');
          } catch {}
        });
      }
    }
    setSidebarSignature(diffNavSignature(workspaceId, v, grouped));
  };

  const wireToggle = (rootEl: HTMLElement) => {
    for (const b of rootEl.querySelectorAll<HTMLButtonElement>('.diff-nav-toggle button')) {
      b.addEventListener('click', () => {
        view = (b.getAttribute('data-nav') as NavView) ?? 'grouped';
        try {
          localStorage.setItem(viewKey(workspaceId), view);
        } catch {}
        void render(view);
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

  await render(view);
  return true;
}

function fileRow(f: GroupedFile, activeDocId: string): string {
  const isActive = f.docId === activeDocId;
  const href = f.reviewUrl ? appendParams(f.reviewUrl) : '#';
  // One compact scannable row: status letter left-justified, filename, then
  // churn right-justified. The folder path is deliberately absent — it's
  // visible once the file is open; hover shows it via title.
  const letter = f.diffStatus ? (f.diffStatus[0]?.toUpperCase() ?? '') : '';
  const counts =
    f.diffAdditions != null || f.diffDeletions != null
      ? `<span class="tree-diff-counts"><span class="add">+${f.diffAdditions ?? 0}</span> <span class="del">−${f.diffDeletions ?? 0}</span></span>`
      : '';
  const open = f.openCount > 0 ? `<span class="tree-badge badge-open">${f.openCount}</span>` : '';
  return `<li class="diff-file"><a href="${href}" class="${isActive ? 'active' : ''}"${
    isActive ? ' aria-current="page"' : ''
  } title="${escapeHtml(f.relPath)}"><span class="tree-diff-status tree-diff-${letter}">${letter}</span><span class="diff-file-name">${escapeHtml(
    f.name,
  )}</span>${open}${counts}</a></li>`;
}

function groupKey(workspaceId: string, title: string): string {
  return `lf:diff-group:${workspaceId}:${title}`;
}

function renderGrouped(model: GroupedModel, activeDocId: string, workspaceId: string): string {
  return model.groups
    .map((g) => {
      let open = true;
      try {
        if (localStorage.getItem(groupKey(workspaceId, g.title)) === 'closed') open = false;
      } catch {}
      return `
      <details class="diff-group"${open ? ' open' : ''} data-group="${escapeHtml(g.title)}">
        <summary class="diff-group-title"><span class="diff-group-name">${escapeHtml(
          g.title,
        )}</span><span class="diff-group-meta">${g.files.length}</span>${
          g.openCount > 0 ? `<span class="tree-badge badge-open">${g.openCount}</span>` : ''
        }</summary>
        <ul class="diff-group-files">${g.files.map((f) => fileRow(f, activeDocId)).join('')}</ul>
      </details>`;
    })
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
      .map(([name, child]) => {
        // Folders on the path to a change auto-expand so the changed files
        // are visible without spelunking; unchanged folders stay collapsed
        // below the top level.
        const changed = hasChanged(child);
        return `<li class="tree-dir"><details${depth === 0 || changed ? ' open' : ''}>
          <summary><span class="tree-name">${escapeHtml(name)}</span>${
            changed ? '<span class="diff-changed-dot" title="contains changes"></span>' : ''
          }</summary>
          <ul>${renderNode(child, depth + 1)}</ul></details></li>`;
      })
      .join('');
    const files = node.files
      .map((f) => {
        const name = f.relPath.split('/').pop() ?? f.relPath;
        const isActive = f.docId === activeDocId;
        if (f.reviewUrl) {
          const letter = f.status ? (f.status[0]?.toUpperCase() ?? '') : '';
          return `<li class="tree-file"><a href="${appendParams(f.reviewUrl)}" class="${
            isActive ? 'active' : ''
          }${f.changed ? ' changed' : ''}"><span class="tree-name">${escapeHtml(name)}</span>${
            letter
              ? `<span class="tree-diff-status tree-diff-${letter}" title="${f.status}">${letter}</span>`
              : ''
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

/** Focus + ~30s heartbeat refresh, same contract as the workspace tree.
 *  Returns a cleanup — the caller (a per-doc mount) must call it on navigation
 *  so refreshers don't stack across docs. */
export function wireDiffNavRefresh(docId: string, workspaceId: string): () => void {
  const refresh = () => void renderDiffNav(docId, workspaceId, true);
  window.addEventListener('focus', refresh);
  const timer = setInterval(refresh, 30_000);
  return () => {
    window.removeEventListener('focus', refresh);
    clearInterval(timer);
  };
}

/** Extract the docId from a `/review/<docId>[?…]` href (absolute or relative). */
function docIdOfHref(href: string | null): string | null {
  if (!href) return null;
  const m = href.match(/\/review\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Move the "open file" marker to `docId` WITHOUT re-rendering the tree — the
 * wholesale render (renderDiffNav) is what loses the reviewer's scroll
 * position, so navigation must not trigger it. Updates both sidebar containers
 * (#set-pane-list and the mobile #doc-menu), which mirror the same list.
 */
export function setActiveFile(docId: string): void {
  activeDocId = docId;
  const lists = ['set-pane-list', 'doc-menu']
    .map((id) => document.getElementById(id))
    .filter((el): el is HTMLElement => el != null);
  const anchorsOf = (list: HTMLElement) =>
    Array.from(list.querySelectorAll<HTMLAnchorElement>('a[href]'));
  // Only mutate when the target is actually in the list. A call for a docId
  // that isn't rendered yet (or ever) must not clear the current marker.
  const present = lists.some((list) =>
    anchorsOf(list).some((a) => docIdOfHref(a.getAttribute('href')) === docId),
  );
  if (!present) return;
  for (const list of lists) {
    for (const a of anchorsOf(list)) {
      const match = docIdOfHref(a.getAttribute('href')) === docId;
      a.classList.toggle('active', match);
      if (match) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  }
}
