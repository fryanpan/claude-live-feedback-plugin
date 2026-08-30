/**
 * Withdrawing a review item raised on a DOC THREAD.
 *
 * The second half of the failure `doc-thread-revise.test.ts` covers, and the
 * half that actually stranded someone. An agent that corrects itself by
 * filing a SECOND item — which is what it had to do before revision existed,
 * and what an agent working a thread it does not own may still do — ends up
 * with two asks on one thread. It then cannot clean up: `/answer` invents a
 * reply the reader never gave, and `/resolve` is thread-scoped and takes the
 * live ask down with the stale one.
 *
 * Measured before building this (2026-08-30), against a real server:
 *
 *   - two declarations on ONE thread → the queue shows ONE row, the newest;
 *     the older is invisible on Home but still renders in the doc
 *   - resolving that thread → both gone
 *   - answering the newest → the older, never-answered ask is gone for good
 *
 * So the fix is not a second visibility model for threads. It is a third
 * exit — the asker takes its own ask back, the thread stays open, and
 * `pendingDeclaration` falls through to whatever is still standing.
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

const STALE_DETAIL =
  'At 430px the call to action falls below the fold. Worth moving it above the gallery so it stays visible?';
const LIVE_DETAIL =
  'The gallery scrolls the whole page sideways at 430px. Cap it at the viewport width, or let it scroll inside its own box?';

describe('withdrawing a review item raised on a doc thread', () => {
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
    status: string;
    comments: Array<{ id: string; review?: Record<string, unknown> }>;
  };

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'doc-withdraw-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    const file = join(dataDir, 'mockup-notes.md');
    writeFileSync(file, '# Mockup notes\n\nThe phone layout holds together.\n');
    const created = await jj<{ docId: string }>(
      await post('/api/docs', { docId: 'mockup-notes', type: 'markdown', sourceUrl: file }),
    );
    docId = created.docId;
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

  /** The stranded shape: a stale ask, then a correction filed as a SECOND
   *  item on the same thread. Returns both comment ids, oldest first. */
  async function twoAsksOnOneThread(): Promise<{
    threadId: string;
    staleId: string;
    liveId: string;
  }> {
    const opened = await jj<{ thread: ThreadPayload }>(
      await post(`/api/docs/${docId}/threads/by_find`, {
        find: 'The phone layout holds together.',
        text: 'Checked this at 430px.',
        author: LEAD,
        review: {
          shape: 'review',
          review_type: 'question',
          headline: 'Does the phone layout need the call to action moved?',
          detail: STALE_DETAIL,
        },
      }),
    );
    const threadId = opened.thread.id;
    const staleId = (opened.thread.comments[0] as { id: string }).id;
    const replied = await jj<{ thread: ThreadPayload }>(
      await post(`/api/docs/${docId}/threads/${threadId}/comments`, {
        text: 'Re-measured — the first question was wrong.',
        author: LEAD,
        review: {
          shape: 'review',
          review_type: 'question',
          headline: 'Should the gallery scroll inside its own box?',
          detail: LIVE_DETAIL,
        },
      }),
    );
    const declaring = replied.thread.comments.filter((c) => c.review !== undefined);
    const live = declaring.at(-1);
    expect(live, 'the correction should have landed as a second declaration').toBeTruthy();
    return { threadId, staleId, liveId: (live as { id: string }).id };
  }

  const withdraw = (threadId: string, body: Record<string, unknown>): Promise<Response> =>
    post(`/api/docs/${docId}/threads/${threadId}/withdraw`, { author: LEAD, ...body });

  const queueAsks = async (): Promise<string[]> => {
    const q = await jj<{ items: Array<{ kind: string; ask?: string }> }>(
      await fetch(`${base}/api/workspaces/${workspaceId}/review-items`),
    );
    return q.items.filter((i) => i.kind === 'doc-thread').map((i) => i.ask ?? '');
  };

  const threadNow = async (threadId: string): Promise<ThreadPayload> => {
    const all = await jj<{ threads: ThreadPayload[] }>(
      await fetch(`${base}/api/docs/${docId}/threads`),
    );
    const t = all.threads.find((x) => x.id === threadId);
    expect(t, 'the thread should still be there').toBeTruthy();
    return t as ThreadPayload;
  };

  it('retires the stale ask and leaves the live one answerable on the same thread', async () => {
    const { threadId, staleId, liveId } = await twoAsksOnOneThread();
    await jj(
      await withdraw(threadId, { commentId: staleId, reason: 'Superseded — I measured it wrong.' }),
    );

    // The thread is untouched: this is the whole difference from /resolve.
    const t = await threadNow(threadId);
    expect(t.status).toBe('open');
    // The live ask is still the one on the queue, and still answerable.
    expect(await queueAsks()).toEqual(['Should the gallery scroll inside its own box?']);
    const answered = await post(`/api/docs/${docId}/threads/${threadId}/answer`, {
      commentId: liveId,
      author: PERSON,
      text: 'Inside its own box.',
    });
    expect(answered.status).toBe(200);
  });

  it('keeps the withdrawn words verbatim, with who took them back and why', async () => {
    const { threadId, staleId } = await twoAsksOnOneThread();
    await jj(
      await withdraw(threadId, { commentId: staleId, reason: 'Superseded — I measured it wrong.' }),
    );
    const t = await threadNow(threadId);
    const stale = t.comments.find((c) => c.id === staleId);
    expect(stale?.review?.detail).toBe(STALE_DETAIL);
    expect(stale?.review?.headline).toBe('Does the phone layout need the call to action moved?');
    expect(stale?.review?.withdrawnBy).toBe('Cartographer');
    expect(stale?.review?.withdrawnReason).toBe('Superseded — I measured it wrong.');
    expect(typeof stale?.review?.withdrawnAt).toBe('number');
  });

  it('falls through: withdrawing the NEWER ask puts the older one back on the queue', async () => {
    const { threadId, liveId } = await twoAsksOnOneThread();
    // Before: the newest decides, so the older ask is buried.
    expect(await queueAsks()).toEqual(['Should the gallery scroll inside its own box?']);
    await jj(await withdraw(threadId, { commentId: liveId }));
    expect(await queueAsks()).toEqual(['Does the phone layout need the call to action moved?']);
  });

  it('undo puts a withdrawn ask back in front of the reader', async () => {
    const { threadId, staleId, liveId } = await twoAsksOnOneThread();
    await jj(await withdraw(threadId, { commentId: liveId }));
    await jj(await withdraw(threadId, { commentId: staleId }));
    expect(await queueAsks()).toEqual([]);
    await jj(
      await post(`/api/docs/${docId}/threads/${threadId}/withdraw/undo`, {
        author: LEAD,
        commentId: liveId,
      }),
    );
    expect(await queueAsks()).toEqual(['Should the gallery scroll inside its own box?']);
    const t = await threadNow(threadId);
    const live = t.comments.find((c) => c.id === liveId);
    expect('withdrawnAt' in (live?.review ?? {})).toBe(false);
  });

  it('refuses to withdraw an ANSWERED item — that would retract somebody’s answer', async () => {
    const { threadId, liveId } = await twoAsksOnOneThread();
    await jj(
      await post(`/api/docs/${docId}/threads/${threadId}/answer`, {
        commentId: liveId,
        author: PERSON,
        text: 'Inside its own box.',
      }),
    );
    const res = await withdraw(threadId, { commentId: liveId });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('answered');
  });

  it('refuses a repeat, so the original withdrawal time survives', async () => {
    const { threadId, staleId } = await twoAsksOnOneThread();
    await jj(await withdraw(threadId, { commentId: staleId }));
    const again = await withdraw(threadId, { commentId: staleId });
    expect(again.status).toBe(400);
    expect((await again.json()).error).toBe('already-withdrawn');
  });

  it('refuses a comment that carries no review item, and an unknown doc', async () => {
    const { threadId } = await twoAsksOnOneThread();
    const plain = await jj<{ thread: ThreadPayload }>(
      await post(`/api/docs/${docId}/threads/${threadId}/comments`, {
        text: 'Just a remark.',
        author: LEAD,
      }),
    );
    const remark = plain.thread.comments.at(-1) as { id: string };
    const res = await withdraw(threadId, { commentId: remark.id });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('not-a-review-item');
    const nowhere = await post(`/api/docs/no-such-doc/threads/${threadId}/withdraw`, {
      author: LEAD,
      commentId: remark.id,
    });
    expect(nowhere.status).toBe(404);
  });

  it('needs an author and a commentId', async () => {
    const { threadId, staleId } = await twoAsksOnOneThread();
    expect((await withdraw(threadId, {})).status).toBe(400);
    const noAuthor = await post(`/api/docs/${docId}/threads/${threadId}/withdraw`, {
      commentId: staleId,
    });
    expect(noAuthor.status).toBe(400);
  });
});
