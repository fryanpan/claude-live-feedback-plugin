import { type Comment, type Thread, pendingDeclaration, reviewWithdrawn } from '@feedback/core';

/**
 * What a thread IS to the reader, in one word — the term every surface keys
 * its glyph off: the highlight in the prose, the card in the margin, the
 * inline card on a phone, the top-bar chip and the off-screen hints.
 *
 *  - `question`  an open review item is waiting on a person. Decisions and
 *                questions alike: Bryan's one change on the approved mock was
 *                ONE question-mark glyph for every review item, no separate
 *                fork glyph for a decision (2026-09-01).
 *  - `answered`  the thread carried an item and somebody has answered it.
 *  - `resolved`  the thread is closed.
 *  - `comment`   everything else — an ordinary conversation.
 *
 * Ordered by what the reader has to DO: a resolved thread that once carried a
 * question is resolved, not answered, because nothing is left to do with it.
 */
export type ThreadKind = 'comment' | 'question' | 'answered' | 'resolved';

/** The three glyphs. `answered` and `resolved` share the green tick — both
 *  say "nothing left for you here". */
export type ThreadGlyph = 'comment' | 'question' | 'done';

export function threadKind(t: Pick<Thread, 'status' | 'comments'>): ThreadKind {
  if (t.status === 'resolved') return 'resolved';
  // The SAME rule the server's queue and the card's answer composer read:
  // newest declaration wins, a withdrawn one is not pending.
  if (pendingDeclaration<Comment>(t)) return 'question';
  const declared = (t.comments ?? []).some((c) => c.review && !reviewWithdrawn(c.review));
  return declared ? 'answered' : 'comment';
}

export function threadGlyph(kind: ThreadKind): ThreadGlyph {
  if (kind === 'question') return 'question';
  if (kind === 'comment') return 'comment';
  return 'done';
}

/** Is a person still on the hook for this thread? */
export function isOpenAsk(t: Pick<Thread, 'status' | 'comments'>): boolean {
  return threadKind(t) === 'question';
}
