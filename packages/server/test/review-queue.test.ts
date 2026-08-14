import { describe, expect, it } from 'bun:test';
import type { Comment, Thread } from '@feedback/core';
import { awaitingPerson, reviewThreadItems } from '../src/review-queue.ts';

/** All fixtures are synthetic — invented names and ids throughout. */

const T0 = 1_700_000_000_000;

/**
 * `kind: 'person'` also swaps the author ID, because `classifyActor` checks
 * the `agent-` id prefix BEFORE it reads `kind` — deliberately, so an agent
 * cannot file itself as a person. A fixture that kept the agent id and merely
 * relabelled the kind would therefore be an AGENT comment wearing a person's
 * label, and the two tests below would pass while asserting nothing.
 */
function comment(over: Partial<Comment> & { kind?: 'agent' | 'person' } = {}): Comment {
  const { kind, ...rest } = over;
  const person = kind === 'person';
  return {
    id: `c-${(seq += 1)}`,
    author: {
      id: person ? 'person-jordan' : 'agent-helper',
      name: person ? 'Jordan' : 'Helper',
      kind: (kind ?? 'agent') as 'known',
      color: '#000000',
    },
    text: 'anything',
    ts: T0,
    ...rest,
  };
}
let seq = 0;

function thread(over: Partial<Thread> = {}): Thread {
  return {
    id: 't1',
    status: 'open',
    anchor: { kind: 'subject' },
    commentCount: 1,
    lastActivity: T0,
    createdBy: { id: 'agent-helper', name: 'Helper', kind: 'known', color: '#000000' },
    comments: [comment()],
    ...over,
  };
}

describe('awaitingPerson', () => {
  it('reports the agent comment nobody has answered', () => {
    const asked = comment({ text: 'Which of the two should I build?', ts: T0 + 5 });
    expect(awaitingPerson(thread({ comments: [comment({ ts: T0 }), asked] }))?.text).toBe(
      asked.text,
    );
  });

  // The whole queue is "your turn". A person having spoken last is exactly
  // what "not your turn" means, and it is the ONLY thing that takes an item
  // out of the queue — there is no separate dismissed flag to keep in sync.
  it('is silent once a person has answered', () => {
    const answered = thread({
      comments: [comment({ ts: T0 }), comment({ kind: 'person', text: 'the second', ts: T0 + 5 })],
    });
    expect(awaitingPerson(answered)).toBeNull();
  });

  it('is silent on a resolved thread and on an empty one', () => {
    expect(awaitingPerson(thread({ status: 'resolved' }))).toBeNull();
    expect(awaitingPerson(thread({ comments: [] }))).toBeNull();
  });

  // Comment order in the Yjs array is insertion order, which is NOT guaranteed
  // to be timestamp order once two clients post concurrently — a CRDT merges
  // by position, not by clock. Reading "the last element" would then answer a
  // question about array layout rather than about who spoke last.
  it('reads the newest comment by time, not by array position', () => {
    const t = thread({
      comments: [
        comment({ kind: 'agent', text: 'newest', ts: T0 + 90 }),
        comment({ kind: 'person', text: 'older', ts: T0 + 10 }),
      ],
    });
    expect(awaitingPerson(t)?.text).toBe('newest');
  });

  // classifyActor treats an absent `kind` as an agent (see its comment: a
  // person misfiled as an agent only over-filters, the reverse launders the
  // audit log). Pinned here because this queue inherits that judgement rather
  // than making its own.
  it('treats an unlabelled author as an agent, per classifyActor', () => {
    const t = thread({
      comments: [{ ...comment(), author: { ...comment().author, kind: undefined } as never }],
    });
    expect(awaitingPerson(t)).not.toBeNull();
  });
});

describe('reviewThreadItems', () => {
  const source = (map: Record<string, Thread[]>) => ({
    threadsOf: (docId: string) => map[docId] ?? [],
  });

  it('carries the question and its age from both surfaces', () => {
    const items = reviewThreadItems({
      tasks: [{ id: 'tk-1', title: 'Ship the widget', bodyDocId: 'task:tk-1' }],
      docs: [{ docId: 'd-1', title: 'Launch plan' }],
      source: source({
        'task:tk-1': [
          thread({ id: 'th-a', comments: [comment({ text: 'Green or blue?', ts: T0 + 20 })] }),
        ],
        'd-1': [
          thread({ id: 'th-b', comments: [comment({ text: 'Is this claim true?', ts: T0 + 10 })] }),
        ],
      }),
    });
    // Oldest first: the thing that has been waiting longest is the thing most
    // at risk of never being answered.
    expect(items.map((i) => i.threadId)).toEqual(['th-b', 'th-a']);
    expect(items[0]).toMatchObject({
      kind: 'doc-thread',
      docId: 'd-1',
      title: 'Launch plan',
      ask: 'Is this claim true?',
      since: T0 + 10,
    });
    expect(items[1]).toMatchObject({ kind: 'task-thread', taskId: 'tk-1', ask: 'Green or blue?' });
  });

  // A finished task's discussion is not a queue item: answering it changes
  // nothing, and the board's whole problem is too much competing for attention.
  it('skips threads on tasks that are already done', () => {
    const items = reviewThreadItems({
      tasks: [{ id: 'tk-1', title: 'Old', bodyDocId: 'task:tk-1', done: true }],
      docs: [],
      source: source({ 'task:tk-1': [thread()] }),
    });
    expect(items).toEqual([]);
  });

  it('says nothing when every thread has been answered', () => {
    const items = reviewThreadItems({
      tasks: [{ id: 'tk-1', title: 'Ship', bodyDocId: 'task:tk-1' }],
      docs: [{ docId: 'd-1', title: 'Plan' }],
      source: source({
        'task:tk-1': [thread({ comments: [comment({ kind: 'person', ts: T0 + 5 })] })],
        'd-1': [thread({ status: 'resolved' })],
      }),
    });
    expect(items).toEqual([]);
  });

  // The strip shows the ask, so a 4000-word comment cannot be allowed to
  // arrive whole — it would dominate the payload and the layout alike.
  it('clips a long question rather than shipping the whole comment', () => {
    const items = reviewThreadItems({
      tasks: [{ id: 'tk-1', title: 'Ship', bodyDocId: 'task:tk-1' }],
      docs: [],
      source: source({ 'task:tk-1': [thread({ comments: [comment({ text: 'x'.repeat(500) })] })] }),
    });
    expect(items[0].ask.length).toBeLessThanOrEqual(200);
    expect(items[0].ask.endsWith('…')).toBe(true);
  });
});
