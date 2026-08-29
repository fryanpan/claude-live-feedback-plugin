/**
 * Voice requests that work SMOOTHLY (Bryan, 2026-08-29):
 *
 *  - "Asking to go to an item with only vaguely relevant words has never
 *    worked (eg 'I want to go to the Akash review doc in QB')." A navigation
 *    ask resolves by TITLE SIMILARITY before any model sees it, and when the
 *    best two are too close to call the ack asks which one instead of
 *    guessing — wrong-but-confident navigation is worse than asking.
 *  - "If I ask for a brief status update, that should be able to show me a
 *    100 word message." Composed server-side from the store, capped at 100
 *    words, no model in the loop.
 *  - "If I'm in a review item, I should be able to reply by voice (choose an
 *    option or add an answer)." An option by ordinal or by label, or a
 *    free-text answer, lands on the item through the same store writes a tap
 *    makes, and the ack says what was recorded.
 *
 * Every fixture phrase is Bryan's own wording. All names are synthetic
 * (jordan@partner.example register); the repo is public. No live model call:
 * the deterministic paths never reach the completer, and the test asserts
 * that by watching the seam.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import {
  VOICE_STATUS_MAX_WORDS,
  answerBody,
  composeStatus,
  countWords,
  navigationAsk,
  parseOrdinal,
  resolveByTitle,
  statusAsk,
} from '../src/voice.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#2e7dd7' };
const AGENT = { id: 'agent-search-revamp', name: 'Search Revamp', kind: 'known', color: '#888888' };

const AKASH = 'Review: Akash — onboarding flow';
const AKASH_TWIN = 'Review: Akash — billing flow';
/** One shared word ("Review") and nothing else in common with the ask. */
const DECOY = 'Review: billing export';

// ── Unit: the deterministic pieces ─────────────────────────────────────────

describe('navigationAsk: which utterances are "take me to …"', () => {
  it('extracts the name from Bryan’s phrasing, dropping the board qualifier', () => {
    const q = navigationAsk("I want to go to the 'Akash review doc' in QB");
    expect(q).not.toBeNull();
    expect(q?.toLowerCase()).toContain('akash');
    expect(q?.toLowerCase()).not.toContain('qb');
  });

  it('is not fooled by verbs that change something or ask for status', () => {
    expect(navigationAsk('mark this done')).toBeNull();
    expect(navigationAsk('brief status')).toBeNull();
    expect(navigationAsk('assign this to me')).toBeNull();
  });
});

describe('resolveByTitle: vague words against the index', () => {
  const doc = (id: string, title: string) => ({ id, kind: 'doc' as const, title });

  it('Bryan’s phrase finds the Akash review over a decoy sharing one word', () => {
    const r = resolveByTitle('akash review', [doc('d-akash', AKASH), doc('d-decoy', DECOY)]);
    expect(r.kind).toBe('hit');
    if (r.kind === 'hit') expect(r.match.id).toBe('d-akash');
  });

  it('two near-identical titles are AMBIGUOUS, never a coin toss', () => {
    const r = resolveByTitle('akash review', [
      doc('d-akash', AKASH),
      doc('d-twin', AKASH_TWIN),
      doc('d-decoy', DECOY),
    ]);
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') {
      expect(r.matches.map((m) => m.id).sort()).toEqual(['d-akash', 'd-twin']);
    }
  });

  it('words that match nothing resolve to nothing — the model gets its turn', () => {
    const r = resolveByTitle('flux capacitor', [doc('d-akash', AKASH), doc('d-decoy', DECOY)]);
    expect(r.kind).toBe('none');
  });

  it('a one-word difference in spelling still matches (speech is not typing)', () => {
    const r = resolveByTitle('keep placeholder', [
      doc('o-1', 'Keep placeholders'),
      doc('o-2', 'Drop placeholders'),
    ]);
    expect(r.kind).toBe('hit');
    if (r.kind === 'hit') expect(r.match.id).toBe('o-1');
  });
});

describe('parseOrdinal: "the second one"', () => {
  it('reads ordinals, numerals and "last"', () => {
    expect(parseOrdinal('pick the second one', 3)).toBe(1);
    expect(parseOrdinal('option 2', 3)).toBe(1);
    expect(parseOrdinal('the first', 3)).toBe(0);
    expect(parseOrdinal('choose the last one', 3)).toBe(2);
    expect(parseOrdinal('number three', 3)).toBe(2);
  });

  it('refuses an ordinal past the end, and a label', () => {
    expect(parseOrdinal('the third one', 2)).toBeNull();
    expect(parseOrdinal('choose keep placeholders', 2)).toBeNull();
  });
});

describe('answerBody: "answer: …" carries the words after the colon', () => {
  it('strips the spoken prefix and nothing else', () => {
    expect(answerBody('answer: yes but only for the auth task')).toBe(
      'yes but only for the auth task',
    );
    expect(answerBody('Reply, ship it Monday')).toBe('ship it Monday');
  });
  it('a sentence with no prefix is not an answer by itself', () => {
    expect(answerBody('yes but only for the auth task')).toBeNull();
  });
});

describe('statusAsk', () => {
  it('hears Bryan’s spellings of "brief status"', () => {
    for (const s of [
      'brief status',
      'status update',
      'where are we',
      'give me a brief status update',
      "what's the status",
      'catch me up',
    ]) {
      expect(statusAsk(s), s).toBe(true);
    }
  });
  it('does not hear a lookup of a doc that happens to be called status', () => {
    expect(statusAsk('open the status doc')).toBe(false);
    expect(statusAsk('mark this done')).toBe(false);
  });
});

describe('composeStatus: the cap holds on a busy board', () => {
  const now = Date.now();
  const tasks = Array.from({ length: 14 }, (_, i) => ({
    id: `t-${i}`,
    title: `Task number ${i} with a fairly long title about the search index`,
    status: (['in-progress', 'todo', 'done', 'triage'] as const)[i % 4] ?? 'todo',
    assignee: i % 2 === 0 ? 'Jordan' : 'Search Revamp',
    doneAt: i % 4 === 2 ? now - i * 3_600_000 : undefined,
  }));
  const queue = Array.from({ length: 6 }, (_, i) => ({
    title: `Task number ${i}`,
    ask: `Is option ${i} acceptable for the launch, given the migration risk we discussed?`,
    askedBy: 'Search Revamp',
  }));

  it('never exceeds VOICE_STATUS_MAX_WORDS and still names the three things', () => {
    const text = composeStatus({ workspaceName: 'search-revamp', tasks, queue, now });
    expect(countWords(text)).toBeLessThanOrEqual(VOICE_STATUS_MAX_WORDS);
    expect(countWords(text)).toBeGreaterThan(20);
    expect(text).toContain('in progress');
    expect(text.toLowerCase()).toContain('waiting on you');
    expect(text.toLowerCase()).toContain('done');
  });

  it('an empty board is still an answer', () => {
    const text = composeStatus({ workspaceName: 'quiet', tasks: [], queue: [], now });
    expect(countWords(text)).toBeGreaterThan(2);
    expect(countWords(text)).toBeLessThanOrEqual(VOICE_STATUS_MAX_WORDS);
  });
});

// ── Route: through the real server ─────────────────────────────────────────

describe('voice, smoothly (route)', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let hubId: string;
  let akashDocId: string;
  let decoyDocId: string;
  /** Attached mid-suite: the near-twin that makes the Akash ask ambiguous. */
  let twinDocId = '';
  let progressTaskId: string;
  /** Docs carrying one open review item each — a decision (options) or a
   *  review (free words). */
  let decisionDocId: string;
  let decisionDocId2: string;
  let reviewDocId: string;
  let reviewThreadId: string;
  let twoItemDocId: string;
  let twoItemThreadIds: string[] = [];
  let ticketTaskId: string;
  let ticketReviewItemId: string;
  /** Per-test classification; null = fast path down. */
  let completeImpl: (() => Promise<string>) | null = null;
  /** Whether the model was consulted at all for the last utterance. */
  const calls = { n: 0 };

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  const post = (path: string, body: unknown) =>
    local(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const say = async (
    transcript: string,
    context: unknown,
    author: unknown = PERSON,
  ): Promise<{ route: string; ack: string; navigate?: string }> => {
    const r = await post(`/api/workspaces/${hubId}/voice`, { transcript, context, author });
    expect(r.status).toBe(200);
    return (await r.json()) as { route: string; ack: string; navigate?: string };
  };

  const newTask = async (body: Record<string, unknown>): Promise<string> => {
    const r = await post(`/api/workspaces/${hubId}/tasks`, { author: PERSON, ...body });
    expect(r.status).toBe(200);
    return ((await r.json()) as { task: { id: string } }).task.id;
  };

  const newDoc = async (name: string, title: string): Promise<string> => {
    const file = join(dataDir, `${name}.md`);
    writeFileSync(file, `# ${title}\n\nBody.\n`);
    const made = await post('/api/docs', { docId: name, type: 'markdown', sourceUrl: file, title });
    expect(made.status).toBe(200);
    const id = ((await made.json()) as { docId: string }).docId;
    expect((await post(`/api/workspaces/${hubId}/docs`, { docId: id })).status).toBe(200);
    return id;
  };

  const declare = async (docId: string, review: Record<string, unknown>): Promise<string> => {
    const r = await post(`/api/docs/${docId}/threads`, {
      author: AGENT,
      text: `${review.headline} — context here.`,
      anchor: { kind: 'subject' },
      review,
    });
    const payload = (await r.json()) as { thread?: { id: string }; error?: string };
    expect(r.status, payload.error ?? '').toBe(200);
    return payload.thread?.id ?? '';
  };

  interface StoredComment {
    id: string;
    text?: string;
    review?: { answeredWith?: string; answerText?: string; answeredBy?: string };
  }
  const commentsOf = async (docId: string, threadId: string): Promise<StoredComment[]> => {
    const r = await local(`/api/docs/${docId}/threads`);
    expect(r.status).toBe(200);
    const { threads } = (await r.json()) as {
      threads: Array<{ id: string; comments: StoredComment[] }>;
    };
    return threads.find((t) => t.id === threadId)?.comments ?? [];
  };

  const DECISION = {
    shape: 'decision',
    headline: 'Placeholder rows on the empty board?',
    options: [
      { id: 'keep', label: 'Keep placeholders' },
      { id: 'drop', label: 'Drop placeholders' },
    ],
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'voice-smooth-'));
    handle = createServer({
      port: 0,
      dataDir,
      voiceComplete: () => {
        calls.n += 1;
        if (!completeImpl) return Promise.reject(new Error('fast path down'));
        return completeImpl();
      },
    });
    base = `http://localhost:${handle.port}`;

    const ws = await post('/api/workspaces', { name: 'QB', goal: 'Ship onboarding.' });
    expect(ws.status).toBe(200);
    hubId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;

    akashDocId = await newDoc('akash-onboarding', AKASH);
    decoyDocId = await newDoc('billing-export', DECOY);

    progressTaskId = await newTask({ title: 'Wire the onboarding checklist', assignee: 'Jordan' });
    expect(
      (
        await post(`/api/tasks/${progressTaskId}/transition`, {
          to: 'in-progress',
          author: PERSON,
        })
      ).status,
    ).toBe(200);
    const doneId = await newTask({ title: 'Land the invite email' });
    expect(
      (await post(`/api/tasks/${doneId}/transition`, { to: 'done', author: PERSON })).status,
    ).toBe(200);

    decisionDocId = await newDoc('decision-one', 'Empty board decision');
    await declare(decisionDocId, DECISION);
    decisionDocId2 = await newDoc('decision-two', 'Empty board decision, again');
    await declare(decisionDocId2, DECISION);
    reviewDocId = await newDoc('review-one', 'Auth rollout notes');
    reviewThreadId = await declare(reviewDocId, {
      shape: 'review',
      headline: 'Roll the token change out to every task?',
    });
    twoItemDocId = await newDoc('two-items', 'Two open decisions');
    twoItemThreadIds = [
      await declare(twoItemDocId, DECISION),
      await declare(twoItemDocId, { ...DECISION, headline: 'Placeholder rows, second ask?' }),
    ];

    ticketTaskId = await newTask({ title: 'Seed the empty board' });
    const added = await post(`/api/tasks/${ticketTaskId}/review-items`, {
      author: AGENT,
      review: DECISION,
    });
    const addedBody = (await added.json()) as { item?: { id: string }; error?: string };
    expect(added.status, addedBody.error ?? '').toBe(200);
    ticketReviewItemId = addedBody.item?.id ?? '';
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  // ── 1. vague names ───────────────────────────────────────────────────────

  it('Bryan’s phrase opens the Akash review doc, and no model was asked', async () => {
    calls.n = 0;
    const body = await say("I want to go to the 'Akash review doc' in QB", { surface: 'hub' });
    expect(body.route).toBe('fast-path');
    expect(body.navigate).toBe(`/review/${encodeURIComponent(akashDocId)}`);
    expect(body.ack).toContain(AKASH);
    expect(body.navigate).not.toContain(decoyDocId);
    expect(calls.n).toBe(0);
  });

  it('a vague ask that matches NOTHING still reaches the model, with the index', async () => {
    calls.n = 0;
    completeImpl = () => Promise.resolve(JSON.stringify({ kind: 'lookup' }));
    const body = await say('take me to the flux capacitor', { surface: 'hub' });
    expect(calls.n).toBe(1);
    expect(body.navigate).toBeUndefined();
  });

  it('two close titles: the ack ASKS which, and "the second one" then opens it', async () => {
    twinDocId = await newDoc('akash-billing', AKASH_TWIN);
    const twinId = twinDocId;
    calls.n = 0;
    const asked = await say("I want to go to the 'Akash review doc' in QB", { surface: 'hub' });
    expect(asked.route).toBe('fast-path');
    expect(asked.navigate).toBeUndefined();
    expect(asked.ack).toContain(AKASH);
    expect(asked.ack).toContain(AKASH_TWIN);
    expect(asked.ack.toLowerCase()).toContain('first');
    expect(calls.n).toBe(0);
    // Which title the ack offered SECOND is the one "the second one" means.
    const secondIsTwin = asked.ack.indexOf(AKASH_TWIN) > asked.ack.indexOf(AKASH);
    const picked = await say('the second one', { surface: 'hub' });
    expect(picked.route).toBe('fast-path');
    expect(picked.navigate).toBe(
      `/review/${encodeURIComponent(secondIsTwin ? twinId : akashDocId)}`,
    );
    expect(calls.n).toBe(0);
  });

  it('a choice can also be made by NAME after the ask', async () => {
    const asked = await say('open the akash review', { surface: 'hub' });
    expect(asked.navigate).toBeUndefined();
    const picked = await say('the billing one', { surface: 'hub' });
    expect(picked.route).toBe('fast-path');
    expect(picked.navigate).toBe(`/review/${encodeURIComponent(twinDocId)}`);
    expect(picked.ack).toContain(AKASH_TWIN);
  });

  it('a pending "which one?" does not swallow an unrelated next utterance', async () => {
    const asked = await say('open the akash review', { surface: 'hub' });
    expect(asked.navigate).toBeUndefined();
    // Not an answer to the question — handled on its own terms (a status read).
    const next = await say('brief status', { surface: 'hub' });
    expect(next.navigate).toBeUndefined();
    expect(next.ack.toLowerCase()).toContain('in progress');
    // And the question is gone: "the first one" now means nothing here.
    completeImpl = () => Promise.resolve(JSON.stringify({ kind: 'change' }));
    const stale = await say('the first one', { surface: 'hub' });
    expect(stale.navigate).toBeUndefined();
  });

  // ── 2. brief status ──────────────────────────────────────────────────────

  it('"brief status" on the board answers in ≤100 words, from the store, no model', async () => {
    calls.n = 0;
    const body = await say('brief status', { surface: 'hub' });
    expect(body.route).toBe('fast-path');
    expect(body.navigate).toBeUndefined();
    expect(countWords(body.ack)).toBeLessThanOrEqual(VOICE_STATUS_MAX_WORDS);
    expect(body.ack).toContain('Wire the onboarding checklist');
    expect(body.ack).toContain('Land the invite email');
    // Something is waiting on a person: the declared decisions above.
    expect(body.ack.toLowerCase()).toContain('waiting on you');
    expect(calls.n).toBe(0);
  });

  it('"status update" over a task describes THAT task', async () => {
    const body = await say('status update', { surface: 'task', taskId: progressTaskId });
    expect(body.route).toBe('fast-path');
    expect(countWords(body.ack)).toBeLessThanOrEqual(VOICE_STATUS_MAX_WORDS);
    expect(body.ack).toContain('Wire the onboarding checklist');
    expect(body.ack).toContain('in progress');
    expect(body.ack).toContain('Jordan');
  });

  // ── 3. reply to a review item by voice ───────────────────────────────────

  it('"pick the second one" answers the decision with its second option', async () => {
    calls.n = 0;
    const body = await say('pick the second one', { surface: 'doc', docId: decisionDocId });
    expect(body.route).toBe('fast-path-action');
    expect(body.ack).toContain('Answered');
    expect(body.ack).toContain('Drop placeholders');
    expect(body.ack).toContain(DECISION.headline);
    expect(calls.n).toBe(0);
    const r = await local(`/api/docs/${decisionDocId}/threads`);
    const { threads } = (await r.json()) as {
      threads: Array<{ id: string; comments: StoredComment[] }>;
    };
    const declared = threads[0]?.comments.find((c) => c.review);
    expect(declared?.review?.answeredWith).toBe('drop');
    expect(declared?.review?.answeredBy).toBe('Jordan');
  });

  it('"choose keep placeholders" answers by LABEL', async () => {
    const body = await say('choose keep placeholders', { surface: 'doc', docId: decisionDocId2 });
    expect(body.route).toBe('fast-path-action');
    expect(body.ack).toContain('Keep placeholders');
    const r = await local(`/api/docs/${decisionDocId2}/threads`);
    const { threads } = (await r.json()) as {
      threads: Array<{ id: string; comments: StoredComment[] }>;
    };
    expect(threads[0]?.comments.find((c) => c.review)?.review?.answeredWith).toBe('keep');
  });

  it('"answer: yes but only for the auth task" lands the words on the review item', async () => {
    calls.n = 0;
    const body = await say('answer: yes but only for the auth task', {
      surface: 'doc',
      docId: reviewDocId,
    });
    expect(body.route).toBe('fast-path-action');
    expect(body.ack).toContain('Roll the token change out to every task?');
    expect(body.ack).toContain('yes but only for the auth task');
    expect(calls.n).toBe(0);
    const comments = await commentsOf(reviewDocId, reviewThreadId);
    const declared = comments.find((c) => c.review);
    expect(declared?.review?.answerText).toBe('yes but only for the auth task');
    // The reply itself is the words, not the "answer:" prefix.
    expect(comments.map((c) => c.text)).toContain('yes but only for the auth task');
  });

  it('a ticket-borne review item answers through the task store', async () => {
    const body = await say('pick the second one', { surface: 'task', taskId: ticketTaskId });
    expect(body.route).toBe('fast-path-action');
    expect(body.ack).toContain('Drop placeholders');
    const item = handle.tasks
      .listReviewItems(ticketTaskId)
      .find((i) => i.id === ticketReviewItemId);
    expect(item?.answer?.answeredWith).toBe('drop');
    expect(item?.answer?.text).toBe('Drop placeholders');
  });

  it('two open items and no thread in view: an ordinal is NOT guessed', async () => {
    completeImpl = () => Promise.resolve(JSON.stringify({ kind: 'change' }));
    const body = await say('pick the second one', { surface: 'doc', docId: twoItemDocId });
    expect(body.route).not.toBe('fast-path-action');
    for (const tid of twoItemThreadIds) {
      const declared = (await commentsOf(twoItemDocId, tid)).find((c) => c.review);
      expect(declared?.review?.answeredWith).toBeUndefined();
    }
  });

  it('…but with the thread in view (the review item open), it lands on THAT one', async () => {
    const target = twoItemThreadIds[1] ?? '';
    const body = await say('pick the second one', {
      surface: 'doc',
      docId: twoItemDocId,
      threadId: target,
    });
    expect(body.route).toBe('fast-path-action');
    expect(body.ack).toContain('second ask');
    const declared = (await commentsOf(twoItemDocId, target)).find((c) => c.review);
    expect(declared?.review?.answeredWith).toBe('drop');
    const other = (await commentsOf(twoItemDocId, twoItemThreadIds[0] ?? '')).find((c) => c.review);
    expect(other?.review?.answeredWith).toBeUndefined();
  });
});
