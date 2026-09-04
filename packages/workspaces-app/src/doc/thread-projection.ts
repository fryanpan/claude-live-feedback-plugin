/**
 * The projection from this document's ydoc to the threads every review
 * surface renders.
 *
 * One reader, four consumers: the drawer panel, the margin balloons, the
 * mobile inline cards and the wide modal all render whatever `collect()`
 * returns. This surface does NOT go through core's `readThread` — it
 * hand-builds each `Thread` so a text-range anchor that no longer resolves
 * can display as orphaned without touching what is persisted — which is
 * exactly why the build lives in one place: a field listed here and nowhere
 * else is a field the whole app renders, and a field forgotten here is one
 * the server can write, sync, and have nobody ever show (see the `summary`
 * story in docs/process/learnings.md).
 *
 * It owns three pieces of state and nothing else reads or writes them: which
 * thread is active (the decoration highlight follows it), the "a summary is
 * being generated" expiry timer, and the seen tracker's in-place dot removal.
 * Everything else — the panel, the count badge, the sheet, the modal — is the
 * caller's, and reaches this module only as the `onPendingExpiry` redraw
 * request. Nothing here reaches back into `mountReviewChrome`.
 */
import {
  SUMMARY_PENDING_WINDOW_MS,
  type Thread,
  type User,
  readReviewPayload,
  readStoredSummary,
  summaryPending,
} from '@feedback/core';
import type * as Y from 'yjs';
import type { SeenTracker } from '../comment-seen.ts';
import type { ReviewSurface } from '../review-surface.ts';
import { threadKind } from '../thread-kind.ts';
import { threadCards } from '../thread-morph.ts';

export interface ThreadProjectionDeps {
  /** This document's CRDT. Its `threads` map is the only source read here. */
  ydoc: Y.Doc;
  /** Position resolution and the decoration sink — the editor surface. */
  surface: Pick<ReviewSurface, 'resolveRel' | 'setThreadRanges' | 'lineForPos'>;
  /** What this reader has already looked at (`comment-seen.ts`). */
  seen: SeenTracker;
  /**
   * Repaint everything that renders threads.
   *
   * A pending-summary card's ONLY exits are a summary syncing in (which the
   * ydoc observer already repaints) or its window expiring — and expiry is a
   * clock event, not a doc event, so without this nothing would ever take the
   * "generating…" state off the card.
   */
  onPendingExpiry: () => void;
}

/** One anchored thread as the editor surface wants it: absolute positions
 *  plus the two flags that pick a highlight style. */
export interface ThreadDecoration {
  id: string;
  from: number;
  to: number;
  status: Thread['status'];
  kind: ReturnType<typeof threadKind>;
  isNew: boolean;
}

export interface ThreadProjection {
  /** Absolute editor positions for a thread's anchor, or null when it no
   *  longer resolves (orphaned) or was never a text range. */
  resolveRange: (threadId: string) => { from: number; to: number } | null;
  /** Every thread in the doc, built for rendering. */
  collect: () => Thread[];
  /** "L293" / "L293–301" for line-oriented surfaces (code/diff); null on
   *  prose. Recomputed at call time so labels track live edits. */
  lineLabel: (threadId: string) => string | null;
  /** Which thread the panel currently has selected — the caller passes it
   *  back into `refreshDecorations` on a plain repaint. */
  activeThreadId: () => string | null;
  /** Push the anchor highlights to the surface and record the active thread. */
  refreshDecorations: (activeId: string | null) => void;
  /**
   * The thread has sat in view long enough: record it seen and take the red
   * dot off every copy of its card and off its highlight, IN PLACE — a
   * rebuild would destroy a card mid-morph, and "new" is not in the render
   * key for exactly that reason.
   */
  markSeen: (threadId: string) => boolean;
  /**
   * Cancel the pending-summary timer.
   *
   * It is not bound to any listener scope, so it would otherwise outlive the
   * mount and fire a redraw for the document we just left — repainting the
   * previous doc's threads over the next mount, which reuses the same DOM.
   */
  clearPendingExpiry: () => void;
}

export function createThreadProjection(deps: ThreadProjectionDeps): ThreadProjection {
  const { ydoc, surface, seen } = deps;

  function resolveRange(threadId: string): { from: number; to: number } | null {
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

  function collect(): Thread[] {
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
          if (cid && author && text != null && ts != null) {
            // The review payload is what makes a thread CARRY an item — drop
            // it here and the panel renders a plain conversation: no item
            // card, no Answer routing, no answered record. This reader is the
            // panel's only source (see the summary note below), so the doc
            // half of answering worked in every panel unit test and not at
            // all through the mounted chrome until the glue tests posted
            // through it.
            const review = readReviewPayload(c.get('review'));
            comments.push({ id: cid, author, text, ts, ...(review ? { review } : {}) });
          }
        }
      }
      // A text-range anchor that no longer resolves displays as orphaned so
      // the panel offers the recover flow (the persisted anchor is untouched).
      let displayAnchor: Thread['anchor'] = anchorRaw;
      if (anchorRaw.kind === 'text-range') {
        const r = resolveRange(id);
        if (!r) displayAnchor = { kind: 'orphan', original: anchorRaw, lastSeenAt: Date.now() };
      }
      // The generated summary is part of the thread, not a decoration on top
      // of it: `threadLines` reads `t.summary`, so a Thread built without it
      // silently renders the deterministic lines forever. This reader is the
      // ONLY source of threads for the panel, the balloons and the mobile
      // cards — the widget gets the lift for free via core's `readThread`,
      // this surface does not. Same shape as the "route layer silently drops
      // params" class in docs/process/learnings.md.
      const summary = readStoredSummary(threadMap.get('summary'));
      const pendingTsRaw = threadMap.get('summaryPendingTs');
      const t: Thread = {
        id,
        status,
        anchor: displayAnchor,
        createdBy,
        commentCount: comments.length,
        lastActivity: comments.length > 0 ? (comments[comments.length - 1]?.ts ?? 0) : 0,
        comments,
        ...(summary ? { summary } : {}),
        ...(typeof pendingTsRaw === 'number' ? { summaryPendingTs: pendingTsRaw } : {}),
      };
      // "A summary is being generated" is a server-written fact, not a guess:
      // `summaryPendingTs` is stamped when a generation is QUEUED (gated
      // visitor writes never stamp), and `summaryPending` time-bounds it so a
      // failed call degrades to the deterministic lines.
      if (summaryPending(t, { now: Date.now() })) {
        t.summaryPending = true;
        schedulePendingExpiry((t.summaryPendingTs ?? 0) + SUMMARY_PENDING_WINDOW_MS);
      }
      out.push(t);
    });
    return out;
  }

  // One timer, always armed for the EARLIEST expiry seen: a later `collect`
  // may find a thread that expires sooner, so an earlier deadline retimes the
  // timer rather than being swallowed by "one is already scheduled".
  let pendingExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingExpiryAt = Number.POSITIVE_INFINITY;
  function schedulePendingExpiry(expiresAt: number): void {
    const fireAt = expiresAt + 250; // small slack so the redraw lands after expiry
    if (fireAt >= pendingExpiryAt) return;
    if (pendingExpiryTimer != null) clearTimeout(pendingExpiryTimer);
    pendingExpiryAt = fireAt;
    pendingExpiryTimer = setTimeout(
      () => {
        clearPendingExpiry();
        deps.onPendingExpiry();
      },
      Math.max(0, fireAt - Date.now()),
    );
  }
  function clearPendingExpiry(): void {
    if (pendingExpiryTimer != null) clearTimeout(pendingExpiryTimer);
    pendingExpiryTimer = null;
    pendingExpiryAt = Number.POSITIVE_INFINITY;
  }

  function markSeen(threadId: string): boolean {
    const t = collect().find((x) => x.id === threadId);
    if (!t) return false;
    if (!seen.markSeen(t)) return false;
    for (const el of threadCards(threadId)) {
      el.classList.remove('is-new');
      // The dot rides the glyph rather than a "NEW" tag beside it — one of
      // the chips this card round removed, so there is nothing left to strip
      // out of the head; clearing the class takes the dot with it.
      el.querySelector('.thread-glyph')?.classList.remove('is-new');
    }
    refreshDecorations(activeThreadId);
    return true;
  }

  let activeThreadId: string | null = null;
  function refreshDecorations(activeId: string | null): void {
    activeThreadId = activeId;
    const ranges = collect()
      .filter((t) => t.anchor.kind === 'text-range')
      .map((t): ThreadDecoration | null => {
        const r = resolveRange(t.id);
        if (!r) return null;
        return {
          id: t.id,
          from: r.from,
          to: r.to,
          status: t.status,
          kind: threadKind(t),
          isNew: seen.isNew(t),
        };
      })
      .filter((x): x is ThreadDecoration => x != null);
    surface.setThreadRanges(ranges, activeId);
  }

  function lineLabel(threadId: string): string | null {
    if (!surface.lineForPos) return null;
    const r = resolveRange(threadId);
    if (!r) return null;
    const a = surface.lineForPos(r.from);
    const b = surface.lineForPos(Math.max(r.from, r.to - 1));
    if (a == null) return null;
    return b != null && b > a ? `L${a}–${b}` : `L${a}`;
  }

  return {
    resolveRange,
    collect,
    lineLabel,
    activeThreadId: () => activeThreadId,
    refreshDecorations,
    markSeen,
    clearPendingExpiry,
  };
}
