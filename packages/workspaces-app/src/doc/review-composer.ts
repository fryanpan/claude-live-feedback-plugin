/**
 * The two places a person writes on an attachment: the comment composer
 * that opens off a selection, and the full-screen thread view with its reply
 * box.
 *
 * They are one module because they share the same three pieces of state — the
 * captured selection, the idempotency key for one send attempt, and which
 * thread the view is showing. Each is written in exactly one place in here and
 * read nowhere else, which is what keeps a second writer from appearing as the
 * chrome around them grows.
 *
 * Everything the writing surfaces need is passed in; nothing here reaches back
 * into `mountReviewChrome`.
 */
import { type Thread, type User, authorLabel, formatTime } from '@feedback/core';
import {
  attachMarkdownComposer,
  blurMarkdownComposer,
  focusMarkdownComposer,
} from '../md-composer.ts';
import type { ReviewSurface } from '../review-surface.ts';
import type { ThreadPanel } from '../threads.ts';
import { type ChromeSelection, anchorBody } from './anchor-body.ts';
import { el, makeBtn, showToast } from './chrome-dom.ts';

/** An idempotency key for one comment-composer submit attempt — unique
 *  enough to dedupe against, not a security token, so `Math.random` is
 *  plenty. Not `crypto.randomUUID`: iOS Safari under 15.4 (still in the
 *  field on shared review links) doesn't have it. */
function makeRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface ComposerElements {
  composer: HTMLElement;
  composerText: HTMLTextAreaElement;
  composerAvatar: HTMLElement;
  composerScrim: HTMLElement;
  threadView: HTMLElement;
  threadViewBody: HTMLElement;
  threadViewClose: HTMLButtonElement;
  threadViewReplyText: HTMLTextAreaElement;
  threadViewReplySubmit: HTMLButtonElement;
}

export interface ComposerOptions {
  els: ComposerElements;
  user: User;
  docId: string;
  /** The chrome's scoped listener helper — every binding here is released
   *  with the mount that owns it. */
  on: (target: EventTarget, type: string, handler: (ev: Event) => void) => void;
  /** The mount's teardown hook, when this mount has a scope. Listeners come
   *  off with `on`; the timers below have to be cancelled by hand, and a
   *  timer that fires after teardown reaches a document that is gone. */
  onCleanup?: (fn: () => void) => void;
  surface: Pick<ReviewSurface, 'scrollToPos' | 'pulseRange'>;
  threadsPanel: Pick<ThreadPanel, 'setActive'>;
  collectThreads: () => Thread[];
  resolveThreadRange: (id: string) => { from: number; to: number } | null;
  threadLineLabel: (id: string) => string | null;
  getSelection: () => ChromeSelection | null;
  selectHint: string;
  hidePill?: () => void;
  onComposerOpened?: () => void;
  onPosted?: () => void;
}

/** What the chrome drives these surfaces with. */
export interface ComposerHandle {
  openComposer: (prefill?: string) => void;
  hideComposer: () => void;
  openThreadView: (id: string) => void;
  closeThreadView: () => void;
  /** Re-render the thread view, if one is open. */
  refreshThreadView: () => void;
}

export function wireReviewComposer(opts: ComposerOptions): ComposerHandle {
  const {
    els: {
      composer,
      composerText,
      composerAvatar,
      composerScrim,
      threadView,
      threadViewBody,
      threadViewClose,
      threadViewReplyText,
      threadViewReplySubmit,
    },
    user,
    docId,
    on,
    surface,
    threadsPanel,
    collectThreads,
    resolveThreadRange,
    threadLineLabel,
  } = opts;

  // --- composer ------------------------------------------------------------
  composerAvatar.style.background = user.color;
  composerAvatar.textContent = (user.name[0] ?? '?').toUpperCase();

  // Every composer is a markdown editor (design point 4), and this is the one
  // a reviewer reaches first — select text, tap the pill, type. Comments
  // RENDER markdown, so the box they are typed into edits it live.
  // `attachMarkdownComposer` is idempotent because `#composer` is shell DOM
  // that outlives the document while this function runs once per navigation.
  const refreshComposer = attachMarkdownComposer(composerText);

  /** Selection captured when the composer opened — survives the editor
   *  losing its DOM selection while the user types the comment. */
  let composerSelection: ChromeSelection | null = null;
  /** One id per comment attempt, minted when the composer opens and reused
   *  across retries of THAT attempt — never per submit call. The server
   *  dedupes a repeat of (docId, requestId) within a short window, so a
   *  request that actually landed but looked like a client-side failure
   *  (timeout, dropped response) doesn't get posted twice on retry either. */
  let composerRequestId: string | null = null;

  /**
   * The highlight is scrolled to 150ms after a comment posts — a timer that
   * can outlive what it is aimed at (a whole mount the router disposed), so
   * it is held and cancelled rather than left to fire into a dead document.
   *
   * The CARET used to be on a timer beside it, 30ms out, and that one is
   * gone. It could outlive the composer in the sharper way — Tiptap's focus
   * command reaches for `requestAnimationFrame`, which a torn-down page no
   * longer has — and it cost the thing it was scheduled for: iOS raises the
   * keyboard only for a focus that happens inside the gesture that asked for
   * it, so a caret 30ms behind the tap was a caret with no keyboard under it,
   * and the reader had to tap the box again (Bryan, 2026-09-04: "when user
   * clicks comment, focus immediately on the text input"). The focus is now
   * synchronous inside `openComposer`, and `hideComposer` gives the caret
   * back — which is what the timer's cancellation was really buying.
   */
  let postScrollTimer: ReturnType<typeof setTimeout> | null = null;
  opts.onCleanup?.(() => {
    if (postScrollTimer !== null) clearTimeout(postScrollTimer);
    postScrollTimer = null;
    // `#composer` is shell DOM that outlives this mount, so a composer left
    // open by a navigation is a box wired to the document the reader just
    // left — its submit would post to the old `docId`. Close it, which also
    // takes the caret back out of it.
    hideComposer();
  });

  /**
   * `prefill` seeds the box with words the person can edit or clear before
   * sending. It is a starting point, never a send: the spin-off menu's
   * "Answer a question" used to POST a fixed sentence nobody typed, which put
   * words in a person's mouth over one tap.
   */
  function openComposer(prefill?: string): void {
    const use = opts.getSelection();
    if (!use) {
      showToast(opts.selectHint);
      return;
    }
    composerSelection = use;
    composerRequestId = null;
    // Muted quote of the anchored text so the user doesn't lose sight of
    // what they're commenting on once iOS lifts the keyboard.
    el<HTMLElement>('composer-quote').textContent = use.snippet;
    composer.classList.remove('hidden');
    composerScrim.classList.remove('hidden');
    document.body.classList.add('composer-open');
    opts.hidePill?.();
    composerText.value = prefill ?? '';
    // Setting the box in code is invisible to the editor, so it has to be
    // told — otherwise the previous comment is still sitting in the box the
    // reviewer just opened for a new one.
    refreshComposer();
    // SYNCHRONOUS, and it has to stay that way: everything above this line is
    // DOM work with nothing awaited, so the focus still sits inside the click
    // that opened the composer and iOS raises the keyboard on that tap rather
    // than the next one. Focusing without scrolling stops iOS's
    // auto-scroll-to-focus from yanking the page — what `preventScroll`
    // bought while this was a textarea.
    focusMarkdownComposer(composerText, null, { scroll: false });
    opts.onComposerOpened?.();
  }
  function hideComposer(): void {
    // The composer is going away; the caret must not stay in a box nobody can
    // see. A real browser blurs a focused element it hides, and happy-dom
    // does not — so say it, rather than letting the test environment and the
    // product disagree about who holds the caret.
    blurMarkdownComposer(composerText);
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
    const submitBtn = el<HTMLButtonElement>('composer-submit');
    // The button's `disabled` is the send-in-progress flag, but Enter never
    // routes through the button — it calls this function directly — so a
    // second Enter (key repeat, or one more tap before the first request
    // lands) has to be turned away HERE, before anything else runs. Checked
    // and set synchronously, with no `await` between them, so two calls
    // arriving back to back can't both pass.
    if (submitBtn.disabled) return;
    const text = composerText.value.trim();
    if (!text) return;
    if (!composerSelection) {
      showToast('Lost the selection — try again.');
      return;
    }
    const anchor = anchorBody(composerSelection);
    const requestId = composerRequestId ?? (composerRequestId = makeRequestId());
    submitBtn.disabled = true;
    // Mirrors the button: no further keystrokes (or Enters) reach the editor
    // while the request is in flight, on top of the disabled-button guard.
    composerText.disabled = true;
    try {
      const res = await fetch(`/api/docs/${encodeURIComponent(docId)}/threads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author: user, text, anchor, requestId }),
      });
      if (!res.ok) throw new Error('post failed');
      const body = (await res.json()) as { thread: { id: string } };
      hideComposer();
      opts.onPosted?.();
      showToast('✓ Comment posted');
      // Post-feedback: wait for the Yjs update to land the highlight, then
      // scroll it into view + pulse so the user sees where it landed.
      postScrollTimer = setTimeout(() => {
        postScrollTimer = null;
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
      composerText.disabled = false;
    }
  }

  // --- full-screen thread view -----------------------------------------------
  // No longer the mobile comment surface — inline cards + the over-doc sheet
  // replaced it, and nothing routes a comment tap here any more. Retained
  // because `#thread-view` is still a live element (its CSS block is what
  // the deletion and suggestion sheets are built from) and because
  // openThreadView remains on the chrome interface for callers outside this
  // file. Do not add new comment routing to it: it is a forked comment DOM
  // with no slots, so a card opened here cannot morph.
  let threadViewId: string | null = null;
  function renderThreadView(id: string): void {
    const t = collectThreads().find((x) => x.id === id);
    if (!t) return;
    const anchorText =
      t.anchor.kind === 'subject'
        ? ''
        : t.anchor.kind === 'orphan'
          ? t.anchor.original.snippet.text
          : t.anchor.snippet.text;
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
      nm.textContent = authorLabel(c.author);
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
  return {
    openComposer,
    hideComposer,
    openThreadView,
    closeThreadView,
    refreshThreadView: () => {
      if (threadViewId) renderThreadView(threadViewId);
    },
  };
}
