import { type FeedbackClient, type User, readDocMeta } from '@feedback/core';
import { startReadingTracker } from '../reading-tracker.ts';
import { el, mountReviewChrome } from '../review-chrome.ts';
import { renderWorkspaceTree, wireWorkspaceTreeRefresh } from '../workspace-tree.ts';
import { createCodeEditor } from './code-editor.ts';

/**
 * Boot the read-only code / diff review surface. All thread/composer/drawer
 * wiring lives in the shared review chrome (review-chrome.ts); this file
 * owns only what's specific to the CodeMirror surface: mounting the editor,
 * the selection→pill affordance, and (for diff docs) the base-text fetch,
 * the Diff ↔ File toggle, and the status banner. The format bar and
 * edit-mode toggle are markdown/Tiptap-only; `body.code-mode` hides them.
 */
export async function bootCode(opts: {
  docId: string;
  client: FeedbackClient;
  user: User;
  sourceUrl?: string;
  workspaceId?: string;
  /** 'diff' boots the same surface in unified-diff mode with a view toggle. */
  docType?: 'code' | 'diff';
  /** Path relative to the repo root — language detection + doc label for
   *  diff docs, which may have no sourceUrl in pinned mode. */
  relPath?: string;
}): Promise<void> {
  const { docId, client, user } = opts;
  const isDiff = opts.docType === 'diff';
  // A code file bound via bind_folder belongs to a workspace — render the
  // shared file tree so the reviewer can navigate the folder (same as the
  // markdown surface; code docs skip app.ts's renderSetNav by booting here).
  if (opts.workspaceId) {
    void renderWorkspaceTree(docId, opts.workspaceId);
    wireWorkspaceTreeRefresh(docId, opts.workspaceId);
  }
  const { ydoc } = client;
  document.body.classList.add('code-mode');
  if (isDiff) document.body.classList.add('diff-mode');

  // Diff rendering data: the base-commit text this file is compared against.
  // Fetched before mounting so the surface can boot straight into diff mode.
  // When it's unavailable (repo worktree pruned), fall back to the whole-file
  // view — that needs nothing beyond the ydoc content.
  interface DiffInfo {
    baseText: string | null;
    status?: 'added' | 'modified' | 'deleted' | 'renamed';
    oldPath?: string;
    error?: string;
  }
  let diffInfo: DiffInfo | null = null;
  if (isDiff) {
    try {
      const res = await fetch(`/api/docs/${encodeURIComponent(docId)}/diff`);
      if (res.ok) diffInfo = (await res.json()) as DiffInfo;
    } catch {
      // fall through to whole-file mode
    }
  }

  const editorMount = el<HTMLElement>('editor');
  const commentPill = el<HTMLButtonElement>('comment-pill');

  // Prefer the sourceUrl from the REST meta (available immediately) over the
  // Yjs meta map, which hasn't synced yet at boot — otherwise the language
  // extension is chosen from an empty path and the file renders unhighlighted.
  // Diff docs may have no sourceUrl; their relPath serves the same purpose.
  const sourceUrl = opts.sourceUrl || opts.relPath || (readDocMeta(ydoc).sourceUrl ?? '');

  let selection: { start: Uint8Array; end: Uint8Array; snippet: string } | null = null;

  const surface = createCodeEditor({
    parent: editorMount,
    ydoc,
    sourceUrl,
    diff: diffInfo?.baseText != null ? { baseText: diffInfo.baseText } : undefined,
    onSelectionChange: () => {
      const sel = surface.getSelectionRel();
      if (sel) {
        selection = sel;
        positionPill();
      } else {
        hidePill();
      }
    },
    onMarkerClick: (id) => chrome.revealThread(id),
  });

  const chrome = mountReviewChrome({
    docId,
    user,
    ydoc,
    surface,
    selectHint: 'Select some lines first to leave a comment.',
    reanchorHint: 'Select new lines first, then click Re-anchor.',
    getSelection: () => surface.getSelectionRel() ?? selection,
    hidePill,
  });

  // Interaction-bounded reading-session capture (doc_open + read_session).
  // CodeMirror manages its own scroller inside #editor; the tracker reads
  // scroll depth from editorMount and listens for interaction at the window.
  startReadingTracker({ docId, user, scrollEl: editorMount });

  // --- diff ↔ whole-file toggle ---------------------------------------------
  if (isDiff) {
    const toggle = document.getElementById('view-toggle');
    const btnDiff = document.getElementById('view-diff') as HTMLButtonElement | null;
    const btnFile = document.getElementById('view-file') as HTMLButtonElement | null;
    if (diffInfo?.baseText != null && toggle && btnDiff && btnFile) {
      toggle.classList.remove('hidden');
      const applyMode = (mode: 'diff' | 'file') => {
        surface.setViewMode(mode);
        btnDiff.classList.toggle('active', mode === 'diff');
        btnDiff.setAttribute('aria-pressed', String(mode === 'diff'));
        btnFile.classList.toggle('active', mode === 'file');
        btnFile.setAttribute('aria-pressed', String(mode === 'file'));
      };
      btnDiff.addEventListener('click', () => applyMode('diff'));
      btnFile.addEventListener('click', () => applyMode('file'));
    }
    if (diffInfo?.status === 'deleted') {
      showBanner('This file was deleted in this diff — the content shown is the base version.');
    } else if (diffInfo?.baseText == null) {
      showBanner(
        `Diff unavailable (${diffInfo?.error ?? 'no diff data'}) — showing the whole file at the target commit.`,
      );
    } else if (diffInfo.status === 'renamed' && diffInfo.oldPath) {
      showBanner(`Renamed from ${diffInfo.oldPath}`);
    }
  }

  // --- comment affordance: a pill anchored to the selection -----------------
  function positionPill(): void {
    if (!document.getElementById('composer')?.classList.contains('hidden')) {
      hidePill();
      return;
    }
    const winSel = window.getSelection();
    if (!winSel || winSel.rangeCount === 0 || winSel.isCollapsed) {
      hidePill();
      return;
    }
    try {
      const rects = winSel.getRangeAt(0).getClientRects();
      const last = rects.length > 0 ? rects[rects.length - 1] : null;
      if (!last) {
        hidePill();
        return;
      }
      const gap = 8;
      const pillW = 36;
      const viewportW = window.innerWidth;
      let left = last.right + gap;
      const top = Math.max(8, last.top - 2);
      if (left + pillW > viewportW - 8) left = Math.max(8, last.right - pillW);
      commentPill.style.left = `${Math.max(8, left)}px`;
      commentPill.style.top = `${top}px`;
      commentPill.classList.remove('hidden');
    } catch {
      hidePill();
    }
  }
  function hidePill(): void {
    commentPill.classList.add('hidden');
  }
  commentPill.addEventListener('mousedown', (ev) => ev.preventDefault());
  commentPill.addEventListener('click', () => chrome.openComposer());

  // --- doc label + boot render -----------------------------------------------
  ydoc.getMap('meta').observe(() => chrome.renderDocLabel());
  client.onReady(() => {
    chrome.renderDocLabel();
    chrome.redrawThreads();
  });

  addEventListener('beforeunload', () => {
    client.close();
    surface.destroy();
  });
}

/** Persistent one-line notice above the editor (rename origin, deleted file,
 *  diff-unavailable fallback). Distinct from the transient toast. */
function showBanner(msg: string): void {
  const pane = document.getElementById('editor-pane');
  if (!pane) return;
  let b = document.getElementById('diff-banner');
  if (!b) {
    b = document.createElement('div');
    b.id = 'diff-banner';
    b.className = 'diff-banner';
    pane.insertBefore(b, pane.firstChild);
  }
  b.textContent = msg;
}
