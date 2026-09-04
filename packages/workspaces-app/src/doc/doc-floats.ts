/**
 * The two always-in-view floats a plan document carries: Approve (the plan
 * gate) and Review.
 *
 * One module because they are one row and one condition. Both mount only on
 * an ordinary markdown doc — never a diff member's companion view — both hang
 * off the same `meta` map for the transition no event stream carries, and the
 * order they mount in IS the order they read in: plan, then review. Splitting
 * them would leave that ordering as an accident of two call sites.
 */
import type { User } from '@feedback/core';
import type * as Y from 'yjs';
import type { LeadBanner } from '../lead-banner.ts';
import type { MountScope } from '../mount-scope.ts';
import { mountPlanGate } from '../plan-gate.ts';
import { mountReviewFloat } from '../review-float.ts';

export interface DocFloatsOptions {
  docId: string;
  /** The `#editor` element the floats dock inside. */
  root: HTMLElement;
  ydoc: Y.Doc;
  user: User;
  canWrite: boolean;
  scope: MountScope;
  /** The lead-presence stream, on a huddle doc — so both receipts can say
   *  "no lead attached" off the same answer. Absent everywhere else. */
  watchLeadPresence?: LeadBanner['watch'];
}

export function mountDocFloats(opts: DocFloatsOptions): void {
  const { docId, root, ydoc, user, canWrite, scope, watchLeadPresence } = opts;

  const planGate = mountPlanGate({
    docId,
    root,
    user,
    canWrite,
    // `setPlanState` writes planState into this same map on the server, so
    // observing it is how the float hears that the plan landed — no event
    // stream carries that transition. Any meta change re-reads; the read is
    // one small GET and the map changes rarely.
    watchDocMeta: (onChange) => {
      const meta = ydoc.getMap('meta');
      meta.observe(onChange);
      return () => meta.unobserve(onChange);
    },
    ...(watchLeadPresence ? { watchLeadPresence } : {}),
  });
  scope.onCleanup(() => planGate.destroy());

  // The Review float docks beside Make Plan (mounted AFTER it, so the row
  // reads plan, then review). Its receipt clears when the ask thread is
  // resolved, and threads live in this doc's own Yjs map — so the map is
  // what it watches, and a resolve from anywhere flips the face with no
  // fetch.
  const reviewFloat = mountReviewFloat({
    docId,
    root,
    user,
    canWrite,
    watchDocMeta: (onChange) => {
      const meta = ydoc.getMap('meta');
      meta.observe(onChange);
      return () => meta.unobserve(onChange);
    },
    threadOpen: (threadId) => {
      const t = ydoc.getMap('threads').get(threadId) as { get(key: string): unknown } | undefined;
      if (!t) return undefined;
      return t.get('status') !== 'resolved';
    },
    watchThreads: (onChange) => {
      const threads = ydoc.getMap('threads');
      threads.observeDeep(onChange);
      return () => threads.unobserveDeep(onChange);
    },
    ...(watchLeadPresence ? { watchLeadPresence } : {}),
  });
  scope.onCleanup(() => reviewFloat.destroy());
}
