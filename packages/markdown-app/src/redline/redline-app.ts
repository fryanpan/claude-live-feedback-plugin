import type { FeedbackClient, User } from '@feedback/core';
import { bootCode } from '../code/code-app.ts';
import { renderDiffNav, wireDiffNavRefresh } from '../diff-nav.ts';
import { startReadingTracker } from '../reading-tracker.ts';
import { el, mountReviewChrome } from '../review-chrome.ts';
import { createRedlineEditor } from './redline-editor.ts';

/**
 * Boot the Word-style redline surface for a markdown file in a diff review.
 *
 * Sibling of `code/code-app.ts`: same diff-nav, base-text fetch, reading
 * tracker, chrome mount and comment pill. What differs is the surface (a
 * read-only Tiptap redline instead of CodeMirror) and a third view mode.
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
 * means swapping the whole surface, and `mountReviewChrome` binds listeners to
 * shared DOM with no teardown — remounting it would double-bind. So a mode
 * change persists and reloads. Toggling is rare; the cost is a lost scroll
 * position, not lost work (threads live server-side). Making this swap in
 * place means giving ReviewChrome a destroy path — worth doing, but not here.
 */
function wireToggle(docId: string, current: RedlineViewMode): void {
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
    location.reload();
  };
  // In redline mode, code-app isn't running, so this file owns all three
  // buttons. In diff/file mode code-app already wired Diff/File to an
  // in-place CodeMirror swap (no reload) — only Redline needs a handler.
  btnRedline.addEventListener('click', () => go('redline'));
  if (current === 'redline') {
    btnDiff.addEventListener('click', () => go('diff'));
    btnFile.addEventListener('click', () => go('file'));
  }
}

interface DiffInfo {
  baseText: string | null;
  status?: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;
  error?: string;
}

export async function bootRedline(opts: {
  docId: string;
  client: FeedbackClient;
  user: User;
  sourceUrl?: string;
  workspaceId?: string;
  docType?: 'code' | 'diff';
  relPath?: string;
}): Promise<void> {
  const { docId, client, user } = opts;
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

  // No base text (repo worktree pruned) means there is no redline to compute;
  // and the reviewer may simply prefer the source diff. Either way that is
  // exactly what code-app already does well.
  if (diffInfo?.baseText == null || mode !== 'redline') {
    // Pass the persisted choice through: bootCode defaults diff docs to
    // unified-diff mode, so a restored 'file' selection would otherwise paint
    // the File button active over a diff surface.
    await bootCode({ ...opts, initialViewMode: mode === 'file' ? 'file' : 'diff' });
    if (diffInfo?.baseText != null) wireToggle(docId, mode);
    return;
  }
  const baseText = diffInfo.baseText;

  if (opts.workspaceId) {
    const workspaceId = opts.workspaceId;
    void (async () => {
      const isDiffNav = await renderDiffNav(docId, workspaceId);
      if (isDiffNav) wireDiffNavRefresh(docId, workspaceId);
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

  const chrome = mountReviewChrome({
    docId,
    user,
    ydoc,
    surface,
    selectHint: 'Select some text first to leave a comment.',
    reanchorHint: 'Select new text first, then click Re-anchor.',
    // The cached selection covers iOS blurring the surface between the pill
    // appearing and being tapped.
    getSelection: () => surface.getSelectionRel() ?? selection,
    hidePill,
  });

  startReadingTracker({ docId, user, scrollEl: editorMount });
  wireToggle(docId, 'redline');

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
  commentPill.addEventListener('mousedown', (ev) => ev.preventDefault());
  commentPill.addEventListener('click', () => chrome.openComposer());

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
