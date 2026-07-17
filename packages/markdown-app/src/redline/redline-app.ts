import { mountCode } from '../code/code-app.ts';
import { renderDiffNav, wireDiffNavRefresh } from '../diff-nav.ts';
import type { MountContext } from '../mount-context.ts';
import type { MountScope } from '../mount-scope.ts';
import { startReadingTracker } from '../reading-tracker.ts';
import { el, mountReviewChrome } from '../review-chrome.ts';
import { remountCurrent } from '../router.ts';
import { createRedlineEditor } from './redline-editor.ts';

/**
 * Mount the Word-style redline surface for a markdown file in a diff review.
 *
 * Sibling of `code/code-app.ts`: same diff-nav, base-text fetch, reading
 * tracker, chrome mount and comment pill. What differs is the surface (a
 * read-only Tiptap redline instead of CodeMirror) and a third view mode.
 *
 * Every listener is bound to `ctx.scope` so navigating to another file tears
 * this mount down cleanly; the router owns the client (closed on dispose).
 */

export type RedlineViewMode = 'redline' | 'diff' | 'file';

const modeKey = (docId: string) => `lf-view-mode:${docId}`;

export function readViewMode(docId: string): RedlineViewMode {
  try {
    const v = localStorage.getItem(modeKey(docId));
    if (v === 'diff' || v === 'file' || v === 'redline') return v;
  } catch {
    // Private mode / storage disabled — fall through to the default.
  }
  return 'redline'; // markdown diffs open redlined
}

function writeViewMode(docId: string, mode: RedlineViewMode): void {
  try {
    localStorage.setItem(modeKey(docId), mode);
  } catch {
    // Non-fatal: the toggle just won't persist across reloads.
  }
}

/**
 * Wire the view toggle for a markdown diff doc.
 *
 * Switching between the redline (Tiptap) and the source diff (CodeMirror)
 * swaps the whole surface. Now that ReviewChrome tears down cleanly, the swap
 * happens in place: the mode change persists to localStorage and the router
 * re-mounts the current doc (no reload, no lost history entry) — the fresh
 * mount reads the new mode and picks redline vs. code.
 */
function wireToggle(docId: string, current: RedlineViewMode, scope: MountScope): void {
  const toggle = document.getElementById('view-toggle');
  const btnRedline = document.getElementById('view-redline') as HTMLButtonElement | null;
  const btnDiff = document.getElementById('view-diff') as HTMLButtonElement | null;
  const btnFile = document.getElementById('view-file') as HTMLButtonElement | null;
  if (!toggle || !btnRedline || !btnDiff || !btnFile) return;

  toggle.classList.remove('hidden');
  btnRedline.classList.remove('hidden'); // markdown-only; hidden by default

  const paint = (btn: HTMLButtonElement, active: boolean) => {
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  };
  paint(btnRedline, current === 'redline');
  paint(btnDiff, current === 'diff');
  paint(btnFile, current === 'file');

  const go = (mode: RedlineViewMode) => {
    if (mode === current) return;
    writeViewMode(docId, mode);
    remountCurrent();
  };
  // In redline mode, code-app isn't running, so this file owns all three
  // buttons. In diff/file mode code-app already wired Diff/File to an
  // in-place CodeMirror swap (no reload) — only Redline needs a handler.
  scope.listen(btnRedline, 'click', () => go('redline'));
  if (current === 'redline') {
    scope.listen(btnDiff, 'click', () => go('diff'));
    scope.listen(btnFile, 'click', () => go('file'));
  }
}

interface DiffInfo {
  baseText: string | null;
  status?: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;
  error?: string;
}

export async function mountRedline(ctx: MountContext): Promise<void> {
  const { docId, client, user, scope } = ctx;
  const mode = readViewMode(docId);

  // The base text this file is compared against. Fetched before mounting so
  // the surface boots straight into the redline.
  let diffInfo: DiffInfo | null = null;
  try {
    const res = await fetch(`/api/docs/${encodeURIComponent(docId)}/diff`);
    if (res.ok) diffInfo = (await res.json()) as DiffInfo;
  } catch {
    // fall through — handled below
  }
  if (scope.disposed) return; // navigated away during the fetch

  // No base text (repo worktree pruned) means there is no redline to compute;
  // and the reviewer may simply prefer the source diff. Either way that is
  // exactly what the code surface already does well.
  if (diffInfo?.baseText == null || mode !== 'redline') {
    // Pass the persisted choice through: mountCode defaults diff docs to
    // unified-diff mode, so a restored 'file' selection would otherwise paint
    // the File button active over a diff surface.
    await mountCode(ctx, mode === 'file' ? 'file' : 'diff');
    if (diffInfo?.baseText != null) wireToggle(docId, mode, scope);
    return;
  }
  const baseText = diffInfo.baseText;

  if (ctx.workspaceId) {
    const workspaceId = ctx.workspaceId;
    void (async () => {
      const isDiffNav = await renderDiffNav(docId, workspaceId);
      if (scope.disposed) return;
      if (isDiffNav) scope.onCleanup(wireDiffNavRefresh(docId, workspaceId));
    })();
  }

  const { ydoc } = client;
  document.body.classList.add('diff-mode', 'redline-mode');

  const editorMount = el<HTMLElement>('editor');
  const commentPill = el<HTMLButtonElement>('comment-pill');

  let selection: ReturnType<ReturnType<typeof createRedlineEditor>['getSelectionRel']> = null;

  const surface = createRedlineEditor({
    parent: editorMount,
    ydoc,
    baseText,
    onSelectionChange: () => {
      const sel = surface.getSelectionRel();
      if (sel) {
        selection = sel;
        positionPill();
      } else {
        hidePill();
      }
    },
  });
  scope.onCleanup(() => surface.destroy());

  const chrome = mountReviewChrome({
    docId,
    user,
    ydoc,
    surface,
    scope,
    selectHint: 'Select some text first to leave a comment.',
    reanchorHint: 'Select new text first, then click Re-anchor.',
    // The cached selection covers iOS blurring the surface between the pill
    // appearing and being tapped.
    getSelection: () => surface.getSelectionRel() ?? selection,
    hidePill,
  });

  scope.onCleanup(startReadingTracker({ docId, user, scrollEl: editorMount }));
  wireToggle(docId, 'redline', scope);

  if (diffInfo.status === 'renamed' && diffInfo.oldPath) {
    showBanner(`Renamed from ${diffInfo.oldPath}`);
  } else if (diffInfo.status === 'deleted') {
    showBanner('This file was deleted in this diff — the content shown is the base version.');
  }

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
      let left = last.right + gap;
      const top = Math.max(8, last.top - 2);
      if (left + pillW > window.innerWidth - 8) left = Math.max(8, last.right - pillW);
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

  const onMeta = () => chrome.renderDocLabel();
  ydoc.getMap('meta').observe(onMeta);
  scope.onCleanup(() => ydoc.getMap('meta').unobserve(onMeta));
  client.onReady(() => {
    if (scope.disposed) return;
    chrome.renderDocLabel();
    chrome.redrawThreads();
  });
}

/** Persistent one-line notice above the editor. Mirrors code-app's banner. */
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
