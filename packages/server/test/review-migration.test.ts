/**
 * Triage for the threads the old inferred review queue left behind.
 *
 * Two layers, and the second is not optional. The classifier is pure and gets
 * hand-built threads. But the thing that decides whether the SCRIPT works is
 * whether the queue endpoint's field names and the reader's agree, and whether
 * a resolve actually takes a row off the queue — neither of which a unit test
 * over fixtures can see. So the last describe drives the real routes on a real
 * in-process server and reads the effect back.
 *
 * Every fixture is synthetic — invented names, invented copy. The repo is
 * public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Comment, Thread, User } from '@feedback/core';
import {
  fetchQueueRows,
  fetchQueueThreads,
  formatPlan,
  opensWithClosingVerb,
  planMigration,
  resolvable,
  resolveReceipts,
  triageThread,
  triageThreads,
} from '../src/review-migration.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { taskBodyDocId } from '../src/task-projection.ts';

const AGENT: User = { id: 'agent-indexer', name: 'Indexer', kind: 'known', color: '#888888' };
const PERSON: User = { id: 'known-morgan', name: 'Morgan', kind: 'known', color: '#2e7dd7' };

let clock = 1_700_000_000_000;
function comment(text: string, author: User = AGENT, over: Partial<Comment> = {}): Comment {
  clock += 60_000;
  return { id: `c${clock}`, author, text, ts: clock, ...over } as Comment;
}

function thread(comments: Comment[], over: Partial<Thread> = {}): Thread {
  return {
    id: `t${clock}`,
    status: 'open',
    createdBy: PERSON,
    anchor: { kind: 'subject' },
    comments,
    ...over,
  } as Thread;
}

const PEOPLE = ['Morgan'];

describe('opensWithClosingVerb', () => {
  it('accepts a plain report of finished work', () => {
    expect(opensWithClosingVerb('Done — removed it in the indexer pass.')).toBe(true);
    expect(opensWithClosingVerb('Merged.')).toBe(true);
  });

  it('sees through the markdown a comment routinely opens with', () => {
    expect(opensWithClosingVerb('**Fixed** the header spacing.')).toBe(true);
    expect(opensWithClosingVerb('- Shipped the retry banner')).toBe(true);
    expect(opensWithClosingVerb('> Landed, no follow-up needed.')).toBe(true);
    expect(opensWithClosingVerb('✅ Deployed to staging.')).toBe(true);
  });

  it('needs the verb to END a word, not merely start the text', () => {
    // Without the word-boundary check these both match a verb in the list.
    expect(opensWithClosingVerb('Doneness is not the metric here.')).toBe(false);
    expect(opensWithClosingVerb('Adding a second option to the picker.')).toBe(false);
  });

  it('needs the verb to open the comment, not appear anywhere in it', () => {
    // The opposite meaning: this one is asking for work, not reporting it.
    expect(opensWithClosingVerb('Let me know when the indexer pass is done.')).toBe(false);
    expect(opensWithClosingVerb('I have not fixed the header yet.')).toBe(false);
  });
});

describe('triageThread', () => {
  it('calls a run containing a question a question', () => {
    const t = thread([comment('Morgan — should the retry banner stay above the fold?')]);
    expect(triageThread('d1', t, PEOPLE)?.disposition).toBe('question');
  });

  it('POSITIVE CONTROL: the same text without the address is not a question', () => {
    // The detector is address-AND-question by design; without this control a
    // classifier that called everything a question would pass the test above.
    const t = thread([comment('Should the retry banner stay above the fold?')]);
    expect(triageThread('d1', t, PEOPLE)?.disposition).not.toBe('question');
  });

  it('calls a run opening with a closing verb a receipt', () => {
    const t = thread([comment('Done — the banner moves below the fold now.')]);
    expect(triageThread('d1', t, PEOPLE)?.disposition).toBe('receipt');
  });

  it('calls anything else a skim', () => {
    const t = thread([comment('Two options here and neither is obviously better.')]);
    expect(triageThread('d1', t, PEOPLE)?.disposition).toBe('skim');
  });

  it('a question inside a comment that OPENS like a receipt is still a question', () => {
    // Precedence, and it is the one that costs something to get wrong: a
    // receipt is resolved in a batch, so reading this row as a receipt buries
    // the question underneath it.
    const t = thread([
      comment('Added the second picker option.\n\nMorgan — do we still need the first?'),
    ]);
    expect(opensWithClosingVerb('Added the second picker option.')).toBe(true);
    expect(triageThread('d1', t, PEOPLE)?.disposition).toBe('question');
  });

  it('has nothing to say about a resolved thread', () => {
    const t = thread([comment('Done — shipped.')], { status: 'resolved' });
    expect(triageThread('d1', t, PEOPLE)).toBeNull();
  });

  it('has nothing to say about a thread a person spoke on last', () => {
    const t = thread([comment('Done — shipped.'), comment('Thanks, looks right.', PERSON)]);
    expect(triageThread('d1', t, PEOPLE)).toBeNull();
  });

  it('measures the wait from the OLDEST comment of the run, not the newest', () => {
    const first = comment('Done — shipped the first half.');
    const later = comment('Second half is out too.');
    const t = thread([first, later]);
    const triaged = triageThread('d1', t, PEOPLE);
    expect(triaged?.since).toBe(first.ts);
    expect(triaged?.runLength).toBe(2);
  });

  it('reports a declaration rather than acting on it', () => {
    const t = thread([
      comment('Done — both screens are built.', AGENT, {
        review: {
          shape: 'decision',
          headline: 'Which banner placement ships?',
          why: 'Both screens exist; the choice is yours.',
        },
      } as Partial<Comment>),
    ]);
    const triaged = triageThread('d1', t, PEOPLE);
    expect(triaged?.declared).toBe(true);
    // It still classifies — the disposition is about the words, the flag is
    // about whether the new queue already holds it.
    expect(triaged?.disposition).toBe('receipt');
  });
});

describe('resolvable', () => {
  const receipt = thread([comment('Done — shipped.')]);
  const question = thread([comment('Morgan — ship it now or wait?')]);
  const skim = thread([comment('Two options and neither is obviously better.')]);
  const declaredReceipt = thread([
    comment('Done — both screens are built.', AGENT, {
      review: { shape: 'decision', headline: 'Which one?', why: 'Your call.' },
    } as Partial<Comment>),
  ]);

  const plan = planMigration(
    [receipt, question, skim, declaredReceipt]
      .map((t, i) => triageThread(`d${i}`, t, PEOPLE))
      .filter((t) => t !== null),
  );

  it('POSITIVE CONTROL: the plan really does hold all four classes', () => {
    // Without this, "resolvable returns one row" is equally consistent with a
    // triage that produced one row in the first place.
    expect(plan.triaged).toHaveLength(4);
    expect(plan.counts).toEqual({ question: 1, receipt: 2, skim: 1 });
    expect(plan.declared).toBe(1);
  });

  it('takes receipts and nothing else', () => {
    expect(resolvable(plan).map((r) => r.docId)).toEqual(['d0']);
  });

  it('leaves an already-declared receipt alone', () => {
    // It is on the new queue. Resolving it would take it straight back off.
    expect(resolvable(plan).some((r) => r.declared)).toBe(false);
  });
});

describe('formatPlan', () => {
  const plan = planMigration(
    [thread([comment('Done — shipped.')])]
      .map((t) => triageThread('d0', t, PEOPLE))
      .filter((t) => t !== null),
  );
  const out = formatPlan(plan, clock + 86_400_000);

  it('prints the classes it will NOT touch, empty or not', () => {
    // The whole reason to run a dry pass is to read the two classes that are
    // not going to be resolved. A table that showed only the targets would be
    // a report on the script rather than on the queue.
    expect(out).toContain('QUESTION');
    expect(out).toContain('SKIM');
    expect(out).toContain('(none)');
  });

  it('names the row and quotes it', () => {
    expect(out).toContain('d0');
    expect(out).toContain('Done — shipped.');
  });

  it('totals every class and says how many it would resolve', () => {
    expect(out).toContain('TOTAL 1');
    expect(out).toContain('would resolve 1');
  });
});

describe('triageThreads derives one roster across every doc', () => {
  // Morgan has only ever spoken on doc A. The agent addresses her on doc B —
  // where she has said nothing and did not even open the thread, which is what
  // makes the control below capable of failing.
  const docA = { docId: 'a', threads: [thread([comment('Looks good to me.', PERSON)])] };
  const askOnB = thread([comment('Morgan — do we keep the old picker?')], { createdBy: AGENT });
  const docB = { docId: 'b', threads: [askOnB] };

  it('a person known from another doc still makes an address a question', () => {
    const plan = triageThreads([docA, docB]);
    const row = plan.triaged.find((t) => t.docId === 'b');
    expect(row?.disposition).toBe('question');
  });

  it('POSITIVE CONTROL: with that doc absent, nobody is known and it is not', () => {
    // Which is what proves the roster is doing the work above, rather than the
    // classifier calling every "?" a question.
    const plan = triageThreads([docB]);
    expect(plan.triaged.find((t) => t.docId === 'b')?.disposition).not.toBe('question');
  });
});

describe('against a running server, through the real routes', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let workspaceId: string;
  let receiptDoc: string;
  let receiptThread: string;
  let questionDoc: string;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** A task whose discussion starts with a PERSON, so the roster has somebody
   *  in it — which is the shape "person asks, agent answers at length" takes,
   *  and the one an agent is most likely to ask back on. */
  async function seedTask(
    title: string,
    opener: string,
    replies: string[],
  ): Promise<{
    docId: string;
    threadId: string;
  }> {
    const r = await post(`/api/workspaces/${workspaceId}/tasks`, { author: PERSON, title });
    expect(r.status, await r.clone().text()).toBe(200);
    const { task } = (await r.json()) as { task: { id: string } };
    const docId = taskBodyDocId(task.id);
    const t = await post(`/api/docs/${encodeURIComponent(docId)}/threads`, {
      author: PERSON,
      text: opener,
      anchor: { kind: 'subject' },
    });
    expect(t.status, await t.clone().text()).toBe(200);
    const { thread: created } = (await t.json()) as { thread: { id: string } };
    for (const text of replies) {
      const c = await post(
        `/api/docs/${encodeURIComponent(docId)}/threads/${created.id}/comments`,
        { author: AGENT, text },
      );
      expect(c.status, await c.clone().text()).toBe(200);
    }
    return { docId, threadId: created.id };
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'review-migration-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    const w = await post('/api/workspaces', { name: 'picker-revamp', goal: 'Ship the picker.' });
    workspaceId = ((await w.json()) as { workspace: { id: string } }).workspace.id;

    const receipt = await seedTask('Move the retry banner', 'Can you move this below the fold?', [
      'Done — it sits below the fold now.',
    ]);
    receiptDoc = receipt.docId;
    receiptThread = receipt.threadId;

    const question = await seedTask('Rework the picker', 'Two options came out of the spike.', [
      'Morgan — do we keep the old picker alongside the new one?',
    ]);
    questionDoc = question.docId;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /**
   * Since 2026-08-21 the queue route itself admits only asks — a receipt
   * never reaches it, so the script has nothing left to resolve. The queue is
   * derived per request, which is what lets the old rows triage themselves:
   * membership changed, so they simply stopped being rows. These tests pin
   * that the script stays a correct no-op over the new route rather than
   * mis-resolving the questions that remain.
   */
  it('reads the queue and finds only the question on it', async () => {
    const rows = await fetchQueueRows(base, workspaceId);
    // The receipt thread is real and open, but it is not a row any more.
    expect(rows.map((r) => r.docId)).toEqual([questionDoc]);

    const plan = triageThreads(await fetchQueueThreads(base, rows));
    const byDoc = new Map(plan.triaged.map((t) => [t.docId, t.disposition]));
    expect(byDoc.get(questionDoc)).toBe('question');
    expect(resolvable(plan)).toEqual([]);
  });

  it('a receipt thread stays OPEN and untouched — off the queue is not resolved', async () => {
    const rows = await fetchQueueRows(base, workspaceId);
    const plan = triageThreads(await fetchQueueThreads(base, rows));
    const { resolved, failed } = await resolveReceipts(base, 'Migration', resolvable(plan));
    expect(failed).toEqual([]);
    expect(resolved).toEqual([]);

    // Soft-delete discipline, now with nothing even to soft-delete: the
    // receipt thread keeps its status and every word. Leaving the queue was a
    // membership change, not an action taken against the thread.
    const read = await fetch(
      `${base}/api/docs/${encodeURIComponent(receiptDoc)}/threads/${receiptThread}`,
    );
    expect(read.status).toBe(200);
    const { thread: stored } = (await read.json()) as { thread: Thread };
    expect(stored.status).toBe('open');
    expect(stored.comments).toHaveLength(2);
    expect(stored.comments[1]?.text).toContain('below the fold');

    // POSITIVE CONTROL: the queue still answers, and still holds the question.
    const after = await fetchQueueRows(base, workspaceId);
    expect(after.map((r) => r.docId)).toContain(questionDoc);
  });

  it('is idempotent — a second pass still finds nothing to resolve', async () => {
    const rows = await fetchQueueRows(base, workspaceId);
    const plan = triageThreads(await fetchQueueThreads(base, rows));
    expect(resolvable(plan)).toEqual([]);
    // POSITIVE CONTROL: it is not that the pass read nothing at all.
    expect(plan.counts.question).toBe(1);
  });
});
