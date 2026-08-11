import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { TextRange } from '../src/anchor/index.ts';
import { createThread, getContent, listThreads, markOrphan, postReply } from '../src/schema.ts';
import {
  DISCUSSION_MAX,
  NO_REPLIES_TEXT,
  SUMMARY_PENDING_TEXT,
  SUMMARY_PENDING_WINDOW_MS,
  summaryHash,
  summaryKey,
  summaryPending,
  threadSummary,
} from '../src/thread-summary.ts';
import type { Thread, User } from '../src/types.ts';

const alex: User = { id: 'u-alex', name: 'Alex', kind: 'known', color: '#2e7dd7' };
const sam: User = { id: 'u-sam', name: 'Sam', kind: 'known', color: '#e36f1e' };
const jordan: User = { id: 'u-jordan', name: 'Jordan', kind: 'known', color: '#8957e5' };

/**
 * Build a thread the way production builds one: a real Y.Doc, a real
 * text-range anchor (so the snippet goes through the real truncation), the
 * real `createThread` / `postReply` writers, and the real `readThread` reader.
 * Hand-written Thread literals would let the builder pass against a shape
 * nothing ever produces.
 */
function makeThread(opts: {
  docText: string;
  /** [start, end] offsets into docText the thread anchors to. */
  range: [number, number];
  author: User;
  first: string;
  replies?: Array<{ author: User; text: string }>;
  orphan?: boolean;
}): Thread {
  const doc = new Y.Doc();
  const ytext = getContent(doc);
  ytext.insert(0, opts.docText);
  const anchor = TextRange.createFromOffsets(ytext, opts.range[0], opts.range[1]);

  createThread(doc, {
    threadId: 't1',
    anchor,
    createdBy: opts.author,
    firstComment: { id: 'c0', text: opts.first },
  });
  opts.replies?.forEach((r, i) => {
    postReply(doc, 't1', { id: `c${i + 1}`, author: r.author, text: r.text });
  });
  if (opts.orphan) markOrphan(doc, 't1');

  const t = listThreads(doc)[0];
  if (!t) throw new Error('fixture thread not readable');
  return t;
}

const DOC =
  'The retry loop swallows the underlying error and gives up quietly.\nSecond line here.\n';

describe('threadSummary', () => {
  describe('the two lines', () => {
    it('takes the topic from the anchor snippet as stored', () => {
      const t = makeThread({
        docText: DOC,
        range: [0, 20],
        author: alex,
        first: 'We should rethrow on the last attempt.',
      });
      const s = threadSummary(t);
      // Positive control: the fixture really does carry that snippet.
      expect(t.anchor.kind === 'text-range' && t.anchor.snippet.text).toBe('The retry loop swall');
      expect(s.topic).toBe('The retry loop swall');
    });

    it('takes the topic from the ORIGINAL snippet when the anchor orphaned', () => {
      const t = makeThread({
        docText: DOC,
        range: [0, 14],
        author: alex,
        first: 'Still relevant?',
        orphan: true,
      });
      expect(t.anchor.kind).toBe('orphan');
      expect(threadSummary(t).topic).toBe('The retry loop');
    });

    it("takes the discussion line from the LATEST comment's opening words", () => {
      const t = makeThread({
        docText: DOC,
        range: [0, 14],
        author: alex,
        first: 'The retry loop swallows the underlying error.',
        replies: [
          { author: sam, text: 'Do we keep the fallback path at all?' },
          { author: jordan, text: 'Keep it — two callers depend on the degraded response.' },
        ],
      });
      const s = threadSummary(t);
      expect(s.discussionKind).toBe('replies');
      expect(s.discussion).toBe('Keep it — two callers depend on the degraded response.');
    });

    it('collapses newlines and clips a long latest comment at a word boundary', () => {
      const long = `${'wordy '.repeat(40)}tail`;
      const t = makeThread({
        docText: DOC,
        range: [0, 14],
        author: alex,
        first: 'opening',
        replies: [{ author: sam, text: `first line\n\n${long}` }],
      });
      const s = threadSummary(t);
      expect(s.discussion.length).toBeLessThanOrEqual(DISCUSSION_MAX);
      expect(s.discussion).not.toContain('\n');
      expect(s.discussion.startsWith('first line wordy')).toBe(true);
      expect(s.discussion.endsWith('…')).toBe(true);
      // Clipped at a word boundary — no half word before the ellipsis.
      expect(s.discussion).not.toMatch(/wor…$/);
    });

    it('falls back to the opening message when the anchor snippet is empty', () => {
      const t = makeThread({
        docText: DOC,
        range: [5, 5],
        author: alex,
        first: 'Jitter is missing from the backoff.',
      });
      expect(t.anchor.kind === 'text-range' && t.anchor.snippet.text).toBe('');
      expect(threadSummary(t).topic).toBe('Jitter is missing from the backoff.');
    });
  });

  describe('a thread with no replies', () => {
    it('still yields both lines, with the literal no-replies discussion state', () => {
      const t = makeThread({
        docText: DOC,
        range: [0, 14],
        author: jordan,
        first: 'No jitter here, so failures retry in lockstep.',
      });
      const s = threadSummary(t);
      expect(s.topic).toBe('The retry loop');
      expect(s.discussion).toBe(NO_REPLIES_TEXT);
      expect(s.discussion).toBe('No replies yet');
      expect(s.discussionKind).toBe('none');
      // Never borrows the opening comment for the discussion line.
      expect(s.discussion).not.toContain('jitter');
      expect(s.participants).toBeNull();
    });

    it('reports no replies when every reply is blank', () => {
      const t = makeThread({
        docText: DOC,
        range: [0, 14],
        author: jordan,
        first: 'opening',
        replies: [{ author: sam, text: '   ' }],
      });
      const s = threadSummary(t);
      expect(s.discussionKind).toBe('none');
      expect(s.discussion).toBe(NO_REPLIES_TEXT);
    });
  });

  describe('participants', () => {
    it('names exactly one replier', () => {
      const t = makeThread({
        docText: DOC,
        range: [0, 14],
        author: sam,
        first: 'Is the timeout per attempt?',
        replies: [{ author: alex, text: 'Per attempt.' }],
      });
      const p = threadSummary(t).participants;
      expect(p?.repliers.map((u) => u.name)).toEqual(['Alex']);
      expect(p?.label).toEqual({ kind: 'named', name: 'Alex', text: 'Alex replied' });
      // The swatch colour rides along with the replier.
      expect(p?.repliers[0]?.color).toBe('#2e7dd7');
    });

    it('counts two or more repliers instead of naming them', () => {
      const t = makeThread({
        docText: DOC,
        range: [0, 14],
        author: alex,
        first: 'The retry loop swallows the error.',
        replies: [
          { author: sam, text: 'Agreed.' },
          { author: jordan, text: 'Keep it.' },
        ],
      });
      const p = threadSummary(t).participants;
      expect(p?.repliers.map((u) => u.name)).toEqual(['Sam', 'Jordan']);
      expect(p?.label).toEqual({ kind: 'count', count: 2, text: '+2 others' });
    });

    it('dedupes a repeat replier and keeps first-appearance order', () => {
      const t = makeThread({
        docText: DOC,
        range: [0, 14],
        author: alex,
        first: 'opening',
        replies: [
          { author: jordan, text: 'one' },
          { author: sam, text: 'two' },
          { author: jordan, text: 'three' },
        ],
      });
      const p = threadSummary(t).participants;
      expect(p?.repliers.map((u) => u.id)).toEqual(['u-jordan', 'u-sam']);
      expect(p?.label).toEqual({ kind: 'count', count: 2, text: '+2 others' });
    });

    it('excludes the thread author even when they reply to themselves', () => {
      const t = makeThread({
        docText: DOC,
        range: [0, 14],
        author: alex,
        first: 'opening',
        replies: [{ author: alex, text: 'Actually, on reflection, drop the fallback.' }],
      });
      const s = threadSummary(t);
      // No participants row — nobody else has spoken…
      expect(s.participants).toBeNull();
      // …but the thread DOES have a discussion, so the discussion line is real.
      expect(s.discussionKind).toBe('replies');
      expect(s.discussion).toBe('Actually, on reflection, drop the fallback.');
    });

    it('treats a same-name different-id replier as a distinct person', () => {
      const otherAlex: User = { id: 'anon-9', name: 'Alex', kind: 'anon', color: '#2da44e' };
      const t = makeThread({
        docText: DOC,
        range: [0, 14],
        author: alex,
        first: 'opening',
        replies: [{ author: otherAlex, text: 'different person, same display name' }],
      });
      const p = threadSummary(t).participants;
      expect(p?.repliers.map((u) => u.id)).toEqual(['anon-9']);
      expect(p?.label).toEqual({ kind: 'named', name: 'Alex', text: 'Alex replied' });
    });
  });

  describe('untrusted input', () => {
    const XSS = '<img src=x onerror="alert(1)">';

    it('returns names and text verbatim — data, never HTML, never pre-escaped', () => {
      const evil: User = { id: 'u-evil', name: XSS, kind: 'anon', color: '#000000' };
      const t = makeThread({
        docText: `${XSS} and more text after it`,
        range: [0, XSS.length],
        author: alex,
        first: 'opening',
        replies: [{ author: evil, text: `reply ${XSS}` }],
      });
      const s = threadSummary(t);
      // Positive control: the payload really is in the fixture.
      expect(t.comments[1]?.author.name).toBe(XSS);
      expect(t.anchor.kind === 'text-range' && t.anchor.snippet.text).toContain('<img');

      // Verbatim: no escaping (the DOM builder uses textContent), and no
      // markup of our own wrapped around it.
      expect(s.topic).toBe(XSS);
      expect(s.discussion).toBe(`reply ${XSS}`);
      expect(s.participants?.label).toEqual({
        kind: 'named',
        name: XSS,
        text: `${XSS} replied`,
      });
      expect(s.topic).not.toContain('&lt;');
      expect(s.topic).not.toContain('<span');
    });
  });

  describe('purity', () => {
    it('is deterministic and does not mutate the thread', () => {
      const t = makeThread({
        docText: DOC,
        range: [0, 14],
        author: alex,
        first: 'opening',
        replies: [{ author: sam, text: 'a reply' }],
      });
      const before = JSON.stringify(t);
      const a = threadSummary(t);
      const b = threadSummary(t);
      expect(a).toEqual(b);
      expect(JSON.stringify(t)).toBe(before);
    });
  });
});

/**
 * Three surfaces cache a rendered card and repaint only when their key moves.
 * Each of them used to key on `topic` alone, which was right only because the
 * other values happen to move with the comment count today. The contract is
 * the whole block: change anything the card SHOWS, and the key changes.
 */
describe('summaryKey', () => {
  const base = {
    docText: DOC,
    range: [4, 14] as [number, number],
    author: alex,
    first: 'The error is swallowed here.',
  };

  it('moves when the topic does', () => {
    const a = summaryKey(makeThread(base));
    const b = summaryKey(makeThread({ ...base, range: [30, 45] }));
    expect(b).not.toBe(a);
  });

  it('moves when the discussion line does, at an identical reply count', () => {
    const a = makeThread({ ...base, replies: [{ author: sam, text: 'Keep the fallback.' }] });
    const b = makeThread({ ...base, replies: [{ author: sam, text: 'Drop the fallback.' }] });
    // The two threads are otherwise indistinguishable to a caller's key: same
    // anchor, same author, same number of comments.
    expect(b.commentCount).toBe(a.commentCount);
    expect(summaryKey(b)).not.toBe(summaryKey(a));
  });

  it('moves when the participants row does, at an identical reply count', () => {
    const a = makeThread({ ...base, replies: [{ author: sam, text: 'Agreed.' }] });
    const b = makeThread({ ...base, replies: [{ author: jordan, text: 'Agreed.' }] });
    expect(b.commentCount).toBe(a.commentCount);
    expect(summaryKey(b)).not.toBe(summaryKey(a));
  });

  it('holds still when nothing the card shows has changed', () => {
    const opts = { ...base, replies: [{ author: sam, text: 'Agreed.' }] };
    expect(summaryKey(makeThread(opts))).toBe(summaryKey(makeThread(opts)));
  });
});

/**
 * The window between a comment landing and the regenerated summary syncing
 * back used to flash the raw fallback lines, which read as the feature
 * breaking. When a collector stamps `summaryPending`, the card says it is
 * generating instead — and the stamp itself is time-bounded so a failed
 * generation degrades back to the fallback lines rather than a stuck spinner.
 */
describe('summaryPending', () => {
  const base = {
    docText: DOC,
    range: [4, 14] as [number, number],
    author: alex,
    first: 'The error is swallowed here.',
  };
  const NOW = 1_000_000;
  const fresh = (t: Thread): Thread => ({ ...t, lastActivity: NOW - 1_000 });
  const old = (t: Thread): Thread => ({ ...t, lastActivity: NOW - SUMMARY_PENDING_WINDOW_MS });

  it('is pending right after activity on a thread with no current summary', () => {
    expect(summaryPending(fresh(makeThread(base)), { enabled: true, now: NOW })).toBe(true);
  });

  it('never pends when generation is off — a summary that will never come', () => {
    expect(summaryPending(fresh(makeThread(base)), { enabled: false, now: NOW })).toBe(false);
  });

  it('never pends when the stored summary is current', () => {
    const t = fresh(makeThread(base));
    t.summary = { topic: 'T', discussion: 'D', hash: summaryHash(t) };
    expect(summaryPending(t, { enabled: true, now: NOW })).toBe(false);
  });

  it('pends when the stored summary went stale (a reply changed the hash)', () => {
    const t = fresh(makeThread({ ...base, replies: [{ author: sam, text: 'New reply.' }] }));
    t.summary = { topic: 'T', discussion: 'D', hash: 'deadbeef' };
    expect(summaryPending(t, { enabled: true, now: NOW })).toBe(true);
  });

  it('expires: an old stale thread is NOT pending (failed call degrades, not spins)', () => {
    expect(summaryPending(old(makeThread(base)), { enabled: true, now: NOW })).toBe(false);
  });

  it('renders the generating line: deterministic topic, pending discussion', () => {
    const t = fresh(makeThread(base));
    t.summaryPending = true;
    const s = threadSummary(t);
    expect(s.topic).toBe(threadSummary(makeThread(base)).topic); // topic unchanged
    expect(s.discussion).toBe(SUMMARY_PENDING_TEXT);
    expect(s.discussionKind).toBe('pending');
  });

  it('a CURRENT stored summary beats a (mistaken) pending stamp', () => {
    const t = fresh(makeThread({ ...base, replies: [{ author: sam, text: 'Yes.' }] }));
    t.summary = { topic: 'Real topic', discussion: 'Real state', hash: summaryHash(t) };
    t.summaryPending = true;
    const s = threadSummary(t);
    expect(s.topic).toBe('Real topic');
    expect(s.discussion).toBe('Real state');
  });

  it('moves summaryKey, so every cached card repaints on the flip', () => {
    const t = makeThread(base);
    const a = summaryKey(t);
    const b = summaryKey({ ...t, summaryPending: true });
    expect(b).not.toBe(a);
  });
});

describe('a malformed anchor', () => {
  /* Anchors are read back out of the ydoc as opaque JSON — `collectThreads`
     casts and does not validate. Since the topic line joined every surface's
     render key, a throw in here stops being one broken card and becomes a
     panel that renders nothing at all. */
  it('falls back to the opening message instead of throwing', () => {
    const t = makeThread({
      docText: DOC,
      range: [4, 14],
      author: alex,
      first: 'The error is swallowed here.',
    });
    const broken = { ...t, anchor: { kind: 'element' } as unknown as Thread['anchor'] };

    expect(() => summaryKey(broken)).not.toThrow();
    expect(threadSummary(broken).topic).toBe('The error is swallowed here.');
  });
});
