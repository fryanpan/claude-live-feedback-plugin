/**
 * The real thread card, on a surface that is not the doc: the Home activity
 * pane (beside a task's group) and the task panel's Activity feed (under the
 * row a phrase was selected in). One card component, because the two
 * surfaces hold the same thing — a draft that becomes a posted thread — and
 * had the same bug to solve: a repaint must never eat the words being typed.
 *
 * `ThreadPanel.renderThread` is the one card renderer every surface uses
 * (the drawer, the redline margin, the modal), and it is imperative DOM — so,
 * like the walkthrough's PromptForm, Preact owns the box and the card is
 * built into it in a layout effect.
 *
 * Before the first post the card renders a DRAFT thread (`draftThread`): the
 * reader's own name in the head, the phrase as the topic, no replies, the
 * reply box. Its Reply is what creates the thread; after that the card
 * shows the thread the server returned, and Reply posts to it.
 */
import type { Thread, User } from '@feedback/core';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { sizeThreadSlots } from '../thread-morph.ts';
import { ThreadPanel } from '../threads.ts';

/** Who the card's reply box is addressed to when no user was handed over —
 *  a surface mounted before identity resolves. Never posted with. */
export const NOBODY: User = { id: '', name: 'you', kind: 'anon', color: '#888888' };

/** The comment being written or shown on one place. `thread` is null while
 *  the words are still a draft — nothing has been posted yet — and `draft`
 *  is the thread-shaped stand-in the card shows meanwhile. Built ONCE, when
 *  the pill is tapped, and held rather than rebuilt per paint: the card
 *  keys its DOM on the thread object, and a fresh object on every signal
 *  write (each board event carries a new `now`) would rebuild the card under
 *  the reader's typing. */
export interface OpenComment {
  /** Which place the card is open on — a task id on the pane, a feed row's
   *  key on the panel. */
  key: string;
  phrase: string;
  thread: Thread | null;
  draft: Thread;
}

export function ThreadCard(props: {
  thread: Thread;
  user: User;
  onReply: (text: string) => Promise<boolean>;
  onFold: () => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  // Read at submit/fold time, never captured: the handlers close over the
  // draft/thread this paint drew, and the box outlives the paint.
  const latest = useRef(props);
  latest.current = props;
  // What the reply box held when the card was last torn down, handed to the
  // rebuilt card the way `ThreadPanel.render` keeps `pendingReplies` — a
  // rebuild (the reader's identity resolving, a draft becoming the posted
  // thread) must never eat words being typed. A successful post empties the
  // box before the thread changes, so nothing stale is ever restored.
  const pending = useRef('');
  const { thread, user } = props;
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const panel = new ThreadPanel({
      // The panel's own list is never shown — the card is lifted out of it.
      container: document.createElement('div'),
      currentUser: user,
      onThreadClick: (id) => panel.setActive(id),
      onReply: (_id, text) => latest.current.onReply(text),
      // One action only on these surfaces: the card's Resolve foot is hidden
      // by CSS, and an open thread never offers Re-anchor.
      onResolve: () => {},
      onReopen: () => {},
      onReanchor: () => {},
      // The card folding shut (a tap on it, or its caret) is the one way a
      // draft is put away besides Escape.
      onActiveChange: (id) => {
        if (id === null) latest.current.onFold();
      },
    });
    panel.markSynced();
    panel.setThreads([thread]);
    panel.setActive(thread.id);
    const card = panel.renderThread(thread);
    const ta = card.querySelector<HTMLTextAreaElement>('textarea');
    if (ta && pending.current !== '' && ta.value === '') ta.value = pending.current;
    pending.current = '';
    el.replaceChildren(card);
    // The card's two slots take their height from the face they show; the
    // margin and the drawer measure after insertion and on resize, so does
    // this.
    sizeThreadSlots(el);
    const onResize = (): void => sizeThreadSlots(el);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      pending.current = el.querySelector<HTMLTextAreaElement>('textarea')?.value ?? '';
      el.replaceChildren();
    };
  }, [thread, user]);
  return <div class="acti-thread" ref={host} />;
}

/** A thread that does not exist yet, shaped for the real card: the reader as
 *  its author, the phrase as its topic, nothing said. */
export function draftThread(key: string, phrase: string, user: User, now: number): Thread {
  return {
    id: `draft:${key}`,
    status: 'open',
    // Local only — never posted (`activityCommentRequest` sends a subject
    // anchor and quotes the phrase). The card's topic line reads whichever
    // anchor's snippet it is handed, and this is the one kind with a
    // snippet and nothing else to satisfy.
    anchor: { kind: 'review-item', reviewItemId: 'draft', snippet: { text: phrase } },
    commentCount: 0,
    lastActivity: now,
    createdBy: user,
    comments: [],
  };
}
