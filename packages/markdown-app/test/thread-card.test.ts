import type { Comment, Thread, User } from '@feedback/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThreadPanel, type ThreadPanelOpts, sizeThreadSlots } from '../src/threads.ts';

/**
 * The streamlined thread card (`ThreadPanel.renderThread`) — the ONE builder
 * behind the drawer list, the margin balloon, the mobile inline card and the
 * sheet. Until now it had no direct test at all; it was only ever reached
 * through the margin's suite, which meant its own structure was unguarded.
 *
 * These assert the card's shape and its tap contract. Layout (slot heights,
 * the morph) can't be measured under happy-dom and is not asserted here.
 */

const alice: User = { id: 'u1', name: 'Alice', kind: 'known', color: '#2e7dd7' };
const bob: User = { id: 'u2', name: 'Bob', kind: 'known', color: '#e36f1e' };
const cara: User = { id: 'u3', name: 'Cara', kind: 'known', color: '#1a7f4f' };

let ts = 1_700_000_000_000;
function comment(author: User, text: string): Comment {
  ts += 1000;
  return { id: `c${ts}`, author, text, ts };
}

function makeThread(over: Partial<Thread> & { comments: Comment[] }): Thread {
  const comments = over.comments;
  return {
    id: 't1',
    status: 'open',
    anchor: { kind: 'element', fingerprint: undefined as never, snippet: { text: 'the anchor' } },
    commentCount: comments.length,
    lastActivity: comments[comments.length - 1]?.ts ?? ts,
    createdBy: comments[0]?.author ?? alice,
    ...over,
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
  vi.restoreAllMocks();
});

function mountPanel(over: Partial<ThreadPanelOpts> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  cleanups.push(() => container.remove());
  const calls = {
    click: [] as string[],
    reply: [] as Array<[string, string]>,
    resolve: [] as string[],
    reopen: [] as string[],
    reanchor: [] as string[],
  };
  const panel = new ThreadPanel({
    container,
    currentUser: alice,
    onThreadClick: (id) => calls.click.push(id),
    onReply: (id, text) => {
      calls.reply.push([id, text]);
    },
    onResolve: (id) => calls.resolve.push(id),
    onReopen: (id) => calls.reopen.push(id),
    onReanchor: (id) => calls.reanchor.push(id),
    ...over,
  });
  const cardFor = (t: Thread): HTMLElement => {
    const el = container.querySelector<HTMLElement>(`.thread[data-thread-id="${t.id}"]`);
    if (!el) throw new Error(`no card rendered for ${t.id}`);
    return el;
  };
  return { panel, container, calls, cardFor };
}

const text = (el: Element | null): string => (el?.textContent ?? '').trim();
const click = (el: Element): void => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
};

describe('thread card — the two slots', () => {
  it('renders both faces of both slots: topic ⇄ opening message, discussion ⇄ replies', () => {
    const t = makeThread({
      comments: [comment(alice, 'Why is the retry count fixed?'), comment(bob, 'Because of X.')],
    });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([t]);
    const card = cardFor(t);

    const slotA = card.querySelector('.thread-slot.slot-a') as HTMLElement;
    const slotB = card.querySelector('.thread-slot.slot-b') as HTMLElement;
    expect(slotA).not.toBeNull();
    expect(slotB).not.toBeNull();

    // Both faces of a slot exist SIMULTANEOUSLY — the morph cross-fades
    // between them, so neither may be built lazily.
    expect(slotA.querySelector('.thread-face.face-summary')).not.toBeNull();
    expect(slotA.querySelector('.thread-face.face-detail')).not.toBeNull();
    expect(slotB.querySelector('.thread-face.face-summary')).not.toBeNull();
    expect(slotB.querySelector('.thread-face.face-detail')).not.toBeNull();

    expect(text(slotA.querySelector('.face-summary .thread-topic'))).toBe('the anchor');
    expect(text(slotA.querySelector('.face-detail .thread-message'))).toBe(
      'Why is the retry count fixed?',
    );
    expect(text(slotB.querySelector('.face-summary .thread-discussion'))).toContain(
      'Because of X.',
    );
    expect(text(slotB.querySelector('.face-detail .comments'))).toContain('Because of X.');
    expect(slotB.querySelector('.face-detail textarea')).not.toBeNull();
  });

  it('never repeats the author name in the opening message — the header row is its attribution', () => {
    const t = makeThread({ comments: [comment(alice, 'Opening thought.')] });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([t]);
    const card = cardFor(t);

    // Positive control: the name IS on the card, exactly once, in the header.
    expect(text(card.querySelector('.thread-head'))).toContain('Alice');
    expect(card.querySelectorAll('.thread-head .name')).toHaveLength(1);

    const msg = card.querySelector('.face-detail .thread-message') as HTMLElement;
    expect(text(msg)).toBe('Opening thought.');
    expect(msg.textContent).not.toContain('Alice');
  });

  it('keeps both lines on a thread with no replies, with "No replies yet" in the discussion slot', () => {
    const withReply = makeThread({
      id: 'has-reply',
      comments: [comment(alice, 'Question?'), comment(bob, 'Answer.')],
    });
    const alone = makeThread({ id: 'no-reply', comments: [comment(alice, 'Question?')] });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([withReply, alone]);

    // Positive control: the participants row and a real discussion line do
    // render when there IS a reply — so their absence below means something.
    const a = cardFor(withReply);
    expect(a.querySelector('.thread-participants')).not.toBeNull();
    expect(text(a.querySelector('.thread-discussion'))).toContain('Answer.');

    const b = cardFor(alone);
    expect(b.querySelector('.thread-topic')).not.toBeNull();
    const discussion = b.querySelector('.thread-discussion') as HTMLElement;
    expect(text(discussion)).toBe('No replies yet');
    expect(discussion.classList.contains('none')).toBe(true);
    expect(b.querySelector('.thread-participants')).toBeNull();
  });
});

describe('thread card — participants', () => {
  it('names exactly one replier and counts two or more, excluding the thread author', () => {
    const one = makeThread({
      id: 'one',
      comments: [comment(alice, 'Open.'), comment(bob, 'Reply.'), comment(bob, 'Again.')],
    });
    const many = makeThread({
      id: 'many',
      comments: [
        comment(alice, 'Open.'),
        comment(bob, 'Reply.'),
        comment(cara, 'Reply.'),
        comment(alice, 'Author again.'),
      ],
    });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([one, many]);

    const p1 = cardFor(one).querySelector('.thread-participants') as HTMLElement;
    expect(text(p1)).toBe('Bob replied');
    expect(p1.querySelectorAll('.swatch')).toHaveLength(1); // deduped

    const p2 = cardFor(many).querySelector('.thread-participants') as HTMLElement;
    expect(text(p2)).toBe('+2 others'); // the author's own reply is not counted
    expect(p2.querySelectorAll('.swatch')).toHaveLength(2);
  });

  it('puts the participants row directly above the discussion line, in the same face', () => {
    const t = makeThread({ comments: [comment(alice, 'Open.'), comment(bob, 'Reply.')] });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([t]);

    const face = cardFor(t).querySelector('.slot-b .face-summary') as HTMLElement;
    const kids = Array.from(face.children);
    expect(kids[0]?.classList.contains('thread-participants')).toBe(true);
    expect(kids[1]?.classList.contains('thread-discussion')).toBe(true);
  });

  it('renders an author name as text, never as HTML', () => {
    const evil: User = { ...bob, name: '<img src=x onerror="alert(1)">' };
    const t = makeThread({ comments: [comment(alice, 'Open.'), comment(evil, 'Reply.')] });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([t]);

    const card = cardFor(t);
    // Positive control: the probe can see an injected tag when there is one.
    card.querySelector('.thread-topic')?.insertAdjacentHTML('beforeend', '<img data-probe>');
    expect(card.querySelectorAll('img[data-probe]')).toHaveLength(1);
    expect(card.querySelectorAll('img:not([data-probe])')).toHaveLength(0);
    expect(text(card.querySelector('.thread-participants'))).toContain('<img src=x');
  });

  it('renders the anchor snippet as text, never as HTML', () => {
    const t = makeThread({
      anchor: {
        kind: 'element',
        fingerprint: undefined as never,
        snippet: { text: '<img src=x onerror="alert(1)">' },
      },
      comments: [comment(alice, 'Open.')],
    });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([t]);
    const topic = cardFor(t).querySelector('.thread-topic') as HTMLElement;
    expect(topic.querySelector('img')).toBeNull();
    expect(text(topic)).toContain('<img src=x');
  });
});

describe('thread card — caret and resolve control', () => {
  it('puts the caret last in the header row, as far from Resolve as the card allows', () => {
    const t = makeThread({ comments: [comment(alice, 'Open.')] });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([t]);
    const card = cardFor(t);

    const head = card.querySelector('.thread-head') as HTMLElement;
    expect(head.lastElementChild?.classList.contains('thread-caret')).toBe(true);
    // Caret at the top, resolve at the bottom — not adjacent.
    expect(card.querySelector('.thread-foot .thread-resolve')).not.toBeNull();
  });

  /* The whole card is the tap target — but a tap is not a gesture a keyboard
     or a screen reader has, and the detail face is `inert` while the card is
     folded. Without one real control there is NO way to open a thread without
     a pointer, and the opening message and every reply are unreachable. The
     caret is that control; it stays a hint rather than the hit area because
     it has no handler of its own (its click rides the card's — see the
     tap-target suite below). */
  it('makes the caret a real, named control so a keyboard can open the card', () => {
    const t = makeThread({ comments: [comment(alice, 'Open.'), comment(bob, 'Re.')] });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([t]);

    const caret = cardFor(t).querySelector('.thread-caret') as HTMLElement;
    expect(caret.tagName).toBe('BUTTON');
    expect(caret.getAttribute('aria-label')).toBeTruthy();
    // ...and it SAYS which way the card is folded: the rotation conveys that
    // to sighted users only, and the announced content changes underneath.
    expect(caret.getAttribute('aria-expanded')).toBe('false');
    expect(caret.hasAttribute('aria-hidden')).toBe(false);

    panel.setActive(t.id);
    expect(
      (cardFor(t).querySelector('.thread-caret') as HTMLElement).getAttribute('aria-expanded'),
    ).toBe('true');

    // Every path that folds a card has to keep it honest, including the one
    // that mutates an existing node (setActive folds in place).
    panel.setActive(null);
    expect(
      (cardFor(t).querySelector('.thread-caret') as HTMLElement).getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('reaches the conversation once open: the detail face leaves the tab order only while folded', () => {
    const t = makeThread({ comments: [comment(alice, 'Open.'), comment(bob, 'Re.')] });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([t]);

    const replyBox = () =>
      cardFor(t).querySelector('.slot-b .face-detail textarea') as HTMLTextAreaElement;
    expect(replyBox().closest('[inert]')).not.toBeNull();

    // Activating the caret is a plain click — which is exactly what Enter and
    // Space raise on a <button>, so this is the keyboard path.
    click(cardFor(t).querySelector('.thread-caret') as HTMLElement);
    panel.setActive(t.id); // what onThreadClick does in the real chrome
    expect(replyBox().closest('[inert]')).toBeNull();
  });

  it('has ONE resolve control, outside both folding slots, identical in both states', () => {
    const t = makeThread({ comments: [comment(alice, 'Open.')] });
    const { panel, cardFor, calls } = mountPanel();
    panel.setThreads([t]);

    const collapsed = cardFor(t).querySelector('.thread-resolve') as HTMLButtonElement;
    expect(cardFor(t).querySelectorAll('.thread-resolve')).toHaveLength(1);
    expect(collapsed.closest('.thread-slot')).toBeNull();
    expect(collapsed.getAttribute('aria-label')).toBe('Resolve thread');
    const collapsedClass = collapsed.className;

    panel.setActive(t.id);
    const expandedCard = cardFor(t);
    expect(expandedCard.classList.contains('expanded')).toBe(true);
    const expanded = expandedCard.querySelector('.thread-resolve') as HTMLButtonElement;
    expect(expandedCard.querySelectorAll('.thread-resolve')).toHaveLength(1);
    expect(expanded.className).toBe(collapsedClass);
    expect(expanded.closest('.thread-slot')).toBeNull();

    click(expanded);
    expect(calls.resolve).toEqual([t.id]);
    expect(calls.click).toEqual([]); // a button never doubles as a card tap
  });

  it('offers Reopen on a resolved thread instead of Resolve', () => {
    const t = makeThread({ status: 'resolved', comments: [comment(alice, 'Open.')] });
    const { panel, cardFor, calls } = mountPanel();
    panel.setThreads([t]);
    panel.setTab('resolved');

    const btn = cardFor(t).querySelector('.thread-resolve') as HTMLButtonElement;
    expect(btn.getAttribute('aria-label')).toBe('Reopen thread');
    click(btn);
    expect(calls.reopen).toEqual([t.id]);
  });
});

describe('thread card — the whole card is the tap target', () => {
  const openThread = () => makeThread({ comments: [comment(alice, 'Open.'), comment(bob, 'Re.')] });

  it('toggles from a tap anywhere on the card, including the comment bodies', () => {
    const t = openThread();
    const { panel, cardFor, calls } = mountPanel();
    panel.setThreads([t]);
    const card = cardFor(t);

    click(card.querySelector('.thread-topic') as HTMLElement);
    click(card.querySelector('.face-detail .comments .body') as HTMLElement);
    click(card.querySelector('.thread-caret') as HTMLElement);
    expect(calls.click).toEqual([t.id, t.id, t.id]);
  });

  it('does not toggle from an input, textarea, select, button, anchor or label', () => {
    const t = openThread();
    const { panel, cardFor, calls } = mountPanel();
    panel.setThreads([t]);
    const card = cardFor(t);

    // Positive control first: a plain tap on this card really does toggle.
    click(card);
    expect(calls.click).toHaveLength(1);
    calls.click.length = 0;

    const host = card.querySelector('.thread-actions') as HTMLElement;
    for (const tag of ['input', 'textarea', 'select', 'button', 'a', 'label']) {
      const el = document.createElement(tag);
      host.appendChild(el);
      click(el);
      el.remove();
    }
    // ...and a tap on something NESTED inside one of them (a span in a button).
    const btn = card.querySelector('.thread-actions button') as HTMLElement;
    const inner = document.createElement('span');
    btn.appendChild(inner);
    click(inner);

    expect(calls.click).toEqual([]);
  });

  it('does not collapse the card out from under a text selection being dragged', () => {
    const t = openThread();
    const { panel, cardFor, calls } = mountPanel();
    panel.setThreads([t]);
    const card = cardFor(t);
    const body = card.querySelector('.face-detail .comments .body') as HTMLElement;

    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
    } as unknown as Selection);
    click(body);
    expect(calls.click).toEqual([]);

    // Positive control: the same tap with a collapsed selection DOES toggle,
    // so the assertion above is about the selection and nothing else.
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: true,
    } as unknown as Selection);
    click(body);
    expect(calls.click).toEqual([t.id]);
  });

  it('announces every selection change, so the anchor highlight can follow the fold', () => {
    const t = openThread();
    const active: Array<string | null> = [];
    const { panel, cardFor } = mountPanel({ onActiveChange: (id) => active.push(id) });
    panel.setThreads([t]);

    // Positive control: selecting DOES announce, so the null below is about
    // the collapse and not about a callback that never fires at all.
    panel.setActive(t.id);
    expect(active).toEqual([t.id]);

    // Tapping the open card folds it. Nothing else tells the editor that no
    // thread is selected any more, so without this the anchor stays lit.
    click(cardFor(t).querySelector('.face-detail .comments .body') as HTMLElement);
    expect(active).toEqual([t.id, null]);
    expect(panel.getActive()).toBeNull();
  });
});

describe('thread card — the resting face is hidden, not just transparent', () => {
  it('keeps the face nobody can see out of the tab order and out of the a11y tree', () => {
    const t = makeThread({ comments: [comment(alice, 'Open.'), comment(bob, 'Reply.')] });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([t]);

    const faces = (card: HTMLElement, cls: string) =>
      Array.from(card.querySelectorAll<HTMLElement>(`.thread-face.${cls}`));

    // Collapsed: the detail face (which holds the reply box) is inert.
    for (const f of faces(cardFor(t), 'face-detail')) {
      expect(f.getAttribute('aria-hidden')).toBe('true');
      expect(f.hasAttribute('inert')).toBe(true);
    }
    for (const f of faces(cardFor(t), 'face-summary')) {
      expect(f.hasAttribute('inert')).toBe(false);
      expect(f.hasAttribute('aria-hidden')).toBe(false);
    }

    // Expanded: exactly the other way round — a screen reader must not read
    // the topic line and the message it became as two separate things.
    panel.setActive(t.id);
    for (const f of faces(cardFor(t), 'face-summary')) {
      expect(f.hasAttribute('inert')).toBe(true);
    }
    for (const f of faces(cardFor(t), 'face-detail')) {
      expect(f.hasAttribute('inert')).toBe(false);
    }
  });
});

describe('thread card — resting slot heights', () => {
  /** happy-dom has no layout, so hand the faces the heights a browser would. */
  function stubFaceHeights(card: HTMLElement): void {
    for (const face of Array.from(card.querySelectorAll<HTMLElement>('.thread-face'))) {
      Object.defineProperty(face, 'offsetHeight', {
        configurable: true,
        get: () => (face.classList.contains('face-detail') ? 90 : 20),
      });
    }
  }

  it('measures the VISIBLE face, so the slot is never left at zero height', () => {
    const t = makeThread({ comments: [comment(alice, 'Open.'), comment(bob, 'Reply.')] });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([t]);
    stubFaceHeights(cardFor(t));

    // Re-render at the measured heights: collapsed reads the summary faces.
    panel.setTab('all');
    stubFaceHeights(cardFor(t));
    sizeThreadSlots(cardFor(t));
    for (const slot of Array.from(cardFor(t).querySelectorAll<HTMLElement>('.thread-slot'))) {
      expect(slot.style.height).toBe('20px');
    }

    panel.setActive(t.id);
    stubFaceHeights(cardFor(t));
    sizeThreadSlots(cardFor(t));
    for (const slot of Array.from(cardFor(t).querySelectorAll<HTMLElement>('.thread-slot'))) {
      expect(slot.style.height).toBe('90px');
    }
  });
});

describe('thread card — repaint', () => {
  it('repaints when only the anchor snippet changed (the topic line is keyed on it)', () => {
    const first = makeThread({
      anchor: { kind: 'element', fingerprint: undefined as never, snippet: { text: 'before' } },
      comments: [comment(alice, 'Open.')],
    });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([first]);
    expect(text(cardFor(first).querySelector('.thread-topic'))).toBe('before');

    // Same id, same status, same commentCount, same lastActivity — ONLY the
    // snippet moved, which is exactly what a doc edit does to it.
    const edited: Thread = {
      ...first,
      anchor: { kind: 'element', fingerprint: undefined as never, snippet: { text: 'after' } },
    };
    panel.setThreads([edited]);
    expect(text(cardFor(edited).querySelector('.thread-topic'))).toBe('after');
  });
});

describe('thread card — a declared Review Item', () => {
  const declared = (over: Partial<Comment['review']> = {}): Comment['review'] => ({
    shape: 'review',
    headline: 'Read the new onboarding copy',
    why: 'Ships Tuesday and nobody outside the team has read it.',
    ...over,
  });

  // This used to assert a two-line banner above the opening message, on the
  // stated grounds that "the pane is collapsed most of the time, so the
  // declaration has to be legible from the card face". That reason was never
  // true of the code: the banner was built into slot A's DETAIL face, which a
  // folded card does not show (`.face-summary` below is the collapsed face,
  // and it holds the topic line and nothing else). What the banner did do was
  // state the kind, the headline and the why immediately above an item card
  // saying all three again.
  it('states the opening declaration once — in the item card, not as a banner too', () => {
    const opening = { ...comment(alice, 'Draft is up.'), review: declared() };
    const t = makeThread({ comments: [opening] });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([t]);
    const card = cardFor(t);
    const slotA = card.querySelector('.thread-slot.slot-a') as HTMLElement;
    expect(slotA.querySelector('.comment-review')).toBeNull();
    // Slot A still carries the words the author wrote.
    expect(text(slotA.querySelector('.face-detail .thread-message'))).toBe('Draft is up.');
    // The ask itself is the item card's, in full.
    const item = card.querySelector('.thread-item-card') as HTMLElement;
    expect(text(item.querySelector('.thread-item-k'))).toBe('Question');
    expect(text(item.querySelector('.thread-item-headline'))).toBe('Read the new onboarding copy');
    expect(text(item.querySelector('.thread-item-body'))).toContain(
      'Ships Tuesday and nobody outside the team has read it.',
    );
  });

  it('marks a declared REPLY and leaves the ordinary ones alone', () => {
    const t = makeThread({
      // The opening comment is slot A's; `.comments` holds the REPLIES, so
      // this needs three to have an ordinary reply to contrast against.
      comments: [
        comment(alice, 'Started on this.'),
        comment(bob, 'Picked it up.'),
        { ...comment(bob, 'Both screens exist now.'), review: declared({ shape: 'decision' }) },
      ],
    });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([t]);
    const card = cardFor(t);
    const rows = [...card.querySelectorAll('.face-detail .comments .comment')];
    // A thread can start as a status note and become a review item later, so
    // the mark is per comment.
    expect(rows.map((r) => r.className.includes('comment-declared'))).toEqual([false, true]);
    // The KIND is stated by the item card that carries this declaration, and
    // not a second time by the history row sitting under it.
    expect(rows[1]?.querySelector('.comment-review-k')).toBeNull();
    expect(text(card.querySelector('.thread-item-card .thread-item-k'))).toBe('Decision');
  });

  it('renders no header at all on a thread nobody declared anything on', () => {
    const t = makeThread({ comments: [comment(alice, 'Just a note.'), comment(bob, 'Ack.')] });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([t]);
    const card = cardFor(t);
    expect(card.querySelector('.comment-review')).toBeNull();
    // Positive control: the card really rendered, so the absence above is not
    // an empty page.
    expect(text(card.querySelector('.face-detail .thread-message'))).toBe('Just a note.');
  });
});

describe('thread card — a thread that carries a review item IS the review item', () => {
  const asked = (over: Partial<NonNullable<Comment['review']>> = {}): Comment['review'] => ({
    shape: 'review',
    headline: 'Read the stall rota',
    why: 'It goes out **Thursday**.',
    lookFor: 'Ordering and missing stalls.',
    detail: 'Draft at [the doc](https://example.test/rota).',
    ...over,
  });
  const declaredComment = (review: Comment['review']): Comment => ({
    ...comment(bob, 'Posted the rota draft.'),
    review,
  });

  it('renders the full item card first, then the history label, then the earlier comments', () => {
    const t = makeThread({
      comments: [declaredComment(asked()), comment(alice, 'Looking now.')],
    });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([t]);
    panel.setActive(t.id);

    const face = cardFor(t).querySelector('.slot-b .face-detail') as HTMLElement;
    const kids = Array.from(face.children).map((el) => el.className.split(' ')[0]);
    expect(kids).toEqual(['thread-item-card', 'thread-history-label', 'comments']);
    expect(text(face.querySelector('.thread-history-label'))).toBe('Earlier in this thread');
    // The answer composer is part of the item interface, inside the card.
    expect(face.querySelector('.thread-item-card .thread-reply textarea')).not.toBeNull();
  });

  it('spells the head row: kind chip, headline, asked-by meta — and one markdown body', () => {
    const t = makeThread({ comments: [declaredComment(asked())] });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([t]);
    panel.setActive(t.id);

    const card = cardFor(t).querySelector('.thread-item-card') as HTMLElement;
    // New UI text says Question; the class token stays `review` (stored
    // vocabulary is unchanged by the rename in flight).
    const chip = card.querySelector('.thread-item-k') as HTMLElement;
    expect(text(chip)).toBe('Question');
    expect(chip.classList.contains('thread-item-k-review')).toBe(true);
    expect(text(card.querySelector('.thread-item-headline'))).toBe('Read the stall rota');
    expect(text(card.querySelector('.thread-item-meta'))).toMatch(/^Asked by Bob .+ ago$/);
    // why + lookFor + detail, composed into ONE body, rendered as markdown.
    const body = card.querySelector('.thread-item-body') as HTMLElement;
    expect(text(body)).toContain('Ordering and missing stalls.');
    expect(body.querySelector('strong')?.textContent).toBe('Thursday');
    expect(body.querySelector('a')?.getAttribute('href')).toBe('https://example.test/rota');
  });

  it('says Decision on a decision and offers its options as whole-row buttons', () => {
    const t = makeThread({
      comments: [
        declaredComment(
          asked({
            shape: 'decision',
            options: [
              { id: 'o1', label: 'Ship it', detail: 'As drafted.' },
              { id: 'o2', label: 'Hold' },
            ],
          }),
        ),
      ],
    });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([t]);
    panel.setActive(t.id);

    const card = cardFor(t).querySelector('.thread-item-card') as HTMLElement;
    expect(text(card.querySelector('.thread-item-k'))).toBe('Decision');
    const options = Array.from(card.querySelectorAll<HTMLButtonElement>('.thread-item-option'));
    expect(options).toHaveLength(2);
    expect(text(options[0]?.querySelector('.thread-item-option-label') ?? null)).toBe('Ship it');
    expect(text(options[0]?.querySelector('.thread-item-option-detail') ?? null)).toBe(
      'As drafted.',
    );
    expect(options[1]?.querySelector('.thread-item-option-detail')).toBeNull();
  });

  it('renders the answered record in place once settled, and a plain Reply after the history', () => {
    const t = makeThread({
      comments: [
        declaredComment(
          asked({ answeredAt: ts, answeredBy: 'Alice', answerText: 'Order is *fine*.' }),
        ),
        comment(alice, 'Order is fine.'),
      ],
    });
    const { panel, cardFor } = mountPanel(); // currentUser is Alice
    panel.setThreads([t]);
    panel.setActive(t.id);

    const face = cardFor(t).querySelector('.slot-b .face-detail') as HTMLElement;
    const kids = Array.from(face.children).map((el) => el.className.split(' ')[0]);
    expect(kids).toEqual(['thread-item-card', 'thread-history-label', 'comments', 'thread-reply']);

    const record = face.querySelector('.thread-item-card .thread-answered') as HTMLElement;
    expect(text(record)).toContain('Answered by you:');
    expect(record.querySelector('.thread-answer-words em')?.textContent).toBe('fine');
    // Settled: no options, no composer inside the card — the plain Reply
    // outside it is the one way to keep talking.
    expect(face.querySelectorAll('.thread-item-option')).toHaveLength(0);
    expect(face.querySelector('.thread-item-card textarea')).toBeNull();
    const send = face.querySelector('.thread-reply .thread-actions button') as HTMLElement;
    expect(text(send)).toBe('Reply');
  });

  it('names the answerer when it was somebody else, and falls back to the tapped option label', () => {
    const t = makeThread({
      comments: [
        declaredComment(
          asked({
            shape: 'decision',
            options: [
              { id: 'o1', label: 'Ship it' },
              { id: 'o2', label: 'Hold' },
            ],
            answeredAt: ts,
            answeredBy: 'Cara',
            answeredWith: 'o2',
          }),
        ),
      ],
    });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([t]);
    panel.setActive(t.id);
    const record = cardFor(t).querySelector('.thread-answered') as HTMLElement;
    expect(text(record)).toContain('Answered by Cara:');
    expect(text(record.querySelector('.thread-answer-words'))).toBe('Hold');
  });

  it('skips the history label when the declaring comment is the whole thread', () => {
    const t = makeThread({ comments: [declaredComment(asked())] });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([t]);
    panel.setActive(t.id);
    expect(cardFor(t).querySelector('.thread-history-label')).toBeNull();
    expect(cardFor(t).querySelector('.thread-item-card')).not.toBeNull();
  });

  it('leaves a thread with no declaration exactly as it was — comments, then the reply box', () => {
    const t = makeThread({ comments: [comment(alice, 'A note.'), comment(bob, 'Ack.')] });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([t]);
    panel.setActive(t.id);
    const face = cardFor(t).querySelector('.slot-b .face-detail') as HTMLElement;
    const kids = Array.from(face.children).map((el) => el.className.split(' ')[0]);
    expect(kids).toEqual(['comments', 'thread-reply']);
    expect(face.querySelector('.thread-item-card')).toBeNull();
    expect(face.querySelector('.thread-history-label')).toBeNull();
  });

  it('keeps the collapsed faces as they were — the item card lives only in the detail face', () => {
    const t = makeThread({
      comments: [declaredComment(asked()), comment(alice, 'Looking now.')],
    });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([t]);
    const card = cardFor(t); // collapsed

    // Slot A's summary face is still just the topic line — which is also why
    // dropping the duplicated declared header from slot A costs a collapsed
    // card nothing: that header was never on the face a folded card shows.
    const slotASummary = card.querySelector('.slot-a .face-summary') as HTMLElement;
    expect(Array.from(slotASummary.children).map((el) => el.className.split(' ')[0])).toEqual([
      'thread-topic',
    ]);
    expect(card.querySelector('.slot-a .comment-review')).toBeNull();
    // Slot B's summary face carries no card either — the sidebar and mobile
    // inline reads are unchanged.
    expect(card.querySelector('.face-summary .thread-item-card')).toBeNull();
    expect(card.querySelectorAll('.thread-item-card')).toHaveLength(1);
    expect(card.querySelector('.thread-item-card')?.closest('.face-detail')).not.toBeNull();
  });
});
