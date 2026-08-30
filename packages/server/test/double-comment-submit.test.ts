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
});
