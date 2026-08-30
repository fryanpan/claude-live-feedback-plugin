/**
 * A double submit on `POST /api/docs/:id/threads` must yield ONE thread.
 *
 * Measured 2026-08-29 on the effort-model plan doc: two thread ids created
 * 343ms apart, identical text, identical anchor — a tap plus a keyboard
 * Enter both reaching the composer's submit handler before the first
 * request had a response back (fixed client-side in `review-chrome.ts`).
 *
 * This is the server half: a request carrying the same client-generated
 * `requestId` as one already turned into a thread, within a short window,
 * returns THAT thread instead of creating a second one — belt to the
 * client's suspenders, for a request that lands but reads as a failure to
 * the browser (dropped response, timeout-then-retry), or a future caller
 * that reintroduces the race.
 *
 * The positive control matters as much as the dedup itself: two genuinely
 * distinct comments (different requestId, different text) must still
 * produce two threads, or the "fix" would just be silently dropping
 * comments.
 *
 * All fixtures synthetic. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

const REVIEWER = { id: 'known-reviewer', name: 'Reviewer', kind: 'known', color: '#2e7dd7' };
const OTHER_REVIEWER = {
  id: 'known-second-reviewer',
  name: 'Second Reviewer',
  kind: 'known',
  color: '#c0392b',
};

/** A minimal valid anchor that skips `text-range`'s Yjs decode requirement —
 *  the composer's real anchors carry encoded RelativePositions, but nothing
 *  about the dedup logic cares about the anchor's kind. */
const anchor = (snippetText: string) => ({
  kind: 'element',
  fingerprint: 'x',
  snippet: { text: snippetText },
});

describe('POST /api/docs/:id/threads dedupes a repeated requestId', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let docId: string;

  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'double-comment-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    const file = join(dataDir, 'plan.md');
    writeFileSync(file, '# Plan\n\nThe effort model needs a review.\n');
    const created = await jj<{ docId: string }>(
      await post('/api/docs', { docId: 'plan', type: 'markdown', sourceUrl: file }),
    );
    docId = created.docId;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('two POSTs with the same requestId, text and anchor produce one thread', async () => {
    const body = {
      author: REVIEWER,
      text: 'Tighten the second paragraph.',
      anchor: anchor('effort model'),
      requestId: 'req-1',
    };
    const first = await jj<{ thread: { id: string } }>(
      await post(`/api/docs/${docId}/threads`, body),
    );
    const second = await jj<{ thread: { id: string } }>(
      await post(`/api/docs/${docId}/threads`, body),
    );
    expect(second.thread.id).toBe(first.thread.id);

    const listed = await jj<{ threads: Array<{ id: string }> }>(
      await fetch(`${base}/api/docs/${docId}/threads`),
    );
    expect(listed.threads).toHaveLength(1);
  });

  it('POSITIVE CONTROL: two genuinely distinct comments both post', async () => {
    // Without this, the assertion above would still pass if the route just
    // dropped every second POST regardless of content.
    const first = await jj<{ thread: { id: string } }>(
      await post(`/api/docs/${docId}/threads`, {
        author: REVIEWER,
        text: 'First comment.',
        anchor: anchor('effort model'),
        requestId: 'req-a',
      }),
    );
    const second = await jj<{ thread: { id: string } }>(
      await post(`/api/docs/${docId}/threads`, {
        author: REVIEWER,
        text: 'Second, different comment.',
        anchor: anchor('review'),
        requestId: 'req-b',
      }),
    );
    expect(second.thread.id).not.toBe(first.thread.id);

    const listed = await jj<{ threads: Array<{ id: string }> }>(
      await fetch(`${base}/api/docs/${docId}/threads`),
    );
    expect(listed.threads).toHaveLength(2);
  });

  it('no requestId at all still posts every time — old clients get no dedup, not a refusal', async () => {
    const body = {
      author: REVIEWER,
      text: 'No idempotency key on this one.',
      anchor: anchor('effort model'),
    };
    await jj(await post(`/api/docs/${docId}/threads`, body));
    await jj(await post(`/api/docs/${docId}/threads`, body));

    const listed = await jj<{ threads: Array<{ id: string }> }>(
      await fetch(`${base}/api/docs/${docId}/threads`),
    );
    expect(listed.threads).toHaveLength(2);
  });

  it('a deduped retry still carries reviewAdvice — the early-return path must build the same response shape as a fresh create', async () => {
    // A thin-but-valid `review` payload gets a 200 PLUS `reviewAdvice` (see
    // review-item-routes.test.ts "a thin-but-valid declaration files"). The
    // dedup escape hatch used to be built before `declared` existed and
    // returned a bare `{ thread }`, silently dropping this on a retry.
    const body = {
      author: REVIEWER,
      text: 'Worth a second look.',
      anchor: anchor('effort model'),
      requestId: 'req-advice',
      review: { shape: 'review', headline: 'Cache size' },
    };
    const first = await jj<{ thread: { id: string }; reviewAdvice?: string }>(
      await post(`/api/docs/${docId}/threads`, body),
    );
    expect(first.reviewAdvice).toContain('review.detail');

    const second = await jj<{ thread: { id: string }; reviewAdvice?: string }>(
      await post(`/api/docs/${docId}/threads`, body),
    );
    expect(second.thread.id).toBe(first.thread.id);
    expect(second.reviewAdvice).toContain('review.detail');
  });

  it('a reused requestId with different text is a new comment, not a collision', async () => {
    const first = await jj<{ thread: { id: string } }>(
      await post(`/api/docs/${docId}/threads`, {
        author: REVIEWER,
        text: 'First comment.',
        anchor: anchor('effort model'),
        requestId: 'req-reused',
      }),
    );
    const second = await jj<{ thread: { id: string } }>(
      await post(`/api/docs/${docId}/threads`, {
        author: REVIEWER,
        text: 'A completely different comment.',
        anchor: anchor('effort model'),
        requestId: 'req-reused',
      }),
    );
    expect(second.thread.id).not.toBe(first.thread.id);
  });

  it('a reused requestId with the same text/anchor but a different review declaration is a new comment, not a collision', async () => {
    // Codex review: the dedup identity used to be anchor-only, so reusing a
    // requestId to CORRECT a review declaration (e.g. filling in a missing
    // detail after the thin-but-valid warning) silently returned the first,
    // uncorrected thread instead of ever persisting the fix.
    const payloadBase = {
      author: REVIEWER,
      text: 'Cache size decision.',
      anchor: anchor('effort model'),
      requestId: 'req-review-correction',
    };
    const first = await jj<{ thread: { id: string } }>(
      await post(`/api/docs/${docId}/threads`, {
        ...payloadBase,
        review: { shape: 'review', headline: 'Cache size' },
      }),
    );
    const second = await jj<{ thread: { id: string } }>(
      await post(`/api/docs/${docId}/threads`, {
        ...payloadBase,
        review: { shape: 'review', headline: 'Cache size', detail: 'Filled in after the fact.' },
      }),
    );
    expect(second.thread.id).not.toBe(first.thread.id);

    const listed = await jj<{ threads: Array<{ id: string }> }>(
      await fetch(`${base}/api/docs/${docId}/threads`),
    );
    expect(listed.threads).toHaveLength(2);
  });

  it('two different authors who happen to mint the same requestId get their own threads, not one attributed to the other', async () => {
    // Codex review: requestId is client-controlled and not globally unique.
    // Identity keyed on anchor+review alone let a second author's comment
    // collide with a first author's in-flight/completed one and come back
    // attributed to that first author.
    const body = {
      text: 'Same wording, different person.',
      anchor: anchor('effort model'),
      requestId: 'req-shared-by-coincidence',
    };
    const first = await jj<{ thread: { id: string } }>(
      await post(`/api/docs/${docId}/threads`, { ...body, author: REVIEWER }),
    );
    const second = await jj<{ thread: { id: string } }>(
      await post(`/api/docs/${docId}/threads`, { ...body, author: OTHER_REVIEWER }),
    );
    expect(second.thread.id).not.toBe(first.thread.id);

    const listed = await jj<{ threads: Array<{ id: string; createdBy: { id: string } }> }>(
      await fetch(`${base}/api/docs/${docId}/threads`),
    );
    expect(listed.threads).toHaveLength(2);
    expect(listed.threads.find((t) => t.id === first.thread.id)?.createdBy.id).toBe(REVIEWER.id);
    expect(listed.threads.find((t) => t.id === second.thread.id)?.createdBy.id).toBe(
      OTHER_REVIEWER.id,
    );
  });
});

/**
 * A `review-item` anchor's own validation refuses a SECOND ask while the
 * item is already `waiting` — a state the first successful create's own
 * side effect (`requestMoreInfoOnReview`) sets. Codex review flagged that a
 * requestId retry would hit that check before ever reaching the dedup
 * logic, turning the retry this feature exists to support into a 409
 * instead of the thread the first request already made.
 */
describe('a requestId retry on a review-item anchor is deduped before the waiting-state check', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };

  const DETAIL = 'A full pass reads the index once. A smaller cache makes it read twice.';
  const PHRASE = 'read twice';

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'double-comment-review-item-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('the retry gets the already-created thread back, not a 409', async () => {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name: 'index-rebuild', goal: 'Rebuild the index nightly.' }),
    );
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/api/workspaces/${workspace.id}/tasks`, {
        title: 'Rebuild the index nightly',
        assignee: 'Index Keeper',
        author: REVIEWER,
      }),
    );
    const { item } = await jj<{ item: { id: string } }>(
      await post(`/api/tasks/${task.id}/review-items`, {
        review: { shape: 'review', headline: 'Cache size', detail: DETAIL },
        author: REVIEWER,
      }),
    );

    const body = {
      author: REVIEWER,
      text: 'Twice per what — per night?',
      anchor: { kind: 'review-item', reviewItemId: item.id, snippet: { text: PHRASE } },
      requestId: 'req-retry-1',
    };
    const first = await jj<{ thread: { id: string } }>(
      await post(`/api/docs/task:${task.id}/threads`, body),
    );
    // Without the fix this second call hits the review-item branch's
    // waiting-state check (the item is now `waiting`, set by the first
    // call) and 409s before dedup ever runs.
    const second = await post(`/api/docs/task:${task.id}/threads`, body);
    expect(second.status, `${second.status} ${await second.clone().text()}`).toBe(200);
    const secondBody = (await second.json()) as { thread: { id: string } };
    expect(secondBody.thread.id).toBe(first.thread.id);

    const { threads } = await jj<{ threads: Array<{ id: string }> }>(
      await fetch(`${base}/api/docs/task:${task.id}/threads`),
    );
    expect(threads).toHaveLength(1);
  });
});
