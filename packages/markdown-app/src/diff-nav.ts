import { escapeHtml } from '@feedback/core';
import {
  beginSidebarRender,
  isCurrentSidebarRender,
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

/** Minimal view of a MountScope. A renderer started by a navigation must bail
 *  after its awaits if that navigation was superseded (its scope disposed), so a
 *  stale late response can't clobber the current sidebar (findings #3, #4, #5). */
interface Disposable {
  readonly disposed: boolean;
}
interface FilesResponse {
  files: RepoFile[];
  truncated?: boolean;
}

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
 *  + view + the identities of the files the ACTIVE view renders. The grouped
 *  view renders the changed-files model; the all/browse view renders the
 *  /files tree — so the signature must draw from whichever is on screen, else a
 *  browse workspace (empty grouped model) gets a constant signature and never
 *  refreshes when a file is added (finding #2). Excludes open-comment counts so
 *  a new comment doesn't force a scroll-resetting rebuild on navigation (the
 *  heartbeat updates counts); includes status so a newly-changed file changes
 *  the signature and rebuilds in place. */
function diffNavSignature(
  workspaceId: string,
  view: NavView,
  model: GroupedModel,
  files: FilesResponse | null,
): string {
  if (view === 'all') {
    const f = (files?.files ?? [])
      .map((x) => `${x.relPath}:${x.status ?? ''}:${x.changed ? '1' : '0'}:${x.docId ?? ''}`)
      .join(',');
    return `diff:${workspaceId}:all:${f}`;
  }
  const f = model.groups
    .flatMap((g) => g.files.map((x) => `${x.docId}:${x.diffStatus ?? ''}`))
    .join(',');
  return `diff:${workspaceId}:grouped:${f}`;
}

/** Render the workspace nav. Diff reviews get the Changed/All toggle;
 *  BROWSE workspaces (no diff members) get the all-files tree only.
 *  Returns false when the workspace has no navigable file data at all.
 *  `force` (the heartbeat refresh) rebuilds even when the signature is
 *  unchanged, so open-comment counts refresh. `scope`, when passed, lets a
 *  render started by a navigation bail if that navigation was superseded — a
 *  stale late response must not clobber the current sidebar. */
export async function renderDiffNav(
  docId: string,
  workspaceId: string,
  force = false,
  scope?: Disposable,
): Promise<boolean> {
  const token = beginSidebarRender();
  activeDocId = docId;
  // Re-fetch on every navigation so a file added to the changed set mid-review
  // shows up in place (findings #2, #7); the signature check below decides
  // whether the fetched list actually needs a DOM rebuild. The active marker
  // itself already moved synchronously in the router's swap(), so this fetch
  // never delays the perceived navigation.
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/grouped`).catch(
    () => null,
  );
  const grouped =
    res?.ok === true ? ((await res.json()) as GroupedModel) : ({ groups: [] } as GroupedModel);
  // Superseded while fetching (mount torn down, or a newer sidebar render
  // claimed the epoch) → don't touch the shared sidebar (findings #3–#5).
  if (scope?.disposed || !isCurrentSidebarRender(token)) return true;
  const hasDiff = grouped.groups.length > 0;

  let view: NavView = hasDiff ? 'grouped' : 'all';
  try {
    if (hasDiff && localStorage.getItem(viewKey(workspaceId)) === 'all') view = 'all';
  } catch {}

  // The all/browse view renders from /files, so fetch it up front — both to
  // decide viability (browse needs it) and so the signature reflects the tree
  // actually rendered (finding #2). Fetched lazily for the grouped view (only
  // the toggle needs it there).
  let filesData: FilesResponse | null = null;
  if (view === 'all') {
    filesData = await fetchFiles(workspaceId);
    if (scope?.disposed || !isCurrentSidebarRender(token)) return true;
    if (!filesData) {
      // No all-files data: a browse workspace has nothing to show; a diff
      // review can still fall back to its grouped list. Don't reset the shared
      // signature on a (possibly transient) fetch miss — that would force a
      // needless scroll-resetting rebuild next navigation (finding #8).
      if (!hasDiff) return false;
      view = 'grouped';
    }
  }

  document.body.classList.add('has-set');
  document.getElementById('set-pane')?.setAttribute('aria-hidden', 'false');

  // Same content already on screen (shared signature, not a per-renderer key) →
  // skip the rebuild that resets scroll; just move the active-file marker.
  if (!force && sidebarShowsSignature(diffNavSignature(workspaceId, view, grouped, filesData))) {
    setActiveFile(docId);
    return true;
  }

  const render = async (v: NavView) => {
    // Claim the sidebar for THIS render. render() is also the Changed/All view
    // TOGGLE handler: it fires on a live user click and closes over the scope of
    // whichever mount last fully rendered — that mount is disposed after a
    // signature-match navigation, so a scope.disposed guard would make the
    // toggle silently dead. The epoch token instead keeps a same-workspace
    // toggle alive (nothing newer claimed the sidebar) while still bailing if a
    // navigation to a DIFFERENT sidebar lands during the on-demand fetch below
    // (round-3 finding: a stale toggle must not clobber the new sidebar).
    const rtoken = beginSidebarRender();
    // Toggling grouped→all mid-session needs the file list now (the grouped
    // path skipped the up-front fetch).
    if (v === 'all' && !filesData) filesData = await fetchFiles(workspaceId);
    if (!isCurrentSidebarRender(rtoken)) return;
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
        : filesData
          ? buildAllFilesHtml(filesData, marked)
          : '<div class="diff-nav-empty">File list unavailable.</div>';
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
    setSidebarSignature(diffNavSignature(workspaceId, v, grouped, filesData));
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

/** Fetch the workspace's full file list (changed + unchanged). Returns null on
 *  any failure so the caller can distinguish "no data" from an empty repo. */
async function fetchFiles(workspaceId: string): Promise<FilesResponse | null> {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/files`).catch(
    () => null,
  );
  if (!res || !res.ok) return null;
  return (await res.json()) as FilesResponse;
}

/** Pure render of the all-files folder tree from an already-fetched list, so the
 *  caller can compute the render signature from the same data it draws. */
function buildAllFilesHtml(data: FilesResponse, activeDocId: string): string {
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
export function wireDiffNavRefresh(
  docId: string,
  workspaceId: string,
  scope?: Disposable,
): () => void {
  const refresh = () => void renderDiffNav(docId, workspaceId, true, scope);
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
