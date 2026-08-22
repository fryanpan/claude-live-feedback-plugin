/**
 * HTTP-level tests for the Review Item payload — through the REAL routes.
 *
 * Every comment-writing route hand-copies body fields into the store call,
 * and that is the one layer nothing type-checks; this repo has shipped
 * "accepted it, returned 200, discarded it" more than once. So each of the
 * three write routes gets a test that reads the stored EFFECT back through a
 * second request rather than trusting the 200 it just got.
 *
 * All fixtures are synthetic — invented names and copy throughout. The repo
 * is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReviewPayload, Thread, User } from '@feedback/core';
import type * as Y from 'yjs';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ThreadSummarizer } from '../src/summarize.ts';

const AGENT: User = {
  id: 'agent-onboarding',
  name: 'Onboarding Rework',
  kind: 'known',
  color: '#888888',
};
const PERSON: User = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#2e7dd7' };

const BODY = '# Onboarding\n\nthe trial banner sits above the fold\n';
const SNIPPET = 'trial banner';

/** A well-formed decision. Fixtures derive from this so a change to the
 *  schema breaks one place rather than six. */
const DECISION: ReviewPayload = {
  shape: 'decision',
  headline: 'Where should the trial banner live?',
  why: 'Blocks the onboarding rework; both screens are built either way.',
  lookFor: 'Whether moving it below the fold hides the price.',
  detail: 'Above the fold it competes with the sign-up button. Below it, fewer people see it.',
  options: [
    { id: 'above', label: 'Keep above', detail: 'Seen by everyone, competes with sign-up.' },
    { id: 'below', label: 'Move below', detail: 'Cleaner header, fewer readers.' },
  ],
};

let handle: ServerHandle;
let dataDir: string;
let base: string;
let seq = 0;

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function mkdoc(): Promise<string> {
  const docId = `review-item-${seq++}`;
  const file = join(dataDir, `${docId}.md`);
  writeFileSync(file, BODY);
  const res = await post('/api/docs', { docId, type: 'markdown', sourceUrl: file });
  expect(res.status).toBe(200);
  return docId;
}

/** Read the doc's threads back through the list route — never the response
 *  body of the write, which is what a dropped param still looks right in. */
async function storedThreads(docId: string): Promise<Thread[]> {
  const res = await fetch(`${base}/api/docs/${docId}/threads`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { threads: Thread[] }).threads;
}

async function firstThread(docId: string): Promise<Thread> {
  const [t] = await storedThreads(docId);
  if (!t) throw new Error('no thread stored');
  return t;
}

/** A real anchor, built by the server from the doc. Never hand-written —
 *  a hand-made text-range with no startRel/endRel is accepted and then
 *  kills the re-anchor sweep on some unrelated request minutes later. */
async function seedThread(docId: string, review?: ReviewPayload): Promise<Thread> {
  const res = await post(`/api/docs/${docId}/threads/by_find`, {
    author: AGENT,
    text: 'The banner placement needs a call.',
    find: SNIPPET,
    ...(review ? { review } : {}),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { thread: Thread }).thread;
}

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'review-item-routes-'));
  handle = createServer({ port: 0, dataDir });
  base = `http://localhost:${handle.port}`;
});
afterAll(async () => {
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the three comment-writing routes forward `review`', () => {
  it('POST /threads/by_find stores it on the first comment', async () => {
    const docId = await mkdoc();
    await seedThread(docId, DECISION);
    const stored = await firstThread(docId);
    expect(stored.comments[0]?.review?.headline).toBe(DECISION.headline);
    expect(stored.comments[0]?.review?.options?.map((o) => o.id)).toEqual(['above', 'below']);
  });

  it('POST /threads stores it on the first comment', async () => {
    const docId = await mkdoc();
    // Borrow a real anchor from a thread the server built, so this route
    // gets a structure it would actually have produced.
    const seeded = await seedThread(docId);
    const res = await post(`/api/docs/${docId}/threads`, {
      author: AGENT,
      text: 'Second look at the same line.',
      anchor: seeded.anchor,
      review: DECISION,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const withReview = (await storedThreads(docId)).find((t) => t.id !== seeded.id);
    expect(withReview?.comments[0]?.review?.headline).toBe(DECISION.headline);
  });

  it('POST /threads/:id/comments stores it on the REPLY, not the thread', async () => {
    const docId = await mkdoc();
    const seeded = await seedThread(docId);
    const res = await post(`/api/docs/${docId}/threads/${seeded.id}/comments`, {
      author: AGENT,
      text: 'Now that both screens exist, this needs a call.',
      review: DECISION,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const stored = await firstThread(docId);
    // The declaration rides the comment that made it, so a thread that
    // starts as a status note can become a review item later.
    expect(stored.comments[0]?.review).toBeUndefined();
    expect(stored.comments[1]?.review?.headline).toBe(DECISION.headline);
  });

  // Positive control for all three refusal cases below: without it, a route
  // that dropped `review` entirely would satisfy every "it 400s" assertion.
  it('an ordinary comment with no declaration is still an ordinary comment', async () => {
    const docId = await mkdoc();
    const seeded = await seedThread(docId);
    expect(seeded.comments[0]?.review).toBeUndefined();
    const stored = await firstThread(docId);
    expect(stored.comments[0]?.text.length).toBeGreaterThan(0);
    expect(stored.comments[0]?.review).toBeUndefined();
  });
});

describe('a thin-but-valid declaration files, and the 200 says it was thin', () => {
  // `checkReviewPayload` has computed `gaps` since it was written, and in the
  // first cut of this feature every route dropped them: the item filed, the
  // card came out thinner than the author meant, and the response said
  // nothing. A field nobody reads is not a feature — so this asserts on the
  // RESPONSE the writer gets, which is the only place advice can reach them.
  const THIN = { ...DECISION, lookFor: undefined, detail: undefined };

  it('rides the 200 from POST /threads/:id/comments', async () => {
    const docId = await mkdoc();
    const seeded = await seedThread(docId);
    const res = await post(`/api/docs/${docId}/threads/${seeded.id}/comments`, {
      author: AGENT,
      text: 'Both screens are built.',
      review: THIN,
    });
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.reviewAdvice).toContain('review.lookFor');
    expect(payload.reviewAdvice).toContain('review.detail');
    // It FILED — the advice is not a soft refusal, and a reader of this test
    // should not be able to confuse the two.
    const stored = await firstThread(docId);
    expect(stored.comments[1]?.review?.headline).toBe(DECISION.headline);
  });

  it('rides the 200 from POST /threads/by_find and POST /threads', async () => {
    const docId = await mkdoc();
    const byFind = await post(`/api/docs/${docId}/threads/by_find`, {
      author: AGENT,
      text: 'Both screens are built.',
      find: SNIPPET,
      review: THIN,
    });
    expect(byFind.status).toBe(200);
    expect((await byFind.json()).reviewAdvice).toContain('review.lookFor');

    const seeded = await firstThread(docId);
    const onSubject = await post(`/api/docs/${docId}/threads`, {
      author: AGENT,
      text: 'And again on the subject.',
      anchor: seeded.anchor,
      review: THIN,
    });
    expect(onSubject.status).toBe(200);
    expect((await onSubject.json()).reviewAdvice).toContain('review.lookFor');
  });

  // The absence assertion, which is why the three above are not vacuous: a
  // route that stapled the advice onto every response would pass all of them.
  it('says nothing when the declaration is complete', async () => {
    const docId = await mkdoc();
    const seeded = await seedThread(docId);
    const res = await post(`/api/docs/${docId}/threads/${seeded.id}/comments`, {
      author: AGENT,
      text: 'Now that both screens exist, this needs a call.',
      review: DECISION,
    });
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.reviewAdvice).toBeUndefined();
    expect(payload.thread).toBeDefined();
  });

  // The bug this pins: a `why` two words over budget used to 400 the whole
  // filing, six times in one measured day, each at the moment an agent was
  // routing an ask to the queue instead of to chat. It files now, and the 200
  // carries the advice — asserted through the ROUTE because the core check
  // passing proves nothing about what a caller receives.
  it('files an over-long why and names it in reviewAdvice rather than 400ing', async () => {
    const docId = await mkdoc();
    const seeded = await seedThread(docId);
    const res = await post(`/api/docs/${docId}/threads/${seeded.id}/comments`, {
      author: AGENT,
      text: 'Both screens are built.',
      review: {
        ...DECISION,
        why: 'Blocks the onboarding rework and the pricing test behind it, and both screens are already built either way.',
      },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).reviewAdvice).toContain('review.why');
    const stored = await firstThread(docId);
    expect(stored.comments[1]?.review?.why).toContain('pricing test');
  });

  it('says nothing on an ordinary comment that declared nothing', async () => {
    const docId = await mkdoc();
    const seeded = await seedThread(docId);
    const res = await post(`/api/docs/${docId}/threads/${seeded.id}/comments`, {
      author: AGENT,
      text: 'Pushed the fix.',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).reviewAdvice).toBeUndefined();
  });
});

describe('a malformed declaration is refused at the door, not truncated', () => {
  const bad: Array<[string, unknown]> = [
    ['no headline', { ...DECISION, headline: undefined }],
    ['a headline past the sanity ceiling', { ...DECISION, headline: 'x'.repeat(900) }],
    ['a multi-line headline', { ...DECISION, headline: 'Two\nlines' }],
    ['no why', { ...DECISION, why: undefined }],
    ['a decision with one option', { ...DECISION, options: [{ id: 'a', label: 'Only' }] }],
    ['a review carrying options', { ...DECISION, shape: 'review' }],
    ['an unknown shape', { ...DECISION, shape: 'links' }],
    ['not an object at all', 'ship it'],
  ];

  for (const [label, review] of bad) {
    it(`400s ${label} on every write route`, async () => {
      const docId = await mkdoc();
      const seeded = await seedThread(docId);
      const byFind = await post(`/api/docs/${docId}/threads/by_find`, {
        author: AGENT,
        text: 'x',
        find: SNIPPET,
        review,
      });
      expect(byFind.status).toBe(400);
      const threads = await post(`/api/docs/${docId}/threads`, {
        author: AGENT,
        text: 'x',
        anchor: seeded.anchor,
        review,
      });
      expect(threads.status).toBe(400);
      const comments = await post(`/api/docs/${docId}/threads/${seeded.id}/comments`, {
        author: AGENT,
        text: 'x',
        review,
      });
      expect(comments.status).toBe(400);
    });
  }

  it('the refusal quotes what is wrong, so a retry can act on the message alone', async () => {
    const docId = await mkdoc();
    const res = await post(`/api/docs/${docId}/threads/by_find`, {
      author: AGENT,
      text: 'x',
      find: SNIPPET,
      review: { ...DECISION, headline: undefined },
    });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain('review.headline');
  });

  it('a refused declaration writes NOTHING — not the comment either', async () => {
    const docId = await mkdoc();
    const before = (await storedThreads(docId)).length;
    await post(`/api/docs/${docId}/threads/by_find`, {
      author: AGENT,
      text: 'this text must not land',
      find: SNIPPET,
      review: { ...DECISION, headline: undefined },
    });
    expect((await storedThreads(docId)).length).toBe(before);
  });
});

describe('POST /threads/:id/answer', () => {
  it('posts the words as an ordinary reply and records the option they came from', async () => {
    const docId = await mkdoc();
    const seeded = await seedThread(docId, DECISION);
    const commentId = seeded.comments[0]?.id ?? '';
    const res = await post(`/api/docs/${docId}/threads/${seeded.id}/answer`, {
      author: PERSON,
      text: 'Move below',
      commentId,
      optionId: 'below',
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const stored = await firstThread(docId);
    // The answer IS the reply — there is no second answer store to check.
    expect(stored.comments[1]?.text).toBe('Move below');
    expect(stored.comments[1]?.author.id).toBe(PERSON.id);
    expect(stored.comments[0]?.review?.answeredWith).toBe('below');
  });

  it('stamps who answered and their words onto the declaration — the record survives reload', async () => {
    // "Answered by you: …" is rendered from the declaration, not from
    // re-deriving which reply was the answer — so the name and the words have
    // to be ON the stored payload, read back through a second request.
    const docId = await mkdoc();
    const seeded = await seedThread(docId, DECISION);
    const res = await post(`/api/docs/${docId}/threads/${seeded.id}/answer`, {
      author: PERSON,
      text: 'Move below',
      commentId: seeded.comments[0]?.id,
      optionId: 'below',
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const review = (await firstThread(docId)).comments[0]?.review;
    expect(review?.answeredBy).toBe(PERSON.name);
    expect(review?.answerText).toBe('Move below');
    expect(typeof review?.answeredAt).toBe('number');
  });

  it('accepts a typed answer with no option id — it is not a lesser answer', async () => {
    const docId = await mkdoc();
    const seeded = await seedThread(docId, DECISION);
    const res = await post(`/api/docs/${docId}/threads/${seeded.id}/answer`, {
      author: PERSON,
      text: 'Neither — put it in the sign-up flow instead.',
      commentId: seeded.comments[0]?.id,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const stored = await firstThread(docId);
    expect(stored.comments[1]?.text).toContain('sign-up flow');
    expect(stored.comments[0]?.review?.answeredWith).toBeUndefined();
    // ...and the declaration is otherwise untouched, so the card still
    // renders its options for anyone reading the thread afterwards.
    expect(stored.comments[0]?.review?.options).toHaveLength(2);
  });

  it('refuses an option id the declaration never offered', async () => {
    const docId = await mkdoc();
    const seeded = await seedThread(docId, DECISION);
    const res = await post(`/api/docs/${docId}/threads/${seeded.id}/answer`, {
      author: PERSON,
      text: 'Somewhere else',
      commentId: seeded.comments[0]?.id,
      optionId: 'sideways',
    });
    expect(res.status).toBe(400);
    // Nothing was written: a dangling id renders as a blank choice on a
    // decision that reads as answered, which is worse than a refusal.
    const stored = await firstThread(docId);
    expect(stored.comments).toHaveLength(1);
    expect(stored.comments[0]?.review?.answeredWith).toBeUndefined();
  });

  it('refuses a comment that declared nothing', async () => {
    const docId = await mkdoc();
    const seeded = await seedThread(docId);
    const res = await post(`/api/docs/${docId}/threads/${seeded.id}/answer`, {
      author: PERSON,
      text: 'Sure',
      commentId: seeded.comments[0]?.id,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('not-a-review-item');
  });
});

describe('POST /threads/:id/answer/undo', () => {
  /** Seed a declared item and answer it, returning the declaring comment id. */
  async function answered(docId: string): Promise<{ threadId: string; commentId: string }> {
    const seeded = await seedThread(docId, DECISION);
    const commentId = seeded.comments[0]?.id ?? '';
    const res = await post(`/api/docs/${docId}/threads/${seeded.id}/answer`, {
      author: PERSON,
      text: 'Move below',
      commentId,
      optionId: 'below',
    });
    expect(res.status, await res.clone().text()).toBe(200);
    return { threadId: seeded.id, commentId };
  }

  it('clears the stamps, keeps the reply, and moves the answer into answerHistory', async () => {
    const docId = await mkdoc();
    const { threadId, commentId } = await answered(docId);
    const res = await post(`/api/docs/${docId}/threads/${threadId}/answer/undo`, {
      author: PERSON,
      commentId,
    });
    expect(res.status, await res.clone().text()).toBe(200);

    const stored = await firstThread(docId);
    const review = stored.comments[0]?.review;
    // Unanswered again — this is what re-offers the item on every surface,
    // because every queue derives from these stamps and nothing else.
    expect(review?.answeredAt).toBeUndefined();
    expect(review?.answeredWith).toBeUndefined();
    expect(review?.answeredBy).toBeUndefined();
    expect(review?.answerText).toBeUndefined();
    // SOFT delete: the words are user content, so they move rather than drop.
    expect(review?.answerHistory).toHaveLength(1);
    expect(review?.answerHistory?.[0]?.answerText).toBe('Move below');
    expect(review?.answerHistory?.[0]?.answeredWith).toBe('below');
    expect(review?.answerHistory?.[0]?.answeredBy).toBe(PERSON.name);
    expect(review?.answerHistory?.[0]?.undoneBy).toBe(PERSON.name);
    // The reply comment stays in the thread — undo takes back the STAMP, not
    // the conversation.
    expect(stored.comments).toHaveLength(2);
    expect(stored.comments[1]?.text).toBe('Move below');
  });

  it('a re-answer after undo stamps fresh and keeps the history', async () => {
    const docId = await mkdoc();
    const { threadId, commentId } = await answered(docId);
    await post(`/api/docs/${docId}/threads/${threadId}/answer/undo`, {
      author: PERSON,
      commentId,
    });
    const res = await post(`/api/docs/${docId}/threads/${threadId}/answer`, {
      author: PERSON,
      text: 'Keep above after all',
      commentId,
      optionId: 'above',
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const review = (await firstThread(docId)).comments[0]?.review;
    expect(review?.answeredWith).toBe('above');
    expect(review?.answerText).toBe('Keep above after all');
    expect(review?.answerHistory).toHaveLength(1);
  });

  it('400s an item nobody has answered — two racing undos must not both be told they took something back', async () => {
    const docId = await mkdoc();
    const seeded = await seedThread(docId, DECISION);
    const res = await post(`/api/docs/${docId}/threads/${seeded.id}/answer/undo`, {
      author: PERSON,
      commentId: seeded.comments[0]?.id,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('not-answered');
  });

  it('400s a comment that declared nothing', async () => {
    const docId = await mkdoc();
    const seeded = await seedThread(docId);
    const res = await post(`/api/docs/${docId}/threads/${seeded.id}/answer/undo`, {
      author: PERSON,
      commentId: seeded.comments[0]?.id,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('not-a-review-item');
  });

  it('400s without author or commentId', async () => {
    const docId = await mkdoc();
    const { threadId, commentId } = await answered(docId);
    expect(
      (await post(`/api/docs/${docId}/threads/${threadId}/answer/undo`, { commentId })).status,
    ).toBe(400);
    expect(
      (await post(`/api/docs/${docId}/threads/${threadId}/answer/undo`, { author: PERSON })).status,
    ).toBe(400);
  });
});

describe('answer + undo drive the shared queue — retire everywhere, reopen everywhere', () => {
  /** The one Home derivation: the workspace review-items route, which reads
   *  the stamps off the declaration. No second state to sync is the design. */
  async function queueItems(workspaceId: string): Promise<Array<{ threadId?: string }>> {
    const res = await fetch(`${base}/api/workspaces/${workspaceId}/review-items`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { items: Array<{ threadId?: string }> }).items;
  }

  it('an answer retires the item from the queue and an undo re-offers it', async () => {
    const ws = await post('/api/workspaces', { name: 'undo-rt', goal: 'Round-trip the record.' });
    expect(ws.status, await ws.clone().text()).toBe(200);
    const { workspace } = (await ws.json()) as { workspace: { id: string } };
    const docId = await mkdoc();
    expect((await post(`/api/workspaces/${workspace.id}/docs`, { docId })).status).toBe(200);

    const seeded = await seedThread(docId, DECISION);
    const commentId = seeded.comments[0]?.id ?? '';
    // On the queue while unanswered — the positive control for both zeros.
    expect((await queueItems(workspace.id)).some((i) => i.threadId === seeded.id)).toBe(true);

    const answer = await post(`/api/docs/${docId}/threads/${seeded.id}/answer`, {
      author: PERSON,
      text: 'Move below',
      commentId,
      optionId: 'below',
    });
    expect(answer.status, await answer.clone().text()).toBe(200);
    expect((await queueItems(workspace.id)).some((i) => i.threadId === seeded.id)).toBe(false);

    const undo = await post(`/api/docs/${docId}/threads/${seeded.id}/answer/undo`, {
      author: PERSON,
      commentId,
    });
    expect(undo.status, await undo.clone().text()).toBe(200);
    expect((await queueItems(workspace.id)).some((i) => i.threadId === seeded.id)).toBe(true);
  });
});

describe('undo respects the visitor gate — a share visitor cannot spend the API key', () => {
  // Mirrors summary-pending-flag.test.ts: the `summaryPendingTs` marker is
  // stamped by `scheduleSummary`, which every thread event funnels through
  // unless the write was gated (`generate: false` — what routes pass for
  // share visitors). Nothing here touches the network: stub fetch, literal
  // key, debounce long enough that no generation lands mid-test.
  let gatedHandle: ServerHandle;
  let gatedDir: string;
  let gatedBase: string;
  let summarizer: ThreadSummarizer;

  const stubFetch = (async () =>
    new Response(
      JSON.stringify({ content: [{ type: 'text', text: '{"topic":"t","discussion":"d"}' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;

  beforeAll(() => {
    gatedDir = mkdtempSync(join(tmpdir(), 'review-undo-gate-'));
    summarizer = new ThreadSummarizer({
      apiKey: 'test-key-never-sent-anywhere',
      fetchImpl: stubFetch,
      debounceMs: 10 * 60_000,
    });
    gatedHandle = createServer({ port: 0, dataDir: gatedDir, summarizer });
    gatedBase = `http://localhost:${gatedHandle.port}`;
  });
  afterAll(async () => {
    summarizer.dispose();
    await gatedHandle.stop();
    rmSync(gatedDir, { recursive: true, force: true });
  });

  function markerOf(docId: string, threadId: string): unknown {
    const room = gatedHandle.rooms.get(docId);
    const threads = room?.ydoc.getMap('threads') as Y.Map<Y.Map<unknown>> | undefined;
    return threads?.get(threadId)?.get('summaryPendingTs');
  }

  it('a gated undo schedules nothing; an ungated one still funnels through the event', async () => {
    const docId = 'undo-gate-doc';
    const file = join(gatedDir, `${docId}.md`);
    writeFileSync(file, BODY);
    const created = await fetch(`${gatedBase}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId, type: 'markdown', sourceUrl: file }),
    });
    expect(created.status).toBe(200);
    const seeded = await fetch(`${gatedBase}/api/docs/${docId}/threads/by_find`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author: AGENT,
        text: 'Needs a call.',
        find: SNIPPET,
        review: DECISION,
      }),
    });
    expect(seeded.status, await seeded.clone().text()).toBe(200);
    const thread = ((await seeded.json()) as { thread: Thread }).thread;
    const commentId = thread.comments[0]?.id ?? '';

    const answered = await gatedHandle.rooms.answerReviewItem(
      docId,
      thread.id,
      commentId,
      PERSON,
      'Move below',
      'below',
    );
    expect(answered.ok).toBe(true);
    const afterAnswer = markerOf(docId, thread.id);
    // Positive control: the ungated answer DID reach scheduleSummary.
    expect(typeof afterAnswer).toBe('number');

    // The visitor gate, exactly as the route passes it (`generate: !visitor`).
    const gated = gatedHandle.rooms.undoReviewItemAnswer(docId, thread.id, commentId, PERSON, {
      generate: false,
    });
    expect(gated.ok).toBe(true);
    expect(markerOf(docId, thread.id)).toBe(afterAnswer);

    // Second positive control, so the zero above cannot be the probe going
    // blind: an UNGATED undo moves the marker, proving undo reaches the same
    // event funnel agents watch.
    const reAnswered = await gatedHandle.rooms.answerReviewItem(
      docId,
      thread.id,
      commentId,
      PERSON,
      'Move below again',
      'below',
    );
    expect(reAnswered.ok).toBe(true);
    // The comparison point must be AFTER the re-answer settles: the re-answer
    // itself schedules a summary and moves the marker off `afterAnswer`, so
    // asserting against that older value would pass even if the undo never
    // reached the event funnel at all — a control that passes on a zero.
    const afterReAnswer = markerOf(docId, thread.id);
    expect(typeof afterReAnswer).toBe('number');
    await new Promise((r) => setTimeout(r, 2));
    const ungated = gatedHandle.rooms.undoReviewItemAnswer(docId, thread.id, commentId, PERSON);
    expect(ungated.ok).toBe(true);
    expect(markerOf(docId, thread.id)).not.toBe(afterReAnswer);
  });
});
