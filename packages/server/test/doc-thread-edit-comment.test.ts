/**
 * Replacing the words of a comment that is already posted.
 *
 * The absence this covers was measured, not imagined. The canonical-routes
 * cutover retired `/review/<docId>`, and months of comments across every board
 * carry inline links in that shape. They do not 404 — `parseWorkspaceLink` no
 * longer recognises the shape at all, so they degrade to plain text, and
 * nobody reports plain text. A sweep found 77 such links on one board and
 * could repair 18: comment bodies were unreachable, because no operation on
 * this server changed a posted comment's text.
 *
 * Two things have to hold, and each has its own test. The old words survive —
 * a comment is somebody's writing and this project soft-deletes — and nothing
 * else about the comment moves, because an edit corrects what a comment SAYS
 * and must not quietly restate who asked, when, or what they asked for.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

const LEAD = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };
const OTHER = { id: 'agent-surveyor', name: 'Surveyor', kind: 'agent' };

/** The dead shape, and what the sweep rewrites it to. */
const OLD_LINK = 'The measurements are in [the notes](/review/mockup-notes).';
const NEW_LINK = 'The measurements are in [the notes](/workspaces/WS/docs/mockup-notes).';

describe('editing the text of a posted comment', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let docId: string;
  let WS = '';

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

  type CommentPayload = {
    id: string;
    text: string;
    ts: number;
    author: { name: string };
    review?: Record<string, unknown>;
    edits?: Array<{ text: string; by: string; at: number; reason?: string }>;
  };
  type ThreadPayload = { id: string; comments: CommentPayload[] };

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'doc-edit-comment-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    WS = await seedBoard(base);
    const file = join(dataDir, 'mockup-notes.md');
    writeFileSync(file, '# Mockup notes\n\nThe phone layout holds together.\n');
    const created = await jj<{ docId: string }>(
      await post(`/workspaces/${WS}/docs`, {
        docId: 'mockup-notes',
        type: 'markdown',
        sourceUrl: file,
      }),
    );
    docId = created.docId;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** A plain comment carrying a link in the retired shape. */
  async function commentWithDeadLink(
    author: typeof LEAD = LEAD,
  ): Promise<{ threadId: string; commentId: string }> {
    const res = await jj<{ thread: ThreadPayload }>(
      await post(`/workspaces/${WS}/docs/${docId}/threads/by_find`, {
        find: 'The phone layout holds together.',
        text: OLD_LINK,
        author,
      }),
    );
    const comment = res.thread.comments[0];
    expect(comment, 'the posted comment should come back on the thread').toBeTruthy();
    return { threadId: res.thread.id, commentId: (comment as CommentPayload).id };
  }

  const edit = (threadId: string, body: Record<string, unknown>): Promise<Response> =>
    post(`/workspaces/${WS}/docs/${docId}/threads/${threadId}/edit-comment`, {
      author: LEAD,
      ...body,
    });

  const readComment = async (threadId: string, commentId: string): Promise<CommentPayload> => {
    const listed = await jj<{ threads: ThreadPayload[] }>(
      await fetch(`${base}/workspaces/${WS}/docs/${docId}/threads`),
    );
    const stored = listed.threads
      .find((t) => t.id === threadId)
      ?.comments.find((c) => c.id === commentId);
    expect(stored, 'the comment should still be on the stored thread').toBeTruthy();
    return stored as CommentPayload;
  };

  it('replaces the words and keeps the old ones on the trail', async () => {
    const { threadId, commentId } = await commentWithDeadLink();
    await jj(await edit(threadId, { commentId, text: NEW_LINK, reason: 'routes cutover sweep' }));

    // Read it back off the server rather than trusting the write's own answer.
    const stored = await readComment(threadId, commentId);
    expect(stored.text).toBe(NEW_LINK);
    // The words somebody may already have read are still readable.
    expect(stored.edits).toHaveLength(1);
    expect(stored.edits?.[0]?.text).toBe(OLD_LINK);
    expect(stored.edits?.[0]?.by).toBe('Cartographer');
    expect(stored.edits?.[0]?.reason).toBe('routes cutover sweep');
  });

  it('moves nothing but the words, and a second edit appends', async () => {
    const { threadId, commentId } = await commentWithDeadLink();
    const before = await readComment(threadId, commentId);

    await jj(await edit(threadId, { commentId, text: NEW_LINK }));
    await jj(await edit(threadId, { commentId, text: 'The measurements moved to the plan.' }));

    const after = await readComment(threadId, commentId);
    // Who wrote it and when they wrote it are not what an edit corrects.
    expect(after.author.name).toBe(before.author.name);
    expect(after.ts).toBe(before.ts);
    // Oldest first, so the trail reads forwards.
    expect(after.edits?.map((e) => e.text)).toEqual([OLD_LINK, NEW_LINK]);
  });

  it('repairs a comment written by a different agent', async () => {
    // The whole point: the sweep fixes links other people wrote. An edit
    // restricted to its own author would leave most of them broken.
    const { threadId, commentId } = await commentWithDeadLink(OTHER);
    await jj(await edit(threadId, { commentId, text: NEW_LINK }));

    const stored = await readComment(threadId, commentId);
    expect(stored.text).toBe(NEW_LINK);
    // The comment still belongs to the agent that wrote it; only the trail
    // records who changed the words.
    expect(stored.author.name).toBe('Surveyor');
    expect(stored.edits?.[0]?.by).toBe('Cartographer');
  });

  it('leaves a review payload riding on the comment untouched', async () => {
    // Correcting an ASK is revise_review_item, which re-runs the quality
    // gate. This verb must not become a way around that gate.
    const raised = await jj<{ thread: ThreadPayload }>(
      await post(`/workspaces/${WS}/docs/${docId}/threads/by_find`, {
        find: 'The phone layout holds together.',
        text: OLD_LINK,
        author: LEAD,
        review: {
          shape: 'review',
          review_type: 'question',
          headline: 'Does the phone layout need the call to action moved?',
          detail:
            'At 430px the call to action falls below the fold. Worth moving it above the gallery so it stays visible?',
        },
      }),
    );
    const commentId = (raised.thread.comments[0] as CommentPayload).id;
    const threadId = raised.thread.id;
    const before = await readComment(threadId, commentId);

    await jj(await edit(threadId, { commentId, text: NEW_LINK }));

    const after = await readComment(threadId, commentId);
    expect(after.text).toBe(NEW_LINK);
    expect(after.review).toEqual(before.review as Record<string, unknown>);
  });

  it('refuses an edit that changes nothing, and one with no words', async () => {
    const { threadId, commentId } = await commentWithDeadLink();

    // A sweep that re-runs would otherwise stamp a correction nobody made.
    const same = await edit(threadId, { commentId, text: OLD_LINK });
    expect(same.status).toBe(409);
    expect(((await same.json()) as { error: string }).error).toBe('unchanged');

    // Emptying a comment is a deletion wearing an edit's clothes.
    const empty = await edit(threadId, { commentId, text: '   ' });
    expect(empty.status).toBe(400);

    // Neither refusal left a trail entry behind.
    const stored = await readComment(threadId, commentId);
    expect(stored.text).toBe(OLD_LINK);
    expect(stored.edits).toBeUndefined();
  });

  it('404s on a comment id that is not on the thread', async () => {
    const { threadId } = await commentWithDeadLink();
    const res = await edit(threadId, { commentId: 'c-not-here', text: NEW_LINK });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('not-found');
  });
});
