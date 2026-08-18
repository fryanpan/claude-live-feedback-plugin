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
import { type ServerHandle, createServer } from '../src/server.ts';

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

describe('a malformed declaration is refused at the door, not truncated', () => {
  const bad: Array<[string, unknown]> = [
    ['no headline', { ...DECISION, headline: undefined }],
    ['a headline over the two-line budget', { ...DECISION, headline: 'x'.repeat(200) }],
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
