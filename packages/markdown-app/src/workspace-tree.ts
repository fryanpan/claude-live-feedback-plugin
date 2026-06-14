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
      : `/review/${encodeURIComponent(node.docId)}${params.toString() ? `?${params.toString()}` : ''}`;
    const badge =
      node.openCount > 0 ? `<span class="tree-badge badge-open">${node.openCount}</span>` : '';
    return `<li class="tree-file"><a href="${href}" class="${isActive ? 'active' : ''}"${
      isActive ? ' aria-current="page"' : ''
    }><span class="tree-name">${escapeHtml(node.name)}</span>${badge}</a></li>`;
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

export async function renderWorkspaceTree(docId: string, workspaceId: string): Promise<void> {
  const setPane = document.getElementById('set-pane');
  const setPaneList = document.getElementById('set-pane-list');
  const docMenu = document.getElementById('doc-menu');
  document.body.classList.add('has-set');
  setPane?.setAttribute('aria-hidden', 'false');
  try {
    const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/tree`);
    if (!res.ok) return;
    const data = (await res.json()) as { tree: TreeDir };
    const html = data.tree.children.map((c) => renderTreeNode(c, workspaceId, '', docId)).join('');
    const treeHtml = `<ul class="tree-root">${html}</ul>`;
    if (setPaneList) setPaneList.innerHTML = treeHtml;
    if (docMenu) docMenu.innerHTML = treeHtml;
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

/** Wire focus + ~30s refresh of the tree (counts are a snapshot otherwise). */
export function wireWorkspaceTreeRefresh(docId: string, workspaceId: string): void {
  const refresh = () => void renderWorkspaceTree(docId, workspaceId);
  window.addEventListener('focus', refresh);
  setInterval(refresh, 30_000);
}
