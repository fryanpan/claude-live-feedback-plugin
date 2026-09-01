/**
 * The Make Plan press, server side — `POST /api/docs/:docId/plan-request`.
 *
 * The press is deliberately NOT a new event type. Asking an agent for
 * something is what a comment already is, so the route files an ordinary
 * subject-anchored thread FROM THE PRESSER, and that thread rides the
 * `thread.created` webhook and board channel every watching agent is already
 * subscribed to. Nothing new to teach the plugin, no version bump, and the
 * ask is visible in the doc's own comment list rather than in a side channel
 * only the agent can see.
 *
 * The server also stamps `planRequestedAt` / `planRequestedBy` on the doc.
 * That stamp is NOT the ask — the comment is — it is only what lets a
 * reopened doc render "plan requested" instead of offering a first ask to
 * somebody who already pressed.
 *
 * The route holds the same posture as the plan gate beside it: local host
 * only, a share visitor refused, and an author that names nobody refused.
 *
 * All fixtures synthetic; no port is bound (port: 0). The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { User } from '@feedback/core';
import { PLAN_REQUEST_COMMENT } from '../src/huddle.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SHARE_COOKIE } from '../src/share/link-session.ts';

const PERSON: User = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#2e7dd7' };
const PUBLIC_HOST = 'feedback.example.com';

interface HuddleResponse {
  docId: string;
  hubWorkspaceId: string;
}
interface PlanRequestResponse {
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
  meta: { planRequestedAt?: number; planRequestedBy?: string; huddleKind?: string };
  leadAgentId?: string;
}

describe('POST /api/docs/:docId/plan-request', () => {
  let handle: ServerHandle;
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
  const newBoard = async (name: string, leadAgentId?: string): Promise<string> =>
    (
      await jj<{ workspace: { id: string } }>(
        await post('/api/workspaces', { name, ...(leadAgentId ? { leadAgentId } : {}) }),
      )
    ).workspace.id;
  /** A fresh "Make a plan" doc — the only surface the float ever presses on. */
  const newPlanDoc = async (ws: string): Promise<string> =>
    (await jj<HuddleResponse>(await post(`/api/workspaces/${ws}/huddles`, { kind: 'plan' }))).docId;
  const threadsOf = async (docId: string): Promise<ThreadRow[]> =>
    (await jj<{ threads: ThreadRow[] }>(await local(`/api/docs/${docId}/threads`))).threads;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'plan-request-'));
    handle = createServer({
      port: 0,
      dataDir,
      share: { config: { publicHostname: PUBLIC_HOST } },
    });
    base = `http://localhost:${handle.port}`;
    workspaceId = await newBoard('plan-request-board');
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('files the ask as a subject-anchored thread from the presser', async () => {
    const docId = await newPlanDoc(workspaceId);
    // Positive control: nothing has asked yet, so a thread found below is
    // this route's doing and not the doc's seeding.
    expect(await threadsOf(docId)).toHaveLength(0);

    const r = await jj<PlanRequestResponse>(
      await post(`/api/docs/${docId}/plan-request`, { author: PERSON }),
    );
    expect(r.docId).toBe(docId);
    expect(r.threadId).toBeTruthy();

    const threads = await threadsOf(docId);
    expect(threads).toHaveLength(1);
    const thread = threads[0]!;
    expect(thread.id).toBe(r.threadId);
    // Subject-anchored: the ask is about the doc, not about a line of it.
    expect(thread.anchor?.kind).toBe('subject');
    // FROM THE PRESSER — this is what makes it an ask an agent answers,
    // rather than the server talking to itself.
    expect(thread.createdBy?.name).toBe('Jordan');
    expect(thread.comments?.[0]?.text).toBe(PLAN_REQUEST_COMMENT);
    expect(thread.comments?.[0]?.author?.name).toBe('Jordan');
  });

  it('stamps planRequestedAt / planRequestedBy on the doc', async () => {
    const docId = await newPlanDoc(workspaceId);
    const before = await jj<DocResponse>(await local(`/api/docs/${docId}`));
    expect(before.meta.planRequestedAt).toBeUndefined();
    expect(before.meta.planRequestedBy).toBeUndefined();

    const r = await jj<PlanRequestResponse>(
      await post(`/api/docs/${docId}/plan-request`, { author: PERSON }),
    );
    const after = await jj<DocResponse>(await local(`/api/docs/${docId}`));
    expect(after.meta.planRequestedAt).toBe(r.requestedAt);
    expect(after.meta.planRequestedBy).toBe('Jordan');
  });

  it('a second press re-asks: another thread, and the newer stamp wins', async () => {
    const docId = await newPlanDoc(workspaceId);
    const first = await jj<PlanRequestResponse>(
      await post(`/api/docs/${docId}/plan-request`, { author: PERSON }),
    );
    // The clock has ms resolution; without a gap the two stamps can tie and
    // "the newer one won" would pass vacuously.
    await new Promise((r) => setTimeout(r, 5));
    const second = await jj<PlanRequestResponse>(
      await post(`/api/docs/${docId}/plan-request`, {
        author: { ...PERSON, id: 'known-sam', name: 'Sam' },
      }),
    );
    expect(second.threadId).not.toBe(first.threadId);
    expect(second.requestedAt).toBeGreaterThan(first.requestedAt);
    expect(await threadsOf(docId)).toHaveLength(2);
    const after = await jj<DocResponse>(await local(`/api/docs/${docId}`));
    expect(after.meta.planRequestedBy).toBe('Sam');
    expect(after.meta.planRequestedAt).toBe(second.requestedAt);
  });

  it('refuses an unknown doc, a missing author, and a bare category author', async () => {
    const docId = await newPlanDoc(workspaceId);
    expect((await post('/api/docs/no-such-doc/plan-request', { author: PERSON })).status).toBe(404);
    expect((await post(`/api/docs/${docId}/plan-request`, {})).status).toBe(400);
    // "agent" names nobody — the same refusal every other comment door gives.
    const category = await post(`/api/docs/${docId}/plan-request`, {
      author: { id: 'agent', name: 'agent', kind: 'agent' },
    });
    expect(category.status).toBe(400);
    // And none of the three left a thread behind.
    expect(await threadsOf(docId)).toHaveLength(0);
  });

  it('refuses a share visitor, whose cookie does reach the doc', async () => {
    const docId = await newPlanDoc(workspaceId);
    const { share } = await jj<{ share: { url: string } }>(
      await post('/api/share/link', { workspaceId, label: 'plan-request share' }),
    );
    const shareUrl = new URL(share.url);
    const redeem = await fetch(`${base}${shareUrl.pathname}${shareUrl.search}`, {
      redirect: 'manual',
      headers: { host: PUBLIC_HOST },
    });
    expect(redeem.status).toBe(302);
    const cookie = (redeem.headers.get('set-cookie') ?? '').match(
      new RegExp(`${SHARE_COOKIE}=([^;]+)`),
    )?.[1];
    expect(cookie).toBeTruthy();
    const visitorHeaders = {
      host: PUBLIC_HOST,
      cookie: `${SHARE_COOKIE}=${cookie}`,
      'content-type': 'application/json',
    };
    // Presence: the same credentials DO read the doc.
    const read = await fetch(`${base}/api/docs/${docId}`, { headers: visitorHeaders });
    expect(read.status).toBe(200);
    // Absence: they ask for nothing.
    const asked = await fetch(`${base}/api/docs/${docId}/plan-request`, {
      method: 'POST',
      headers: visitorHeaders,
      body: JSON.stringify({ author: PERSON }),
    });
    expect(asked.status).toBe(403);
    expect(await threadsOf(docId)).toHaveLength(0);
  });

  it("names the board's lead agent on the doc read, for the float's subtitle", async () => {
    // The float says "Ask <lead> to create a plan". The lead is a board fact,
    // so it rides the doc read rather than a second fetch from the editor.
    const led = await newBoard('led-board', 'Workspaces');
    const docId = await newPlanDoc(led);
    const doc = await jj<DocResponse>(await local(`/api/docs/${docId}`));
    expect(doc.leadAgentId).toBe('Workspaces');
    // Negative control: a board with no lead names none, and the float falls
    // back to "your agent" on the client.
    const unled = await newPlanDoc(workspaceId);
    expect((await jj<DocResponse>(await local(`/api/docs/${unled}`))).leadAgentId).toBeUndefined();
  });
});
