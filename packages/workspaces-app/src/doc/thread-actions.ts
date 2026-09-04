/**
 * The five writes a comment card can make, and what the reader is told when
 * one fails.
 *
 * Reply, undo-answer, resolve, reopen, re-anchor: every one is a POST to this
 * document's thread routes and a toast, and none of them touches the DOM, the
 * ydoc or the panel. The repaint comes from the websocket — the server writes
 * the thread, the CRDT syncs it, the observer redraws — so there is no client
 * state to keep here and nothing to roll back on failure.
 *
 * One module because the failure contract is the part that is easy to get
 * wrong and has to be uniform: a refused ANSWER toasts and returns `false`,
 * which is what makes the panel put the typed words back in the box instead
 * of clearing them over an error; a refused undo of an answer somebody else
 * already took back toasts nothing, because the live repaint is already
 * showing the outcome and a "try again" over an already-done undo reads as a
 * broken button.
 */
import type { User } from '@feedback/core';
import { type ChromeSelection, anchorBody } from '../review-chrome.ts';
import { showToast } from './chrome-dom.ts';

export interface ThreadActionDeps {
  /** The document whose thread routes these calls address. */
  docId: string;
  /** Authorship for every write. */
  user: User;
  /** Current selection, for re-anchor. The surface owns its caching quirks
   *  (iOS blur, caret expansion) behind this. */
  getSelection: () => ChromeSelection | null;
  /** Toast shown when re-anchor is clicked without a selection. */
  reanchorHint: string;
}

export interface ThreadActions {
  /**
   * Post a reply, or ANSWER a review item declared in this thread.
   *
   * Two routes, one reply. `/answer` posts the SAME comment and additionally
   * stamps `answeredAt` on the declaring comment, which is what takes the item
   * off the Home queue. The caller decides which by handing back an id or not;
   * sending one the server did not declare is refused rather than invented, so
   * there is nothing to guess here.
   *
   * Until this branch existed, every doc reply went to `/comments`, so a
   * review item could be read in the doc, answered in the person's own words,
   * and stay queued — which is exactly what happened four times on
   * `board-review-2026-08-19`.
   *
   * Resolves `false` when the post did not land, which is what lets the panel
   * restore the typed words.
   */
  reply: (
    threadId: string,
    text: string,
    answersCommentId?: string,
    optionId?: string,
  ) => Promise<boolean>;
  /** Take a recorded answer back. Soft delete on the server: the stamps move
   *  into `answerHistory` and the reply comment stays. */
  undoAnswer: (threadId: string, commentId: string) => Promise<void>;
  resolve: (threadId: string) => Promise<void>;
  reopen: (threadId: string) => Promise<void>;
  /** Re-point an orphaned thread at the current selection. */
  reanchor: (threadId: string) => Promise<void>;
}

export function createThreadActions(deps: ThreadActionDeps): ThreadActions {
  const { docId, user } = deps;
  const threadUrl = (threadId: string, suffix: string) =>
    `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(threadId)}${suffix}`;

  return {
    async reply(threadId, text, answersCommentId, optionId) {
      let res: Response;
      try {
        res = await fetch(threadUrl(threadId, answersCommentId ? '/answer' : '/comments'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            author: user,
            text,
            ...(answersCommentId ? { commentId: answersCommentId } : {}),
            // Provenance for a tapped option — records WHICH offered candidate
            // the verbatim words came from. Typed answers send none.
            ...(answersCommentId && optionId ? { optionId } : {}),
          }),
        });
      } catch {
        if (answersCommentId) showToast('Answer failed to post — try again');
        return false;
      }
      // A failed answer must not read as a posted one: the toast says try
      // again, and the returned `false` is what makes trying again possible —
      // the panel puts the typed words back in the box.
      if (!res.ok && answersCommentId) {
        showToast('Answer failed to post — try again');
      }
      return res.ok;
    },

    async undoAnswer(threadId, commentId) {
      const res = await fetch(threadUrl(threadId, '/answer/undo'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author: user, commentId }),
      });
      if (!res.ok) {
        // "not-answered" means somebody else took it back first — the live
        // repaint is already showing that, and a failure toast over an
        // already-done undo would read as a broken button.
        const err = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
        if (err?.error !== 'not-answered') showToast('Undo failed — try again');
      }
    },

    async resolve(threadId) {
      try {
        const res = await fetch(threadUrl(threadId, '/resolve'), { method: 'POST' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast('✓ Resolved');
      } catch {
        showToast('Failed to resolve — try again');
      }
    },

    async reopen(threadId) {
      try {
        const res = await fetch(threadUrl(threadId, '/reopen'), { method: 'POST' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast('✓ Reopened');
      } catch {
        showToast('Failed to reopen — try again');
      }
    },

    async reanchor(threadId) {
      const sel = deps.getSelection();
      if (!sel) {
        showToast(deps.reanchorHint);
        return;
      }
      try {
        const res = await fetch(threadUrl(threadId, '/reanchor'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ anchor: anchorBody(sel) }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast('✓ Re-anchored');
      } catch {
        showToast('Failed to re-anchor — try again');
      }
    },
  };
}
