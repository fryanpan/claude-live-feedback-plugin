import type { Comment, ReviewPayload, Thread, User } from '@feedback/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThreadPanel } from '../src/threads.ts';
import { PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The compact comment card (Bryan, 2026-09-04, on mock round 4).
 *
 * A folded card is two lines of topic and two lines of thread summary, who
 * started it and when, the kind glyph and a chevron — and then whatever the
 * reader can press. **The control is the marking**: a row of option buttons IS
 * a decision and a field with a send button IS a question, so the "DECIDE" and
 * "ANSWER" chips that used to name them said nothing the reader could not
 * already see. The reply count, the "No replies yet" line and the "Details ▾"
 * caption go with them: a row that reports an absence, or restates the fold it
 * sits above, is a row spent saying nothing.
 *
 * These are behaviour tests. Each one names a thing a reader can do or read,
 * and each fails on the shipped card that PR 647 replaced and PR 664 restored.
 */

const alice: User = { id: 'u1', name: 'Alice', kind: 'known', color: '#2e7dd7' };
const bryan: User = { id: 'u2', name: 'Bryan', kind: 'known', color: '#b25e09' };

let ts = 1_700_000_000_000;
function comment(text: string, review?: ReviewPayload, author: User = alice): Comment {
  ts += 1000;
  return { id: `c${ts}`, author, text, ts, ...(review ? { review } : {}) };
}

function thread(comments: Comment[], over: Partial<Thread> = {}): Thread {
  return {
    id: 't1',
    status: 'open',
    anchor: { kind: 'element', fingerprint: undefined as never, snippet: { text: 'anchor' } },
    commentCount: comments.length,
    lastActivity: comments[comments.length - 1]?.ts ?? ts,
    createdBy: alice,
    comments,
    ...over,
  };
}

const decision = (over: Partial<ReviewPayload> = {}): ReviewPayload => ({
  shape: 'decision',
  headline: 'Pick a tick clock',
  options: [
    { id: 'a', label: 'Cadence ceiling', detail: 'A tick fires at most every 45 s.' },
    { id: 'b', label: 'Pause threshold', detail: 'A tick fires after 8 s of silence.' },
  ],
  ...over,
});

const question = (over: Partial<ReviewPayload> = {}): ReviewPayload => ({
  shape: 'review',
  headline: 'Should the strip stay after the meeting ends?',
  ...over,
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
});

/** Build the card through the panel, so `statusOf` is the real derivation. */
function renderVia(t: Thread, over: Record<string, unknown> = {}) {
  const r = render(t, over);
  r.panel.setThreads([t]);
  const card = r.panel.renderThread(t);
  r.card.replaceWith(card);
  return { ...r, card };
}

function render(t: Thread, over: Record<string, unknown> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  cleanups.push(() => container.remove());
  const onReply = vi.fn(() => true);
  const panel = new ThreadPanel({
    container,
    currentUser: bryan,
    onThreadClick: () => {},
    onReply,
    onResolve: () => {},
    onReopen: () => {},
    onReanchor: () => {},
    ...over,
  });
  const card = panel.renderThread(t);
  container.appendChild(card);
  return { card, panel, onReply };
}

/** Everything a reader can actually read on the folded card. */
const foldedText = (card: HTMLElement): string =>
  [
    card.querySelector('.thread-head')?.textContent ?? '',
    card.querySelector('.slot-a .face-summary')?.textContent ?? '',
    card.querySelector('.slot-b .face-summary')?.textContent ?? '',
  ].join(' ');

describe('the folded card carries no chip naming its kind', () => {
  it('a pending decision is marked by its options, not by a "Decision needed" flag', () => {
    const { card } = render(thread([comment('Which clock?', decision())]));
    expect(card.querySelector('.thread-flag-row')).toBe(null);
    expect(card.querySelector('.thread-decision-flag')).toBe(null);
    expect(foldedText(card)).not.toMatch(/decision/i);
    // What replaced it: the options themselves, on the folded face.
    const opts = card.querySelectorAll('.slot-b .face-summary .thread-item-option-compact');
    expect(Array.from(opts).map((o) => o.textContent)).toEqual([
      'Cadence ceiling',
      'Pause threshold',
    ]);
  });

  it('a pending question is marked by its answer field, not by an "Answer" caption', () => {
    const { card } = render(thread([comment('Well?', question())]));
    expect(card.querySelector('.thread-answer-cta')).toBe(null);
    expect(foldedText(card)).not.toMatch(/^\s*Answer\s*$/m);
  });

  it('the chevron is a chevron on every card — no "Details ▾" caption', () => {
    const declared = render(thread([comment('Well?', question())]));
    expect(declared.card.querySelector('.thread-caret')?.textContent).toBe('›');
    expect(declared.card.querySelector('.thread-caret-words')).toBe(null);
    const plain = render(thread([comment('Looks fine.')]));
    expect(plain.card.querySelector('.thread-caret')?.textContent).toBe('›');
  });
});

describe('the folded card carries no count and reports no absence', () => {
  it('a thread with three replies never states how many', () => {
    const { card } = render(
      thread([comment('Opening'), comment('One'), comment('Two'), comment('Three')]),
    );
    expect(foldedText(card)).not.toMatch(/\breply\b|\breplies\b/i);
    expect(card.querySelector('.thread-meta')).toBe(null);
  });

  it('a thread with no replies has no discussion line at all', () => {
    const { card } = render(thread([comment('Just this one')]));
    expect(foldedText(card)).not.toMatch(/no replies/i);
    expect(card.querySelector('.slot-b .face-summary .thread-discussion')).toBe(null);
  });
});

describe('who started it and when, top right of the head', () => {
  it('the head carries the OPENING comment’s clock, not the thread’s last activity', () => {
    const opening = comment('Opening');
    const later = comment('A reply four days on');
    later.ts = opening.ts + 4 * 24 * 60 * 60 * 1000;
    const { card } = render(thread([opening, later], { lastActivity: later.ts }));
    const head = card.querySelector('.thread-head');
    const time = head?.querySelector('.thread-time');
    expect(time).not.toBe(null);
    // The head's clock has to be the one that moved with the OPENING comment:
    // reading `lastActivity` would put the reply's age beside the author of
    // the message that started the thread.
    expect(time?.textContent).not.toBe('');
    // Last thing in the head bar the chevron.
    const kids = Array.from(head?.children ?? []);
    expect(kids[kids.length - 1]?.classList.contains('thread-caret')).toBe(true);
    expect(kids[kids.length - 2]).toBe(time);
  });

  it('the status dot is gone — the glyph is the only state marker', () => {
    const { card } = render(thread([comment('Hi')]));
    expect(card.querySelector('.status-dot')).toBe(null);
    expect(card.querySelector('.thread-head .thread-glyph')).not.toBe(null);
  });
});

describe('a pending question answers from its folded face', () => {
  it('the field posts against the declaring comment, and the words survive a refusal', async () => {
    const c = comment('Well?', question());
    const { card, onReply } = render(thread([c]));
    const field = card.querySelector('.slot-b .face-summary .thread-answer-field');
    const input = field?.querySelector<HTMLInputElement>('.thread-answer-input');
    const send = field?.querySelector<HTMLButtonElement>('.thread-answer-send');
    expect(input?.placeholder).toBe('Answer as Bryan…');
    expect(send?.textContent).toBe('Answer');
    if (!input || !send) throw new Error('no answer field');
    input.value = 'Keep it up for a week.';
    send.click();
    // The declaring comment's id rides along — that is what makes it an ANSWER
    // rather than a reply that happens to be under a question.
    expect(onReply).toHaveBeenCalledWith('t1', 'Keep it up for a week.', c.id);
    expect(input.value).toBe('');
  });

  it('a refused post hands the words back to the field', async () => {
    const c = comment('Well?', question());
    const onReply = vi.fn(() => Promise.resolve(false));
    const { card } = render(thread([c]), { onReply });
    const input = card.querySelector<HTMLInputElement>('.thread-answer-input');
    if (!input) throw new Error('no field');
    input.value = 'Yes';
    card.querySelector<HTMLButtonElement>('.thread-answer-send')?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(input.value).toBe('Yes');
  });

  it('an answered question shows none of it — the record replaces the field', () => {
    const { card } = render(
      thread([
        comment('Well?', question({ answeredAt: ts, answeredBy: 'Bryan', answerText: 'Yes.' })),
      ]),
    );
    expect(card.querySelector('.thread-answer-field')).toBe(null);
    expect(card.querySelector('.thread-answered-words')?.textContent).toBe('Yes.');
  });
});

describe('a settled item keeps a tick, the outcome and who decided', () => {
  it('a decision states what was decided — nothing above the head says it any more', () => {
    const { card } = render(
      thread([comment('Which clock?', decision({ answeredAt: ts, answeredWith: 'a' }))]),
    );
    const line = card.querySelector('.slot-b .face-summary .thread-answered-line');
    expect(line?.querySelector('.thread-answered-tick')?.textContent?.trim()).toBe('✓');
    // The words used to ride a flag row above the head, which is gone; this is
    // now the only place a folded card says what was decided.
    expect(line?.querySelector('.thread-answered-words')?.textContent).toBe('Cadence ceiling');
    expect(line?.querySelector('.thread-answered-who')?.textContent).not.toBe('');
    expect(card.querySelector('.thread-decision-outcome')).toBe(null);
    expect(card.querySelector('.thread-options-compact')).toBe(null);
  });
});

describe('✓ Resolve is the last thing in an expanded thread', () => {
  it('the folded card offers no resolve control at all', () => {
    const { card } = render(thread([comment('Hi')]));
    expect(card.querySelector('.face-summary .thread-resolve')).toBe(null);
    // Not a sibling of the slots either — that is where it used to live, one
    // thumb-width from the caret on a face meant only for scanning.
    expect(card.querySelector(':scope > .thread-foot')).toBe(null);
  });

  it('it is the LAST node of slot B’s detail face', () => {
    const { card } = render(thread([comment('Hi'), comment('There')]));
    const detail = card.querySelector('.slot-b .face-detail');
    const last = detail?.lastElementChild;
    expect(last?.classList.contains('thread-foot')).toBe(true);
    expect(last?.querySelector('.thread-resolve')?.textContent).toBe('✓ Resolve');
  });

  it('holds true for a declared thread, below the item card and the composer', () => {
    const { card } = render(thread([comment('Which clock?', decision())]));
    const detail = card.querySelector('.slot-b .face-detail');
    expect(detail?.lastElementChild?.classList.contains('thread-foot')).toBe(true);
  });
});

describe('the expanded faces carry no summary text', () => {
  it('expanding hides the summary face from the reader AND from assistive tech', () => {
    const { card, panel } = render(thread([comment('Opening'), comment('A reply')]));
    panel.setActive('t1');
    for (const face of Array.from(card.querySelectorAll('.face-summary'))) {
      expect(face.hasAttribute('inert')).toBe(true);
      expect(face.getAttribute('aria-hidden')).toBe('true');
    }
    for (const face of Array.from(card.querySelectorAll('.face-detail'))) {
      expect(face.hasAttribute('inert')).toBe(false);
    }
  });

  it('an expanded decision grows each option’s cost inside its own button', () => {
    const { card, panel } = render(thread([comment('Which clock?', decision())]));
    panel.setActive('t1');
    const opts = Array.from(
      card.querySelectorAll<HTMLElement>('.face-detail .thread-item-options .thread-item-option'),
    );
    expect(opts.map((o) => o.querySelector('.thread-item-option-label')?.textContent)).toEqual([
      'Cadence ceiling',
      'Pause threshold',
    ]);
    // The reasoning is a LINE INSIDE the button here, not the title it rides
    // as on the 260px folded face.
    expect(opts[0]?.querySelector('.thread-item-option-detail')?.textContent).toBe(
      'A tick fires at most every 45 s.',
    );
  });

  it('an expanded question has exactly one answer box', () => {
    const { card, panel } = render(thread([comment('Well?', question())]));
    panel.setActive('t1');
    const detail = card.querySelector('.slot-b .face-detail');
    expect(detail?.querySelectorAll('.thread-reply').length).toBe(1);
    // The compact field belongs to the folded face and must not be duplicated
    // into the open one, where the composer is already the way to answer.
    expect(detail?.querySelector('.thread-answer-field')).toBe(null);
  });
});

describe('a closed-out card recedes and keeps the row that says why', () => {
  const resolved = (over: Partial<Thread> = {}) =>
    thread([comment('Two c’s, one r.'), comment('Fixed.')], { status: 'resolved', ...over });

  it('carries no word on the head — the tick, the dimming and the foot already say it', () => {
    const { card } = renderVia(resolved());
    // Four sayings of one fact, and the badge was the only one adding nothing:
    // the glyph is the green tick, the card recedes, the settled line carries
    // the outcome, and the foot reads "✓ Resolved".
    expect(card.querySelector('.thread-tag')).toBe(null);
    expect(foldedText(card)).not.toMatch(/resolved/i);
    expect(card.querySelector('.thread-head .lf-ic-done')).not.toBe(null);
    expect(card.querySelector('.thread-foot .thread-resolve')?.textContent).toBe('✓ Resolved');
  });

  it('an orphan keeps its badge — nothing else on the card can say it', () => {
    const t = thread([comment('Still relevant?')], {
      anchor: { kind: 'orphan', original: { kind: 'element' }, lastSeenAt: ts } as Thread['anchor'],
    });
    const { card } = renderVia(t);
    expect(card.querySelector('.thread-tag')?.textContent).toBe('Orphaned');
  });

  it('a resolved review item still shows its tick and outcome on the folded face', () => {
    // Mock 3 folded a resolved card to one faded line by clipping slot B. Slot
    // B's summary face is where the outcome lives, so the state whose whole
    // point is "here is what was settled" was the one hiding it.
    const { card } = renderVia(
      resolved({
        comments: [
          comment('Which clock?', decision({ answeredAt: ts, answeredWith: 'a' })),
          comment('Done.'),
        ],
      }),
    );
    const line = card.querySelector('.slot-b .face-summary .thread-answered-line');
    expect(line?.querySelector('.thread-answered-words')?.textContent).toBe('Cadence ceiling');
  });

  it('the stylesheet recedes the card without clipping the face that carries it', () => {
    const off = installSheets('styles.css');
    cleanups.push(off);
    setViewport(PHONE);
    const card = attach('thread resolved');
    const slot = attach('thread-slot slot-b', { parent: card });
    expect(styleOf(card).opacity).toBe('0.6');
    expect(styleOf(slot).maxHeight).not.toBe('0px');
  });
});

describe('a withdrawn ask is a dimmed card and one line saying why', () => {
  const withdrawn = (over: Partial<ReviewPayload> = {}) =>
    question({ withdrawnAt: ts, withdrawnBy: 'Workspaces', ...over });

  it('states the reason, and no word repeating "withdrawn"', () => {
    const { card } = renderVia(
      thread([
        comment(
          'Cache the system prompt?',
          withdrawn({
            withdrawnReason:
              'It sits under the 4096-token cache floor, so there is nothing to cache.',
          }),
        ),
      ]),
    );
    expect(card.classList.contains('withdrawn')).toBe(true);
    const gone = card.querySelector('.thread-gone');
    expect(gone?.textContent).toBe(
      'It sits under the 4096-token cache floor, so there is nothing to cache.',
    );
    // Not `clip`: that class is `white-space: nowrap`, and it put an ellipsis
    // through the middle of the reason at 260px — the one row on this card
    // whose whole job is to be read.
    expect(gone?.classList.contains('clip')).toBe(false);
    // The strike-through and the dimming already say it was taken back.
    expect(foldedText(card)).not.toMatch(/withdrawn/i);
    // And it is not still offering the field, which would be an ask again.
    expect(card.querySelector('.thread-answer-field')).toBe(null);
  });

  it('names who took it back when no reason was given', () => {
    const { card } = renderVia(thread([comment('Never mind.', withdrawn())]));
    expect(card.querySelector('.thread-gone')?.textContent).toBe('Taken back by Workspaces.');
  });

  it('a LIVE ask above a withdrawn one wins — the card is a question again', () => {
    // Only the newest declaration decides. A retracted ask under a live one is
    // history, and dimming the card would retire an ask still waiting on
    // somebody.
    const first = comment('Cache the prompt?', withdrawn());
    const second = comment('Cache the transcript instead?', question());
    second.ts = first.ts + 60_000;
    const { card } = renderVia(thread([first, second]));
    expect(card.classList.contains('withdrawn')).toBe(false);
    expect(card.querySelector('.thread-gone')).toBe(null);
    expect(card.querySelector('.slot-b .face-summary .thread-answer-field')).not.toBe(null);
  });
});

describe('the head shows the author’s colour everywhere the row can afford it', () => {
  it('the swatch is built into every card', () => {
    const { card } = render(thread([comment('Hi')]));
    const swatch = card.querySelector<HTMLElement>('.thread-head > .swatch');
    expect(swatch).not.toBe(null);
    expect(swatch?.style.background).not.toBe('');
  });

  it('and the 260px margin column is the one place it stands down', () => {
    const off = installSheets('styles.css');
    cleanups.push(off);
    setViewport({ width: 1180, height: 820 });
    const margin = attach('markup-margin');
    const marginCard = attach('thread', { parent: margin });
    const marginHead = attach('thread-head', { parent: marginCard });
    const hidden = attach('swatch', { tag: 'span', parent: marginHead });
    const looseHead = attach('thread-head');
    const shown = attach('swatch', { tag: 'span', parent: looseHead });
    expect(styleOf(hidden).display).toBe('none');
    expect(styleOf(shown).display).toBe('inline-block');
  });
});

describe('no face of the card names its kind — not even the open one', () => {
  /** The item card, which only exists on the detail face. */
  const openItem = (t: Thread) => {
    const r = render(t);
    r.panel.setActive('t1');
    return r.card.querySelector<HTMLElement>('.face-detail .thread-item-card');
  };

  it('an expanded decision offers its options and never says the word', () => {
    const item = openItem(thread([comment('Which clock?', decision())]));
    expect(item).not.toBe(null);
    expect(item?.querySelector('.thread-item-k')).toBe(null);
    expect(item?.querySelector('.thread-item-head')?.textContent).not.toMatch(/decision/i);
    // Positive control: what says "decision" instead is still there to press.
    const opts = item?.querySelectorAll('.thread-item-options .thread-item-option') ?? [];
    expect(
      Array.from(opts).map((o) => o.querySelector('.thread-item-option-label')?.textContent),
    ).toEqual(['Cadence ceiling', 'Pause threshold']);
  });

  it('an expanded question offers its answer box and never says the word', () => {
    const item = openItem(thread([comment('Well?', question())]));
    expect(item?.querySelector('.thread-item-k')).toBe(null);
    expect(item?.querySelector('.thread-item-head')?.textContent).not.toMatch(/question/i);
    // Positive control: the composer the item card carries while it is pending.
    expect(item?.querySelector('.thread-reply textarea')).not.toBe(null);
  });

  it('the headline and the asked-by line survive the chip’s removal', () => {
    const item = openItem(thread([comment('Which clock?', decision())]));
    expect(item?.querySelector('.thread-item-headline')?.textContent).toBe('Pick a tick clock');
    expect(item?.querySelector('.thread-item-meta')?.textContent).toMatch(/Asked/);
  });
});
