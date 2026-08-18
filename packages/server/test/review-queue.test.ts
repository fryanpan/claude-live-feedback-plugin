import { describe, expect, it } from 'bun:test';
import type { Comment, ReviewPayload, Thread } from '@feedback/core';
import {
  asksPerson,
  awaitingPerson,
  reviewThreadItems,
  unansweredRun,
} from '../src/review-queue.ts';

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

// ── The wait clock, the question, and telling the two kinds of run apart ────

describe('unansweredRun', () => {
  /**
   * The rule this change had to preserve, restated independently.
   *
   * Comparing against `awaitingPerson` would prove nothing — that function is
   * now implemented ON TOP of `unansweredRun`, so the equivalence would be a
   * tautology that passes however wrong the run is. This is the pre-change
   * predicate written out from scratch: open, non-empty, newest-by-time is an
   * agent's.
   */
  const wasAwaiting = (t: Thread): boolean => {
    if (t.status !== 'open') return false;
    const cs = t.comments ?? [];
    if (cs.length === 0) return false;
    let newest = cs[0];
    for (const c of cs) if (c.ts >= newest.ts) newest = c;
    return newest.author.id.startsWith('agent-') || newest.author.kind === undefined;
  };

  // The safety property of the whole change. The run is non-empty exactly when
  // the old predicate said a person was being waited on, so no thread that
  // reaches the strip today can stop reaching it — only the quoted line and the
  // clock move.
  it('is non-empty exactly where the pre-change predicate was', () => {
    const cases = [
      thread({ comments: [comment({ ts: T0 })] }),
      thread({ comments: [comment({ kind: 'person', ts: T0 })] }),
      thread({ comments: [comment({ ts: T0 }), comment({ kind: 'person', ts: T0 + 5 })] }),
      thread({ comments: [comment({ kind: 'person', ts: T0 }), comment({ ts: T0 + 5 })] }),
      // Out of array order, so a run built by position rather than by clock
      // disagrees here.
      thread({
        comments: [comment({ ts: T0 + 90 }), comment({ kind: 'person', ts: T0 + 10 })],
      }),
      thread({ status: 'resolved' }),
      thread({ comments: [] }),
    ];
    // Non-vacuity: these cases must cover BOTH answers, or an implementation
    // that always returns one of them passes.
    expect(new Set(cases.map(wasAwaiting)).size).toBe(2);
    for (const t of cases) {
      expect(unansweredRun(t).length > 0).toBe(wasAwaiting(t));
    }
  });

  it('starts after the last person comment, not at the top of the thread', () => {
    const t = thread({
      comments: [
        comment({ text: 'early agent note', ts: T0 }),
        comment({ kind: 'person', text: 'answered', ts: T0 + 10 }),
        comment({ text: 'first since', ts: T0 + 20 }),
        comment({ text: 'second since', ts: T0 + 30 }),
      ],
    });
    expect(unansweredRun(t).map((c) => c.text)).toEqual(['first since', 'second since']);
  });
});

describe('asksPerson', () => {
  const people = ['Jordan'];

  // Every one of these was measured firing a bare "?" rule on this project's
  // real board — 19 of 86 agent comments. They are why the interrogative alone
  // is unusable as the signal.
  it('refuses a question mark that is punctuation rather than a question', () => {
    for (const text of [
      'Opened at http://example.test/board?tab=open — have a look.',
      'Measured: `in listUntriaged?` returned false for that row.',
      'Revert `anchor.snippet?.text` and the named test goes red.',
      '## Is the fleet knowable from this server?\n\nYes, via the presence strip.',
      'A first-time visitor is held at the "Who\'s reviewing?" prompt.',
    ]) {
      expect(asksPerson(text, people)).toBe(false);
    }
  });

  it('refuses a name that is mentioned rather than addressed', () => {
    expect(asksPerson('That call is Jordan’s, and I think it should be (b)?', people)).toBe(false);
  });

  it('refuses an address with nothing asked', () => {
    expect(asksPerson('**Jordan —** merged and deployed. Leaving this open.', people)).toBe(false);
  });

  // Found by codex review. Asking only that a "?" exist SOMEWHERE let a status
  // note that happens to link a query string be announced as a question — the
  // exact false positive the two-part rule was chosen to avoid, arriving
  // through the half that was supposed to prevent it.
  it('refuses an address whose only question mark is a URL or code', () => {
    for (const text of [
      'Jordan — deployed; see /board?tab=open',
      'Jordan: reverting `anchor.snippet?.text` turns the named test red.',
    ]) {
      expect(asksPerson(text, people)).toBe(false);
    }
  });

  // A "?" that belongs to a later, unrelated paragraph is not this address's
  // question.
  it('refuses a question mark from a paragraph the address did not open', () => {
    expect(asksPerson('Jordan — merged and deployed.\n\nIs the fleet knowable?', people)).toBe(
      false,
    );
  });

  it('accepts a name addressed at a line or emphasis boundary plus a question', () => {
    for (const text of [
      '**Jordan — this one is yours:** should the API refuse, or report?',
      'Jordan: do you want (a) or (b)?',
      'Long preamble.\nJordan, which of these should ship first?',
    ]) {
      expect(asksPerson(text, people)).toBe(true);
    }
  });

  // A workspace where nobody has spoken as a person yet must behave exactly as
  // it did before this rule existed.
  it('answers no to everything when no people are known', () => {
    expect(asksPerson('**Jordan — this one is yours:** (a) or (b)?', [])).toBe(false);
  });

  // Requiring whitespace immediately after the "?" rejected 7 of 9 realistic
  // markdown endings — including the bold form these comments almost always
  // use, so an agent's bolded question fell back to a clip of the report above
  // it. Each of these ends the sentence; the closer is just markup.
  it('accepts a question closed by markup rather than by whitespace', () => {
    for (const text of [
      '**Jordan — should we ship now?**',
      '**Jordan: ship (a) or (b)?**',
      'Jordan: "should we ship now?"',
      'Jordan: ship now (or later?)',
    ]) {
      expect(asksPerson(text, people)).toBe(true);
    }
  });

  // Allowing closers re-admitted the quoted-copy class that condition 3 exists
  // to reject: measured on the live board it matched a comment quoting example
  // questions back, whose extracted ask rendered as a run of fragments.
  it('refuses a question mark inside inline code, and an address inside it', () => {
    expect(
      asksPerson('Jordan: the fixture is `Bryan: ship (a) or (b)?` in the test.', people),
    ).toBe(false);
    expect(asksPerson('The fixture reads `Jordan: ship now?` and nothing else.', people)).toBe(
      false,
    );
    // The shape measured on the live board, and the one the "?" guard alone
    // does NOT catch: the only ADDRESS is inside code, while a "?" sits in
    // ordinary prose after it. Anchoring on the quoted address drags the whole
    // quoted run into the extracted ask. Note each of these puts the name
    // within reach of a line start or an emphasis run, which is what makes the
    // address regex fire at all — a fixture that does not is testing nothing.
    for (const text of [
      'Fixture: `Jordan: ship now?` — so is that worth doing?',
      'Fixture:\n`**Jordan: ship now?**` — so is that worth doing?',
      'Docs say `**Jordan — pick one?**` here. Should we do that?',
    ]) {
      expect(asksPerson(text, people)).toBe(false);
    }
    // Positive control on the same shape: unquote the address and it asks.
    expect(asksPerson('Fixture:\n**Jordan: ship now?**', people)).toBe(true);
  });

  // Same text, CRLF: `\r\n\r\n` is not `\n\n`, so the paragraph scope ran to
  // the end of the comment and a question two paragraphs down counted as this
  // address's own.
  it('refuses a later paragraph question when the breaks are CRLF', () => {
    expect(asksPerson('Jordan — merged and deployed.\r\n\r\nIs the fleet knowable?', people)).toBe(
      false,
    );
    // Positive control on the same encoding: a CRLF comment can still ask.
    expect(asksPerson('Jordan — should we ship (a) or (b)?\r\nMore below.', people)).toBe(true);
  });

  // The paragraph bound was recomputed per match with `indexOf` from the match
  // position, which re-scans to the end of the text on every miss. Measured at
  // 49ms for one 188KB comment, on a path that runs per person, per comment,
  // on every strip refresh.
  it('stays cheap on a very long comment', () => {
    const text = '**Jordan: x? '.repeat(16_000);
    const started = performance.now();
    asksPerson(text, people);
    expect(performance.now() - started).toBeLessThan(150);
  });
});

describe('reviewThreadItems — which comment is the ask, and since when', () => {
  const source = (map: Record<string, Thread[]>) => ({
    threadsOf: (docId: string) => map[docId] ?? [],
  });
  // A person has spoken somewhere in the workspace, which is where the set of
  // addressable names comes from.
  const seenPerson = thread({
    id: 'th-seed',
    comments: [comment({ kind: 'person', text: 'noted', ts: T0 })],
  });

  /** The shape the fixture task describes: an agent asks, then keeps working
   *  and posting on its own thread. Synthetic text, real structure. */
  const askedThenKeptTalking = thread({
    id: 'th-ask',
    comments: [
      comment({ text: 'Reproduced first; the premise is incomplete.', ts: T0 + 100 }),
      comment({
        text: 'Shipped the reporting half.\n\n**Jordan — this is the open question and it is yours:** should the API (a) report and let it land in the bucket, (b) refuse until the caller names a band, or (c) file it automatically, which I think is wrong?\n\nLeaving this open.',
        ts: T0 + 200,
      }),
      comment({ text: 'Merged as a1b2c3d and deployed. Not closing this one.', ts: T0 + 300 }),
      comment({ text: 'PR is open; found a second hole while building it.', ts: T0 + 400 }),
    ],
  });

  const items = () =>
    reviewThreadItems({
      tasks: [{ id: 'tk-1', title: 'File tasks against the current goal', bodyDocId: 'task:tk-1' }],
      docs: [{ docId: 'd-1', title: 'Plan' }],
      source: source({ 'task:tk-1': [askedThenKeptTalking], 'd-1': [seenPerson] }),
    });

  // The defect this change exists for. The agent's own follow-ups were being
  // read as the ask, so the strip quoted a status note for a thread whose open
  // question sat two comments back.
  it('quotes the question, not whatever the agent said most recently', () => {
    const [item] = items();
    expect(item.direct).toBe(true);
    expect(item.ask).toContain('should the API');
    expect(item.ask).not.toContain('found a second hole');
  });

  // "Whatever surfaces the question must carry its options and their costs, or
  // it just relocates the reading problem."
  it('carries the options through to the strip', () => {
    const [item] = items();
    for (const opt of ['(a)', '(b)', '(c)']) expect(item.ask).toContain(opt);
    expect(item.ask.endsWith('?')).toBe(true);
  });

  // The starvation bug: measured on the live board, 20 of 42 open threads
  // understated their wait, the worst two by more than 60 hours.
  it('dates the wait from when it started, not from the latest follow-up', () => {
    expect(items()[0].since).toBe(T0 + 100);
  });

  // Also found by codex review, and the root cause of both: the extractor kept
  // its OWN copy of the address regex and had dropped the newline branch, so a
  // comment `asksPerson` accepted could fall through to clipping from character
  // zero — truncating away the very question the change exists to surface.
  // Both now go through one matcher.
  it('extracts an address that opens a later line, after a long preamble', () => {
    const text = `${'Context that runs on. '.repeat(30)}\nJordan, which of these should ship first?`;
    const [item] = reviewThreadItems({
      tasks: [{ id: 'tk-3', title: 'Ship', bodyDocId: 'task:tk-3' }],
      docs: [{ docId: 'd-1', title: 'Plan' }],
      source: source({
        'task:tk-3': [thread({ id: 'th-late', comments: [comment({ text, ts: T0 + 5 })] })],
        'd-1': [seenPerson],
      }),
    });
    expect(item.direct).toBe(true);
    expect(item.ask).toBe('Jordan, which of these should ship first?');
  });

  // The strip renders textContent, and these comments are markdown. An
  // unstripped line reads `**PR #169 is open…`, and slicing mid-emphasis
  // leaves an unmatched marker behind.
  it('strips emphasis markers the plain-text strip would show literally', () => {
    const [item] = items();
    expect(item.ask).not.toContain('**');
    expect(item.ask.startsWith('Jordan')).toBe(true);
  });

  it('leaves a run with no question undecorated and clipped as before', () => {
    const notes = thread({
      id: 'th-note',
      comments: [comment({ text: 'Merged and deployed.', ts: T0 + 50 })],
    });
    const [item] = reviewThreadItems({
      tasks: [{ id: 'tk-2', title: 'Ship', bodyDocId: 'task:tk-2' }],
      docs: [{ docId: 'd-1', title: 'Plan' }],
      source: source({ 'task:tk-2': [notes], 'd-1': [seenPerson] }),
    });
    expect(item.direct).toBe(false);
    expect(item.ask).toBe('Merged and deployed.');
  });

  // `since` is the run's start, which is right for RANKING. But the row says
  // "asked you <t>", and the run can begin days before the question — status,
  // status, then an ask. Reading `since` there told the reader they had been
  // sitting on something they were handed moments ago.
  it('dates the question itself separately from the wait it belongs to', () => {
    const [item] = items();
    expect(item.since).toBe(T0 + 100);
    expect(item.askedAt).toBe(T0 + 200);
    expect(item.askedAt).not.toBe(item.since);
  });

  it('leaves askedAt off a run that asks nothing', () => {
    const notes = thread({
      id: 'th-note2',
      comments: [comment({ text: 'Merged and deployed.', ts: T0 + 50 })],
    });
    const [item] = reviewThreadItems({
      tasks: [{ id: 'tk-4', title: 'Ship', bodyDocId: 'task:tk-4' }],
      docs: [{ docId: 'd-1', title: 'Plan' }],
      source: source({ 'task:tk-4': [notes], 'd-1': [seenPerson] }),
    });
    expect(item.askedAt).toBeUndefined();
  });
});

/**
 * Who counts as a person must not depend on which threads are still open.
 *
 * The route filters `threadsOf` to open threads — right for "what is waiting",
 * wrong for "who is a person here". With one source, resolving an unrelated
 * thread on a different task removed its author from the roster and silently
 * flipped a live question from "asked you" back to "posted".
 */
describe('reviewThreadItems — who counts as a person', () => {
  const asking = thread({
    id: 'th-q',
    comments: [comment({ text: '**Jordan — which one:** (a) or (b)?', ts: T0 + 10 })],
  });
  const personSpoke = (status: Thread['status']) =>
    thread({ id: 'th-seed', status, comments: [comment({ kind: 'person', text: 'go', ts: T0 })] });

  const run = (seedStatus: Thread['status'], withRoster: boolean) => {
    const all: Record<string, Thread[]> = {
      'task:tk-1': [asking],
      'd-1': [personSpoke(seedStatus)],
    };
    const open: Record<string, Thread[]> = {
      'task:tk-1': [asking],
      'd-1': all['d-1'].filter((t) => t.status === 'open'),
    };
    return reviewThreadItems({
      tasks: [{ id: 'tk-1', title: 'Ship', bodyDocId: 'task:tk-1' }],
      docs: [{ docId: 'd-1', title: 'Plan' }],
      source: {
        threadsOf: (docId: string) => open[docId] ?? [],
        ...(withRoster ? { allThreadsOf: (docId: string) => all[docId] ?? [] } : {}),
      },
    }).find((i) => i.threadId === 'th-q');
  };

  // Positive control first: while the seed thread is open, both wirings agree
  // the question is a direct ask. Without this the assertion below could pass
  // against a rule that never fires at all.
  it('sees the question while the person’s own thread is open', () => {
    expect(run('open', false)?.direct).toBe(true);
    expect(run('open', true)?.direct).toBe(true);
  });

  it('keeps seeing it once that unrelated thread is resolved', () => {
    // The bug, pinned: with only the open-filtered source the roster empties.
    expect(run('resolved', false)?.direct).toBe(false);
    expect(run('resolved', true)?.direct).toBe(true);
  });

  // "Person opens a thread, agent answers at length and asks back" is exactly
  // the shape where every COMMENT in the roster source is an agent's.
  it('counts a person who opened a thread but never commented on it', () => {
    const opened = thread({
      id: 'th-q2',
      createdBy: { id: 'person-jordan', name: 'Jordan', kind: 'known', color: '#000000' },
      comments: [comment({ text: '**Jordan — which one:** (a) or (b)?', ts: T0 + 10 })],
    });
    const [item] = reviewThreadItems({
      tasks: [{ id: 'tk-1', title: 'Ship', bodyDocId: 'task:tk-1' }],
      docs: [],
      source: { threadsOf: (docId: string) => (docId === 'task:tk-1' ? [opened] : []) },
    });
    expect(item.direct).toBe(true);
  });
});

describe('reviewThreadItems — declared review items vs the inferred band', () => {
  const source = (map: Record<string, Thread[]>) => ({
    threadsOf: (docId: string) => map[docId] ?? [],
  });

  /** A well-formed declaration. Synthetic copy throughout. */
  const declaration = (over: Partial<ReviewPayload> = {}): ReviewPayload => ({
    shape: 'decision',
    headline: 'Should a resolved thread stay visible inline?',
    why: 'Blocks the inline-comments branch.',
    options: [
      { id: 'hide', label: 'Hide them' },
      { id: 'dim', label: 'Keep dimmed' },
    ],
    ...over,
  });

  const run = (threads: Thread[]) =>
    reviewThreadItems({
      tasks: [{ id: 'tk-1', title: 'Ship the inline comments', bodyDocId: 'task:tk-1' }],
      docs: [],
      source: source({ 'task:tk-1': threads }),
    });

  it('bands a declared item as declared and titles the row with the headline', () => {
    const t = thread({
      id: 'th-d',
      comments: [comment({ text: 'see the card', review: declaration(), ts: T0 + 10 })],
    });
    const [item] = run([t]);
    expect(item.band).toBe('declared');
    expect(item.ask).toBe(declaration().headline);
    expect(item.review?.options).toHaveLength(2);
    expect(item.commentId).toBe(t.comments[0].id);
  });

  // The positive control for every assertion above: an ordinary agent status
  // note must still produce a row, in the OTHER band. Without this, a
  // collector that dropped undeclared threads entirely would satisfy the
  // declared-band tests and silently delete the thing the migration exists to
  // account for.
  it('still emits an ordinary agent status note, in the unreplied band', () => {
    const [item] = run([
      thread({ id: 'th-s', comments: [comment({ text: 'Done — merged in a1b2c3d.', ts: T0 })] }),
    ]);
    expect(item.band).toBe('unreplied');
    expect(item.review).toBeUndefined();
    expect(item.ask).toContain('Done');
  });

  /**
   * The safety property of the whole change, asserted as a relationship rather
   * than as values: banding may re-sort and re-label rows, it may not change
   * WHICH threads appear. A queue that quietly dropped rows would look like a
   * fixed queue and be a queue that lost questions.
   */
  it('emits exactly the same set of threads whether or not they declare', () => {
    const bare = [
      thread({ id: 'a', comments: [comment({ text: 'Done.', ts: T0 })] }),
      thread({ id: 'b', comments: [comment({ text: 'Fixed it.', ts: T0 + 1 })] }),
      thread({ id: 'c', comments: [comment({ text: 'Merged.', ts: T0 + 2 })] }),
    ];
    const declared = bare.map((t, i) =>
      i === 1
        ? thread({
            id: t.id,
            comments: [comment({ text: t.comments[0].text, review: declaration(), ts: T0 + 1 })],
          })
        : t,
    );
    const ids = (ts: Thread[]) =>
      run(ts)
        .map((i) => i.threadId)
        .sort();
    expect(ids(declared)).toEqual(ids(bare));
    // …and non-vacuously: the banding really did change between the two runs.
    expect(run(bare).every((i) => i.band === 'unreplied')).toBe(true);
    expect(run(declared).filter((i) => i.band === 'declared')).toHaveLength(1);
  });

  it('takes the newest declaration when an agent declared twice', () => {
    const [item] = run([
      thread({
        id: 'th-two',
        comments: [
          comment({ text: 'first', review: declaration({ headline: 'Older ask' }), ts: T0 }),
          comment({ text: 'second', review: declaration({ headline: 'Newer ask' }), ts: T0 + 50 }),
        ],
      }),
    ]);
    expect(item.ask).toBe('Newer ask');
  });

  /**
   * `since` ranks the band oldest-first so nothing starves, and for an
   * INFERRED row it has to be the run's start or an agent's follow-ups reset
   * its own clock. A declaration is immune to that by construction — a later
   * comment does not become the declaration — so its own timestamp is both
   * safe and more truthful. An agent that posted status for three days and
   * only then declared has been waiting minutes, not days.
   */
  it('dates a declared row from the declaration, not from the run start', () => {
    const t = thread({
      id: 'th-late',
      comments: [
        comment({ text: 'working on it', ts: T0 }),
        comment({ text: 'still working', ts: T0 + 1_000 }),
        comment({ text: 'now I need you', review: declaration(), ts: T0 + 9_000 }),
      ],
    });
    expect(run([t])[0].since).toBe(T0 + 9_000);
    // The control: strip the declaration and the same thread dates from T0.
    const bare = thread({
      id: t.id,
      comments: t.comments.map((c) => ({ ...c, review: undefined })),
    });
    expect(run([bare])[0].since).toBe(T0);
  });

  // A person's reply ends the unanswered run, and a declaration inside a run
  // that has ended is answered. This is the ONLY clearing mechanism, and it is
  // the one that already existed — a second "handled" flag would immediately
  // disagree with the first.
  it('drops a declared item once a person has replied under it', () => {
    expect(
      run([
        thread({
          id: 'th-ans',
          comments: [
            comment({ text: 'need you', review: declaration(), ts: T0 }),
            comment({ kind: 'person', text: 'Keep them dimmed.', ts: T0 + 10 }),
          ],
        }),
      ]),
    ).toEqual([]);
  });

  it('drops a declared item once the thread is resolved', () => {
    expect(
      run([
        thread({
          id: 'th-res',
          status: 'resolved',
          comments: [comment({ text: 'need you', review: declaration(), ts: T0 })],
        }),
      ]),
    ).toEqual([]);
  });
});
