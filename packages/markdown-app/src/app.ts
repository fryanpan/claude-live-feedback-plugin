import {
  DEFAULT_CAPTURE_MODE,
  type User,
  connect,
  escapeHtml,
  readDocMeta,
  suggestOps,
} from '@feedback/core';
import { mountCode } from './code/code-app.ts';
import { saveStateView, settlePending, watchConnection } from './connection-state.ts';
import { renderDiffNav, setActiveFile } from './diff-nav.ts';
import { fetchDocMeta } from './doc-meta.ts';
import { docHref, workspaceIdFromPath } from './doc-path.ts';
import { type EditMode, initialEditMode, writeEditModePref } from './edit-mode.ts';
import { wireEditViewport } from './edit-viewport.ts';
import { type EditorHandle, createEditor } from './editor.ts';
import { trackGesture } from './gesture.ts';
import { huddleCaptureMode, wantsHuddleStart, withoutHuddleStart } from './huddle-entry.ts';
import { ensureUserIdentity } from './identity-prompt.ts';
import { wireKeyboardInset } from './keyboard-inset.ts';
import { mountMeetingStrip } from './meeting-strip.ts';
import type { MountContext } from './mount-context.ts';
import type { MountScope } from './mount-scope.ts';
import { startReadingTracker } from './reading-tracker.ts';
import { mountMarkupMargin } from './redline/markup-margin.ts';
import { mountRedline } from './redline/redline-app.ts';
import { mountSuggestionsSummary } from './redline/suggestions-summary.ts';
import {
  type ReviewChrome,
  el,
  mountReviewChrome,
  showToast,
  wireThreadRangeClicks,
} from './review-chrome.ts';
import { navigateTo, startRouter } from './router.ts';
import { type SetDoc, selectSetSiblings, setDocsUrl } from './set-nav.ts';
import {
  beginSidebarRender,
  commitSidebarColumn,
  isCurrentSidebarRender,
  resetSidebarSignature,
  setSidebarSignature,
  sidebarShowsSignature,
} from './sidebar-nav-key.ts';
import {
  fetchWriteAccess,
  installWriteGateNotice,
  lockDocToReading,
  showSignInBar,
} from './signin/write-gate.ts';
import { mountSpeakerReassign } from './speaker-reassign-menu.ts';
import { loadDocVoices } from './speaker-voices.ts';
import { installStaleClientNotice } from './stale-client.ts';
import { readSuggestModePref, setSuggesting, writeSuggestModePref } from './suggest-input.ts';
import { registerMarkdownMount } from './surface-registry.ts';
import { type TableMenuItem, tableMenuItems } from './table-menu.ts';
import { watchTaskLinkStatuses } from './task-link-chips.ts';
import { mountDocVoice } from './voice-dock.ts';
import { renderWorkspaceTree } from './workspace-tree.ts';

const DEFAULT_WS_PATH = (docId: string, type: string) =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/y/${encodeURIComponent(docId)}?type=${encodeURIComponent(type)}`;

interface Selection {
  start: Uint8Array;
  end: Uint8Array;
  snippet: string;
}

interface LegacyDocs {
  docs: SetDoc[];
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
async function main(): Promise<void> {
  // Before anything can write: a refused write raises a sign-in prompt
  // wherever it happened, rather than a "try again" this person can never
  // satisfy. See signin/write-gate.ts.
  installWriteGateNotice();
  wireKeyboardInset();
  wireDocSwitcher();
  const asParam = new URL(location.href).searchParams.get('as');
  // May this browser write at all? Asked BEFORE the name prompt, because the
  // answer decides whether that prompt should be shown: where the server
  // requires a session, "what shall we call you?" is a modal that blocks boot
  // to collect a name the server will not accept, in place of the one
  // question this person actually has to answer.
  const writeAccess = await fetchWriteAccess();
  if (!writeAccess.canWrite) showSignInBar();
  // First arrival with no stored name shows the name prompt; this awaits the
  // user's answer (or skip) before anything connects, so awareness, comments,
  // and edits all carry the chosen identity from the first packet.
  const user: User = await ensureUserIdentity(
    asParam,
    {
      get: (k) => localStorage.getItem(k),
      set: (k, v) => localStorage.setItem(k, v),
    },
    writeAccess.canWrite ? {} : { suppressNamePrompt: true },
  );
  // Voice on the doc surface (§3.8): one dock for the whole session; each
  // utterance reads the CURRENT doc + topmost heading at release time, so
  // the anchor follows navigation without remounting.
  mountDocVoice(user);
  registerMarkdownMount(mountMarkdown);
  startRouter({
    user,
    // The answer is already in hand — every mount gets it as a value rather
    // than asking again. A mount that re-asks is editable while it waits.
    canWrite: writeAccess.canWrite,
    fetchMeta: fetchDocMeta,
    connectFor: (docId, docType) => {
      const client = connect(DEFAULT_WS_PATH(docId, docType));
      installStaleClientNotice(client);
      return client;
    },
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
  // Which docId the sidebar marks active — differs from `docId` only for the
  // editable File view of a .md diff member (see MountContext.navDocId).
  const navDocId = ctx.navDocId ?? docId;
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
  // Declared beside the edit toggle, not down in the Suggesting section
  // that wires it: the write gate locks BOTH, and it runs first.
  const toggleSuggestMode = el<HTMLButtonElement>('toggle-suggest-mode');
  /**
   * Whether the server will accept writes from this browser.
   *
   * One flag, read by BOTH toggles — either one of them makes the document
   * editable and it only takes one to lose a person's writing — and by the
   * chrome that describes what this surface IS. Declared this high because
   * the save-state chip reads it, and that renders long before the toggles
   * are wired.
   *
   * The server's answer, carried in on the MountContext — not a hopeful
   * `true` narrowed later. It used to start `true` and be corrected one
   * round trip after the mount, and everything this flag guards was open
   * for the length of that trip.
   */
  const canWrite = ctx.canWrite;

  // Forward ref: the chrome is mounted right after the editor, but editor
  // callbacks can fire during initial Yjs application — guard until set.
  // biome-ignore lint/style/useConst: assigned after createEditor so its callbacks can close over it
  let chrome: ReviewChrome | undefined;
  // Same forward-ref shape as `chrome`: the editor's selection callback fires
  // during the first Yjs application, before this is wired.
  // biome-ignore lint/style/useConst: assigned after the meeting strip mounts
  let editViewport: ReturnType<typeof wireEditViewport> | undefined;
  const editor: EditorHandle = createEditor({
    parent: editorMount,
    ydoc,
    awareness,
    onSelectionChange: () => refreshSelectionState(),
    onUpdate: () => chrome?.redrawThreads(),
    user: { name: user.name, color: user.color },
    // Workspace members (folder binds, diff File views — ctx spreads through
    // mountEditableFileView) get in-app navigation for relative sibling links.
    docLink: ctx.workspaceId
      ? { workspaceId: ctx.workspaceId, relPath: ctx.relPath, navigate: navigateTo }
      : undefined,
    // A huddle washes each participant's recent sections in their color;
    // every other doc is untouched (no plugin registered at all).
    recentEdits: ctx.huddle === true ? { whenSynced: (cb) => client.onReady(cb) } : undefined,
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
    whenSynced: (cb) => client.onReady(cb),
    scope,
    labelHint: ctx.sourceUrl || ctx.relPath || undefined,
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
    // The markdown surface mounts the balloon margin unconditionally below.
    hasBalloonMargin: true,
  });
  const reviewChrome = chrome;

  // The balloon margin: plain markdown docs get comment balloons only (no
  // git base, so no deletions) — reuses the same mount as the redline
  // surface, which is why comment balloons behave identically everywhere.
  // Mounted unconditionally; the `#editor.redline-layout` grid and the
  // `.markup-margin` column both collapse via CSS below 1100px, so this
  // never introduces horizontal scroll on mobile.
  const margin = mountMarkupMargin({
    editorEl: editorMount,
    view: editor.editor.view,
    getDeletions: () => [],
    threads: () => reviewChrome.collectThreads(),
    chrome: reviewChrome,
    getSuggestions: () => suggestOps.listSuggestions(ydoc),
    docId,
    scope,
  });
  // Doc-level "N pending suggestions" topbar badge (Accept all / Reject all
  // across every author) — per-suggestion Accept/Reject lives on the
  // balloon/chip card the margin just wired above.
  const suggestionsSummary = mountSuggestionsSummary({ docId, ydoc, scope });
  const onMarginTransaction = (): void => {
    margin.scheduleRelayout();
    suggestionsSummary.scheduleRefresh();
  };
  editor.editor.on('transaction', onMarginTransaction);
  scope.onCleanup(() => editor.editor.off('transaction', onMarginTransaction));

  // Interaction-bounded reading-session capture (doc_open + read_session).
  // The #editor element is the scroll container on the markdown surface.
  scope.onCleanup(startReadingTracker({ docId, user, scrollEl: editorMount }));

  // Live-meeting transcript strip along the bottom of the editor pane. Bound
  // to this scope, so navigating away closes the audio socket and releases the
  // microphone — a mic left open behind a doc nobody is looking at is the
  // failure worth designing against.
  //
  // Ordinary markdown docs only. A `.md` diff member's File view mounts this
  // same surface over a companion doc (that is what `navDocId` marks), and a
  // review of somebody's branch is not a place a meeting is recorded.
  //
  // Opened by the Board's "Start a planning huddle": the address carries a
  // flag, and the strip asks for the mic at once instead of waiting for a
  // press. Read once and taken back out of the address, so a reload or a
  // later Back into this entry does not open a mic nobody pressed for.
  const meetingStripEl = document.getElementById('meeting-strip');
  if (meetingStripEl && ctx.docType === 'markdown' && ctx.navDocId === undefined) {
    const huddleStart = wantsHuddleStart(location.search);
    // "Record a conversation" is the only thing that says someone else is in
    // the room, and it is a press on the Board — a page that is gone by the
    // time this mounts. It rides in on the address with the start flag and
    // leaves with it.
    const huddleMode = huddleStart ? huddleCaptureMode(location.search) : DEFAULT_CAPTURE_MODE;
    if (huddleStart) {
      history.replaceState(
        history.state,
        '',
        withoutHuddleStart(location.pathname + location.search + location.hash),
      );
    }
    const strip = mountMeetingStrip({
      docId,
      root: meetingStripEl,
      autoStart: huddleStart,
      // Read BEFORE the flag is stripped from the address above… it is, in
      // fact, read from `location.search` there too, so both come off the
      // same address; see `huddleCaptureMode`.
      mode: huddleMode,
    });
    scope.onCleanup(() => strip.destroy());
  }

  // Tapping a speaker tag in the notes offers the voices this doc's meetings
  // had. Mounted whatever the doc type, and independent of the strip: notes
  // outlive the meeting that produced them, and correcting an attribution a
  // week later is the ordinary case rather than the exotic one.
  const reassign = mountSpeakerReassign({
    editor: editor.editor,
    loadVoices: () => loadDocVoices(docId),
    // Permission, not mode: a reader in view mode may still fix an
    // attribution, and a reader without write access may not.
    canWrite: () => canWrite,
  });
  scope.onCleanup(() => reassign.destroy());

  // Editing under an on-screen keyboard: the meeting strip gives its grid row
  // back while a phone-width editor has focus, and the caret is kept above
  // whatever the keyboard is covering. See edit-viewport.ts for both rules.
  editViewport = wireEditViewport({
    roots: () => [editorMount, composer],
    scroller: () => editorMount,
    strip: () => meetingStripEl,
    caretRect: () => {
      const view = editor.editor.view;
      // View mode never focuses the editor; there is no caret to follow and
      // no keyboard that could be covering one.
      if (!view.dom.contains(document.activeElement)) return null;
      try {
        const c = view.coordsAtPos(view.state.selection.head);
        return { top: c.top, bottom: c.bottom };
      } catch {
        // A head position that has not been rendered yet (a fresh mount, a
        // remote edit mid-frame) throws rather than returning coordinates.
        return null;
      }
    },
    listen: (t, type, h, o) => scope.listen(t, type, h, o),
    onCleanup: (fn) => scope.onCleanup(fn),
  });

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
  /** What the pill represents if clicked: a range selection, or expand
   *  to the paragraph containing the caret. */
  let pillMode: 'range' | 'caret' = 'range';
  /** Cached paragraph range for caret mode — captured when the pill is
   *  shown so the click handler doesn't depend on the editor still having
   *  the same selection (iOS blurs the editor when the pill is tapped). */
  let caretParaRange: { from: number; to: number } | null = null;

  // A gesture on the document suppresses the pill until it ends, so the pill
  // doesn't hop around under the finger mid-drag. Releasing is only ONE of
  // the ways a touch ends — a cancelled one (scroll, iOS long-press takeover)
  // delivers no pointerup at all, and treating that as "still dragging" left
  // inline commenting dead for the rest of the page load. See gesture.ts.
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  const gesture = trackGesture({
    dom: editor.editor.view.dom,
    win: window,
    onBegin: () => {
      selectionSettled = false;
      hidePill();
    },
    onEnd: () => {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        selectionSettled = true;
        const sel = editor.getSelectionRel();
        if (sel) selection = sel;
        positionPill();
      }, 50);
    },
  });
  scope.onCleanup(() => {
    gesture.dispose();
    // Same reason the selectionchange timer is cleared below: this one would
    // run positionPill() against the destroyed editor of the previous doc.
    if (settleTimer) clearTimeout(settleTimer);
  });

  function refreshSelectionState(): void {
    const sel = editor.getSelectionRel();
    if (sel) selection = sel;
    // Typing or arrowing towards the bottom of the window walks the caret
    // under the on-screen keyboard; `follow` scrolls it back into the band
    // the visual viewport says is visible. No-op with no keyboard up, and a
    // no-op again once the caret is already clear.
    editViewport?.follow();
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
    if (gesture.active) {
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

  // This lives on the editor's own DOM, which is removed by editor.destroy()
  // on teardown, so its listener dies with it — no scope binding needed.
  editor.editor.view.dom.addEventListener('keyup', (ev) => {
    if (ev.shiftKey || ev.key.startsWith('Arrow') || ev.key === 'Home' || ev.key === 'End') {
      selectionSettled = true;
      refreshSelectionState();
      positionPill();
    }
  });
  editor.editor.on('selectionUpdate', () => {
    if (!gesture.active && selectionSettled) positionPill();
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
    if (gesture.active) return; // wait for the gesture to settle (see gesture.ts)
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
  //   • A visible balloon for it → scroll the balloon into view.
  //   • Mobile: full-screen thread view (Notion pattern — gives the
  //     conversation space without the doc competing for it).
  //   • Desktop: open the side drawer and highlight the thread.
  wireThreadRangeClicks({
    editorMount,
    chrome: reviewChrome,
    surface: editor,
    scope,
    revealBalloon: (id) => margin.revealThreadBalloon(id),
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
  const setPaneList = document.getElementById('set-pane-list');
  const docMenu = document.getElementById('doc-menu');
  const docSwitcher = document.getElementById('doc-switcher') as HTMLButtonElement | null;

  async function renderSetNav(): Promise<void> {
    // Claim the sidebar so any concurrent/stale render (e.g. two legacy-set
    // meta ticks resolving out of order, or a previous workspace's in-flight
    // render) can detect it was superseded and bail before overwriting.
    const token = beginSidebarRender();
    const m = readDocMeta(ydoc);
    const workspaceId = m.workspaceId ?? '';
    const setId = m.setId ?? '';
    // The sidebar grid shows whenever the doc is part of a workspace OR a
    // legacy hand-grouped set. workspaceId implies a folder bind → tree;
    // setId-only stays on the flat list.
    const navKey = workspaceId || setId;
    // Nothing reserves the column here. Knowing the doc names a set is not
    // knowing the set has anything in it — each renderer below commits once it
    // has a list, and `commitSidebarColumn` explains what that cost when this
    // line toggled `has-set` from meta instead.
    if (!navKey) {
      commitSidebarColumn(false);
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
      const ok = await renderDiffNav(navDocId, workspaceId, false, scope);
      if (scope.disposed) return;
      if (!ok) await renderWorkspaceTree(navDocId, workspaceId, false, scope);
      return;
    }
    // ---- Legacy flat setId path ----
    // Re-fetch /api/docs on every renderSetNav so the list self-heals: a
    // transient failure or an incomplete initial-sync snapshot is corrected on
    // the next meta tick, and a sibling added mid-review appears in place. The
    // shared signature check below means an unchanged list costs only the small
    // fetch, not a scroll-resetting DOM rebuild. (Do NOT memo this per mount —
    // that froze a failed/partial snapshot for the whole mount.) `scope.disposed`
    // guards the superseded-navigation race after the await.
    try {
      const res = await fetch(setDocsUrl(setId));
      // Bail if the mount was torn down OR a newer sidebar render superseded us
      // (e.g. a later meta tick's fetch already resolved) — an earlier,
      // possibly smaller snapshot must not overwrite it.
      if (scope.disposed || !isCurrentSidebarRender(token)) return;
      if (!res.ok) return;
      const data = (await res.json()) as LegacyDocs;
      if (scope.disposed || !isCurrentSidebarRender(token)) return;
      const siblings = selectSetSiblings(data.docs, setId);
      // The list is known now, so the column can be decided. A set whose
      // members are all non-markdown lands here with zero rows and gives the
      // width back rather than rendering an empty labelled panel.
      commitSidebarColumn(siblings.length > 0);
      if (siblings.length === 0) {
        if (setPaneList) setPaneList.innerHTML = '';
        if (docMenu) docMenu.innerHTML = '';
        docSwitcher?.setAttribute('aria-expanded', 'false');
        resetSidebarSignature();
        return;
      }
      const sig = `set:${setId}:${siblings.map((d) => d.docId).join(',')}`;
      if (sidebarShowsSignature(sig)) {
        setActiveFile(navDocId);
        return;
      }
      const items = siblings
        .map((d) => {
          const isActive = d.docId === docId;
          const label = d.title ?? basename(d.sourceUrl ?? d.docId);
          const sub = d.sourceUrl && d.title ? d.sourceUrl : '';
          const params = new URLSearchParams(location.search);
          const href = docHref(d.docId, workspaceIdFromPath(location.pathname), params.toString());
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
        const ok = await renderDiffNav(navDocId, workspaceId, true, scope);
        if (scope.disposed) return;
        if (!ok) await renderWorkspaceTree(navDocId, workspaceId, true, scope);
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

  // `?thread=<id>` — arrive AT the comment, not at the document that contains
  // it. The board's review queue links here, and "it drops me on the doc and I
  // scroll looking for it" is the thing that link exists to remove. Fired once,
  // on the first sync: threads don't exist before the ydoc arrives, and
  // re-revealing on every later sync would yank the reader back mid-read.
  let deepLinked = false;
  function revealLinkedThread(): void {
    if (deepLinked) return;
    const wanted = new URLSearchParams(location.search).get('thread');
    if (!wanted) return;
    deepLinked = true;
    // Only when it's really there — a stale link leaves the reader on the doc
    // rather than pulsing at nothing, and SAYS so: threads all ride the ydoc
    // that just synced, so absent now is gone (resolved away, or a stale
    // paste), not still loading. A silent nothing reads as a broken link.
    if (!reviewChrome.collectThreads().some((t) => t.id === wanted)) {
      showToast('That comment thread is gone from this doc — the link may be outdated.');
      return;
    }
    reviewChrome.revealThread(wanted);
  }

  // Live task-link status chips: once the doc's meta has synced (onReady) we
  // know its board, and the board's `task.transitioned` push keeps every chip
  // honest — the "filed in the meeting, flips when dispatched" surface.
  let chipsWatched = false;
  function watchChips(): void {
    if (chipsWatched || scope.disposed) return;
    const chipWorkspaceId = ctx.workspaceId ?? readDocMeta(ydoc).workspaceId;
    if (!chipWorkspaceId) return;
    chipsWatched = true;
    scope.onCleanup(watchTaskLinkStatuses(chipWorkspaceId, editor.editor.view));
  }

  client.onReady(() => {
    if (scope.disposed) return;
    reviewChrome.renderDocLabel();
    void renderSetNav();
    reviewChrome.redrawThreads();
    revealLinkedThread();
    watchChips();
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
  // TWO facts, deliberately not one. `wsOnline` is the raw socket, updated
  // the instant it changes, and it decides whether an edit may be called
  // saved. `reconnecting` is the graced VIEW, and it decides what the chip
  // says — so a blip never repaints, while nothing is ever reported as saved
  // to a server that isn't there.
  let wsOnline = false;
  let reconnecting = false;
  function renderSaveState(): void {
    saveStateEl.classList.remove('save-state--saved', 'save-state--dirty', 'save-state--offline');
    // Nothing to report about saving on a surface that cannot save. "All
    // changes saved" beside a locked editor is a true sentence describing a
    // thing that is not happening, which is worse than silence.
    if (!canWrite) {
      saveStateEl.textContent = '';
      return;
    }
    switch (saveStateView({ reconnecting, pendingEdits: pendingLocalEdits })) {
      case 'reconnecting':
        // Not "Offline": a restart is the usual cause and it is coming back.
        saveStateEl.textContent = 'Reconnecting…';
        saveStateEl.classList.add('save-state--offline');
        return;
      case 'dirty':
        saveStateEl.textContent = 'Unsaved changes';
        saveStateEl.classList.add('save-state--dirty');
        return;
      default:
        saveStateEl.textContent = 'All changes saved';
        saveStateEl.classList.add('save-state--saved');
    }
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
      // "Typing stopped" only means "saved" if there was a server listening.
      pendingLocalEdits = settlePending(pendingLocalEdits, wsOnline);
      renderSaveState();
    }, 500);
  });
  // Raw status: the truth half. Nothing visible hangs off it directly, so it
  // can flip as often as the backoff does without any flicker.
  client.onStatus((s) => {
    if (scope.disposed) return;
    const was = wsOnline;
    wsOnline = s === 'open';
    // Coming back is what the debounce was waiting for. Edits it refused to
    // settle while offline settle now, without needing another keystroke.
    if (wsOnline && !was && pendingLocalEdits > 0) {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        pendingLocalEdits = settlePending(pendingLocalEdits, wsOnline);
        renderSaveState();
      }, 500);
    }
    renderSaveState();
  });
  // One reading of the connection, shared with the board: a drop is only
  // worth SHOWING once it has outlasted the grace window, and it clears the
  // moment the socket returns — no reload. The disposed guard matters because
  // the grace timer can outlive the mount that armed it.
  watchConnection({
    onStatus: (cb) => client.onStatus(cb),
    onView: (view) => {
      if (scope.disposed) return;
      reconnecting = view === 'reconnecting';
      renderSaveState();
    },
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
  //   The mode itself, and the stored preference behind it, live in
  //   edit-mode.ts — including why the preference alone can never decide this.
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
  // The stored preference is CONSULTED, not obeyed: `canWrite` is the answer
  // main() already awaited, so the first `setEditable` of this mount is
  // already the right one. There is no window in which the document is live
  // and the answer is outstanding — the mount had the answer before it ran.
  let editMode: EditMode = initialEditMode(canWrite);
  applyEditMode(editMode);
  scope.listen(toggleEditMode, 'click', () => {
    // A disabled button fires no click. Kept anyway: `lockDocToReading` is
    // what disables it, and a guard that depends on a DOM property having
    // been set is one refactor away from being no guard at all.
    if (!canWrite) return;
    editMode = editMode === 'edit' ? 'view' : 'edit';
    writeEditModePref(editMode);
    applyEditMode(editMode);
  });

  // =========================================================================
  // SUGGESTING MODE — Google-Docs-style proposals. While ON, the suggest-input
  //   plugin turns typing/deleting into attributed suggestInsert/suggestDelete
  //   marks; nothing reaches disk until accepted (the serializer emits the
  //   accepted state). Persisted per doc (localStorage is per-browser, so the
  //   doc key already scopes it to this user).
  // =========================================================================
  let suggesting = readSuggestModePref(docId);
  function applySuggestMode(on: boolean): void {
    // Never on for a browser the server refuses. Belt to the toggle's
    // braces: this is the single call both the mount and the click go
    // through, so a persisted `suggest: on` preference cannot bring the
    // mode back for a reader who cannot write.
    if (!canWrite) on = false;
    setSuggesting(editor.editor.view, {
      on,
      author: { id: user.id, name: user.name, color: user.color },
    });
    document.body.classList.toggle('suggest-mode', on);
    toggleSuggestMode.setAttribute('aria-pressed', String(on));
    toggleSuggestMode.title = on
      ? 'Suggesting — edits become proposals. Tap for direct editing'
      : 'Tap to switch to Suggesting — edits become proposals';
    toggleSuggestMode.setAttribute(
      'aria-label',
      on
        ? 'Suggesting on — your edits become proposals. Tap for direct editing'
        : 'Suggesting off — tap to propose edits instead of making them',
    );
  }
  applySuggestMode(suggesting);
  scope.listen(toggleSuggestMode, 'click', () => {
    // See the edit toggle: covers the window before the session answer lands.
    if (!canWrite) return;
    suggesting = !suggesting;
    writeSuggestModePref(docId, suggesting);
    // Suggesting implies an editable surface — proposing requires typing.
    if (suggesting && editMode !== 'edit') {
      editMode = 'edit';
      writeEditModePref(editMode);
      applyEditMode(editMode);
    }
    applySuggestMode(suggesting);
  });

  /**
   * A browser the server will not accept writes from does not get an edit
   * toggle — or a Suggesting toggle, which is the same door. The socket is
   * already read-only server-side; this is what stops a person typing into it
   * and watching the text vanish on reload.
   *
   * Synchronous, and last in the mount because it speaks for the whole
   * surface: `canWrite` came in on the MountContext, so nothing here waits on
   * a network answer and nothing is editable in the meantime. It used to be a
   * `.then()` on a second `/api/auth/session` call, and everything above ran
   * — editable — while that was in flight.
   */
  if (!canWrite) {
    // The crumb and the save-state chip are `lockDocToReading`'s now — they
    // were here, and the redline and code surfaces went without them.
    lockDocToReading({
      stopSuggesting: () => {
        suggesting = false;
        applySuggestMode(false);
      },
      toViewMode: () => {
        editMode = 'view';
        applyEditMode('view');
      },
    });
  }

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
