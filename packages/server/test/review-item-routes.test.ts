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
  detail: 'Above the fold it competes with the sign-up button. Below it, fewer people see it.',
  options: [
    { id: 'above', label: 'Keep above', detail: 'Seen by everyone, competes with sign-up.' },
    { id: 'below', label: 'Move below', detail: 'Cleaner header, fewer readers.' },
  ],
};

/** An open question — the other shape, the one with no buttons to tap. */
const QUESTION: ReviewPayload = {
  shape: 'review',
  headline: 'Does the new banner copy read right?',
  detail: 'Two sentences, both about the trial. Anything you would cut?',
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
  const THIN = { ...DECISION, detail: undefined };

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
    expect((await byFind.json()).reviewAdvice).toContain('review.detail');

    const seeded = await firstThread(docId);
    const onSubject = await post(`/api/docs/${docId}/threads`, {
      author: AGENT,
      text: 'And again on the subject.',
      anchor: seeded.anchor,
      review: THIN,
    });
    expect(onSubject.status).toBe(200);
    expect((await onSubject.json()).reviewAdvice).toContain('review.detail');
  });

  it('advises when the links are in the comment and not in the detail', async () => {
    // Bryan, 2026-08-27: the Home card described the work and gave no way to
    // reach it, because the diff and the draft were links in the comment text
    // while `detail` was prose. The card renders `detail`.
    const docId = await mkdoc();
    const seeded = await seedThread(docId);
    const res = await post(`/api/docs/${docId}/threads/${seeded.id}/comments`, {
      author: AGENT,
      text: 'Diff is at [the review](/review/d-9fQ2) and the draft is [here](/docs/d-4kTx).',
      review: DECISION,
    });
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.reviewAdvice).toContain('review.detail');
    // It FILED — advice, never a refusal.
    const stored = await firstThread(docId);
    expect(stored.comments[1]?.review?.headline).toBe(DECISION.headline);
  });

  it('says nothing when the detail carries the links itself', async () => {
    const docId = await mkdoc();
    const seeded = await seedThread(docId);
    const res = await post(`/api/docs/${docId}/threads/${seeded.id}/comments`, {
      author: AGENT,
      text: 'Diff is at [the review](/review/d-9fQ2).',
      review: { ...DECISION, detail: `${DECISION.detail} See [the review](/review/d-9fQ2).` },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).reviewAdvice).toBeUndefined();
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

  // THE compatibility obligation, asserted where it actually has to hold.
  // `why` and `lookFor` left the payload on 2026-08-25, but this is the shared
  // server's REST surface: an old plugin bundle keeps calling it from a
  // session nobody can restart, and it must neither be refused nor have its
  // author's words dropped on the floor. Asserted through the ROUTE because
  // the core check passing proves nothing about what a caller receives — and
  // on the STORED payload, because that is what every reader renders from.
  it('accepts a legacy payload and folds its why and lookFor into the body', async () => {
    const docId = await mkdoc();
    const seeded = await seedThread(docId);
    const res = await post(`/api/docs/${docId}/threads/${seeded.id}/comments`, {
      author: AGENT,
      text: 'Both screens are built.',
      review: {
        ...DECISION,
        why: 'The pricing test starts Monday and both screens are built.',
        lookFor: 'Whether moving it below the fold hides the price.',
      },
    });
    expect(res.status).toBe(200);

    const stored = await firstThread(docId);
    const review = stored.comments[1]?.review;
    // Neither retired name survives the write…
    expect(review).toBeDefined();
    expect(Object.hasOwn(review as object, 'why')).toBe(false);
    expect(Object.hasOwn(review as object, 'lookFor')).toBe(false);
    // …and not one word of what the author typed is missing from the body.
    expect(review?.detail).toBe(
      `The pricing test starts Monday and both screens are built.\n\nWhether moving it below the fold hides the price.\n\n${DECISION.detail}`,
    );
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

describe("a person's plain reply answers the item it lands on", () => {
  // The measured failure this closes: across this project's stored docs, 152
  // comment-borne declarations, 123 answered, and 12 unanswered ones with a
  // person's reply sitting under them. The answer path was not unused — it
  // loses on the doors that post a plain comment (the task panel's discussion
  // composer, the board's thread reply, MCP `post_reply`, the widget, any
  // older bundle), because only the three surfaces that render an Answer
  // composer route to `/answer`. Everywhere else a person answers in words
  // and the item stays queued.

  it('stamps an open question from a plain reply on /comments', async () => {
    const docId = await mkdoc();
    const seeded = await seedThread(docId, QUESTION);
    const res = await post(`/api/docs/${docId}/threads/${seeded.id}/comments`, {
      author: PERSON,
      text: 'Cut the second sentence — the first says it.',
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const stored = await firstThread(docId);
    // The reply is an ordinary reply, unchanged…
    expect(stored.comments[1]?.text).toContain('Cut the second sentence');
    // …and the declaration now carries the same four stamps `/answer` writes,
    // which is what takes the row off every queue.
    const review = stored.comments[0]?.review;
    expect(review?.answeredBy).toBe(PERSON.name);
    expect(review?.answerText).toBe('Cut the second sentence — the first says it.');
    expect(typeof review?.answeredAt).toBe('number');
    // Nothing was picked, because nothing was offered.
    expect(review?.answeredWith).toBeUndefined();
  });

  it('does not stamp a QUESTION — asking back is not answering', async () => {
    // The incident this pins (Bryan, 2026-08-30): "Why is this important?"
    // recorded as an answer closed the item, `revise` refused it, and the only
    // way to keep asking was a duplicate row. A person's reply that ends
    // asking posts as the ordinary reply it is; the item stays open behind it.
    const docId = await mkdoc();
    const seeded = await seedThread(docId, QUESTION);
    const res = await post(`/api/docs/${docId}/threads/${seeded.id}/comments`, {
      author: PERSON,
      text: 'Why is this important?',
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const stored = await firstThread(docId);
    expect(stored.comments[1]?.text).toBe('Why is this important?');
    const review = stored.comments[0]?.review;
    expect(review?.answeredAt).toBeUndefined();
    expect(review?.answeredBy).toBeUndefined();
  });

  it('does not stamp a question through /answer either, and says it asked', async () => {
    // The explicit answer composer is the door the incident came through.
    const docId = await mkdoc();
    const seeded = await seedThread(docId, QUESTION);
    const res = await post(`/api/docs/${docId}/threads/${seeded.id}/answer`, {
      author: PERSON,
      text: 'Why is this important?',
      commentId: seeded.comments[0]?.id,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as { asked?: boolean }).asked).toBe(true);
    const stored = await firstThread(docId);
    expect(stored.comments[1]?.text).toBe('Why is this important?');
    const review = stored.comments[0]?.review;
    expect(review?.answeredAt).toBeUndefined();
    expect(review?.answeredBy).toBeUndefined();
    // Positive control: prose through the same door still answers — the
    // question above narrowed the verb without breaking it.
    const picked = await post(`/api/docs/${docId}/threads/${seeded.id}/answer`, {
      author: PERSON,
      text: 'Cut the second sentence.',
      commentId: seeded.comments[0]?.id,
    });
    expect(picked.status).toBe(200);
    expect((await firstThread(docId)).comments[0]?.review?.answeredBy).toBe(PERSON.name);
  });

  it("does not stamp an agent's reply", async () => {
    // The addressee is a person. An agent posting a closing note under its own
    // question must not answer it on the reader's behalf — the whole point of
    // the row is that only a person can retire it.
    const docId = await mkdoc();
    const seeded = await seedThread(docId, QUESTION);
    const res = await post(`/api/docs/${docId}/threads/${seeded.id}/comments`, {
      author: AGENT,
      text: 'Bumping this — still waiting on a read.',
    });
    expect(res.status).toBe(200);
    const review = (await firstThread(docId)).comments[0]?.review;
    expect(review?.answeredAt).toBeUndefined();
    expect(review?.answeredBy).toBeUndefined();
  });

  it('leaves a decision unanswered when the words match no option', async () => {
    // A decision's options are the answer's vocabulary. Prose under one is
    // as often a question back as an answer ("is there a reason to trigger
    // it?"), and inferring a pick from it is the exact regression that once
    // let a line of small talk retire a decision and delete its card.
    const docId = await mkdoc();
    const seeded = await seedThread(docId, DECISION);
    const res = await post(`/api/docs/${docId}/threads/${seeded.id}/comments`, {
      author: PERSON,
      text: 'Why is it above the fold at all?',
    });
    expect(res.status).toBe(200);
    const stored = await firstThread(docId);
    expect(stored.comments[1]?.text).toContain('above the fold at all');
    const review = stored.comments[0]?.review;
    expect(review?.answeredAt).toBeUndefined();
    expect(review?.answeredWith).toBeUndefined();
  });

  it('answers a decision when the reply IS an option label', async () => {
    // Typing the label is how a person picks on a surface with no buttons —
    // a phone keyboard, a widget, an agent relaying the words. Matched on the
    // trimmed, case-folded label and nothing looser: a rule that guessed
    // would be the inference this deliberately does not make.
    const docId = await mkdoc();
    const seeded = await seedThread(docId, DECISION);
    const res = await post(`/api/docs/${docId}/threads/${seeded.id}/comments`, {
      author: PERSON,
      text: '  move below  ',
    });
    expect(res.status).toBe(200);
    const review = (await firstThread(docId)).comments[0]?.review;
    expect(review?.answeredWith).toBe('below');
    expect(review?.answeredBy).toBe(PERSON.name);
    // Verbatim, as posted — the answer is always the person's own words.
    expect(review?.answerText).toBe('  move below  ');
  });

  it('leaves a standing answer alone when the conversation continues', async () => {
    // Once answered there is nothing pending, so the follow-up is just a
    // follow-up. Without this, every later remark would displace the recorded
    // answer into `answerHistory` and rewrite who answered.
    const docId = await mkdoc();
    const seeded = await seedThread(docId, QUESTION);
    await post(`/api/docs/${docId}/threads/${seeded.id}/comments`, {
      author: PERSON,
      text: 'Cut the second sentence.',
    });
    await post(`/api/docs/${docId}/threads/${seeded.id}/comments`, {
      author: PERSON,
      text: 'Actually, reading it again on the phone now.',
    });
    const review = (await firstThread(docId)).comments[0]?.review;
    expect(review?.answerText).toBe('Cut the second sentence.');
    expect(review?.answerHistory).toBeUndefined();
  });

  it('does not answer the pending item with a reply that asks its own question', async () => {
    // A reply carrying its own declaration is a new ask, not an answer to the
    // old one. Both would otherwise be true of the same comment.
    const docId = await mkdoc();
    const seeded = await seedThread(docId, QUESTION);
    const res = await post(`/api/docs/${docId}/threads/${seeded.id}/comments`, {
      author: PERSON,
      text: 'Before I read it — which draft is current?',
      review: { shape: 'review', headline: 'Which draft is current?' },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const stored = await firstThread(docId);
    expect(stored.comments[0]?.review?.answeredAt).toBeUndefined();
    expect(stored.comments[1]?.review?.headline).toBe('Which draft is current?');
  });

  it('does not let a second folded reply displace the answer already recorded', async () => {
    // The write has to be conditioned on the declaration STILL being pending,
    // not merely on it having been pending when the request was read.
    // `answerReviewItem` treats a second answer as a legitimate re-answer and
    // moves the standing one into `answerHistory` — right for a person tapping
    // Answer again, wrong for a reply that was only ever folded because the
    // item looked open. Called directly, because a race is what this guards
    // and a race is exactly what a request pair cannot be relied on to stage.
    const docId = await mkdoc();
    const seeded = await seedThread(docId, QUESTION);
    const commentId = seeded.comments[0]?.id ?? '';
    const first = await post(`/api/docs/${docId}/threads/${seeded.id}/comments`, {
      author: PERSON,
      text: 'Cut the second sentence.',
    });
    expect(first.status).toBe(200);
    // The loser of the race: it read the item as pending, and by the time it
    // writes, it is not. Addressed by the room's PRIMARY id — `answerReviewItem`
    // takes the resolved id the routes hand it, and a readable alias reaches no
    // room from in here. Resolved rather than assumed, because a miss would
    // return `no-doc` and this test would pass without ever reaching the guard.
    const roomId = handle.rooms.get(docId)?.docId ?? docId;
    const late = await handle.rooms.answerReviewItem(
      roomId,
      seeded.id,
      commentId,
      { ...PERSON, id: 'known-sam', name: 'Sam' },
      'Leave it as it is.',
      undefined,
      { onlyIfUnanswered: true },
    );
    expect(late.ok).toBe(false);
    // Named, not merely falsy: `no-doc` from a mis-addressed call is also
    // `ok: false`, and it would let this test pass having tested nothing.
    expect(late.ok === false ? late.error : '').toBe('already-answered');
    const review = (await firstThread(docId)).comments[0]?.review;
    expect(review?.answerText).toBe('Cut the second sentence.');
    expect(review?.answeredBy).toBe(PERSON.name);
    // Nothing was displaced, because nothing was written.
    expect(review?.answerHistory).toBeUndefined();
  });

  it('still lets a person answer again on purpose', async () => {
    // The positive control for the guard above: the explicit answer path is
    // unconditional, so changing your mind still works and still keeps the
    // displaced answer as history rather than dropping it.
    const docId = await mkdoc();
    const seeded = await seedThread(docId, QUESTION);
    await post(`/api/docs/${docId}/threads/${seeded.id}/comments`, {
      author: PERSON,
      text: 'Cut the second sentence.',
    });
    const again = await post(`/api/docs/${docId}/threads/${seeded.id}/answer`, {
      author: PERSON,
      text: 'On reflection, keep both.',
      commentId: seeded.comments[0]?.id,
    });
    expect(again.status, await again.clone().text()).toBe(200);
    const review = (await firstThread(docId)).comments[0]?.review;
    expect(review?.answerText).toBe('On reflection, keep both.');
    expect(review?.answerHistory?.[0]?.answerText).toBe('Cut the second sentence.');
  });

  it('still leaves an ordinary thread an ordinary thread', async () => {
    // The positive control for the negatives above: a thread that declared
    // nothing takes a plain reply and gains no review payload from anywhere.
    const docId = await mkdoc();
    const seeded = await seedThread(docId);
    const res = await post(`/api/docs/${docId}/threads/${seeded.id}/comments`, {
      author: PERSON,
      text: 'Agreed.',
    });
    expect(res.status).toBe(200);
    const stored = await firstThread(docId);
    expect(stored.comments).toHaveLength(2);
    expect(stored.comments[0]?.review).toBeUndefined();
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
    const name = 'undo-gate-doc';
    const file = join(gatedDir, `${name}.md`);
    writeFileSync(file, BODY);
    const created = await fetch(`${gatedBase}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: name, type: 'markdown', sourceUrl: file }),
    });
    expect(created.status).toBe(200);
    // The caller NAMED the doc; the server minted its id. The rooms handle
    // below keys on the minted one, while the route still takes the name.
    const docId = ((await created.json()) as { docId: string }).docId;
    const seeded = await fetch(`${gatedBase}/api/docs/${name}/threads/by_find`, {
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
