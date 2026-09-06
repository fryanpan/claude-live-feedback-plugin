/**
 * The Review press, server side — `POST /api/docs/:docId/review-request`.
 *
 * The meeting's second one-tap ask, beside Make Plan, and the same shape:
 * NOT a new event type. The route files an ordinary subject-anchored thread
 * FROM THE PRESSER, which rides the `thread.created` webhook and board
 * channel every watching agent already subscribes to. The server stamps
 * `reviewRequestedAt` / `reviewRequestedBy` / `reviewThreadId` beside it —
 * the stamp is not the ask, it is what lets a reopened doc render "review
 * requested", and the thread id is how the float sees the ask answered.
 *
 * Works on a discussion doc as well as a plan doc: a discussion has no Make
 * Plan and still wants a review. Same posture as plan-request otherwise —
 * local host only, a share visitor refused, an author naming nobody refused.
 *
 * All fixtures synthetic; no port is bound (port: 0). The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { User } from '@feedback/core';
import { REVIEW_REQUEST_COMMENT } from '../src/huddle.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type AccessHarness, accessHarness, mintAccessShare } from './access-share.ts';
import { seedBoard } from './workspace-seed.ts';

const PERSON: User = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#2e7dd7' };

interface HuddleResponse {
  docId: string;
}
interface ReviewRequestResponse {
  docId: string;
  threadId: string;
  requestedAt: number;
}
interface ThreadRow {
  id: string;
  anchor?: { kind?: string };
  createdBy?: { id?: string; name?: string };
  comments?: Array<{ text: string; author?: { name?: string } }>;
}
interface DocResponse {
  meta: {
    huddle?: boolean;
    reviewRequestedAt?: number;
    reviewRequestedBy?: string;
    reviewThreadId?: string;
    planRequestedAt?: number;
  };
}

/** The board this file's docs, tasks and reviews are filed under. */
let WS = '';

describe(`POST /workspaces/${WS}/docs/:docId/review-request`, () => {
  let handle: ServerHandle;
  let access: AccessHarness;
  let dataDir: string;
  let base: string;
  let workspaceId: string;

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
  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };
  const newHuddle = async (kind: 'plan' | 'discussion'): Promise<string> =>
    (await jj<HuddleResponse>(await post(`/workspaces/${workspaceId}/huddles`, { kind }))).docId;
  const threadsOf = async (docId: string): Promise<ThreadRow[]> =>
    (await jj<{ threads: ThreadRow[] }>(await local(`/workspaces/${WS}/docs/${docId}/threads`)))
      .threads;
  const docOf = async (docId: string): Promise<DocResponse> =>
    jj<DocResponse>(await local(`/workspaces/${WS}/docs/${docId}?format=json`));

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'review-request-'));
    access = await accessHarness();
    handle = createServer({
      port: 0,
      dataDir,
      ...access.serverOptions,
    });
    base = `http://localhost:${handle.port}`;
    WS = await seedBoard(base);
    workspaceId = (
      await jj<{ workspace: { id: string } }>(
        await post('/workspaces', { name: 'review-request-board' }),
      )
    ).workspace.id;
    WS = workspaceId;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('files the ask as a subject thread from the presser, on a discussion doc', async () => {
    const docId = await newHuddle('discussion');
    expect((await docOf(docId)).meta.huddle).toBe(true);
    // Positive control: nothing has asked yet, so a thread found below is
    // this route's doing and not the doc's seeding.
    expect(await threadsOf(docId)).toHaveLength(0);

    const r = await jj<ReviewRequestResponse>(
      await post(`/workspaces/${WS}/docs/${docId}/review-request`, { author: PERSON }),
    );
    expect(r.docId).toBe(docId);
    expect(r.threadId).toBeTruthy();

    const threads = await threadsOf(docId);
    expect(threads).toHaveLength(1);
    const thread = threads[0]!;
    expect(thread.id).toBe(r.threadId);
    expect(thread.anchor?.kind).toBe('subject');
    expect(thread.createdBy?.name).toBe('Jordan');
    expect(thread.comments?.[0]?.text).toBe(REVIEW_REQUEST_COMMENT);
    expect(thread.comments?.[0]?.author?.name).toBe('Jordan');
  });

  it('stamps who, when and WHICH THREAD on the doc, and leaves the plan stamp alone', async () => {
    const docId = await newHuddle('plan');
    const before = await docOf(docId);
    expect(before.meta.reviewRequestedAt).toBeUndefined();
    expect(before.meta.reviewThreadId).toBeUndefined();

    const r = await jj<ReviewRequestResponse>(
      await post(`/workspaces/${WS}/docs/${docId}/review-request`, { author: PERSON }),
    );
    const after = await docOf(docId);
    expect(after.meta.reviewRequestedAt).toBe(r.requestedAt);
    expect(after.meta.reviewRequestedBy).toBe('Jordan');
    expect(after.meta.reviewThreadId).toBe(r.threadId);
    // Negative control: a review ask is not a plan ask.
    expect(after.meta.planRequestedAt).toBeUndefined();
  });

  it('a second press re-asks: another thread, and the stamp names the newer one', async () => {
    const docId = await newHuddle('discussion');
    const first = await jj<ReviewRequestResponse>(
      await post(`/workspaces/${WS}/docs/${docId}/review-request`, { author: PERSON }),
    );
    await new Promise((r) => setTimeout(r, 5));
    const second = await jj<ReviewRequestResponse>(
      await post(`/workspaces/${WS}/docs/${docId}/review-request`, {
        author: { ...PERSON, id: 'known-sam', name: 'Sam' },
      }),
    );
    expect(second.threadId).not.toBe(first.threadId);
    expect(second.requestedAt).toBeGreaterThan(first.requestedAt);
    expect(await threadsOf(docId)).toHaveLength(2);
    const after = await docOf(docId);
    expect(after.meta.reviewRequestedBy).toBe('Sam');
    expect(after.meta.reviewThreadId).toBe(second.threadId);
  });

  it('refuses an unknown doc, a missing author, and a bare category author', async () => {
    const docId = await newHuddle('discussion');
    expect(
      (await post(`/workspaces/${WS}/docs/no-such-doc/review-request`, { author: PERSON })).status,
    ).toBe(404);
    expect((await post(`/workspaces/${WS}/docs/${docId}/review-request`, {})).status).toBe(400);
    const category = await post(`/workspaces/${WS}/docs/${docId}/review-request`, {
      author: { id: 'agent', name: 'agent', kind: 'agent' },
    });
    expect(category.status).toBe(400);
    expect(await threadsOf(docId)).toHaveLength(0);
  });

  it('refuses a share visitor, whose cookie does reach the doc', async () => {
    const docId = await newHuddle('discussion');
    const visitor = await mintAccessShare(base, access, workspaceId, {
      label: 'review-request share',
    });
    const visitorHeaders = { ...visitor.headers, 'content-type': 'application/json' };
    const read = await fetch(`${base}/workspaces/${WS}/docs/${docId}?format=json`, {
      headers: visitorHeaders,
    });
    expect(read.status).toBe(200);
    const asked = await fetch(`${base}/workspaces/${WS}/docs/${docId}/review-request`, {
      method: 'POST',
      headers: visitorHeaders,
      body: JSON.stringify({ author: PERSON }),
    });
    expect(asked.status).toBe(403);
    expect(await threadsOf(docId)).toHaveLength(0);
  });
});
