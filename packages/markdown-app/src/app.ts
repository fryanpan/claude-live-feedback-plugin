import { type User, connect, escapeHtml, readDocMeta, resolveUser } from '@feedback/core';
import { mountCode } from './code/code-app.ts';
import { renderDiffNav, setActiveFile } from './diff-nav.ts';
import { type EditorHandle, createEditor } from './editor.ts';
import type { DocMeta, MountContext } from './mount-context.ts';
import type { MountScope } from './mount-scope.ts';
import { startReadingTracker } from './reading-tracker.ts';
import { mountRedline } from './redline/redline-app.ts';
import { type ReviewChrome, el, mountReviewChrome, showToast } from './review-chrome.ts';
import { startRouter } from './router.ts';
import {
  resetSidebarSignature,
  setSidebarSignature,
  sidebarShowsSignature,
} from './sidebar-nav-key.ts';
import { type TableMenuItem, tableMenuItems } from './table-menu.ts';
import { renderWorkspaceTree } from './workspace-tree.ts';

const DEFAULT_WS_PATH = (docId: string, type: string) =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/y/${encodeURIComponent(docId)}?type=${encodeURIComponent(type)}`;

/** Fetch a doc's persisted type + paths before mounting a surface. Defaults to
 *  'markdown' if the meta can't be read (the markdown path is the safe
 *  fallback — it never assumes code). */
async function fetchDocMeta(docId: string): Promise<DocMeta> {
  const fallback: DocMeta = { docType: 'markdown', sourceUrl: '', workspaceId: '', relPath: '' };
  try {
    const res = await fetch(`/api/docs/${encodeURIComponent(docId)}`);
    if (!res.ok) return fallback;
    const data = (await res.json()) as {
      meta?: { type?: string; sourceUrl?: string; workspaceId?: string; relPath?: string };
    };
    const t = data.meta?.type;
    return {
      docType: t === 'code' || t === 'diff' ? t : 'markdown',
      sourceUrl: data.meta?.sourceUrl ?? '',
      workspaceId: data.meta?.workspaceId ?? '',
      relPath: data.meta?.relPath ?? '',
    };
  } catch {
    return fallback;
  }
}

interface Selection {
  start: Uint8Array;
  end: Uint8Array;
  snippet: string;
}

interface LegacyDocs {
  docs: Array<{
    docId: string;
    type: string;
    sourceUrl?: string;
    title?: string;
    setId?: string;
  }>;
}

/**
 * iOS Safari puts `position:fixed` elements on the LAYOUT viewport, which
 * doesn't shrink when the keyboard appears — so bottom:16px ends up
 * behind the keyboard. Track the visual viewport and publish a
 * --kb-bottom CSS variable that every bottom-docked UI element rises by.
 */
function wireKeyboardInset(): void {
  const vv = window.visualViewport;
  // iOS shows a form-accessory bar (^ v ✓) ABOVE the keyboard whenever a
  // text input is focused. visualViewport doesn't account for it — its
  // height only excludes the keyboard itself — so bottom-docked UI pinned
  // to --kb-bottom sits UNDER that bar. Pad --kb-bottom by its typical
  // height (~46px) whenever the keyboard is open so the composer clears
  // both the keyboard AND the accessory bar.
  const IOS_ACCESSORY = 46;
  const apply = () => {
    let kb = 0;
    if (vv) {
      kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    }
    if (kb > 0) kb += IOS_ACCESSORY;
    document.documentElement.style.setProperty('--kb-bottom', `${Math.round(kb)}px`);
  };
  apply();
  if (vv) {
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
  }
  window.addEventListener('orientationchange', () => setTimeout(apply, 120));
}

/**
 * Wire the topbar doc-switcher dropdown ONCE (shell-level, doc-independent).
 * The dropdown's CONTENTS are repopulated per navigation by the sidebar
 * renderers; only the open/close behaviour lives here.
 */
function wireDocSwitcher(): void {
  const docMenu = document.getElementById('doc-menu');
  const docSwitcher = document.getElementById('doc-switcher') as HTMLButtonElement | null;
  if (!docSwitcher || !docMenu) return;
  const close = () => {
    docMenu.classList.add('hidden');
    docMenu.setAttribute('aria-hidden', 'true');
    docSwitcher.setAttribute('aria-expanded', 'false');
  };
  docSwitcher.addEventListener('click', (ev) => {
    if (!document.body.classList.contains('has-set')) return;
    ev.stopPropagation();
    const isOpen = !docMenu.classList.contains('hidden');
    docMenu.classList.toggle('hidden', isOpen);
    docMenu.setAttribute('aria-hidden', String(isOpen));
    docSwitcher.setAttribute('aria-expanded', String(!isOpen));
  });
  document.addEventListener('click', (ev) => {
    if (docMenu.classList.contains('hidden')) return;
    if (!docMenu.contains(ev.target as Node) && !docSwitcher.contains(ev.target as Node)) close();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !docMenu.classList.contains('hidden')) close();
  });
  // Auto-close on scroll. The dropdown overlays the doc, and on mobile the
  // user reaching the content is the strongest "I'm done with the nav" signal.
  const closeOnScroll = () => {
    if (!docMenu.classList.contains('hidden')) close();
  };
  document.getElementById('editor')?.addEventListener('scroll', closeOnScroll, { passive: true });
  window.addEventListener('scroll', closeOnScroll, { passive: true });
}

/**
 * One-time app bootstrap: the persistent shell (keyboard inset, doc-switcher)
 * plus the router. Everything document-specific is a per-doc mount the router
 * runs; navigation swaps mounts in place with no reload.
 */
function main(): void {
  wireKeyboardInset();
  wireDocSwitcher();
  const asParam = new URL(location.href).searchParams.get('as');
  const user: User = resolveUser(asParam, {
    get: (k) => localStorage.getItem(k),
    set: (k, v) => localStorage.setItem(k, v),
  });
  startRouter({
    user,
    fetchMeta: fetchDocMeta,
    connectFor: (docId, docType) => connect(DEFAULT_WS_PATH(docId, docType)),
    mountFor: (ctx) => {
      // A MARKDOWN file in a diff review reads as prose → Word-style redline;
      // other code/diff docs → CodeMirror source; everything else → Tiptap.
      // (redline falls back to code when the base text is unavailable.)
      if (ctx.docType === 'diff' && ctx.relPath.toLowerCase().endsWith('.md')) {
        return mountRedline(ctx);
      }
      if (ctx.docType === 'code' || ctx.docType === 'diff') return mountCode(ctx);
      return mountMarkdown(ctx);
    },
  });
}

/** Per-document mount for the markdown (Tiptap) surface. Every listener is
 *  bound to `ctx.scope`; the router disposes the scope on navigation, which
 *  tears down the editor, chrome, listeners, and (via the router) the client. */
async function mountMarkdown(ctx: MountContext): Promise<void> {
  const { docId, client, user, scope } = ctx;
  const { ydoc, awareness } = client;
  awareness.setLocalStateField('user', { name: user.name, color: user.color });

  // The thread panel / composer / thread-view / drawer elements are owned
  // by the shared review chrome; only the markdown-specific elements are here.
  const editorMount = el<HTMLElement>('editor');
  const composer = el<HTMLElement>('composer');
  const commentPill = el<HTMLButtonElement>('comment-pill');
  const formatBar = el<HTMLElement>('format-bar');
  const toggleFormat = el<HTMLButtonElement>('toggle-format');
  const toggleEditMode = el<HTMLButtonElement>('toggle-edit-mode');

  // Forward ref: the chrome is mounted right after the editor, but editor
  // callbacks can fire during initial Yjs application — guard until set.
  // biome-ignore lint/style/useConst: assigned after createEditor so its callbacks can close over it
  let chrome: ReviewChrome | undefined;
  const editor: EditorHandle = createEditor({
    parent: editorMount,
    ydoc,
    awareness,
    onSelectionChange: () => refreshSelectionState(),
    onUpdate: () => chrome?.redrawThreads(),
    user: { name: user.name, color: user.color },
  });
  // Editor teardown runs before the client closes (LIFO — client.close was
  // registered first by the router), so the y-prosemirror binding detaches
  // before its ydoc is destroyed.
  scope.onCleanup(() => editor.destroy());

  chrome = mountReviewChrome({
    docId,
    user,
    ydoc,
    surface: editor,
    scope,
    selectHint: 'Select some text first to leave a comment.',
    reanchorHint: 'Select new text first, then click Re-anchor.',
    // The cached `selection` covers iOS blurring the editor between the
    // pill appearing and being tapped. `use` already encodes a resolved
    // range (from PM in edit mode, or from the raw DOM selection in view
    // mode) — don't also require a non-empty PM selection, which is always
    // empty in view mode even with a live DOM selection and would wrongly
    // block iOS long-press commenting.
    getSelection: () => {
      const use = editor.getSelectionRel() ?? selection;
      if (!use) return null;
      return use;
    },
    onComposerOpened: () => {
      // Wait for the keyboard to finish sliding up (visualViewport
      // resizes), THEN scroll the editor so the selection sits ~20% from
      // the top of the visible-above-keyboard area. If vv doesn't resize
      // within 500ms, assume the keyboard was already open.
      const vv = window.visualViewport;
      let done = false;
      const run = () => {
        if (done) return;
        done = true;
        vv?.removeEventListener('resize', run);
        scrollSelectionAboveKeyboard();
      };
      vv?.addEventListener('resize', run);
      setTimeout(run, 500);
    },
    onPosted: () => {
      // Drop focus so no caret blinks in the doc after posting.
      editor.editor.commands.blur();
      (document.activeElement as HTMLElement | null)?.blur?.();
    },
    hidePill: () => hidePill(),
  });
  const reviewChrome = chrome;

  // Interaction-bounded reading-session capture (doc_open + read_session).
  // The #editor element is the scroll container on the markdown surface.
  scope.onCleanup(startReadingTracker({ docId, user, scrollEl: editorMount }));

  // =========================================================================
  // COMMENT PILL — small inline affordance
  //   • Range selection → pill appears just past the end of the selection
  //     (or below it if there's no room), so the user sees what they've
  //     selected without the pill occluding the doc or competing with
  //     iOS's native selection menu for screen space.
  //   • Empty selection (caret after tap) → a lighter pill appears in the
  //     right margin of the current line so the user can comment on a
  //     paragraph by tap → pill → composer (Bryan: "tap then comment").
  //     Tapping the pill expands selection to the tapped paragraph before
  //     opening the composer.
  // =========================================================================

  let selection: Selection | null = null;
  let selectionSettled = false;
  let isDragging = false;
  /** What the pill represents if clicked: a range selection, or expand
   *  to the paragraph containing the caret. */
  let pillMode: 'range' | 'caret' = 'range';
  /** Cached paragraph range for caret mode — captured when the pill is
   *  shown so the click handler doesn't depend on the editor still having
   *  the same selection (iOS blurs the editor when the pill is tapped). */
  let caretParaRange: { from: number; to: number } | null = null;

  function refreshSelectionState(): void {
    const sel = editor.getSelectionRel();
    if (sel) selection = sel;
  }

  /** Is there a non-collapsed native selection sitting inside the editor?
   *  In VIEW mode (contenteditable=false) the editor is never focused and
   *  ProseMirror's selection stays empty, so the pill must key off the raw
   *  DOM selection instead — this is what makes iOS long-press commenting
   *  work without making the doc editable. */
  function hasDomSelection(): boolean {
    const s = window.getSelection();
    if (!s || s.rangeCount === 0 || s.isCollapsed) return false;
    const r = s.getRangeAt(0);
    const dom = editor.editor.view.dom;
    return dom.contains(r.startContainer) && dom.contains(r.endContainer);
  }

  function positionPill(): void {
    if (isDragging) {
      hidePill();
      return;
    }
    // Don't reposition (and don't re-show) the pill while the composer
    // is open. The visualViewport `resize` that fires when the keyboard
    // slides up would otherwise repaint the pill mid-transition at a
    // stale location.
    if (!composer.classList.contains('hidden')) {
      hidePill();
      return;
    }
    // No focus = no active cursor = no pill — UNLESS there's a raw DOM
    // selection inside the editor (view mode, where the editor never takes
    // focus but the user can still long-press-select text to comment on).
    if (!editor.editor.isFocused && !hasDomSelection()) {
      hidePill();
      return;
    }
    const state = editor.editor.state;
    const view = editor.editor.view;
    const { from, to, empty } = state.selection;
    try {
      const pillW = 36;
      const pillH = 36;
      const gap = 8;
      const viewportW = window.innerWidth;
      // On iOS, position:fixed and getBoundingClientRect are LAYOUT-viewport
      // relative, but visualViewport.height already excludes the on-screen
      // keyboard. We want the max-y the pill can use to stay above the
      // keyboard, expressed in the same layout-viewport coords the browser
      // gives us. That's vv.offsetTop + vv.height. Do NOT subtract
      // --kb-bottom again here — that was the bug that pinned the pill
      // to y=0 when the keyboard was open.
      const vv = window.visualViewport;
      const vvTop = vv?.offsetTop ?? 0;
      const vvHeight = vv?.height ?? window.innerHeight;
      const availableBottom = vvTop + vvHeight - pillH - 8;

      // Range mode fires when PM has a selection (edit mode) OR there's a raw
      // DOM selection (view mode). The positioning below already prefers the
      // DOM selection's client rects, so it works the same either way.
      if (!empty || hasDomSelection()) {
        pillMode = 'range';
        caretParaRange = null;
        commentPill.classList.remove('caret');
        // Prefer the DOM selection's LAST client rect — that's what the
        // user actually sees highlighted on iOS (where native selection
        // handles don't always stay in lockstep with ProseMirror's `to`).
        // Fall back to coordsAtPos if DOM selection is empty.
        let endRight = 0;
        let endTop = 0;
        let endBottom = 0;
        const winSel = window.getSelection();
        if (winSel && winSel.rangeCount > 0 && !winSel.isCollapsed) {
          const rects = winSel.getRangeAt(0).getClientRects();
          const last = rects.length > 0 ? rects[rects.length - 1] : null;
          if (last) {
            endRight = last.right;
            endTop = last.top;
            endBottom = last.bottom;
          }
        }
        if (endRight === 0) {
          const c = view.coordsAtPos(to);
          endRight = c.right;
          endTop = c.top;
          endBottom = c.bottom;
        }
        let left = endRight + gap;
        let top = Math.max(8, endTop - 2);
        // If that runs past the right edge, tuck below the selection end.
        if (left + pillW > viewportW - 8) {
          left = Math.max(8, endRight - pillW);
          top = endBottom + gap;
        }
        top = Math.min(top, availableBottom);
        commentPill.style.left = `${Math.max(8, left)}px`;
        commentPill.style.top = `${top}px`;
        commentPill.classList.remove('hidden');
      } else if (selectionSettled) {
        // Caret mode — float the pill RIGHT next to the caret so the user
        // sees it as attached to the spot they tapped. Cache the SENTENCE
        // range (not the whole paragraph) so the click handler can commit
        // even if iOS blurred the editor selection in the meantime.
        pillMode = 'caret';
        commentPill.classList.add('caret');
        const caret = view.coordsAtPos(from);
        let left = caret.right + gap;
        let top = Math.max(8, caret.top - 2);
        if (left + pillW > viewportW - 8) left = viewportW - pillW - 8;
        top = Math.min(top, availableBottom);
        commentPill.style.left = `${Math.max(8, left)}px`;
        commentPill.style.top = `${Math.max(8, top)}px`;
        commentPill.classList.remove('hidden');
        caretParaRange = sentenceRangeAt(state, from);
      } else {
        hidePill();
      }
    } catch {
      hidePill();
    }
  }

  function hidePill(): void {
    commentPill.classList.add('hidden');
    caretParaRange = null;
  }

  // Prevent the pill from stealing focus on DESKTOP (mousedown causes blur
  // before click). On iOS, preventDefault on touchstart/pointerdown
  // cancels the synthetic click entirely — so only hook mousedown.
  scope.listen(commentPill, 'mousedown', (ev) => (ev as MouseEvent).preventDefault());
  scope.listen(commentPill, 'click', () => {
    if (pillMode === 'caret') {
      // Use the cached paragraph range — the editor may have lost its
      // selection when the pill was tapped (iOS blur), but we stashed
      // the range when the pill appeared.
      if (!caretParaRange) {
        showToast('Tap again to place the caret, then the pill.');
        return;
      }
      const { from, to } = caretParaRange;
      if (from >= to) return;
      editor.editor.commands.focus();
      editor.editor.commands.setTextSelection({ from, to });
      // setTextSelection is synchronous; read the rel positions now.
      const sel = editor.getSelectionRel();
      if (sel) selection = sel;
      reviewChrome.openComposer();
    } else {
      reviewChrome.openComposer();
    }
  });

  // These live on the editor's own DOM, which is removed by editor.destroy()
  // on teardown, so their listeners die with it — no scope binding needed.
  editor.editor.view.dom.addEventListener('pointerdown', () => {
    isDragging = true;
    selectionSettled = false;
    hidePill();
  });
  scope.listen(window, 'pointerup', () => {
    isDragging = false;
    setTimeout(() => {
      selectionSettled = true;
      const sel = editor.getSelectionRel();
      if (sel) selection = sel;
      positionPill();
    }, 50);
  });
  editor.editor.view.dom.addEventListener('keyup', (ev) => {
    if (ev.shiftKey || ev.key.startsWith('Arrow') || ev.key === 'Home' || ev.key === 'End') {
      selectionSettled = true;
      refreshSelectionState();
      positionPill();
    }
  });
  editor.editor.on('selectionUpdate', () => {
    if (!isDragging && selectionSettled) positionPill();
  });
  // Typing into the editor hides the caret-mode pill — it's a commenting
  // affordance, not something we want hovering mid-sentence. Range-mode
  // pill auto-clears because a selection can't exist while typing.
  editor.editor.on('update', () => {
    if (pillMode === 'caret') hidePill();
  });
  // Editor loses focus (user tapped outside, keyboard dismissed, etc.)
  // → no active cursor → no pill. Same for the underlying DOM element,
  // since iOS can blur the input without firing Tiptap's blur event
  // when the pill is tapped.
  editor.editor.on('blur', () => {
    selectionSettled = false;
    hidePill();
  });
  editor.editor.view.dom.addEventListener('focusout', (ev) => {
    // Ignore transient focus loss that immediately returns to the editor
    // (e.g., toolbar button clicks that refocus).
    setTimeout(() => {
      if (!editor.editor.isFocused) {
        selectionSettled = false;
        hidePill();
      }
    }, 0);
    void ev;
  });
  // Keep pill in sync if the keyboard appears/disappears (visualViewport
  // resize changes --kb-bottom, which changes our clamp max).
  if (window.visualViewport) scope.listen(window.visualViewport, 'resize', () => positionPill());
  scope.listen(window, 'scroll', () => positionPill(), { passive: true });
  scope.listen(editorMount, 'scroll', () => positionPill(), { passive: true });
  // VIEW mode: ProseMirror fires no selectionUpdate (the editor isn't
  // editable), and iOS selection-handle drags don't always produce a clean
  // pointerup on the editor DOM. The document `selectionchange` event is the
  // reliable signal there, so (debounced) drive the pill off it. In edit mode
  // PM's own selectionUpdate already handles this, so skip to avoid double work.
  let selChangeTimer: ReturnType<typeof setTimeout> | null = null;
  scope.listen(document, 'selectionchange', () => {
    if (!document.body.classList.contains('view-mode')) return;
    if (isDragging) return; // wait for the drag to settle (pointerup path)
    if (selChangeTimer) clearTimeout(selChangeTimer);
    selChangeTimer = setTimeout(() => {
      selectionSettled = true;
      refreshSelectionState();
      positionPill();
    }, 120);
  });
  // A pending selectionchange timer must not fire after this mount is torn down
  // — it would run positionPill() against a destroyed editor on the next doc.
  scope.onCleanup(() => {
    if (selChangeTimer) clearTimeout(selChangeTimer);
  });

  // =========================================================================
  // COMPOSER (Notion-style slim sheet)
  //   The doc stays behind a dim scrim with the selection still visible
  //   (we do NOT re-quote the snippet inside the composer — the user sees
  //   what they're commenting on in place). On open we scroll the editor
  //   so the selection sits above the composer + keyboard.
  // =========================================================================

  function scrollSelectionAboveKeyboard(): void {
    try {
      const vv = window.visualViewport;
      const vvTop = vv?.offsetTop ?? 0;
      const vvHeight = vv?.height ?? window.innerHeight;
      // 20% from the top of the visible-above-keyboard area
      const desiredTop = vvTop + vvHeight * 0.2;
      let selTop = 0;
      const winSel = window.getSelection();
      if (winSel && winSel.rangeCount > 0 && !winSel.isCollapsed) {
        selTop = winSel.getRangeAt(0).getBoundingClientRect().top;
      } else {
        const { from } = editor.editor.state.selection;
        selTop = editor.editor.view.coordsAtPos(from).top;
      }
      const deltaY = selTop - desiredTop;
      if (Math.abs(deltaY) < 20) return;
      const scroller = document.getElementById('editor');
      if (scroller) scroller.scrollBy({ top: deltaY, behavior: 'smooth' });
    } catch {}
  }
  // Tap-on-highlight in the editor → focus the thread.
  //   • Mobile: full-screen thread view (Notion pattern — gives the
  //     conversation space without the doc competing for it).
  //   • Desktop: open the side drawer and highlight the thread.
  scope.listen(editorMount, 'click', (ev) => {
    const t = ((ev as MouseEvent).target as HTMLElement).closest('.thread-range');
    if (!t) return;
    const threadId = t.getAttribute('data-thread-id');
    if (!threadId) return;
    ev.preventDefault();
    ev.stopPropagation();
    reviewChrome.refreshThreadDecorations(threadId);
    // No scrollToPos here — the user clicked the highlight, it's already
    // on screen; jumping the doc would feel broken.
    const range = reviewChrome.resolveThreadRange(threadId);
    if (range) editor.pulseRange(range.from, range.to);
    if (reviewChrome.isMobile()) {
      reviewChrome.threadsPanel.setActive(threadId);
      reviewChrome.openThreadView(threadId);
    } else {
      reviewChrome.openDrawer();
      requestAnimationFrame(() => reviewChrome.threadsPanel.revealThread(threadId));
    }
  });

  const meta = ydoc.getMap('meta');
  const onMeta = () => {
    reviewChrome.renderDocLabel();
    void renderSetNav();
  };
  meta.observe(onMeta);
  scope.onCleanup(() => meta.unobserve(onMeta));
  // ---- Review-set navigation ----
  // If the doc has a setId/workspaceId, render its siblings into the sidebar
  // and topbar dropdown. The sidebar renderers are idempotent per nav key, so
  // navigating between files in the same review keeps the sidebar (and its
  // scroll) intact — only the active marker moves.
  const setPane = document.getElementById('set-pane');
  const setPaneList = document.getElementById('set-pane-list');
  const docMenu = document.getElementById('doc-menu');
  const docSwitcher = document.getElementById('doc-switcher') as HTMLButtonElement | null;

  async function renderSetNav(): Promise<void> {
    const m = readDocMeta(ydoc);
    const workspaceId = m.workspaceId ?? '';
    const setId = m.setId ?? '';
    // The sidebar grid shows whenever the doc is part of a workspace OR a
    // legacy hand-grouped set. workspaceId implies a folder bind → tree;
    // setId-only stays on the flat list.
    const navKey = workspaceId || setId;
    document.body.classList.toggle('has-set', !!navKey);
    setPane?.setAttribute('aria-hidden', navKey ? 'false' : 'true');
    if (!navKey) {
      if (setPaneList) setPaneList.innerHTML = '';
      if (docMenu) docMenu.innerHTML = '';
      docSwitcher?.setAttribute('aria-expanded', 'false');
      resetSidebarSignature();
      return;
    }
    if (workspaceId) {
      // Same chooser as the code/diff mount: diff reviews + browse workspaces
      // get the diff-nav; only data-less workspaces fall back to the folder
      // tree. `scope` lets a superseded navigation's late fetch bail instead of
      // clobbering the current sidebar.
      const ok = await renderDiffNav(docId, workspaceId, false, scope);
      if (scope.disposed) return;
      if (!ok) await renderWorkspaceTree(docId, workspaceId, false, scope);
      return;
    }
    // ---- Legacy flat setId path ----
    // Fetch the doc list once per MOUNT (each navigation is a fresh mount) and
    // reuse it across meta-tick re-renders, so a burst of meta.observe events
    // during initial sync doesn't refetch the whole list every time (finding
    // #6). A sibling added mid-review still appears on the next navigation's
    // fresh fetch (finding #1). The shared signature then decides whether the
    // list actually changed and needs a rebuild, or just a marker move.
    try {
      if (!legacyDocsPromise) {
        legacyDocsPromise = fetch('/api/docs')
          .then((r) => (r.ok ? (r.json() as Promise<LegacyDocs>) : null))
          .catch(() => null);
      }
      const data = await legacyDocsPromise;
      // Superseded during the fetch, or the fetch failed → don't touch the
      // shared sidebar for a doc that's no longer open (finding #4).
      if (scope.disposed || !data) return;
      const siblings = data.docs.filter((d) => d.setId === setId && d.type === 'markdown');
      // Stable order: title (or sourceUrl basename) ASC, then docId.
      siblings.sort((a, b) => {
        const ka = (a.title ?? a.sourceUrl ?? a.docId).toLowerCase();
        const kb = (b.title ?? b.sourceUrl ?? b.docId).toLowerCase();
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
      const sig = `set:${setId}:${siblings.map((d) => d.docId).join(',')}`;
      if (sidebarShowsSignature(sig)) {
        setActiveFile(docId);
        return;
      }
      const items = siblings
        .map((d) => {
          const isActive = d.docId === docId;
          const label = d.title ?? basename(d.sourceUrl ?? d.docId);
          const sub = d.sourceUrl && d.title ? d.sourceUrl : '';
          const params = new URLSearchParams(location.search);
          const href = `/review/${encodeURIComponent(d.docId)}${
            params.toString() ? `?${params.toString()}` : ''
          }`;
          return `<li><a href="${href}" class="${isActive ? 'active' : ''}"${
            isActive ? ' aria-current="page"' : ''
          }>${escapeHtml(label)}${sub ? `<small>${escapeHtml(sub)}</small>` : ''}</a></li>`;
        })
        .join('');
      if (setPaneList) setPaneList.innerHTML = items;
      if (docMenu) docMenu.innerHTML = `<ol>${items}</ol>`;
      setSidebarSignature(sig);
      // On mobile, the desktop sidebar is hidden — the dropdown is the ONLY
      // surface that shows the review set. Open it on first render so the
      // reviewer sees siblings without discovering the doc-switcher tap
      // target. The scroll-to-close handler dismisses it once they engage.
      const isMobile = window.matchMedia('(max-width: 1100px)').matches;
      if (isMobile && docMenu && docSwitcher && !openedOnce) {
        openedOnce = true;
        docMenu.classList.remove('hidden');
        docMenu.setAttribute('aria-hidden', 'false');
        docSwitcher.setAttribute('aria-expanded', 'true');
      }
    } catch {
      // Fetch failure — skip; not load-bearing for the editor itself.
    }
  }
  let openedOnce = false;
  let legacyDocsPromise: Promise<LegacyDocs | null> | null = null;

  // ---- Workspace (folder) file tree ----
  // A doc bound via bind_folder carries a workspaceId. renderSetNav (above)
  // renders it; here we wire the focus + ~30s heartbeat refresh so badges
  // reflect newly-opened/resolved threads. Scoped so navigation drops it.
  const workspaceId = readDocMeta(ydoc).workspaceId;
  if (workspaceId) {
    // The heartbeat/focus refresh MUST use the same renderer the navigation
    // path (renderSetNav) picks — renderDiffNav first, the folder tree only as
    // the fallback — otherwise it writes a `tree:` signature while navigation
    // writes `diff:`, and the shared-signature mismatch forces a full
    // scroll-resetting rebuild on the next navigation (finding #1).
    const refresh = () => {
      void (async () => {
        const ok = await renderDiffNav(docId, workspaceId, true, scope);
        if (scope.disposed) return;
        if (!ok) await renderWorkspaceTree(docId, workspaceId, true, scope);
      })();
    };
    window.addEventListener('focus', refresh);
    const timer = setInterval(refresh, 30_000);
    scope.onCleanup(() => {
      window.removeEventListener('focus', refresh);
      clearInterval(timer);
    });
  }

  function basename(p: string): string {
    const m = p.match(/[^/]+$/);
    return m ? m[0] : p;
  }

  client.onReady(() => {
    if (scope.disposed) return;
    reviewChrome.renderDocLabel();
    void renderSetNav();
    reviewChrome.redrawThreads();
  });

  // ---- Save state indicator ----
  //   dirty   = local change produced but not yet confirmed synced to server
  //   saved   = WS is up AND no pending local updates after a short idle window
  //   offline = WS connection closed or reconnecting
  // The widget's canonical "saved" signal is a server ack of the most
  // recent local update. y-websocket doesn't surface per-update acks,
  // so we use the next best thing: WS status + a short "typing stopped
  // and nothing went out for 500ms" debounce.
  const saveStateEl = el<HTMLElement>('save-state');
  let pendingLocalEdits = 0;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let wsOnline = false;
  function renderSaveState(): void {
    saveStateEl.classList.remove('save-state--saved', 'save-state--dirty', 'save-state--offline');
    if (!wsOnline) {
      saveStateEl.textContent = 'Offline — reconnecting…';
      saveStateEl.classList.add('save-state--offline');
      return;
    }
    if (pendingLocalEdits > 0) {
      saveStateEl.textContent = 'Unsaved changes';
      saveStateEl.classList.add('save-state--dirty');
      return;
    }
    saveStateEl.textContent = 'All changes saved';
    saveStateEl.classList.add('save-state--saved');
  }
  // ydoc.on('update') is released when the client destroys the ydoc on close.
  ydoc.on('update', (_update, origin) => {
    // Remote updates come from the server with origin === client.ws.
    // Everything else — typing, formatting, agent edits merged in — counts as
    // a local change the server hasn't ack'd yet.
    if (origin === client.ws) return;
    pendingLocalEdits++;
    renderSaveState();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      pendingLocalEdits = 0;
      renderSaveState();
    }, 500);
  });
  client.onStatus((s) => {
    if (scope.disposed) return;
    wsOnline = s === 'open';
    renderSaveState();
  });
  renderSaveState();
  // On navigation, cancel the pending save-state debounce and blank the shared
  // #save-state indicator — otherwise a stale timer rewrites it with THIS
  // mount's closed-over wsOnline/pendingLocalEdits over the next document
  // (findings #3, #9), and code/diff surfaces have no save state to show.
  scope.onCleanup(() => {
    if (saveTimer) clearTimeout(saveTimer);
    saveStateEl.classList.remove('save-state--saved', 'save-state--dirty', 'save-state--offline');
    saveStateEl.textContent = '';
  });

  // =========================================================================
  // FORMATTING TOOLBAR — collapsed by default. Aa button toggles it.
  // =========================================================================
  scope.listen(toggleFormat, 'click', () => {
    const collapsed = formatBar.classList.toggle('is-collapsed');
    toggleFormat.setAttribute('aria-pressed', String(!collapsed));
  });
  applyWidthPref();
  wireFormatBar(editor, scope);

  // =========================================================================
  // VIEW / EDIT MODE
  //   Mobile Safari focuses the editor on tap → keyboard opens → bottom UI
  //   gets pushed around. Default mobile viewports to read-only (view) mode
  //   so a tap doesn't bring up the keyboard. Long-press to select text
  //   still works in view mode and surfaces the comment pill. Persist the
  //   user's chosen mode in localStorage.
  // =========================================================================
  type EditMode = 'view' | 'edit';
  const EDIT_MODE_KEY = 'lf:edit-mode';
  function defaultEditMode(): EditMode {
    // Default to VIEW everywhere — a review surface reads first, edits by
    // choice, and view mode avoids the mobile keyboard popping up on tap.
    // View-mode commenting works: getSelectionRel() falls back to the raw DOM
    // selection and the pill keys off it, so an iOS long-press raises the pill
    // even though the doc is non-editable.
    return 'view';
  }
  function readEditModePref(): EditMode {
    const stored = localStorage.getItem(EDIT_MODE_KEY);
    return stored === 'view' || stored === 'edit' ? stored : defaultEditMode();
  }
  function applyEditMode(mode: EditMode): void {
    const editable = mode === 'edit';
    editor.editor.setEditable(editable);
    document.body.classList.toggle('view-mode', !editable);
    toggleEditMode.setAttribute('aria-pressed', String(editable));
    toggleEditMode.title = editable ? 'Tap to switch to view mode' : 'Tap to switch to edit mode';
    toggleEditMode.setAttribute(
      'aria-label',
      editable
        ? 'Currently editing — tap to switch to view mode'
        : 'Currently viewing — tap to switch to edit mode',
    );
    if (!editable) {
      formatBar.classList.add('is-collapsed');
      toggleFormat.setAttribute('aria-pressed', 'false');
    }
  }
  let editMode: EditMode = readEditModePref();
  applyEditMode(editMode);
  scope.listen(toggleEditMode, 'click', () => {
    editMode = editMode === 'edit' ? 'view' : 'edit';
    localStorage.setItem(EDIT_MODE_KEY, editMode);
    applyEditMode(editMode);
  });

  // =========================================================================
  // HOTKEYS — ⌘M / Escape are wired by the shared chrome; only the
  // markdown-specific format-bar hotkey lives here.
  // =========================================================================
  scope.listen(document, 'keydown', (ev) => {
    const ke = ev as KeyboardEvent;
    if ((ke.metaKey || ke.ctrlKey) && ke.shiftKey && ke.key.toLowerCase() === 'f') {
      ke.preventDefault();
      toggleFormat.click();
    }
  });
}

/**
 * Expand a caret position to the sentence it's inside (or the sentence
 * immediately before, if the caret sits in whitespace just after a
 * terminator). Operates on the paragraph-level textblock the caret is in
 * — multi-paragraph sentences aren't really a thing. Returns prosemirror
 * absolute positions.
 */
function sentenceRangeAt(
  state: import('@tiptap/pm/state').EditorState,
  pos: number,
): { from: number; to: number } {
  const $pos = state.doc.resolve(pos);
  const blockStart = $pos.start($pos.depth);
  const blockEnd = $pos.end($pos.depth);
  const text = $pos.parent.textContent;
  const n = text.length;
  if (n === 0) return { from: blockStart, to: blockEnd };

  let i = Math.min($pos.parentOffset, n - 1);
  if (i < 0) i = 0;
  // If sitting on whitespace immediately after a terminator, step back
  // so we land in the previous sentence instead of the next.
  if (i > 0 && /\s/.test(text.charAt(i)) && /[.!?]/.test(text.charAt(i - 1))) {
    i = i - 1;
  }

  // Find start of sentence — scan back for a terminator followed by
  // whitespace, then skip past the whitespace to the next real char.
  let start = 0;
  for (let j = i; j > 0; j--) {
    if (/[.!?]/.test(text.charAt(j - 1)) && /\s/.test(text.charAt(j))) {
      start = j;
      while (start < n && /\s/.test(text.charAt(start))) start++;
      break;
    }
  }
  // Find end of sentence — scan forward for the next terminator.
  let end = n;
  for (let j = Math.max(i, start); j < n; j++) {
    if (/[.!?]/.test(text.charAt(j))) {
      end = j + 1;
      break;
    }
  }

  return { from: blockStart + start, to: blockStart + end };
}

const WIDTH_PREF_KEY = 'lfb.editor.width';

// In-memory mirror so the toggle still works in private mode (where
// localStorage throws on get and set) — without it, every read would
// fall back to the default and the button wouldn't appear to do anything.
let widthPrefInMemory: 'full' | 'reading' | undefined;

/** Read the persisted width preference. Default is 'full' so wide tables
 *  in review docs aren't squeezed. */
function readWidthPref(): 'full' | 'reading' {
  try {
    const raw = localStorage.getItem(WIDTH_PREF_KEY);
    return raw === 'reading' ? 'reading' : 'full';
  } catch {
    return widthPrefInMemory ?? 'full';
  }
}

function applyWidthPref(): void {
  const pref = readWidthPref();
  document.body.classList.toggle('is-reading-width', pref === 'reading');
  const btn = document.querySelector<HTMLButtonElement>('#format-bar [data-cmd="width"]');
  if (btn) btn.setAttribute('aria-pressed', String(pref === 'reading'));
}

function toggleWidthPref(): void {
  const next = readWidthPref() === 'reading' ? 'full' : 'reading';
  widthPrefInMemory = next;
  try {
    localStorage.setItem(WIDTH_PREF_KEY, next);
  } catch {
    // localStorage disabled (private mode) — in-memory mirror keeps the toggle alive.
  }
  applyWidthPref();
}

/**
 * Contextual popover for table operations. Insert/edit are powered by
 * @tiptap/extension-table; this renders the item list from tableMenuItems()
 * and dispatches to the matching Tiptap command. Rendered into <body> as a
 * fixed-position element so it escapes the format bar's `overflow:hidden`.
 * Scoped: the appended element + its document listeners are removed on nav.
 */
interface TableMenuController {
  toggle: (anchor: HTMLElement) => void;
  close: () => void;
}

function wireTableMenu(editor: EditorHandle, scope: MountScope): TableMenuController {
  const menu = document.createElement('div');
  menu.className = 'table-menu hidden';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-hidden', 'true');
  document.body.appendChild(menu);
  scope.onCleanup(() => menu.remove());

  let anchorBtn: HTMLElement | null = null;

  const close = () => {
    if (menu.classList.contains('hidden')) return;
    menu.classList.add('hidden');
    menu.setAttribute('aria-hidden', 'true');
    anchorBtn?.setAttribute('aria-expanded', 'false');
    anchorBtn = null;
  };

  const runTableCmd = (cmd: TableMenuItem['cmd']) => {
    const c = editor.editor.chain().focus();
    switch (cmd) {
      case 'insertTable':
        c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
        break;
      case 'addRowBefore':
        c.addRowBefore().run();
        break;
      case 'addRowAfter':
        c.addRowAfter().run();
        break;
      case 'addColumnBefore':
        c.addColumnBefore().run();
        break;
      case 'addColumnAfter':
        c.addColumnAfter().run();
        break;
      case 'deleteRow':
        c.deleteRow().run();
        break;
      case 'deleteColumn':
        c.deleteColumn().run();
        break;
      case 'deleteTable':
        c.deleteTable().run();
        break;
    }
  };

  const open = (anchor: HTMLElement) => {
    anchorBtn = anchor;
    menu.innerHTML = '';
    for (const item of tableMenuItems(editor.editor.isActive('table'))) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `table-menu-item${item.danger ? ' danger' : ''}`;
      b.setAttribute('role', 'menuitem');
      b.textContent = item.label;
      b.addEventListener('click', () => {
        runTableCmd(item.cmd);
        close();
      });
      menu.appendChild(b);
    }
    menu.classList.remove('hidden');
    menu.setAttribute('aria-hidden', 'false');
    anchor.setAttribute('aria-expanded', 'true');
    // Position under the anchor, clamped to the viewport (mobile-safe).
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${r.bottom + 4}px`;
    const mw = menu.offsetWidth;
    let left = Math.min(r.left, window.innerWidth - 8 - mw);
    if (left < 8) left = 8;
    menu.style.left = `${left}px`;
  };

  // Keep the editor selection alive while pressing menu items.
  scope.listen(menu, 'mousedown', (ev) => (ev as MouseEvent).preventDefault());
  scope.listen(document, 'click', (ev) => {
    if (menu.classList.contains('hidden')) return;
    const t = ev.target as Node;
    if (menu.contains(t) || anchorBtn?.contains(t)) return;
    close();
  });
  scope.listen(document, 'keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Escape') close();
  });
  document.getElementById('editor')?.addEventListener('scroll', close, {
    passive: true,
    signal: scope.signal,
  });

  return {
    toggle: (anchor) => {
      if (!menu.classList.contains('hidden') && anchorBtn === anchor) close();
      else open(anchor);
    },
    close,
  };
}

function wireFormatBar(editor: EditorHandle, scope: MountScope): void {
  const bar = document.getElementById('format-bar');
  if (!bar) return;
  const chain = () => editor.editor.chain().focus();
  const tableMenu = wireTableMenu(editor, scope);
  const handlers: Record<string, () => void> = {
    bold: () => chain().toggleBold().run(),
    italic: () => chain().toggleItalic().run(),
    h1: () => chain().toggleHeading({ level: 1 }).run(),
    h2: () => chain().toggleHeading({ level: 2 }).run(),
    h3: () => chain().toggleHeading({ level: 3 }).run(),
    bulletList: () => chain().toggleBulletList().run(),
    orderedList: () => chain().toggleOrderedList().run(),
    blockquote: () => chain().toggleBlockquote().run(),
    code: () => chain().toggleCode().run(),
    codeBlock: () => chain().toggleCodeBlock().run(),
    hr: () => chain().setHorizontalRule().run(),
    width: toggleWidthPref,
    table: () => {
      const btn = bar.querySelector<HTMLElement>('[data-cmd="table"]');
      if (btn) tableMenu.toggle(btn);
    },
    link: () => {
      const existing = editor.editor.getAttributes('link').href as string | undefined;
      const href = prompt('Link URL', existing ?? 'https://');
      if (href === null) return;
      if (href === '') chain().unsetLink().run();
      else chain().setLink({ href }).run();
    },
  };
  scope.listen(bar, 'mousedown', (ev) => {
    const t = ((ev as MouseEvent).target as HTMLElement).closest('button');
    if (t) (ev as MouseEvent).preventDefault();
  });
  scope.listen(bar, 'click', (ev) => {
    const t = ((ev as MouseEvent).target as HTMLElement).closest('button');
    if (!t) return;
    const cmd = t.getAttribute('data-cmd');
    if (cmd && handlers[cmd]) handlers[cmd]();
  });

  const refresh = () => {
    for (const btn of Array.from(bar.querySelectorAll<HTMLButtonElement>('button'))) {
      const cmd = btn.getAttribute('data-cmd');
      let active = false;
      switch (cmd) {
        case 'bold':
          active = editor.editor.isActive('bold');
          break;
        case 'italic':
          active = editor.editor.isActive('italic');
          break;
        case 'h1':
          active = editor.editor.isActive('heading', { level: 1 });
          break;
        case 'h2':
          active = editor.editor.isActive('heading', { level: 2 });
          break;
        case 'h3':
          active = editor.editor.isActive('heading', { level: 3 });
          break;
        case 'bulletList':
          active = editor.editor.isActive('bulletList');
          break;
        case 'orderedList':
          active = editor.editor.isActive('orderedList');
          break;
        case 'blockquote':
          active = editor.editor.isActive('blockquote');
          break;
        case 'code':
          active = editor.editor.isActive('code');
          break;
        case 'codeBlock':
          active = editor.editor.isActive('codeBlock');
          break;
        case 'link':
          active = editor.editor.isActive('link');
          break;
        case 'table':
          active = editor.editor.isActive('table');
          break;
      }
      btn.classList.toggle('active', active);
    }
  };
  editor.editor.on('selectionUpdate', refresh);
  editor.editor.on('transaction', refresh);
}

void main();
