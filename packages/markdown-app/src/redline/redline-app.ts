import { type FeedbackClient, connect, suggestOps } from '@feedback/core';
import { mountCode } from '../code/code-app.ts';
import { isEditableRedlineMember } from '../code/editable-policy.ts';
import { renderDiffNav, wireDiffNavRefresh } from '../diff-nav.ts';
import type { MountContext } from '../mount-context.ts';
import type { MountScope } from '../mount-scope.ts';
import { startReadingTracker } from '../reading-tracker.ts';
import {
  type ChromeSelection,
  el,
  mountReviewChrome,
  wireThreadRangeClicks,
} from '../review-chrome.ts';
import type { ReviewSurface } from '../review-surface.ts';
import { navigateTo, remountCurrent } from '../router.ts';
import { getMarkdownMount } from '../surface-registry.ts';
import { createLiveRedlineEditor } from './live-redline-editor.ts';
import { type MarkupMarginHandle, mountMarkupMargin } from './markup-margin.ts';
import { createRedlineEditor } from './redline-editor.ts';
import { mountSuggestionsSummary } from './suggestions-summary.ts';

/**
 * Mount the Word-style redline surface for a markdown file in a diff review.
 *
 * Sibling of `code/code-app.ts`: same diff-nav, base-text fetch, reading
 * tracker, chrome mount and comment pill. What differs is the surface and a
 * third view mode. For LIVE working-tree diffs the surface is the EDITABLE
 * collaborative editor over the companion doc (the same doc the File view and
 * the agent tools use) with ins/del markup rendered as live decorations;
 * pinned reviews and deleted members keep the read-only derived redline.
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
function wireToggle(
  docId: string,
  current: RedlineViewMode,
  scope: MountScope,
  ownAll = false,
): void {
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
  // In redline mode (and the markdown-editor File view, ownAll), code-app
  // isn't running, so this file owns all three buttons. In diff/file mode
  // on the CODE surface, code-app already wired Diff/File to an in-place
  // CodeMirror swap (no reload) — only Redline needs a handler there.
  scope.listen(btnRedline, 'click', () => go('redline'));
  if (current === 'redline' || ownAll) {
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
    // File mode on a LIVE working-tree .md member = the full markdown
    // editor over the companion doc (edits land in the working tree; the
    // redline/diff re-render as they flush). Falls back to the raw-source
    // code view when the companion can't be opened (pinned, no workspace,
    // server error).
    if (mode === 'file' && ctx.workspaceId && !ctx.diffTarget) {
      const mounted = await mountEditableFileView(ctx);
      if (scope.disposed) return;
      if (mounted) {
        if (diffInfo?.baseText != null) wireToggle(docId, 'file', scope, true);
        return;
      }
    }
    // Pass the persisted choice through: mountCode defaults diff docs to
    // unified-diff mode, so a restored 'file' selection would otherwise paint
    // the File button active over a diff surface.
    await mountCode(ctx, mode === 'file' ? 'file' : 'diff');
    // A navigation that superseded us during mountCode's in-flight fetch already
    // disposed this scope and hid the toggle; wireToggle would re-show it,
    // stranding the Redline/Diff/File bar over the next document (finding #2).
    if (scope.disposed) return;
    if (diffInfo?.baseText != null) wireToggle(docId, mode, scope);
    return;
  }
  const baseText = diffInfo.baseText;

  if (ctx.workspaceId) {
    const workspaceId = ctx.workspaceId;
    void (async () => {
      const isDiffNav = await renderDiffNav(docId, workspaceId, false, scope);
      if (scope.disposed) return;
      if (isDiffNav) scope.onCleanup(wireDiffNavRefresh(docId, workspaceId, scope));
    })();
  }

  document.body.classList.add('diff-mode', 'redline-mode');

  const editorMount = el<HTMLElement>('editor');
  const commentPill = el<HTMLButtonElement>('comment-pill');

  let selection: ChromeSelection | null = null;

  // The editable companion editor is the default redline surface for a live
  // working-tree diff. When policy says read-only (pinned target, deleted
  // member) — or the companion can't be opened — fall back to the derived
  // read-only redline over the member doc's `content`.
  const companion = isEditableRedlineMember({
    diffTarget: ctx.diffTarget,
    workspaceId: ctx.workspaceId,
    diffStatus: diffInfo.status,
  })
    ? await openCompanionDoc(ctx)
    : null;
  if (scope.disposed) return;

  // Both surfaces fire onSelectionChange synchronously during construction —
  // before `surface` is bound — so guard the callback until construction
  // returns (otherwise it hits `surface` in the TDZ).
  let surfaceReady = false;
  const onSelectionChange = (): void => {
    if (!surfaceReady) return;
    const sel = surface.getSelectionRel();
    if (sel) {
      selection = sel;
      positionPill();
    } else {
      hidePill();
    }
  };

  const isAdded = diffInfo.status === 'added';
  const liveSurface = companion
    ? createLiveRedlineEditor({
        parent: editorMount,
        ydoc: companion.client.ydoc,
        awareness: companion.client.awareness,
        baseText,
        isAdded,
        onSelectionChange,
        docLink: ctx.workspaceId
          ? { workspaceId: ctx.workspaceId, relPath: ctx.relPath, navigate: navigateTo }
          : undefined,
      })
    : null;
  const surface: ReviewSurface & { getSelectionRel: () => ChromeSelection | null } =
    liveSurface ??
    createRedlineEditor({
      parent: editorMount,
      ydoc: client.ydoc,
      baseText,
      isAdded,
      onSelectionChange,
    });
  surfaceReady = true;
  scope.onCleanup(() => surface.destroy());

  // Threads live where the surface anchors them: the companion doc's prose
  // fragment on the editable surface (interoperable with the agent's
  // create_thread on markdown docs), the member doc's `content` on the
  // read-only one.
  const chromeDocId = companion ? companion.docId : docId;
  const chromeYdoc = companion ? companion.client.ydoc : client.ydoc;
  const chrome = mountReviewChrome({
    docId: chromeDocId,
    user,
    ydoc: chromeYdoc,
    surface,
    // Must be the client whose ydoc the chrome is reading — the companion's
    // when there is one, or the drawer would go on saying "Loading" against a
    // doc that has already arrived (and vice versa).
    whenSynced: (cb) => (companion ? companion.client : client).onReady(cb),
    scope,
    labelHint: ctx.sourceUrl || ctx.relPath || undefined,
    selectHint: 'Select some text first to leave a comment.',
    reanchorHint: 'Select new text first, then click Re-anchor.',
    // The cached selection covers iOS blurring the surface between the pill
    // appearing and being tapped.
    getSelection: () => surface.getSelectionRel() ?? selection,
    hidePill,
    // The margin below mounts only on the editable surface — the read-only
    // fallback keeps inline <del> and needs the drawer as its thread surface.
    hasBalloonMargin: Boolean(liveSurface),
  });

  // The balloon margin renders deletions extracted by the editable surface
  // plus open comment threads; the read-only fallback keeps its inline <del>
  // rendering and has no margin (no companion doc to type into).
  let margin: MarkupMarginHandle | null = null;
  if (liveSurface) {
    margin = mountMarkupMargin({
      editorEl: editorMount,
      view: liveSurface.handle.editor.view,
      getDeletions: () => liveSurface.getDeletions(),
      threads: () => chrome.collectThreads(),
      chrome,
      getSuggestions: () => suggestOps.listSuggestions(chromeYdoc),
      docId: chromeDocId,
      scope,
    });
    // Doc-level "N pending suggestions" topbar badge — same affordance the
    // plain markdown surface mounts (app.ts), wired to the companion doc so
    // it tracks the SAME suggestions the balloons above render.
    const suggestionsSummary = mountSuggestionsSummary({
      docId: chromeDocId,
      ydoc: chromeYdoc,
      scope,
    });
    // Every transaction (typing, remote edits, the debounced markup recompute
    // dispatching its meta, thread activation/decoration changes) can move
    // anchors or change the deletions/threads/suggestions list.
    const onTransaction = (): void => {
      margin?.scheduleRelayout();
      suggestionsSummary.scheduleRefresh();
    };
    liveSurface.handle.editor.on('transaction', onTransaction);
    scope.onCleanup(() => liveSurface.handle.editor.off('transaction', onTransaction));
  }

  // Tap-on-highlight → focus the thread. Only comments have anchors that
  // decorate the doc (deletions never render inline here — that's the whole
  // point of the margin), so this is purely the comment-balloon "vice versa".
  wireThreadRangeClicks({
    editorMount,
    chrome,
    surface,
    scope,
    revealBalloon: margin
      ? (id) => (margin as MarkupMarginHandle).revealThreadBalloon(id)
      : undefined,
  });

  scope.onCleanup(startReadingTracker({ docId, user, scrollEl: editorMount }));
  wireToggle(docId, 'redline', scope);

  if (isAdded) {
    // Added file: nothing to mark up — render clean instead of underlining
    // the whole document.
    showBanner('New file in this diff');
  } else if (diffInfo.status === 'renamed' && diffInfo.oldPath) {
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
  chromeYdoc.getMap('meta').observe(onMeta);
  scope.onCleanup(() => chromeYdoc.getMap('meta').unobserve(onMeta));
  (companion ? companion.client : client).onReady(() => {
    if (scope.disposed) return;
    chrome.renderDocLabel();
    chrome.redrawThreads();
  });
}

interface CompanionDoc {
  docId: string;
  client: FeedbackClient;
  sourceUrl: string;
}

/**
 * Open (or create) the companion editable doc for this `.md` diff member and
 * connect its websocket. The companion is a separate doc with its own socket;
 * the socket closes with the member's scope. Returns null when the companion
 * can't be opened (no workspace binding, server error) so callers can fall
 * back to a read-only surface.
 */
async function openCompanionDoc(ctx: MountContext): Promise<CompanionDoc | null> {
  let opened: { docId: string; meta?: { sourceUrl?: string } };
  try {
    const res = await fetch(
      `/api/workspaces/${encodeURIComponent(ctx.workspaceId)}/editable-file`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relPath: ctx.relPath }),
      },
    );
    if (!res.ok) return null;
    opened = (await res.json()) as { docId: string; meta?: { sourceUrl?: string } };
  } catch {
    return null;
  }
  if (ctx.scope.disposed) return null; // navigated away — don't open a socket
  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/y/${encodeURIComponent(opened.docId)}?type=markdown`;
  const client = connect(wsUrl);
  ctx.scope.onCleanup(() => client.close());
  return { docId: opened.docId, client, sourceUrl: opened.meta?.sourceUrl ?? '' };
}

/**
 * Mount the full markdown editor over the companion editable doc for this
 * `.md` diff member. The companion is a separate doc with its own websocket;
 * both close with the member's scope. Returns false when the companion
 * can't be opened, so the caller can fall back to the raw-source view.
 */
async function mountEditableFileView(ctx: MountContext): Promise<boolean> {
  const mountMarkdown = getMarkdownMount();
  if (!mountMarkdown) return false;
  const companion = await openCompanionDoc(ctx);
  if (ctx.scope.disposed) return true; // navigated away — report handled
  if (!companion) return false;
  await mountMarkdown({
    ...ctx,
    docId: companion.docId,
    // The sidebar lists the diff MEMBER, not the companion — keep marking it
    // active (mountMarkdown's nav renders would otherwise highlight nothing).
    navDocId: ctx.docId,
    client: companion.client,
    docType: 'markdown',
    sourceUrl: companion.sourceUrl,
    diffTarget: '',
  });
  return true;
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
