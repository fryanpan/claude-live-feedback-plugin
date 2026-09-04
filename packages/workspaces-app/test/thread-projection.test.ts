/**
 * The one reader that turns this document's ydoc into the `Thread[]` every
 * review surface renders.
 *
 * It matters that this has a test of its own rather than only being reached
 * through a mounted chrome: it hand-builds each `Thread` field by field, so a
 * field the server can write, sync and persist is invisible to the whole app
 * the moment it is missing from THIS list — which is exactly how `summary`
 * first shipped broken (docs/process/learnings.md). Every assertion below
 * drives `createThreadProjection` directly and reads what came out.
 */
import { createThread, postReply, summaryHash } from '@feedback/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { createSeenTracker } from '../src/comment-seen.ts';
import { type ThreadDecoration, createThreadProjection } from '../src/doc/thread-projection.ts';
import type { ReviewSurface } from '../src/review-surface.ts';

const AUTHOR = { id: 'u1', name: 'Ann', kind: 'known', color: '#2e7dd7' } as const;

/** A text-range anchor whose relative positions the fake surface below reads
 *  straight back as absolute ones — so a test can say where a thread sits. */
function range(from: number, to: number) {
  return {
    kind: 'text-range' as const,
    startRel: new Uint8Array([from]),
    endRel: new Uint8Array([to]),
    snippet: { text: 'anchored words' },
  };
}

/** The byte a range uses to say "this anchor no longer resolves". */
const GONE = 255;

interface Recorded {
  ranges: ThreadDecoration[];
  activeId: string | null;
}

function fakeSurface(opts: { lines?: boolean } = {}) {
  const recorded: Recorded[] = [];
  const surface = {
    resolveRel: (start: Uint8Array, end: Uint8Array) =>
      start[0] === GONE ? null : { from: start[0] as number, to: end[0] as number },
    setThreadRanges: (ranges: ThreadDecoration[], activeId: string | null) => {
      recorded.push({ ranges, activeId });
    },
    // Two document positions per line, so pos 4 and 5 share line 2.
    ...(opts.lines ? { lineForPos: (pos: number) => Math.floor(pos / 2) + 1 } : {}),
  } as unknown as Pick<ReviewSurface, 'resolveRel' | 'setThreadRanges' | 'lineForPos'>;
  return { surface, recorded, last: () => recorded[recorded.length - 1] };
}

/** A tracker whose storage already holds a record, so this is NOT a first
 *  visit and an unseen thread reads as new (see comment-seen.ts). */
function returningReader(docId = 'd1') {
  const store = new Map<string, string>([[`lf:seen:${docId}`, '{"threads":{}}']]);
  return createSeenTracker({
    docId,
    storage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => {
        store.set(k, v);
      },
    },
  });
}

function projectionOver(ydoc: Y.Doc, opts: { lines?: boolean } = {}) {
  const surface = fakeSurface(opts);
  const onPendingExpiry = vi.fn();
  const projection = createThreadProjection({
    ydoc,
    surface: surface.surface,
    seen: returningReader(),
    onPendingExpiry,
  });
  return { projection, onPendingExpiry, ...surface };
}

describe('the ydoc → Thread[] projection', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('carries the comments, their count and the last activity', () => {
    const ydoc = new Y.Doc();
    createThread(ydoc, {
      threadId: 't1',
      anchor: range(2, 6),
      createdBy: AUTHOR,
      firstComment: { id: 'c1', text: 'Why is this swallowed?' },
    });
    const reply = postReply(ydoc, 't1', {
      id: 'c2',
      author: AUTHOR,
      text: 'The retry wrapper eats it.',
    });

    const { projection } = projectionOver(ydoc);
    const [t] = projection.collect();

    expect(t?.id).toBe('t1');
    expect(t?.status).toBe('open');
    expect(t?.createdBy).toEqual(AUTHOR);
    expect(t?.comments.map((c) => c.text)).toEqual([
      'Why is this swallowed?',
      'The retry wrapper eats it.',
    ]);
    expect(t?.commentCount).toBe(2);
    expect(t?.lastActivity).toBe(reply?.ts);
  });

  it('carries a comment’s review payload, which is what makes the thread an item', () => {
    const ydoc = new Y.Doc();
    createThread(ydoc, {
      threadId: 't1',
      anchor: range(0, 3),
      createdBy: AUTHOR,
      firstComment: {
        id: 'c1',
        text: 'Ship it Tuesday or Thursday?',
        review: { shape: 'review', headline: 'Does this read right?' },
      },
    });

    const { projection } = projectionOver(ydoc);
    expect(projection.collect()[0]?.comments[0]?.review).toMatchObject({
      shape: 'review',
      headline: 'Does this read right?',
    });
  });

  it('carries a stored summary through — the one field whose loss is invisible', () => {
    const ydoc = new Y.Doc();
    createThread(ydoc, {
      threadId: 't1',
      anchor: range(0, 1),
      createdBy: AUTHOR,
      firstComment: { id: 'c1', text: 'Why is this swallowed?' },
    });
    // A reply, because the discussion line is what a generated summary
    // replaces — a thread with none stays deterministic.
    postReply(ydoc, 't1', { id: 'c2', author: AUTHOR, text: 'The wrapper eats it.' });
    const threadMap = ydoc.getMap('threads').get('t1') as Y.Map<unknown>;
    // Stamped as generating, so the assertions below also pin the branch that
    // takes the card back OUT of "Generating summary…": `summaryPending` reads
    // `t.summary`, so a projection that drops the field leaves every card
    // spinning until the window runs out and then shows the fallback lines
    // forever. Both symptoms are invisible to every other test in this file.
    threadMap.set('summaryPendingTs', Date.now());

    const { projection } = projectionOver(ydoc);
    const before = projection.collect()[0];
    if (!before) throw new Error('no thread projected');
    expect(before.summary).toBeUndefined(); // positive control: nothing stored yet
    expect(before.summaryPending).toBe(true);

    const stored = {
      topic: 'The retry wrapper swallows it',
      discussion: 'Ann traced it to the wrapper.',
      hash: summaryHash(before),
      promptVersion: 3,
    };
    threadMap.set('summary', stored);

    const t = projection.collect()[0];
    expect(t?.summary).toEqual(stored);
    expect(t?.summaryPending).toBeUndefined();
  });

  it('shows an unresolvable range as orphaned without touching what is stored', () => {
    const ydoc = new Y.Doc();
    const stored = range(GONE, GONE);
    createThread(ydoc, {
      threadId: 't1',
      anchor: stored,
      createdBy: AUTHOR,
      firstComment: { id: 'c1', text: 'gone' },
    });

    const { projection } = projectionOver(ydoc);
    const [t] = projection.collect();

    expect(t?.anchor.kind).toBe('orphan');
    // The recover flow needs the original back, and the CRDT must still hold it.
    expect((t?.anchor as { original: unknown }).original).toMatchObject({ kind: 'text-range' });
    const persisted = (ydoc.getMap('threads').get('t1') as Y.Map<unknown>).get('anchor') as {
      kind: string;
    };
    expect(persisted.kind).toBe('text-range');
    expect(projection.resolveRange('t1')).toBeNull();
  });

  it('pushes one decoration per resolvable thread and remembers the active one', () => {
    const ydoc = new Y.Doc();
    createThread(ydoc, {
      threadId: 'here',
      anchor: range(4, 9),
      createdBy: AUTHOR,
      firstComment: { id: 'c1', text: 'a' },
    });
    createThread(ydoc, {
      threadId: 'lost',
      anchor: range(GONE, GONE),
      createdBy: AUTHOR,
      firstComment: { id: 'c2', text: 'b' },
    });

    const { projection, last } = projectionOver(ydoc);
    expect(projection.activeThreadId()).toBeNull();

    projection.refreshDecorations('here');

    expect(last()?.activeId).toBe('here');
    expect(last()?.ranges).toEqual([
      { id: 'here', from: 4, to: 9, status: 'open', kind: 'comment', isNew: true },
    ]);
    expect(projection.activeThreadId()).toBe('here');
  });

  it('marks a thread seen, clears its dot in place, and refuses an unknown id', () => {
    const ydoc = new Y.Doc();
    createThread(ydoc, {
      threadId: 't1',
      anchor: range(1, 2),
      createdBy: AUTHOR,
      firstComment: { id: 'c1', text: 'a' },
    });
    document.body.innerHTML =
      '<li class="thread is-new" data-thread-id="t1"><span class="thread-new-tag">new</span></li>';

    const { projection, last } = projectionOver(ydoc);
    const card = document.querySelector('.thread') as HTMLElement;

    expect(projection.markSeen('nope')).toBe(false);
    expect(card.classList.contains('is-new')).toBe(true); // positive control

    expect(projection.markSeen('t1')).toBe(true);
    expect(card.classList.contains('is-new')).toBe(false);
    expect(card.querySelector('.thread-new-tag')).toBeNull();
    // The highlight carries the same dot, so it repaints from here too.
    expect(last()?.ranges[0]?.isNew).toBe(false);

    // Already seen: nothing changed, so no repaint is claimed.
    expect(projection.markSeen('t1')).toBe(false);
  });

  it('labels a line range only where the surface has lines', () => {
    const ydoc = new Y.Doc();
    createThread(ydoc, {
      threadId: 'one',
      anchor: range(4, 5),
      createdBy: AUTHOR,
      firstComment: { id: 'c1', text: 'a' },
    });
    createThread(ydoc, {
      threadId: 'many',
      anchor: range(4, 9),
      createdBy: AUTHOR,
      firstComment: { id: 'c2', text: 'b' },
    });

    const lined = projectionOver(ydoc, { lines: true }).projection;
    expect(lined.lineLabel('one')).toBe('L3');
    expect(lined.lineLabel('many')).toBe('L3–5');
    expect(lined.lineLabel('missing')).toBeNull();

    // Prose has no lines at all — the card shows no location chip.
    expect(projectionOver(ydoc).projection.lineLabel('one')).toBeNull();
  });

  describe('a summary the server says is being generated', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    function pendingDoc(): Y.Doc {
      const ydoc = new Y.Doc();
      createThread(ydoc, {
        threadId: 't1',
        anchor: range(0, 1),
        createdBy: AUTHOR,
        firstComment: { id: 'c1', text: 'Why is this swallowed?' },
      });
      // A reply, because the discussion line is what a summary would replace:
      // a thread with none stays deterministic and is never pending.
      postReply(ydoc, 't1', { id: 'c2', author: AUTHOR, text: 'The wrapper eats it.' });
      (ydoc.getMap('threads').get('t1') as Y.Map<unknown>).set('summaryPendingTs', Date.now());
      return ydoc;
    }

    it('flags the thread and repaints once the window has run out', () => {
      const { projection, onPendingExpiry } = projectionOver(pendingDoc());

      expect(projection.collect()[0]?.summaryPending).toBe(true);
      expect(onPendingExpiry).not.toHaveBeenCalled();

      // Expiry is a CLOCK event, not a doc event: nothing else would ever take
      // the "generating…" state off the card.
      vi.advanceTimersByTime(60_000);
      expect(onPendingExpiry).toHaveBeenCalledTimes(1);
      expect(projection.collect()[0]?.summaryPending).toBeUndefined();
    });

    it('stops the timer on teardown so it cannot repaint the doc we left', () => {
      const { projection, onPendingExpiry } = projectionOver(pendingDoc());
      projection.collect();

      projection.clearPendingExpiry();
      vi.advanceTimersByTime(60_000);

      expect(onPendingExpiry).not.toHaveBeenCalled();
    });
  });
});
