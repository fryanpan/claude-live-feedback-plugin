import { type Thread, type User, formatTime, readDocMeta } from '@feedback/core';
import type * as Y from 'yjs';
import type { MountScope } from './mount-scope.ts';
import type { ReviewSurface } from './review-surface.ts';
import { ThreadPanel, type ThreadTab } from './threads.ts';

/**
 * The review "chrome" — everything around the editor that is identical for
 * every SPA surface (markdown / code / diff): the threads drawer + tabs +
 * panel callbacks, the composer sheet, the mobile full-screen thread view,
 * thread collection/decoration plumbing, the doc-title label, hotkeys, and
 * the small DOM helpers. Extracted from app.ts / code-app.ts, which had
 * forked ~450 duplicated lines of this wiring; each boot now supplies only
 * its genuinely surface-specific parts via `ChromeOpts`.
 */

export interface ChromeSelection {
  start: Uint8Array;
  end: Uint8Array;
  snippet: string;
  /**
   * Set by the redline surface when the selection was entirely base-only
   * (struck-through) text, which has no position in `content`. The anchor
   * snaps to the nearest following retained line; this records what the
   * comment was actually about.
   */
  deletedSnippet?: string;
}

/**
 * Build the wire anchor for a selection.
 *
 * ONE place on purpose. Every anchor body here is hand-built field by field,
 * so a new field added to ChromeSelection but not copied is silently dropped —
 * the server accepts it, returns 200, and the data is gone. That is exactly
 * how `deletedSnippet` first shipped broken (and how `groups` did before it;
 * see docs/process/learnings.md). Add new anchor fields HERE, not at the call
 * sites.
 */
export function anchorBody(sel: ChromeSelection) {
  return {
    kind: 'text-range' as const,
    startRel: Array.from(sel.start),
    endRel: Array.from(sel.end),
    snippet: { text: sel.snippet },
    ...(sel.deletedSnippet ? { deletedSnippet: sel.deletedSnippet } : {}),
  };
}

export interface ChromeOpts {
  docId: string;
  user: User;
  ydoc: Y.Doc;
  surface: ReviewSurface;
  /** Toast shown when the composer opens without a usable selection. */
  selectHint: string;
  /** Toast shown when re-anchor is clicked without a selection. */
  reanchorHint: string;
  /** Current selection for composer/re-anchor. Surfaces own their caching
   *  quirks (iOS blur, caret expansion) behind this. */
  getSelection: () => ChromeSelection | null;
  /** Runs right after the composer sheet opens (markdown scrolls the
   *  selection above the keyboard here). */
  onComposerOpened?: () => void;
  /** Runs after a comment posts successfully (markdown blurs the editor). */
  onPosted?: () => void;
  /** Hide the surface's comment pill (called when the composer or the
   *  thread view opens). */
  hidePill?: () => void;
  /** Per-document lifecycle scope. When provided, every listener this mount
   *  registers is torn down on `scope.dispose()` and the chrome self-registers
   *  its `destroy()` — so navigating to another doc leaves no double-bound
   *  submit handlers (which would post to the previous docId). */
  scope?: MountScope;
}

export interface ReviewChrome {
  threadsPanel: ThreadPanel;
  openDrawer: () => void;
  closeDrawer: () => void;
  isMobile: () => boolean;
  resolveThreadRange: (threadId: string) => { from: number; to: number } | null;
  collectThreads: () => Thread[];
  redrawThreads: () => void;
  refreshThreadDecorations: (activeId: string | null) => void;
  /** Scroll+pulse the thread's range and focus it in panel / thread view. */
  revealThread: (id: string) => void;
  openThreadView: (id: string) => void;
  closeThreadView: () => void;
  openComposer: () => void;
  hideComposer: () => void;
  renderDocLabel: () => void;
  /** Tear down the chrome for this document: signal-bound listeners are
   *  already gone via `scope.dispose()`; this clears the rendered UI so the
   *  next document's mount doesn't briefly show this one's threads. */
  destroy: () => void;
}

export function mountReviewChrome(opts: ChromeOpts): ReviewChrome {
  const { docId, user, ydoc, surface } = opts;

  // Every listener registered here closes over this document's `docId` /
  // `ydoc` / `surface`. When a scope is supplied, bind through it so a
  // navigation removes them — otherwise the next mount's submit handlers stack
  // on top of this one's and a single click posts to multiple docs.
  const on = (
    target: EventTarget,
    type: string,
    handler: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions,
  ): void => {
    if (opts.scope) opts.scope.listen(target, type, handler, options);
    else target.addEventListener(type, handler, options);
  };

  const threadsListEl = el<HTMLElement>('threads-list');
  const docTitleEl = el<HTMLElement>('doc-title');
  const composer = el<HTMLElement>('composer');
  const composerText = el<HTMLTextAreaElement>('composer-text');
  const composerAvatar = el<HTMLElement>('composer-avatar');
  const composerScrim = el<HTMLElement>('composer-scrim');
  const threadView = el<HTMLElement>('thread-view');
  const threadViewBody = el<HTMLElement>('thread-view-body');
  const threadViewClose = el<HTMLButtonElement>('thread-view-close');
  const threadViewReplyText = el<HTMLTextAreaElement>('thread-view-reply-text');
  const threadViewReplySubmit = el<HTMLButtonElement>('thread-view-reply-submit');
  const toggleThreads = el<HTMLButtonElement>('toggle-threads');
  const threadsCount = el<HTMLElement>('threads-count');
  const closeThreads = el<HTMLButtonElement>('close-threads');
  const scrim = el<HTMLElement>('threads-scrim');
  const shell = document.getElementById('shell') as HTMLElement;

  function isMobile(): boolean {
    return !window.matchMedia('(min-width: 901px)').matches;
  }

  // --- threads drawer --------------------------------------------------------
  function openDrawer(): void {
    shell.classList.add('threads-open');
    toggleThreads.setAttribute('aria-pressed', 'true');
    document.getElementById('threads-pane')?.setAttribute('aria-hidden', 'false');
  }
  function closeDrawer(): void {
    shell.classList.remove('threads-open');
    toggleThreads.setAttribute('aria-pressed', 'false');
    document.getElementById('threads-pane')?.setAttribute('aria-hidden', 'true');
  }
  on(toggleThreads, 'click', () =>
    shell.classList.contains('threads-open') ? closeDrawer() : openDrawer(),
  );
  on(closeThreads, 'click', closeDrawer);
  on(scrim, 'click', closeDrawer);

  // Resizable side panels (desktop): the comments pane (right edge drag)
  // and the In-This-Review pane (left edge drag). Widths persist; on
  // mobile both are overlays and the handles are hidden.
  wireResizeHandle({
    pane: document.getElementById('threads-pane'),
    cssVar: '--threads-w',
    storageKey: 'lf:threads-w',
    min: 280,
    max: () => Math.min(720, Math.round(window.innerWidth * 0.6)),
    widthFromPointer: (e) => window.innerWidth - e.clientX,
    handleClass: 'threads-resize',
    label: 'Resize comments panel',
  });
  wireResizeHandle({
    pane: document.getElementById('set-pane'),
    cssVar: '--set-w',
    storageKey: 'lf:set-w',
    min: 240,
    max: () => Math.min(600, Math.round(window.innerWidth * 0.45)),
    widthFromPointer: (e) => e.clientX,
    handleClass: 'set-resize',
    label: 'Resize review panel',
  });
  // Desktop layout shows the drawer inline; open by default there.
  if (window.matchMedia('(min-width: 901px)').matches) openDrawer();

  const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.threads-tabs .tab'));
  for (const b of tabButtons) {
    on(b, 'click', () => {
      const tab = (b.getAttribute('data-tab') ?? 'open') as ThreadTab;
      threadsPanel.setTab(tab);
      for (const x of tabButtons) x.classList.toggle('active', x === b);
    });
  }

  // --- thread data plumbing --------------------------------------------------
  function resolveThreadRange(threadId: string): { from: number; to: number } | null {
    const doc = ydoc.getMap('threads').get(threadId) as Y.Map<unknown> | undefined;
    if (!doc) return null;
    const anchor = doc.get('anchor') as
      | { kind: 'text-range'; startRel: Uint8Array | number[]; endRel: Uint8Array | number[] }
      | { kind: 'element' | 'orphan' }
      | undefined;
    if (!anchor || anchor.kind !== 'text-range') return null;
    const startRel =
      anchor.startRel instanceof Uint8Array ? anchor.startRel : new Uint8Array(anchor.startRel);
    const endRel =
      anchor.endRel instanceof Uint8Array ? anchor.endRel : new Uint8Array(anchor.endRel);
    return surface.resolveRel(startRel, endRel);
  }

  function collectThreads(): Thread[] {
    const threadsMap = ydoc.getMap('threads');
    const out: Thread[] = [];
    threadsMap.forEach((entry, id) => {
      const threadMap = entry as Y.Map<unknown>;
      const anchorRaw = threadMap.get('anchor') as Thread['anchor'] | undefined;
      const status = threadMap.get('status') as Thread['status'] | undefined;
      const createdBy = threadMap.get('createdBy') as User | undefined;
      const commentsArr = threadMap.get('comments') as Y.Array<Y.Map<unknown>> | undefined;
      if (!anchorRaw || !status || !createdBy) return;
      const comments = [];
      if (commentsArr) {
        for (const c of commentsArr) {
          const cid = c.get('id') as string | undefined;
          const author = c.get('author') as User | undefined;
          const text = c.get('text') as string | undefined;
          const ts = c.get('ts') as number | undefined;
          if (cid && author && text != null && ts != null)
            comments.push({ id: cid, author, text, ts });
        }
      }
      // A text-range anchor that no longer resolves displays as orphaned so
      // the panel offers the recover flow (the persisted anchor is untouched).
      let displayAnchor: Thread['anchor'] = anchorRaw;
      if (anchorRaw.kind === 'text-range') {
        const r = resolveThreadRange(id);
        if (!r) displayAnchor = { kind: 'orphan', original: anchorRaw, lastSeenAt: Date.now() };
      }
      out.push({
        id,
        status,
        anchor: displayAnchor,
        createdBy,
        commentCount: comments.length,
        lastActivity: comments.length > 0 ? (comments[comments.length - 1]?.ts ?? 0) : 0,
        comments,
      });
    });
    return out;
  }

  let activeThreadId: string | null = null;
  function redrawThreads(): void {
    const all = collectThreads();
    threadsPanel.setThreads(all);
    refreshThreadDecorations(activeThreadId);
    const counts = threadsPanel.countByStatus();
    const openCount = counts.open + counts.orphan;
    threadsCount.textContent = String(openCount);
    threadsCount.classList.toggle('has-count', openCount > 0);
  }
  function refreshThreadDecorations(activeId: string | null): void {
    activeThreadId = activeId;
    const ranges = collectThreads()
      .filter((t) => t.anchor.kind === 'text-range')
      .map((t) => {
        const r = resolveThreadRange(t.id);
        if (!r) return null;
        return { id: t.id, from: r.from, to: r.to, status: t.status };
      })
      .filter((x): x is NonNullable<typeof x> => x != null);
    surface.setThreadRanges(ranges, activeId);
  }

  // "L293" / "L293–301" for line-oriented surfaces (code/diff); null on
  // prose. Recomputed at render time so labels track live edits.
  function threadLineLabel(threadId: string): string | null {
    if (!surface.lineForPos) return null;
    const r = resolveThreadRange(threadId);
    if (!r) return null;
    const a = surface.lineForPos(r.from);
    const b = surface.lineForPos(Math.max(r.from, r.to - 1));
    if (a == null) return null;
    return b != null && b > a ? `L${a}–${b}` : `L${a}`;
  }

  // --- thread panel ------------------------------------------------------
  const threadsPanel = new ThreadPanel({
    container: threadsListEl,
    currentUser: user,
    threadLineLabel,
    onThreadClick: (id) => {
      const range = resolveThreadRange(id);
      if (range) {
        surface.scrollToPos(range.from);
        surface.pulseRange(range.from, range.to);
      }
      threadsPanel.setActive(id);
      refreshThreadDecorations(id);
      // On mobile, swap the drawer for a full-screen thread view (Notion
      // pattern) — gives the conversation room to breathe on a small screen.
      if (isMobile()) {
        closeDrawer();
        openThreadView(id);
      }
    },
    onReply: async (id, text) => {
      await fetch(
        `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(id)}/comments`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ author: user, text }),
        },
      );
    },
    onResolve: async (id) => {
      try {
        const res = await fetch(
          `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(id)}/resolve`,
          { method: 'POST' },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast('✓ Resolved');
      } catch {
        showToast('Failed to resolve — try again');
      }
    },
    onReopen: async (id) => {
      try {
        const res = await fetch(
          `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(id)}/reopen`,
          { method: 'POST' },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast('✓ Reopened');
      } catch {
        showToast('Failed to reopen — try again');
      }
    },
    onReanchor: async (id) => {
      const sel = opts.getSelection();
      if (!sel) {
        showToast(opts.reanchorHint);
        return;
      }
      try {
        const res = await fetch(
          `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(id)}/reanchor`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ anchor: anchorBody(sel) }),
          },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast('✓ Re-anchored');
      } catch {
        showToast('Failed to re-anchor — try again');
      }
    },
  });

  function revealThread(id: string): void {
    refreshThreadDecorations(id);
    const range = resolveThreadRange(id);
    if (range) {
      surface.scrollToPos(range.from);
      surface.pulseRange(range.from, range.to);
    }
    if (isMobile()) {
      threadsPanel.setActive(id);
      openThreadView(id);
    } else {
      // Open the drawer first, then (after layout) scroll the panel to the
      // thread — otherwise the active comment lands off-screen and the
      // click appears to do nothing.
      openDrawer();
      requestAnimationFrame(() => threadsPanel.revealThread(id));
    }
  }

  // --- composer ------------------------------------------------------------
  composerAvatar.style.background = user.color;
  composerAvatar.textContent = (user.name[0] ?? '?').toUpperCase();

  /** Selection captured when the composer opened — survives the editor
   *  losing its DOM selection while the user types the comment. */
  let composerSelection: ChromeSelection | null = null;

  function openComposer(): void {
    const use = opts.getSelection();
    if (!use) {
      showToast(opts.selectHint);
      return;
    }
    composerSelection = use;
    // Muted quote of the anchored text so the user doesn't lose sight of
    // what they're commenting on once iOS lifts the keyboard.
    el<HTMLElement>('composer-quote').textContent = use.snippet;
    composer.classList.remove('hidden');
    composerScrim.classList.remove('hidden');
    document.body.classList.add('composer-open');
    opts.hidePill?.();
    composerText.value = '';
    // preventScroll stops iOS's auto-scroll-to-focus from yanking the page.
    setTimeout(() => composerText.focus({ preventScroll: true }), 30);
    opts.onComposerOpened?.();
  }
  function hideComposer(): void {
    composer.classList.add('hidden');
    composerScrim.classList.add('hidden');
    document.body.classList.remove('composer-open');
  }
  on(composerScrim, 'click', hideComposer);
  on(composerText, 'keydown', (ev) => {
    const ke = ev as KeyboardEvent;
    if (ke.key === 'Enter' && !ke.shiftKey && !ke.isComposing) {
      ke.preventDefault();
      void submitComposer();
    }
    if (ke.key === 'Escape') hideComposer();
  });
  on(el<HTMLButtonElement>('composer-submit'), 'click', () => void submitComposer());

  async function submitComposer(): Promise<void> {
    const text = composerText.value.trim();
    if (!text) return;
    if (!composerSelection) {
      showToast('Lost the selection — try again.');
      return;
    }
    const anchor = anchorBody(composerSelection);
    const submitBtn = el<HTMLButtonElement>('composer-submit');
    submitBtn.disabled = true;
    try {
      const res = await fetch(`/api/docs/${encodeURIComponent(docId)}/threads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author: user, text, anchor }),
      });
      if (!res.ok) throw new Error('post failed');
      const body = (await res.json()) as { thread: { id: string } };
      hideComposer();
      opts.onPosted?.();
      showToast('✓ Comment posted');
      // Post-feedback: wait for the Yjs update to land the highlight, then
      // scroll it into view + pulse so the user sees where it landed.
      setTimeout(() => {
        const r = resolveThreadRange(body.thread.id);
        if (r) {
          surface.scrollToPos(r.from);
          surface.pulseRange(r.from, r.to);
        }
      }, 150);
    } catch {
      showToast('Failed to post comment');
    } finally {
      submitBtn.disabled = false;
    }
  }

  // --- full-screen thread view (mobile) --------------------------------------
  let threadViewId: string | null = null;
  function renderThreadView(id: string): void {
    const t = collectThreads().find((x) => x.id === id);
    if (!t) return;
    const anchorText =
      t.anchor.kind === 'orphan' ? t.anchor.original.snippet.text : t.anchor.snippet.text;
    threadViewBody.innerHTML = '';
    const anchor = document.createElement('div');
    anchor.className = 'thread-anchor';
    anchor.textContent = anchorText;
    const lineLabel = threadLineLabel(id);
    if (lineLabel) {
      const chip = document.createElement('span');
      chip.className = 'thread-line';
      chip.textContent = lineLabel;
      anchor.prepend(chip);
    }
    threadViewBody.appendChild(anchor);
    for (const c of t.comments) {
      const row = document.createElement('div');
      row.className = 'comment';
      const a = document.createElement('div');
      a.className = 'author';
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = c.author.color;
      const nm = document.createElement('span');
      nm.className = 'name';
      nm.textContent = c.author.name;
      const tm = document.createElement('span');
      tm.className = 'time';
      tm.textContent = formatTime(c.ts);
      a.append(sw, nm, tm);
      const bodyEl = document.createElement('div');
      bodyEl.className = 'body';
      bodyEl.textContent = c.text;
      row.append(a, bodyEl);
      threadViewBody.appendChild(row);
    }
    const actions = document.createElement('div');
    actions.className = 'thread-view-actions';
    const isResolved = t.status === 'resolved';
    const action = isResolved ? 'reopen' : 'resolve';
    actions.appendChild(
      makeBtn(isResolved ? 'Reopen' : 'Resolve', async () => {
        // Don't close the sheet until the fetch confirms — closing on a
        // fire-and-forget call leaves the user with no signal on a network
        // blip. Yjs sync re-renders panel + highlights once status flips.
        try {
          const res = await fetch(
            `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(t.id)}/${action}`,
            { method: 'POST' },
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          showToast(isResolved ? '✓ Reopened' : '✓ Resolved');
          if (!isResolved) closeThreadView();
        } catch {
          showToast(`Failed to ${action} — try again`);
        }
      }),
    );
    threadViewBody.appendChild(actions);
  }
  function openThreadView(id: string): void {
    threadViewId = id;
    threadsPanel.setActive(id);
    refreshThreadDecorations(id);
    renderThreadView(id);
    opts.hidePill?.();
    threadView.classList.remove('hidden');
    threadView.setAttribute('aria-hidden', 'false');
    document.body.classList.add('thread-view-open');
    // Scroll the anchor into view behind the sheet for when it closes.
    const range = resolveThreadRange(id);
    if (range) surface.scrollToPos(range.from);
  }
  function closeThreadView(): void {
    threadViewId = null;
    threadView.classList.add('hidden');
    threadView.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('thread-view-open');
    threadViewReplyText.value = '';
  }
  on(threadViewClose, 'click', closeThreadView);
  async function submitThreadReply(): Promise<void> {
    if (!threadViewId) return;
    const text = threadViewReplyText.value.trim();
    if (!text) return;
    const id = threadViewId;
    threadViewReplyText.value = '';
    await fetch(
      `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(id)}/comments`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author: user, text }),
      },
    );
  }
  on(threadViewReplySubmit, 'click', () => void submitThreadReply());
  on(threadViewReplyText, 'keydown', (ev) => {
    const ke = ev as KeyboardEvent;
    if (ke.key === 'Enter' && !ke.shiftKey && !ke.isComposing) {
      ke.preventDefault();
      void submitThreadReply();
    }
  });

  // --- doc label --------------------------------------------------------------
  function renderDocLabel(): void {
    const m = readDocMeta(ydoc);
    // Diff docs label with the repo-relative path — the absolute worktree
    // path (their sourceUrl in live mode) is noise for a reviewer.
    const full = (m.type === 'diff' ? m.relPath : undefined) ?? m.sourceUrl ?? m.title ?? m.docId;
    // On mobile the full path eats the topbar — show just the basename
    // truncated to ~32 chars, full path in `title` for tap-and-hold.
    const mobile = window.matchMedia('(max-width: 720px)').matches;
    docTitleEl.textContent = mobile ? mobileLabel(full) : full;
    docTitleEl.title = full;
  }
  on(window.matchMedia('(max-width: 720px)'), 'change', () => renderDocLabel());

  // --- live wiring -------------------------------------------------------------
  // Bound to this document's ydoc, which is destroyed when its client closes on
  // navigation (see ws-client close()), so this observer is released with it.
  const threadsObserver = () => {
    redrawThreads();
    if (threadViewId) renderThreadView(threadViewId);
  };
  ydoc.getMap('threads').observeDeep(threadsObserver);
  opts.scope?.onCleanup(() => ydoc.getMap('threads').unobserveDeep(threadsObserver));

  // --- hotkeys ------------------------------------------------------------------
  on(document, 'keydown', (ev) => {
    const ke = ev as KeyboardEvent;
    if ((ke.metaKey || ke.ctrlKey) && ke.key.toLowerCase() === 'm') {
      ke.preventDefault();
      openComposer();
    }
    if (ke.key === 'Escape') {
      if (!composer.classList.contains('hidden')) hideComposer();
      else if (!threadView.classList.contains('hidden')) closeThreadView();
      else if (shell.classList.contains('threads-open')) closeDrawer();
    }
  });

  const chrome: ReviewChrome = {
    threadsPanel,
    openDrawer,
    closeDrawer,
    isMobile,
    resolveThreadRange,
    collectThreads,
    redrawThreads,
    refreshThreadDecorations,
    revealThread,
    openThreadView,
    closeThreadView,
    openComposer,
    hideComposer,
    renderDocLabel,
    destroy() {
      // Signal-bound listeners are already gone via scope.dispose(); clear the
      // rendered UI so the next document's mount doesn't briefly show this
      // one's threads / open composer / open thread view.
      threadsListEl.innerHTML = '';
      hideComposer();
      closeThreadView();
    },
  };
  // The router only calls scope.dispose(); make the visual teardown part of it.
  opts.scope?.onCleanup(() => chrome.destroy());
  return chrome;
}

// --- thread-range click → focus the thread -------------------------------------

export interface ThreadFocusOpts {
  /** The scroll container that hosts the editor's `.thread-range` spans. */
  editorMount: HTMLElement;
  chrome: ReviewChrome;
  surface: Pick<ReviewSurface, 'pulseRange'>;
  scope: MountScope;
  /**
   * Try showing the thread in the balloon margin first (the "vice versa" of
   * "click a balloon, see its anchor" — see markup-margin.ts). Return true
   * when handled; the drawer/thread-view fallback below is skipped. Omit on
   * surfaces with no margin (the click still highlights + pulses the anchor).
   */
  revealBalloon?: (threadId: string) => boolean;
}

/**
 * Tap-on-highlight in the editor → focus the thread. Shared by the plain
 * markdown mount and the redline mount so the click-to-focus behaviour is
 * one implementation, not two forks that drift.
 *   • A balloon margin present and showing the thread → scroll the balloon
 *     into view (the balloon already reads as the mini-drawer for that spot).
 *   • Otherwise: mobile → full-screen thread view; desktop → open the side
 *     drawer and scroll to the thread's card.
 */
export function wireThreadRangeClicks(opts: ThreadFocusOpts): void {
  const { editorMount, chrome, surface, scope, revealBalloon } = opts;
  scope.listen(editorMount, 'click', (ev) => {
    const t = ((ev as MouseEvent).target as HTMLElement).closest('.thread-range');
    if (!t) return;
    const threadId = t.getAttribute('data-thread-id');
    if (!threadId) return;
    ev.preventDefault();
    ev.stopPropagation();
    chrome.refreshThreadDecorations(threadId);
    // No scrollToPos here — the user clicked the highlight, it's already
    // on screen; jumping the doc would feel broken.
    const range = chrome.resolveThreadRange(threadId);
    if (range) surface.pulseRange(range.from, range.to);
    if (revealBalloon?.(threadId)) return;
    if (chrome.isMobile()) {
      chrome.threadsPanel.setActive(threadId);
      chrome.openThreadView(threadId);
    } else {
      chrome.openDrawer();
      requestAnimationFrame(() => chrome.threadsPanel.revealThread(threadId));
    }
  });
}

// --- resizable side panels ----------------------------------------------------

interface ResizeOpts {
  pane: HTMLElement | null;
  cssVar: string;
  storageKey: string;
  min: number;
  max: () => number;
  /** Pointer x → desired panel width (direction depends on which edge). */
  widthFromPointer: (e: PointerEvent) => number;
  handleClass: string;
  label: string;
}

function wireResizeHandle(opts: ResizeOpts): void {
  const { pane } = opts;
  if (!pane) return;
  // The pane and handle are shell-level (doc-independent), but mountReviewChrome
  // runs per navigation — wire the handle exactly once so re-mounts don't stack
  // duplicate drag bars (and duplicate window pointer listeners) on the pane.
  // Each pane owns a distinct handleClass, so a plain class query is precise.
  if (pane.querySelector(`.${opts.handleClass}`)) return;
  const clamp = (w: number) => Math.max(opts.min, Math.min(opts.max(), w));
  const apply = (w: number) => document.documentElement.style.setProperty(opts.cssVar, `${w}px`);
  try {
    const saved = Number(localStorage.getItem(opts.storageKey));
    if (Number.isFinite(saved) && saved >= opts.min) apply(clamp(saved));
  } catch {
    // localStorage unavailable — fall back to the CSS default width.
  }

  const handle = document.createElement('div');
  handle.className = opts.handleClass;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', opts.label);
  handle.title = 'Drag to resize · double-click to reset';
  pane.appendChild(handle);

  let dragging = false;
  const onMove = (e: PointerEvent) => {
    if (dragging) apply(clamp(opts.widthFromPointer(e)));
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.classList.remove('threads-resizing');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    const px = Number.parseInt(
      getComputedStyle(document.documentElement).getPropertyValue(opts.cssVar),
      10,
    );
    if (Number.isFinite(px)) {
      try {
        localStorage.setItem(opts.storageKey, String(px));
      } catch {
        // ignore — width still applied for this session
      }
    }
  };
  handle.addEventListener('pointerdown', (e) => {
    if (window.matchMedia('(max-width: 900px)').matches) return;
    e.preventDefault();
    dragging = true;
    handle.classList.add('dragging');
    document.body.classList.add('threads-resizing');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
  handle.addEventListener('dblclick', () => {
    document.documentElement.style.removeProperty(opts.cssVar);
    try {
      localStorage.removeItem(opts.storageKey);
    } catch {
      // ignore
    }
  });
}

// --- tiny DOM helpers shared by the boots -------------------------------------

export function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing element #${id}`);
  return e as T;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function showToast(msg: string): void {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2400);
}

export function makeBtn(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  if (primary) b.className = 'primary';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

export function mobileLabel(full: string): string {
  let s = full;
  try {
    if (/^https?:\/\//.test(s)) s = new URL(s).pathname;
  } catch {}
  const parts = s.split('/').filter(Boolean);
  const base = parts[parts.length - 1] ?? s;
  return base.length <= 32 ? base : `…${base.slice(-31)}`;
}

/** Exposed for unit tests — this is the layer that silently drops anchor
 *  fields, so it needs a test of its own. Not part of the public surface. */
export const __testing = { anchorBody };
