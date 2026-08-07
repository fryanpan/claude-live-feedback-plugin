import { renderDiffNav, wireDiffNavRefresh } from '../diff-nav.ts';
import type { MountContext } from '../mount-context.ts';
import { startReadingTracker } from '../reading-tracker.ts';
import { el, mountReviewChrome } from '../review-chrome.ts';
import { renderWorkspaceTree, wireWorkspaceTreeRefresh } from '../workspace-tree.ts';
import { createCodeEditor } from './code-editor.ts';
import { isEditableFileMember } from './editable-policy.ts';

/**
 * Mount the read-only code / diff review surface. All thread/composer/drawer
 * wiring lives in the shared review chrome (review-chrome.ts); this file
 * owns only what's specific to the CodeMirror surface: mounting the editor,
 * the selection→pill affordance, and (for diff docs) the base-text fetch,
 * the Diff ↔ File toggle, and the status banner. The format bar and
 * edit-mode toggle are markdown/Tiptap-only; `body.code-mode` hides them.
 *
 * Every listener is bound to `ctx.scope` so navigation tears the mount down.
 * `initialViewMode` (redline-app passes a reviewer's persisted choice through)
 * defaults to unified-diff; without it a restored 'file' selection would paint
 * File active over a diff surface.
 */
export async function mountCode(
  ctx: MountContext,
  initialViewMode?: 'diff' | 'file',
): Promise<void> {
  const { docId, client, user, scope } = ctx;
  const isDiff = ctx.docType === 'diff';
  // Workspace nav: diff reviews get the grouped-diffs / all-files sidebar;
  // plain folder binds keep the folder tree. Detection is by data, not doc
  // type, so a context file (type 'code') opened inside a diff review still
  // shows the diff nav.
  if (ctx.workspaceId) {
    const workspaceId = ctx.workspaceId;
    void (async () => {
      const isDiffNav = await renderDiffNav(docId, workspaceId, false, scope);
      if (scope.disposed) return;
      if (isDiffNav) {
        scope.onCleanup(wireDiffNavRefresh(docId, workspaceId, scope));
      } else {
        void renderWorkspaceTree(docId, workspaceId, false, scope);
        scope.onCleanup(wireWorkspaceTreeRefresh(docId, workspaceId, scope));
      }
    })();
  }
  const { ydoc, awareness } = client;
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
    if (scope.disposed) return; // navigated away during the fetch
  }

  // The File view of a LIVE working-tree diff member is a real editor — the
  // server binds those members with disk write-back, so edits land in the
  // working tree within ~1s. Decided AFTER the diff fetch because status
  // matters: see isEditableFileMember (a deleted member has no binding).
  const editable = isEditableFileMember({
    isDiff,
    diffTarget: ctx.diffTarget,
    relPath: ctx.relPath,
    diffStatus: diffInfo?.status,
  });
  if (editable) {
    awareness.setLocalStateField('user', { name: user.name, color: user.color });
    document.body.classList.add('code-editable');
    scope.onCleanup(() => document.body.classList.remove('code-editable'));
  }

  const editorMount = el<HTMLElement>('editor');
  const commentPill = el<HTMLButtonElement>('comment-pill');

  // Only used to pick a syntax-highlighting language. It comes from the REST
  // meta, which is available immediately at boot. There used to be a fallback
  // to the Yjs meta map; sourceUrl no longer lives in the CRDT (it named a
  // path on the host, and the CRDT syncs to share visitors), so that branch
  // is gone. A share visitor gets relPath — a bare filename for a standalone
  // doc — which is all the language lookup needs.
  const sourceUrl = ctx.sourceUrl || ctx.relPath || '';

  let selection: { start: Uint8Array; end: Uint8Array; snippet: string } | null = null;

  // Forward ref — the chrome mounts right after the editor; editor callbacks
  // are user-triggered so the guard never fires in practice.
  // biome-ignore lint/style/useConst: assigned after createCodeEditor so its callbacks can close over it
  let chromeRef: import('../review-chrome.ts').ReviewChrome | undefined;
  const surface = createCodeEditor({
    parent: editorMount,
    ydoc,
    sourceUrl,
    diff: diffInfo?.baseText != null ? { baseText: diffInfo.baseText } : undefined,
    initialViewMode,
    editable,
    awareness,
    onSelectionChange: () => {
      const sel = surface.getSelectionRel();
      if (sel) {
        selection = sel;
        positionPill();
      } else {
        hidePill();
      }
    },
    onMarkerClick: (id) => chromeRef?.revealThread(id),
    // PR-style: clicking a line number selects the line and opens the
    // composer directly — no range selection needed.
    onGutterComment: () => chromeRef?.openComposer(),
  });
  scope.onCleanup(() => surface.destroy());

  const chrome = mountReviewChrome({
    docId,
    user,
    ydoc,
    surface,
    scope,
    labelHint: ctx.sourceUrl || ctx.relPath || undefined,
    selectHint: 'Click a line number, or select some lines, to leave a comment.',
    reanchorHint: 'Select new lines first, then click Re-anchor.',
    getSelection: () => surface.getSelectionRel() ?? selection,
    hidePill,
  });
  chromeRef = chrome;

  // Click a line (not just its number) → light caret-style pill on that
  // line; tapping it opens the composer for the whole line.
  scope.listen(editorMount, 'click', (ev) => {
    const mev = ev as MouseEvent;
    const target = mev.target as HTMLElement | null;
    if (!target?.closest('.cm-content')) return;
    if (!document.getElementById('composer')?.classList.contains('hidden')) return;
    // Let CodeMirror place the cursor first.
    setTimeout(() => {
      if (surface.getSelectionRel()) return; // real range selection → normal pill
      const lineSel = surface.getCursorLineRel();
      if (!lineSel) return;
      selection = lineSel;
      const gap = 10;
      const pillW = 36;
      let left = mev.clientX + gap;
      if (left + pillW > window.innerWidth - 8) left = window.innerWidth - pillW - 8;
      commentPill.classList.add('caret');
      commentPill.style.left = `${Math.max(8, left)}px`;
      commentPill.style.top = `${Math.max(8, mev.clientY - 14)}px`;
      commentPill.classList.remove('hidden');
    }, 30);
  });
  // The caret pill is a click affordance, not a cursor follower — dismiss on scroll.
  scope.listen(
    editorMount,
    'scroll',
    () => {
      if (commentPill.classList.contains('caret')) hidePill();
    },
    { passive: true, capture: true },
  );

  // Interaction-bounded reading-session capture (doc_open + read_session).
  // CodeMirror manages its own scroller inside #editor; the tracker reads
  // scroll depth from editorMount and listens for interaction at the window.
  scope.onCleanup(startReadingTracker({ docId, user, scrollEl: editorMount }));

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
      scope.listen(btnDiff, 'click', () => applyMode('diff'));
      scope.listen(btnFile, 'click', () => applyMode('file'));
      // Always paint the toggle to THIS file's mode on mount. resetSurfaceChrome
      // doesn't touch these buttons, so after SPA nav they'd keep the previous
      // file's active/aria-pressed state (finding #6) — repaint unconditionally.
      applyMode(initialViewMode === 'file' ? 'file' : 'diff');
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
      commentPill.classList.remove('caret');
      commentPill.style.left = `${Math.max(8, left)}px`;
      commentPill.style.top = `${top}px`;
      commentPill.classList.remove('hidden');
    } catch {
      hidePill();
    }
  }
  function hidePill(): void {
    commentPill.classList.add('hidden');
    commentPill.classList.remove('caret');
  }
  scope.listen(commentPill, 'mousedown', (ev) => ev.preventDefault());
  scope.listen(commentPill, 'click', () => chrome.openComposer());

  // --- doc label + boot render -----------------------------------------------
  const onMeta = () => chrome.renderDocLabel();
  ydoc.getMap('meta').observe(onMeta);
  scope.onCleanup(() => ydoc.getMap('meta').unobserve(onMeta));
  client.onReady(() => {
    if (scope.disposed) return;
    chrome.renderDocLabel();
    chrome.redrawThreads();
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
