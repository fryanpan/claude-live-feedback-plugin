/**
 * Correcting a review item raised on a DOC THREAD.
 *
 * The failure this covers was measured: an agent re-measured a mockup, found
 * the advice it had already given was wrong at phone width, and had no way to
 * correct it — `revise_review_item` is addressed by taskId, and a doc-thread
 * item is a review payload on a COMMENT. Its only recourse was a second item,
 * which left the reader's queue carrying two rows about one question with the
 * older, wronger one still reading as live.
 *
 * Two things have to hold and each has its own test. The superseded wording
 * stays readable as history — soft-delete discipline, because a person may
 * already have read it — and the reader can tell a correction from a fresh
 * ask, which is what the queue assertions at the bottom are for. A revision
 * the reader cannot recognise would remove the duplicate and keep the
 * confusion, which is half a fix.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

const LEAD = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };
const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'person' };

const FIRST_DETAIL =
  'At 430px the call to action falls below the fold. Worth moving it above the gallery so it stays visible?';
const CORRECTED_DETAIL =
  'At 430px the call to action is above the fold after all — I measured it wrong. The real problem is the gallery scrolling the page sideways.';

describe('revising a review item raised on a doc thread', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let docId: string;
  let workspaceId: string;

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

  type ThreadPayload = {
    id: string;
    comments: Array<{ id: string; review?: Record<string, unknown> }>;
  };

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'doc-revise-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    const file = join(dataDir, 'mockup-notes.md');
    writeFileSync(file, '# Mockup notes\n\nThe phone layout holds together.\n');
    const created = await jj<{ docId: string }>(
      await post('/api/docs', { docId: 'mockup-notes', type: 'markdown', sourceUrl: file }),
    );
    docId = created.docId;
    // The queue is per workspace, and it reads the docs LINKED to one — so
    // the doc has to be attached for its thread to reach a row at all.
    const ws = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name: 'search-revamp', leadAgentId: LEAD.id }),
    );
    workspaceId = ws.workspace.id;
    await jj(await post(`/api/workspaces/${workspaceId}/docs`, { docId }));
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** A declared review item on a thread of the doc, as an agent raises one. */
  async function raiseItem(): Promise<{ threadId: string; commentId: string }> {
    const res = await jj<{ thread: ThreadPayload }>(
      await post(`/api/docs/${docId}/threads/by_find`, {
        find: 'The phone layout holds together.',
        text: 'Checked this at 430px.',
        author: LEAD,
        review: {
          shape: 'review',
          review_type: 'question',
          headline: 'Does the phone layout need the call to action moved?',
          detail: FIRST_DETAIL,
        },
      }),
    );
    const comment = res.thread.comments[0];
    expect(comment, 'the raised item should come back with its comment').toBeTruthy();
    return { threadId: res.thread.id, commentId: (comment as { id: string }).id };
  }

  const revise = (threadId: string, body: Record<string, unknown>): Promise<Response> =>
    post(`/api/docs/${docId}/threads/${threadId}/revise`, { author: LEAD, ...body });

  it('replaces the words and keeps the superseded ones as history', async () => {
    const { threadId, commentId } = await raiseItem();
    const out = await jj<{ review: Record<string, unknown> }>(
      await revise(threadId, { commentId, detail: CORRECTED_DETAIL }),
    );

    expect(out.review.detail).toBe(CORRECTED_DETAIL);
    // The headline was not patched, so it stands — a revision is a patch, not
    // a replacement of the whole payload.
    expect(out.review.headline).toBe('Does the phone layout need the call to action moved?');
    const revisions = out.review.revisions as Array<Record<string, unknown>>;
    expect(revisions).toHaveLength(1);
    // The words a person may already have read are still readable.
    expect(revisions[0]?.detail).toBe(FIRST_DETAIL);
    expect(revisions[0]?.by).toBe('Cartographer');
    // And the changed span was derived, so the card can highlight it.
    expect(revisions[0]?.revisedRange).toBeTruthy();
  });

  it('the stored doc agrees with the response, and a second revision appends', async () => {
    const { threadId, commentId } = await raiseItem();
    await jj(await revise(threadId, { commentId, detail: CORRECTED_DETAIL }));
    await jj(await revise(threadId, { commentId, headline: 'Is the gallery scrolling sideways?' }));

    // Read it back off the server rather than trusting the write's own answer.
    const listed = await jj<{ threads: ThreadPayload[] }>(
      await fetch(`${base}/api/docs/${docId}/threads`),
    );
    const stored = listed.threads.find((t) => t.id === threadId)?.comments[0]?.review;
    expect(stored?.headline).toBe('Is the gallery scrolling sideways?');
    expect(stored?.detail).toBe(CORRECTED_DETAIL);
    const history = stored?.revisions as Array<Record<string, unknown>>;
    expect(history).toHaveLength(2);
    // Oldest first: nothing is displaced by a later correction.
    expect(history[0]?.detail).toBe(FIRST_DETAIL);
    expect(history[1]?.detail).toBe(CORRECTED_DETAIL);
  });

  it('refuses a patch that changes nothing, an unknown comment, and a bad range', async () => {
    const { threadId, commentId } = await raiseItem();

    const empty = await revise(threadId, { commentId });
    expect(empty.status).toBe(400);
    expect((await empty.json()).error).toBe('empty-patch');

    const unknown = await revise(threadId, { commentId: 'no-such-comment', detail: 'x' });
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error).toBe('not-a-review-item');

    const badRange = await revise(threadId, {
      commentId,
      detail: 'short',
      revisedRange: { start: 0, end: 9_000 },
    });
    expect(badRange.status).toBe(400);
    expect((await badRange.json()).error).toBe('bad-range');

    const noAuthor = await post(`/api/docs/${docId}/threads/${threadId}/revise`, { commentId });
    expect(noAuthor.status).toBe(400);
  });

  it('refuses to rewrite the words an answer was given to', async () => {
    const { threadId, commentId } = await raiseItem();
    await jj(
      await post(`/api/docs/${docId}/threads/${threadId}/answer`, {
        commentId,
        author: PERSON,
        text: 'Leave it where it is.',
      }),
    );
    const res = await revise(threadId, { commentId, detail: CORRECTED_DETAIL });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('answered');
    // The refusal has to say what to do instead, or it just blocks.
    expect(String(body.message)).toContain('raise a new item');
  });

  describe('the reader can tell a correction from a fresh ask', () => {
    const queueRows = async (): Promise<Array<Record<string, unknown>>> => {
      const res = await fetch(`${base}/api/workspaces/${workspaceId}/review-items`);
      expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
      const body = (await res.json()) as { items?: Array<Record<string, unknown>> };
      return body.items ?? [];
    };

    it('an unrevised item carries no revision mark', async () => {
      await raiseItem();
      const row = (await queueRows()).find((r) => r.kind === 'doc-thread');
      // The positive control for the test below: the row is on the queue at
      // all, and it is NOT marked. A test that only asserted the marked case
      // would pass just as well if every row were marked.
      expect(row, 'the raised item should reach the queue').toBeTruthy();
      expect(row?.revisedAt).toBeUndefined();
    });

    it('a revised item carries when it changed and which span', async () => {
      const { threadId, commentId } = await raiseItem();
      await jj(await revise(threadId, { commentId, detail: CORRECTED_DETAIL }));
      const row = (await queueRows()).find((r) => r.kind === 'doc-thread');
      expect(row?.revisedAt).toBeGreaterThan(0);
      expect(row?.revisedRange).toBeTruthy();
      // One row, not two — the whole point. Filing a second item was the
      // workaround this replaces.
      expect((await queueRows()).filter((r) => r.kind === 'doc-thread')).toHaveLength(1);
    });
  });
});
