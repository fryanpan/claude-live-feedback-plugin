import { type User, connect, escapeHtml, readDocMeta, resolveUser } from '@feedback/core';
import { bootCode } from './code/code-app.ts';
import { type EditorHandle, createEditor } from './editor.ts';
import { startReadingTracker } from './reading-tracker.ts';
import { type ReviewChrome, el, mountReviewChrome, showToast } from './review-chrome.ts';
import { renderWorkspaceTree, wireWorkspaceTreeRefresh } from './workspace-tree.ts';

const DEFAULT_WS_PATH = (docId: string, type: string) =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/y/${encodeURIComponent(docId)}?type=${encodeURIComponent(type)}`;

/** Fetch a doc's persisted type before mounting a surface. Defaults to
 *  'markdown' if the meta can't be read (the markdown path is the safe
 *  fallback — it migrates legacy content and never assumes code). */
async function fetchDocMeta(
  docId: string,
): Promise<{ type: string; sourceUrl: string; workspaceId: string; relPath: string }> {
  try {
    const res = await fetch(`/api/docs/${encodeURIComponent(docId)}`);
    if (!res.ok) return { type: 'markdown', sourceUrl: '', workspaceId: '', relPath: '' };
    const data = (await res.json()) as {
      meta?: { type?: string; sourceUrl?: string; workspaceId?: string; relPath?: string };
    };
    return {
      type: data.meta?.type ?? 'markdown',
      sourceUrl: data.meta?.sourceUrl ?? '',
      workspaceId: data.meta?.workspaceId ?? '',
      relPath: data.meta?.relPath ?? '',
    };
  } catch {
    return { type: 'markdown', sourceUrl: '', workspaceId: '', relPath: '' };
  }
}

interface Selection {
  start: Uint8Array;
  end: Uint8Array;
  snippet: string;
}

function docIdFromPath(): string {
  const m = location.pathname.match(/^\/review\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1] ?? '') : 'default';
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

async function boot(): Promise<void> {
  wireKeyboardInset();
  const docId = docIdFromPath();
  const url = new URL(location.href);
  const asParam = url.searchParams.get('as');
  const user: User = resolveUser(asParam, {
    get: (k) => localStorage.getItem(k),
    set: (k, v) => localStorage.setItem(k, v),
  });

  const {
    type: docType,
    sourceUrl: docSourceUrl,
    workspaceId: docWorkspaceId,
    relPath: docRelPath,
  } = await fetchDocMeta(docId);
  const client = connect(DEFAULT_WS_PATH(docId, docType));

  // Code and diff docs get a read-only, syntax-highlighted CodeMirror
  // surface that reuses the same thread/comment stack (diff docs add the
  // unified-diff rendering + view toggle on top). Everything below this
  // branch is Tiptap/ProseMirror-specific (format bar, edit-mode toggle,
  // comment pill positioning) and only applies to markdown docs.
  if (docType === 'code' || docType === 'diff') {
    void bootCode({
      docId,
      client,
      user,
      sourceUrl: docSourceUrl,
      workspaceId: docWorkspaceId,
      docType,
      relPath: docRelPath,
    });
    return;
  }

  const { ydoc, awareness } = client;
  awareness.setLocalStateField('user', { name: user.name, color: user.color });

  // The thread panel / composer / thread-view / drawer elements are owned
  // by the shared review chrome now; only the markdown-specific elements
  // are grabbed here.
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

  chrome = mountReviewChrome({
    docId,
    user,
    ydoc,
    surface: editor,
    selectHint: 'Select some text first to leave a comment.',
    reanchorHint: 'Select new text first, then click Re-anchor.',
    // The cached `selection` covers iOS blurring the editor between the
    // pill appearing and being tapped; the empty-check mirrors the old
    // openComposerForSelection guard.
    getSelection: () => {
      const use = editor.getSelectionRel() ?? selection;
      if (!use || editor.editor.state.selection.empty) return null;
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
  startReadingTracker({ docId, user, scrollEl: editorMount });

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
    // No focus = no active cursor = no pill. The pill only represents a
    // commentable spot while the user is actively pointing at one.
    if (!editor.editor.isFocused) {
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

      if (!empty) {
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
  commentPill.addEventListener('mousedown', (ev) => ev.preventDefault());
  commentPill.addEventListener('click', () => {
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

  editor.editor.view.dom.addEventListener('pointerdown', () => {
    isDragging = true;
    selectionSettled = false;
    hidePill();
  });
  window.addEventListener('pointerup', () => {
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
  window.visualViewport?.addEventListener('resize', () => positionPill());
  window.addEventListener('scroll', () => positionPill(), { passive: true });
  el<HTMLElement>('editor').addEventListener('scroll', () => positionPill(), { passive: true });

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
  editorMount.addEventListener('click', (ev) => {
    const t = (ev.target as HTMLElement).closest('.thread-range');
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
  meta.observe(() => {
    reviewChrome.renderDocLabel();
    void renderSetNav();
  });
  // ---- Review-set navigation ----
  // If the doc has a setId, fetch all docs sharing that set and render
  // them into both the desktop sidebar and the topbar dropdown. The same
  // list goes into both; CSS handles which is visible.
  const setPane = document.getElementById('set-pane');
  const setPaneList = document.getElementById('set-pane-list');
  const docMenu = document.getElementById('doc-menu');
  const docSwitcher = document.getElementById('doc-switcher') as HTMLButtonElement | null;
  let lastRenderedSetId: string | null = null;

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
      lastRenderedSetId = '';
      if (setPaneList) setPaneList.innerHTML = '';
      if (docMenu) docMenu.innerHTML = '';
      docSwitcher?.setAttribute('aria-expanded', 'false');
      return;
    }
    if (workspaceId) {
      await renderWorkspaceTree(docId, workspaceId);
      return;
    }
    // ---- Legacy flat setId path ----
    // Cache so a meta-observe storm doesn't re-fetch /api/docs each tick.
    if (setId === lastRenderedSetId) return;
    lastRenderedSetId = setId;
    try {
      const res = await fetch('/api/docs');
      if (!res.ok) return;
      const data = (await res.json()) as {
        docs: Array<{
          docId: string;
          type: string;
          sourceUrl?: string;
          title?: string;
          setId?: string;
        }>;
      };
      const siblings = data.docs.filter((d) => d.setId === setId && d.type === 'markdown');
      // Stable order: title (or sourceUrl basename) ASC, then docId.
      siblings.sort((a, b) => {
        const ka = (a.title ?? a.sourceUrl ?? a.docId).toLowerCase();
        const kb = (b.title ?? b.sourceUrl ?? b.docId).toLowerCase();
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
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
      // On mobile, the desktop sidebar is hidden — the dropdown is the
      // ONLY surface that shows the review set. Open it on first render
      // so the reviewer sees siblings without having to discover the
      // doc-switcher tap target. The existing scroll-to-close handler
      // dismisses it as soon as they engage with the content.
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

  // ---- Workspace (folder) file tree ----
  // A doc bound via bind_folder carries a workspaceId. The collapsible
  // <details>/<summary> tree (per-file open-comment badges + folder
  // roll-ups) lives in the shared ./workspace-tree.ts module so both the
  // markdown (Tiptap) and code (CodeMirror) boot paths render it identically.
  // renderSetNav (above) calls renderWorkspaceTree on the workspace branch;
  // here we just wire the focus + ~30s heartbeat refresh so the badges
  // reflect newly-opened/resolved threads without a full reload.
  const workspaceId = readDocMeta(ydoc).workspaceId;
  if (workspaceId) wireWorkspaceTreeRefresh(docId, workspaceId);

  function basename(p: string): string {
    const m = p.match(/[^/]+$/);
    return m ? m[0] : p;
  }
  // Wire the dropdown toggle. On click outside or Escape, close.
  if (docSwitcher && docMenu) {
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
      if (!docMenu.contains(ev.target as Node) && !docSwitcher.contains(ev.target as Node)) {
        docMenu.classList.add('hidden');
        docMenu.setAttribute('aria-hidden', 'true');
        docSwitcher.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !docMenu.classList.contains('hidden')) {
        docMenu.classList.add('hidden');
        docMenu.setAttribute('aria-hidden', 'true');
        docSwitcher.setAttribute('aria-expanded', 'false');
      }
    });
    // Auto-close on scroll. The dropdown overlays the doc, and on mobile
    // the user reaching the content is the strongest "I'm done with the
    // nav" signal — don't make them tap-to-dismiss before reading.
    const closeOnScroll = () => {
      if (docMenu.classList.contains('hidden')) return;
      docMenu.classList.add('hidden');
      docMenu.setAttribute('aria-hidden', 'true');
      docSwitcher.setAttribute('aria-expanded', 'false');
    };
    document.getElementById('editor')?.addEventListener('scroll', closeOnScroll, { passive: true });
    window.addEventListener('scroll', closeOnScroll, { passive: true });
  }

  client.onReady(() => {
    reviewChrome.renderDocLabel();
    void renderSetNav();
    editor.migrateLegacyIfNeeded();
    reviewChrome.redrawThreads();
  });

  // ---- Save state indicator ----
  //   dirty   = local change produced but not yet confirmed synced to server
  //   saved   = WS is up AND no pending local updates after a short idle window
  //   offline = WS connection closed or reconnecting
  // The widget's canonical "saved" signal is a server ack of the most
  // recent local update. y-websocket doesn't surface per-update acks,
  // so we use the next best thing: WS status + a short "typing stopped
  // and nothing went out for 500ms" debounce. Good enough to trust for
  // "my keystrokes made it to the server."
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
  ydoc.on('update', (_update, origin) => {
    // Remote updates come from the server with origin === client.ws
    // (see readSyncMessage in client.ts). Everything else — typing,
    // formatting toolbar actions, agent edits merged in — counts as a
    // local change the server hasn't ack'd yet.
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
    wsOnline = s === 'open';
    renderSaveState();
  });
  renderSaveState();

  // =========================================================================
  // FORMATTING TOOLBAR — collapsed by default. Aa button toggles it.
  // =========================================================================
  toggleFormat.addEventListener('click', () => {
    const collapsed = formatBar.classList.toggle('is-collapsed');
    toggleFormat.setAttribute('aria-pressed', String(!collapsed));
  });
  applyWidthPref();
  wireFormatBar(editor);

  // =========================================================================
  // VIEW / EDIT MODE
  //   Mobile Safari focuses the editor on tap → keyboard opens → bottom UI
  //   gets pushed around. Default mobile viewports to read-only (view) mode
  //   so a tap doesn't bring up the keyboard. Long-press to select text
  //   still works in view mode and surfaces the comment pill. Persist the
  //   user's chosen mode in localStorage so a desktop user who toggles to
  //   view (or a mobile user who toggles to edit) is remembered next visit.
  // =========================================================================
  type EditMode = 'view' | 'edit';
  const EDIT_MODE_KEY = 'lf:edit-mode';
  function defaultEditMode(): EditMode {
    // Default to EDIT everywhere. View mode (contenteditable=false) is great for
    // tap-to-read on mobile, but on iOS Safari a non-editable ProseMirror does
    // NOT propagate the long-press text selection back to ProseMirror's
    // selection state, so getSelectionRel() comes back empty and the comment
    // pill never appears — i.e. you can neither edit NOR comment. Until view-
    // mode commenting is wired off the raw DOM selection, edit mode (which
    // makes both work) is the safe default; the Aa toolbar toggle still opts
    // into view mode (and the choice is remembered per device).
    return 'edit';
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
  toggleEditMode.addEventListener('click', () => {
    editMode = editMode === 'edit' ? 'view' : 'edit';
    localStorage.setItem(EDIT_MODE_KEY, editMode);
    applyEditMode(editMode);
  });

  // =========================================================================
  // HOTKEYS
  // =========================================================================
  // ⌘M / Escape are wired by the shared review chrome; only the
  // markdown-specific format-bar hotkey lives here.
  document.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.shiftKey && ev.key.toLowerCase() === 'f') {
      ev.preventDefault();
      toggleFormat.click();
    }
  });

  addEventListener('beforeunload', () => {
    client.close();
    editor.destroy();
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
// fall back to the default and the button wouldn't appear to do
// anything.
let widthPrefInMemory: 'full' | 'reading' | undefined;

/** Read the persisted width preference. Default is 'full' so wide tables
 *  in review docs aren't squeezed. Falsy / unknown values normalize to
 *  the default. */
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
    // localStorage disabled (private mode) — in-memory mirror keeps the toggle alive for this session.
  }
  applyWidthPref();
}

function wireFormatBar(editor: EditorHandle): void {
  const bar = document.getElementById('format-bar');
  if (!bar) return;
  const chain = () => editor.editor.chain().focus();
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
    link: () => {
      const existing = editor.editor.getAttributes('link').href as string | undefined;
      const href = prompt('Link URL', existing ?? 'https://');
      if (href === null) return;
      if (href === '') chain().unsetLink().run();
      else chain().setLink({ href }).run();
    },
  };
  bar.addEventListener('mousedown', (ev) => {
    const t = (ev.target as HTMLElement).closest('button');
    if (t) ev.preventDefault();
  });
  bar.addEventListener('click', (ev) => {
    const t = (ev.target as HTMLElement).closest('button');
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
      }
      btn.classList.toggle('active', active);
    }
  };
  editor.editor.on('selectionUpdate', refresh);
  editor.editor.on('transaction', refresh);
}

void boot();
