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

describe('thread card — the collapsed card is two lines', () => {
  it('leads line one with the topic and who started it, and line two with the discussion', () => {
    const t = makeThread({
      comments: [comment(alice, 'Why is the retry count fixed?'), comment(bob, 'Because of X.')],
    });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([t]);
    const card = cardFor(t);

    // Line one: the head, and it is NOT a folding face — it stays put when
    // the card opens, which is what makes opening read as growth rather than
    // as a second panel appearing under a row that repeats itself.
    const head = card.querySelector('.thread-head') as HTMLElement;
    expect(head.closest('.thread-slot')).toBeNull();
    expect(text(head.querySelector('.thread-topic'))).toBe('the anchor');
    expect(text(head.querySelector('.thread-who'))).toBe('Alice');
    expect(head.querySelector('.thread-glyph')).not.toBeNull();

    // Line two is the ONE folding slot, and both of its faces exist at once —
    // the morph cross-fades between them, so neither may be built lazily.
    const slots = Array.from(card.querySelectorAll('.thread-slot'));
    expect(slots).toHaveLength(1);
    const slot = slots[0] as HTMLElement;
    expect(slot.classList.contains('slot-a')).toBe(true);
    expect(slot.querySelector('.thread-face.face-summary')).not.toBeNull();
    expect(slot.querySelector('.thread-face.face-detail')).not.toBeNull();

    expect(text(slot.querySelector('.face-summary .thread-discussion'))).toContain('Because of X.');
    expect(text(slot.querySelector('.face-detail .comments'))).toContain('Because of X.');
    expect(text(slot.querySelector('.face-detail .thread-message'))).toBe(
      'Why is the retry count fixed?',
    );
    expect(slot.querySelector('.face-detail textarea')).not.toBeNull();
  });

  it('carries nothing on the folded card that a folded line has no job for', () => {
    // Each of these cost a row and answered none of the four jobs in the
    // card module's header, and each was removed by name in round 2 of the
    // mocks. A positive control follows, so an empty card would not pass.
    const t = makeThread({ comments: [comment(alice, 'Open.'), comment(bob, 'Reply.')] });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([t]);
    const card = cardFor(t);

    expect(card.querySelector('.thread-meta')).toBeNull(); // no reply count
    expect(card.querySelector('.thread-flag-row')).toBeNull(); // no decision tag
    expect(card.querySelector('.thread-participants')).toBeNull();
    expect(card.querySelector('.thread-new-tag')).toBeNull();
    expect(card.querySelector('.status-dot')).toBeNull();
    // Resolve exists, but only inside the fold — see the resolve suite below.
    expect(card.querySelector('.face-summary .thread-resolve')).toBeNull();

    // POSITIVE CONTROL: the two lines this card DOES carry are both there,
    // so the nulls above are about what was removed and not about a card
    // that failed to render.
    expect(text(card.querySelector('.thread-topic'))).not.toBe('');
    expect(text(card.querySelector('.face-summary .thread-discussion'))).not.toBe('');
  });

  it('names the starter as exactly the name, with the separator beside it', () => {
    // The hub's activity feed and the task panel read `.thread-who` for the
    // name on its own; a card that folded " · Alice" into that node would
    // hand them a name with punctuation in it.
    const t = makeThread({ comments: [comment(alice, 'Open.')] });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([t]);
    const card = cardFor(t);

    expect(text(card.querySelector('.thread-who'))).toBe('Alice');
    expect(text(card.querySelector('.thread-sep'))).toBe('·');
    // …and the whole line reads as one phrase.
    expect(text(card.querySelector('.thread-topic-line'))).toBe('the anchor · Alice');
  });

  it('never repeats the author name in the opening message — line one is its attribution', () => {
    const t = makeThread({ comments: [comment(alice, 'Opening thought.')] });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([t]);
    const card = cardFor(t);

    // Positive control: the name IS on the card, exactly once, on line one.
    expect(text(card.querySelector('.thread-head'))).toContain('Alice');
    expect(card.querySelectorAll('.thread-head .name')).toHaveLength(1);

    const msg = card.querySelector('.face-detail .thread-message') as HTMLElement;
    expect(text(msg)).toBe('Opening thought.');
    expect(msg.textContent).not.toContain('Alice');
    // Opened, the attribution moves under line one as its own meta row — the
    // folded card's "· Alice" and this are the same fact in the two places it
    // has room to live.
    expect(text(card.querySelector('.face-detail .thread-asked-meta'))).toContain('Alice');
  });

  it('drops line two on a thread with no replies rather than filling it', () => {
    const withReply = makeThread({
      id: 'has-reply',
      comments: [comment(alice, 'Question?'), comment(bob, 'Answer.')],
    });
    const alone = makeThread({ id: 'no-reply', comments: [comment(alice, 'Question?')] });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([withReply, alone]);

    // Positive control: a real discussion line does render when there IS a
    // reply — so the absence below is the suppression and not a dead probe.
    const a = cardFor(withReply);
    expect(text(a.querySelector('.face-summary .thread-discussion'))).toContain('Answer.');

    const b = cardFor(alone);
    expect(b.querySelector('.thread-topic')).not.toBeNull();
    expect(b.querySelector('.face-summary .thread-discussion')).toBeNull();
    expect(b.textContent).not.toContain('No replies yet');
  });

  it('folds to one line when there is nothing to put on line two', () => {
    // Every one of these used to carry "No replies yet" — a plain comment
    // nobody had answered, and a RESOLVED one, where it was the last thing
    // said about a finished thread. An empty summary face is what makes the
    // folded card one line, and `sizeThreadSlots` writes its zero (see
    // below); the guard that refuses a zero is for a face WITH children.
    const empty: Thread[] = [
      makeThread({ id: 's1', comments: [comment(alice, 'Alone.')] }),
      makeThread({ id: 's3', status: 'resolved', comments: [comment(alice, 'Done.')] }),
    ];
    const populated = makeThread({
      id: 's2',
      comments: [comment(alice, 'A.'), comment(bob, 'B.')],
    });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([...empty, populated]);
    panel.setTab('all');
    for (const t of empty) {
      expect((cardFor(t).querySelector('.face-summary') as HTMLElement).childElementCount).toBe(0);
    }
    // Control: a thread that HAS something to say still says it, so the zero
    // above is about the content and not about the render.
    expect(
      (cardFor(populated).querySelector('.face-summary') as HTMLElement).childElementCount,
    ).toBeGreaterThan(0);
  });

  it('sizes an empty summary face to zero, and still refuses a populated face’s zero', () => {
    // The two halves of one rule. Before this, `sizeThreadSlots` refused
    // every zero it measured, because the only zero it could ever see came
    // from a subtree that was not being laid out. A card with nothing on line
    // two now measures zero truthfully, and a slot left at its last good
    // height would carry a blank second row under a one-line card.
    const alone = makeThread({ id: 'z1', comments: [comment(alice, 'Alone.')] });
    const withReply = makeThread({ id: 'z2', comments: [comment(alice, 'A.'), comment(bob, 'B.')] });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([alone, withReply]);

    // happy-dom has no layout, so every offsetHeight is already 0 — which is
    // exactly the measurement both branches have to be told apart under.
    const slotOf = (t: Thread) => cardFor(t).querySelector('.thread-slot') as HTMLElement;
    const populated = slotOf(withReply);
    populated.style.height = '24px';
    sizeThreadSlots(document);

    expect(slotOf(alone).style.height).toBe('0px');
    // The original bug, rebuilt: this face HAS children, so its zero is the
    // not-laid-out case and the last good height survives.
    expect(populated.style.height).toBe('24px');
    expect(
      (cardFor(withReply).querySelector('.face-summary') as HTMLElement).childElementCount,
    ).toBeGreaterThan(0);
  });
});

describe('thread card — untrusted text', () => {
  it('renders an author name as text, never as HTML', () => {
    const evil: User = { ...bob, name: '<img src=x onerror="alert(1)">' };
    const t = makeThread({ comments: [comment(evil, 'Open.'), comment(alice, 'Reply.')] });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([t]);

    const card = cardFor(t);
    // Positive control: the probe can see an injected tag when there is one.
    card.querySelector('.thread-topic')?.insertAdjacentHTML('beforeend', '<img data-probe>');
    expect(card.querySelectorAll('img[data-probe]')).toHaveLength(1);
    expect(card.querySelectorAll('img:not([data-probe])')).toHaveLength(0);
    expect(text(card.querySelector('.thread-who'))).toContain('<img src=x');
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
    // Caret on line one, resolve at the bottom of the fold — not adjacent,
    // and not even on the same face while the card is closed.
    const resolve = card.querySelector('.thread-foot .thread-resolve') as HTMLElement;
    expect(resolve).not.toBeNull();
    expect(resolve.closest('.thread-face.face-detail')).not.toBeNull();
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
      cardFor(t).querySelector('.slot-a .face-detail textarea') as HTMLTextAreaElement;
    expect(replyBox().closest('[inert]')).not.toBeNull();

    // Activating the caret is a plain click — which is exactly what Enter and
    // Space raise on a <button>, so this is the keyboard path.
    click(cardFor(t).querySelector('.thread-caret') as HTMLElement);
    panel.setActive(t.id); // what onThreadClick does in the real chrome
    expect(replyBox().closest('[inert]')).toBeNull();
  });

  it('has ONE resolve control, and only inside the fold', () => {
    const t = makeThread({ comments: [comment(alice, 'Open.')] });
    const { panel, cardFor, calls } = mountPanel();
    panel.setThreads([t]);

    // Folded, Resolve is present but on the face nobody can see or reach —
    // deliberately: it used to sit a thumb-width from the chevron, and the
    // misfire that costs you is the one that closes somebody's thread.
    const collapsedCard = cardFor(t);
    expect(collapsedCard.querySelectorAll('.thread-resolve')).toHaveLength(1);
    const collapsed = collapsedCard.querySelector('.thread-resolve') as HTMLButtonElement;
    expect(collapsed.closest('.thread-face.face-detail')).not.toBeNull();
    expect(collapsed.closest('[inert]')).not.toBeNull();
    expect(collapsed.getAttribute('aria-label')).toBe('Resolve thread');
    const collapsedClass = collapsed.className;

    panel.setActive(t.id);
    const expandedCard = cardFor(t);
    expect(expandedCard.classList.contains('expanded')).toBe(true);
    const expanded = expandedCard.querySelector('.thread-resolve') as HTMLButtonElement;
    expect(expandedCard.querySelectorAll('.thread-resolve')).toHaveLength(1);
    // Same element and same class in both states, so opening never swaps it
    // for a different button.
    expect(expanded.className).toBe(collapsedClass);
    expect(expanded.closest('[inert]')).toBeNull();

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
    detail: 'Ships Tuesday and nobody outside the team has read it.',
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
    // The headline is line ONE of the card, and the item card below it does
    // not print it a second time.
    expect(text(card.querySelector('.thread-head .thread-topic'))).toBe(
      'Read the new onboarding copy',
    );
    expect(item.querySelector('.thread-item-headline')).toBeNull();
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
    detail:
      'It goes out **Thursday**. Ordering and missing stalls. Draft at [the doc](https://example.test/rota).',
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

    const face = cardFor(t).querySelector('.slot-a .face-detail') as HTMLElement;
    const kids = Array.from(face.children).map((el) => el.className.split(' ')[0]);
    // The opened card reads top-down: the summary line it grew out of, who
    // asked and when, what they wrote, then the item interface, then the
    // history under a plain "Comments" heading, then the one resolve control.
    expect(kids).toEqual([
      'thread-discussion',
      'thread-asked-meta',
      'thread-message',
      'thread-item-card',
      'thread-history-label',
      'comments',
      'thread-foot',
    ]);
    // A plain heading with no reply count anywhere on the card (Bryan,
    // round 2: "no reply-count line").
    expect(text(face.querySelector('.thread-history-label'))).toBe('Comments');
    expect(face.querySelector('.thread-meta')).toBeNull();
    // The answer composer is part of the item interface, inside the card.
    expect(face.querySelector('.thread-item-card .thread-reply textarea')).not.toBeNull();
    // ...and the item card does not re-attribute an ask the line above it
    // already attributed.
    expect(face.querySelectorAll('.thread-item-meta')).toHaveLength(0);
  });

  it('spells the head row: kind chip and one markdown body, nothing said twice', () => {
    const t = makeThread({ comments: [declaredComment(asked())] });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([t]);
    panel.setActive(t.id);

    const whole = cardFor(t);
    const card = whole.querySelector('.thread-item-card') as HTMLElement;
    // New UI text says Question; the class token stays `review` (stored
    // vocabulary is unchanged by the rename in flight).
    const chip = card.querySelector('.thread-item-k') as HTMLElement;
    expect(text(chip)).toBe('Question');
    expect(chip.classList.contains('thread-item-k-review')).toBe(true);
    // The headline is line one of the card, and the asked-by line sits under
    // it — so the item card repeats neither. It used to print both, which put
    // the ask in two sizes and the asker twice on one open card.
    expect(card.querySelector('.thread-item-headline')).toBeNull();
    expect(card.querySelector('.thread-item-meta')).toBeNull();
    expect(text(whole.querySelector('.thread-asked-meta'))).toMatch(/^Bob · \S/);
    // The ONE body, rendered as markdown.
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

    const face = cardFor(t).querySelector('.slot-a .face-detail') as HTMLElement;
    const kids = Array.from(face.children).map((el) => el.className.split(' ')[0]);
    expect(kids).toEqual([
      'thread-discussion',
      'thread-asked-meta',
      'thread-message',
      'thread-item-card',
      'thread-history-label',
      'comments',
      'thread-reply',
      'thread-foot',
    ]);

    const record = face.querySelector('.thread-item-card .thread-answered') as HTMLElement;
    // A labelled outcome, then who settled it — not one sentence with the
    // outcome buried mid-way through it.
    expect(text(record.querySelector('.thread-decision-label'))).toBe('Answer');
    expect(record.querySelector('.thread-answer-words em')?.textContent).toBe('fine');
    expect(text(record.querySelector('.thread-answered-meta'))).toMatch(
      /^Answered by you \d+ \w+ ago$/,
    );
    // The item it settles is still whole above it — a decided card keeps the
    // question exactly as it was asked, headline on line one and detail in
    // the body.
    expect(text(face.querySelector('.thread-item-k'))).not.toBe('');
    expect(face.querySelector('.thread-item-body')).not.toBeNull();
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
    // A DECISION says "Decision" and "Decided by", following the same shape
    // the card's kind chip reads — a question above would say Answer.
    expect(text(record.querySelector('.thread-decision-label'))).toBe('Decision');
    expect(text(record.querySelector('.thread-answered-meta'))).toMatch(
      /^Decided by Cara \d+ \w+ ago$/,
    );
    expect(text(record.querySelector('.thread-answer-words'))).toBe('Hold');
  });

  it('a settled record with no recorded clock keeps the line and drops only the time', () => {
    // Records written before `answeredAt` existed: naming a time we do not
    // have would be inventing one.
    const t = makeThread({
      comments: [
        declaredComment(
          asked({ shape: 'decision', answeredBy: 'Cara', answerText: 'Ship it', answeredAt: ts }),
        ),
      ],
    });
    // An option tapped before `answeredAt` existed — `answeredWith` alone is
    // what marks it settled (see `reviewAnswered`).
    const legacy = makeThread({
      // Its own id — `makeThread` defaults every thread to `t1`, and two
      // cards sharing one id is how the control below reads the wrong card.
      id: 't2',
      comments: [
        declaredComment(
          asked({
            shape: 'decision',
            options: [{ id: 'o1', label: 'Ship it' }],
            answeredBy: 'Cara',
            answeredWith: 'o1',
          }),
        ),
      ],
    });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([t, legacy]);
    // Control: the one that HAS a clock prints it, so a missing time below is
    // a fact about the payload and not about the assertion.
    panel.setActive(t.id);
    expect(text(cardFor(t).querySelector('.thread-answered-meta'))).toMatch(/ago$/);
    panel.setActive(legacy.id);
    expect(text(cardFor(legacy).querySelector('.thread-answered-meta'))).toBe('Decided by Cara');
  });

  it('skips the history label when the declaring comment is the whole thread', () => {
    const t = makeThread({ comments: [declaredComment(asked())] });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([t]);
    panel.setActive(t.id);
    expect(cardFor(t).querySelector('.thread-history-label')).toBeNull();
    expect(cardFor(t).querySelector('.thread-item-card')).not.toBeNull();
  });

  it('heads the history "Comments" on an undeclared thread too, and adds no item card', () => {
    const t = makeThread({ comments: [comment(alice, 'A note.'), comment(bob, 'Ack.')] });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([t]);
    panel.setActive(t.id);
    const face = cardFor(t).querySelector('.slot-a .face-detail') as HTMLElement;
    const kids = Array.from(face.children).map((el) => el.className.split(' ')[0]);
    expect(kids).toEqual([
      'thread-discussion',
      'thread-asked-meta',
      'thread-message',
      'thread-history-label',
      'comments',
      'thread-reply',
      'thread-foot',
    ]);
    expect(face.querySelector('.thread-item-card')).toBeNull();
    // One heading for the history everywhere, declared or not — it is the
    // same conversation either way.
    expect(text(face.querySelector('.thread-history-label'))).toBe('Comments');
  });

  it('keeps the collapsed faces as they were — the item card lives only in the detail face', () => {
    const t = makeThread({
      comments: [declaredComment(asked()), comment(alice, 'Looking now.')],
    });
    const { panel, cardFor } = mountPanel();
    panel.setThreads([t]);
    const card = cardFor(t); // collapsed

    // The folded face is line two and the row that answers it — never the
    // item card, and never a second copy of the declared header. That header
    // was never on the face a folded card shows.
    const summary = card.querySelector('.slot-a .face-summary') as HTMLElement;
    expect(Array.from(summary.children).map((el) => el.className.split(' ')[0])).toEqual([
      'thread-discussion',
      'thread-answer-cta',
    ]);
    expect(card.querySelector('.face-summary .comment-review')).toBeNull();
    // …and line one carries the ask's headline rather than the sentence it
    // hangs off, which is the whole reason a declared card reads at a glance.
    expect(text(card.querySelector('.thread-topic'))).toBe('Read the stall rota');
    expect(card.querySelector('.face-summary .thread-item-card')).toBeNull();
    expect(card.querySelectorAll('.thread-item-card')).toHaveLength(1);
    expect(card.querySelector('.thread-item-card')?.closest('.face-detail')).not.toBeNull();
  });
});
