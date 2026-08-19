/**
 * Posting a report on a task hands back the link to it.
 *
 * The measured problem this serves: over 38 hours, 52,340 words — 40% of
 * every word in the user's chat window — were agent-to-agent reports relayed
 * through his terminal. Ninety-nine of them, two single messages at 3,079 and
 * 4,392 words, none addressed to him. Each had an obvious correct home: the
 * task the work belonged to.
 *
 * The rule telling agents to post there already ships, and did not prevent
 * it. Part of the reason is friction on the honest path: an agent that DOES
 * post its report on the task then has to hand its peer a pointer, and the
 * response it just got back contains no link. It has to assemble
 * `/workspaces/<wsId>?task=<taskId>` from parts, against a base URL it may
 * not know — while replying in chat costs nothing. So the cheap path is the
 * wrong one.
 *
 * This closes that gap the way `reviewGapAdvice` closes its own: the thing
 * the author needs travels back on the success response. No new endpoint, no
 * second URL contract — `externalBaseUrl()` already exists precisely so an
 * operator override cannot reach some links and miss others, and
 * `taskDeepLink()` already owns this path's shape.
 *
 * The share-visitor case is a genuine constraint, not caution: a workspace id
 * is an unguessable URL capability, and a doc-scoped visitor must not learn
 * one from a member doc (the same rule that gates `hubWorkspaceId` and
 * `backTo` on the doc route).
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SHARE_COOKIE } from '../src/share/link-session.ts';

const PUBLIC_BASE = 'https://feedback.example.com';
const PUBLIC_HOST = 'feedback.example.com';

const AGENT = { id: 'agent-search-revamp', name: 'Search Revamp', kind: 'known', color: '#888888' };

interface ThreadResponse {
  thread?: { id: string };
  url?: string;
  error?: string;
}

describe('a report posted on a task comes back with the link to hand over', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsId: string;
  let taskId: string;

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

  /** Open a subject thread the way `create_thread(docId="task:…")` does. */
  const postSubjectThread = async (docId: string, text: string): Promise<ThreadResponse> => {
    const r = await post(`/api/docs/${encodeURIComponent(docId)}/threads`, {
      author: AGENT,
      text,
      anchor: { kind: 'subject' },
    });
    expect(r.status).toBe(200);
    return (await r.json()) as ThreadResponse;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'report-link-'));
    handle = createServer({ port: 0, dataDir, publicBaseUrl: PUBLIC_BASE });
    base = `http://localhost:${handle.port}`;

    const ws = await post('/api/workspaces', {
      name: 'search-revamp',
      goal: 'Ship the new search.',
    });
    expect(ws.status).toBe(200);
    wsId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;

    const t = await post(`/api/workspaces/${wsId}/tasks`, {
      title: 'Wire the results page',
      author: AGENT,
    });
    expect(t.status).toBe(200);
    taskId = ((await t.json()) as { task: { id: string } }).task.id;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('opening the thread returns a URL that opens the task on the board', async () => {
    const body = await postSubjectThread(
      `task:${taskId}`,
      'Deploy done: gates green, prod on abc.',
    );
    // Absolute, and on the operator's public base — the whole point is that
    // it can be pasted somewhere else and still resolve. A relative path
    // would be useless to the peer it is being handed to.
    expect(body.url).toBe(
      `${PUBLIC_BASE}/workspaces/${encodeURIComponent(wsId)}?task=${encodeURIComponent(taskId)}`,
    );
  });

  it('a reply returns it too — the second report is where the long ones actually land', async () => {
    const opened = await postSubjectThread(`task:${taskId}`, 'Starting on this.');
    const threadId = opened.thread?.id ?? '';
    expect(threadId).not.toBe('');

    const r = await post(
      `/api/docs/${encodeURIComponent(`task:${taskId}`)}/threads/${encodeURIComponent(threadId)}/comments`,
      { author: AGENT, text: 'Gates green, PR open.' },
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as ThreadResponse;
    expect(body.url).toBe(
      `${PUBLIC_BASE}/workspaces/${encodeURIComponent(wsId)}?task=${encodeURIComponent(taskId)}`,
    );
  });

  it('POSITIVE CONTROL: the id in the link is THIS task, not any task', async () => {
    // Without this, a hardcoded or first-task link passes both assertions
    // above and sends every reader to the same wrong row.
    const second = await post(`/api/workspaces/${wsId}/tasks`, {
      title: 'A different piece of work',
      author: AGENT,
    });
    const otherId = ((await second.json()) as { task: { id: string } }).task.id;
    expect(otherId).not.toBe(taskId);

    const body = await postSubjectThread(`task:${otherId}`, 'Report on the other one.');
    expect(body.url).toContain(encodeURIComponent(otherId));
    expect(body.url).not.toContain(encodeURIComponent(taskId));
  });

  it('an ordinary doc comment carries no such field', async () => {
    // The link answers "where did my report go" for a TASK. A markdown doc
    // already has `reviewUrl` on its own metadata, and inventing a second
    // URL contract here is exactly what `externalBaseUrl` exists to prevent.
    const docId = 'plain-notes';
    const p = join(dataDir, `${docId}.md`);
    writeFileSync(p, '# Notes\n\nSome body text to anchor to.\n');
    expect((await post('/api/docs', { docId, type: 'markdown', sourceUrl: p })).status).toBe(200);

    const r = await post(`/api/docs/${encodeURIComponent(docId)}/threads`, {
      author: AGENT,
      text: 'A note on the doc itself.',
      anchor: { kind: 'subject' },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as ThreadResponse;
    expect(body.thread?.id).toBeDefined(); // the post really happened
    expect(body.url).toBeUndefined();
  });
});

describe('the handoff link is owner-only — a workspace id is a capability', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let boardId: string;
  let taskId: string;
  let cookie: string;

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
  /** The same POST, as the share visitor. */
  const pubPost = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        host: PUBLIC_HOST,
        'content-type': 'application/json',
        cookie: `${SHARE_COOKIE}=${cookie}`,
      },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'report-link-share-'));
    handle = createServer({
      port: 0,
      dataDir,
      share: { config: { publicHostname: PUBLIC_HOST } },
    });
    base = `http://localhost:${handle.port}`;

    const ws = await post('/api/workspaces', { name: 'shared-board', goal: 'Ship it.' });
    boardId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    const t = await post(`/api/workspaces/${boardId}/tasks`, {
      title: 'Something to discuss',
      author: AGENT,
    });
    taskId = ((await t.json()) as { task: { id: string } }).task.id;

    const mint = await post('/api/share/link', { workspaceId: boardId, label: 'a share' });
    expect(mint.status).toBe(200);
    const slug = ((await mint.json()) as { share: { slug: string } }).share.slug;
    const redeemed = await fetch(`${base}/s/${slug}`, {
      redirect: 'manual',
      headers: { host: PUBLIC_HOST },
    });
    expect(redeemed.status).toBe(302);
    cookie = (redeemed.headers.get('set-cookie') ?? '').match(
      new RegExp(`${SHARE_COOKIE}=([^;]+)`),
    )?.[1] as string;
    expect(cookie).toBeTruthy();
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('the owner gets the link and the visitor gets none of it', async () => {
    const docId = `task:${taskId}`;
    // PRESENCE FIRST, on the same doc in the same pass: without it the
    // `undefined` below is equally consistent with a resolver that never
    // resolves anything for anyone, and the test would pass against a
    // feature that is simply broken.
    const ownerRes = await post(`/api/docs/${encodeURIComponent(docId)}/threads`, {
      author: AGENT,
      text: 'Owner-side report.',
      anchor: { kind: 'subject' },
    });
    expect(ownerRes.status).toBe(200);
    const owner = (await ownerRes.json()) as ThreadResponse;
    expect(owner.url).toContain(encodeURIComponent(boardId));

    const seen = await pubPost(`/api/docs/${encodeURIComponent(docId)}/threads`, {
      author: { id: 'visitor-1', name: 'Visitor', kind: 'anon', color: '#999999' },
      text: 'Visitor-side comment.',
      anchor: { kind: 'subject' },
    });
    expect(seen.status).toBe(200); // the visitor really can post here
    const raw = await seen.text();
    const visitor = JSON.parse(raw) as ThreadResponse;
    expect(visitor.thread?.id).toBeDefined(); // …and really got a thread back
    expect(visitor.url).toBeUndefined();
    // Belt and braces: the board id must not appear ANYWHERE in what they
    // got, not merely be absent from the field we remembered to strip.
    expect(raw).not.toContain(boardId);
  });
});
