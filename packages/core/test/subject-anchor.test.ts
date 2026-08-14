/**
 * A thread about the SUBJECT rather than about a span inside it.
 *
 * Every anchor kind so far points INTO a document: a text range, a DOM
 * element, or the memory of one that has gone (orphan). There was no way to
 * say "this comment is about the thing itself" — which is the only kind of
 * comment a hub task can carry, because a task's discussion is about the
 * task, and a freshly created task's description is empty, so there is
 * nothing in it to point at. `create_thread` requires a `find` string and
 * `POST /api/docs/<id>/threads` requires an anchor, so neither a person nor
 * an agent could open that discussion at all.
 *
 * The invariant that earns this its own kind: a subject anchor can never
 * break, so it must never be orphaned. Orphaning is how a thread gets
 * filtered out of the surfaces that show anchored comments, and a task
 * discussion that vanishes because someone rewrote the description would be
 * the store-has-it/surface-can't-show-it failure again.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createThread, listThreads, markOrphan } from '../src/schema.ts';
import type { TextRangeAnchor } from '../src/types.ts';

const threadById = (doc: Y.Doc, id: string) => listThreads(doc).find((t) => t.id === id);

const AUTHOR = { id: 'known-jordan', name: 'Jordan', kind: 'known' as const, color: '#4488cc' };

const textAnchor = (): TextRangeAnchor => ({
  kind: 'text-range',
  startRel: new Uint8Array([1, 2, 3]),
  endRel: new Uint8Array([4, 5, 6]),
  snippet: { text: 'the second paragraph' },
});

const open = (doc: Y.Doc, id: string, anchor: Parameters<typeof createThread>[1]['anchor']) =>
  createThread(doc, {
    threadId: id,
    anchor,
    createdBy: AUTHOR,
    firstComment: { id: `c-${id}`, text: 'why is this here?' },
  });

describe('subject anchors', () => {
  it('opens a thread with no span to point at', () => {
    const doc = new Y.Doc();
    const t = open(doc, 't-1', { kind: 'subject' });
    expect(t.anchor.kind).toBe('subject');
    expect(t.comments).toHaveLength(1);
    expect(listThreads(doc)).toHaveLength(1);
  });

  it('survives a round trip through the doc, kind intact', () => {
    const doc = new Y.Doc();
    open(doc, 't-1', { kind: 'subject' });
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    expect(threadById(other, 't-1')?.anchor.kind).toBe('subject');
  });

  // The invariant. A subject anchor points at the thing the thread is on,
  // which cannot stop existing while the thread does.
  it('is NEVER orphaned — there is nothing for it to lose', () => {
    const doc = new Y.Doc();
    open(doc, 't-1', { kind: 'subject' });
    const after = markOrphan(doc, 't-1');
    expect(after?.anchor.kind).toBe('subject');
  });

  // Positive control for the test above: markOrphan is reached, and it really
  // does orphan the kind that CAN break. Without this, "still subject" would
  // pass just as well against a markOrphan that did nothing at all.
  it('POSITIVE CONTROL: a text-range anchor in the same doc still orphans', () => {
    const doc = new Y.Doc();
    open(doc, 't-1', { kind: 'subject' });
    open(doc, 't-2', textAnchor());
    expect(markOrphan(doc, 't-2')?.anchor.kind).toBe('orphan');
    expect(threadById(doc, 't-1')?.anchor.kind).toBe('subject');
  });
});
