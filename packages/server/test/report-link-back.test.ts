/**
 * Posting a report hands back the link to where it landed.
 *
 * The measured problem this serves, from one 38-hour window on this
 * project's own board: 52,340 words — 40% of every word in the owner's chat
 * window — were agent-to-agent reports relayed through his terminal. Ninety-
 * nine of them, two single messages at 3,079 and 4,392 words, none addressed
 * to him. Each had an obvious correct home: the thread that asked.
 *
 * The rule telling agents to post there already ships, and did not prevent
 * it. Part of the reason is friction on the honest path: an agent that DOES
 * post its report then has to hand its peer a pointer, and the response it
 * just got back contained no link. It had to assemble the URL from parts
 * against a base it may not know — while replying in chat cost nothing. So
 * the cheap path was the wrong one.
 *
 * This closes that gap the way `reviewGapAdvice` closes its own: the thing
 * the author needs travels back on the success response. No new endpoint and
 * no second URL contract — `externalBaseUrl()` already exists precisely so an
 * operator override cannot reach some links and miss others, `taskDeepLink()`
 * owns the task path's shape, and `withReviewUrl` owns the doc path's.
 *
 * BOTH surfaces are covered on purpose. The thread that asked you for
 * something is very often a comment on a markdown review doc rather than a
 * task, so a version answering only for `task:` docs would hand back nothing
 * on the commonest reply path.
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
  threadUrl?: string;
  error?: string;
}

describe('a report comes back with the link to hand over', () => {
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

  const taskLink = (t: string) =>
    `${PUBLIC_BASE}/workspaces/${encodeURIComponent(wsId)}?task=${encodeURIComponent(t)}`;

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
    const body = await postSubjectThread(`task:${taskId}`, 'Deploy done: gates green.');
    // Absolute, and on the operator's public base — the whole point is that
    // it can be pasted somewhere else and still resolve. A relative path
    // would be useless to the peer it is being handed to.
    expect(body.threadUrl).toBe(taskLink(taskId));
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
    expect(body.threadUrl).toBe(taskLink(taskId));
  });

  it('by_find returns it as well — the third write site, and the odd one out', async () => {
    // This route builds its response from a differently-named local than the
    // other two, which makes it the site most likely to be miswired. It also
    // had no coverage at all until this case existed.
    // This route anchors to text, so the task body needs some first.
    const docId = `task:${taskId}`;
    const seeded = await post(`/api/docs/${encodeURIComponent(docId)}/content`, {
      markdown: '# Results page\n\nAnchor me here.\n',
    });
    expect(seeded.status).toBe(200);

    const r = await post(`/api/docs/${encodeURIComponent(docId)}/threads/by_find`, {
      author: AGENT,
      text: 'Filed from the by_find route.',
      find: 'Anchor me here.',
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as ThreadResponse;
    expect(body.thread?.id).toBeDefined();
    expect(body.threadUrl).toBe(taskLink(taskId));
  });

  it('POSITIVE CONTROL: the id in the link is THIS task, not any task', async () => {
    // Without this, a hardcoded or first-task link passes every assertion
    // above and sends every reader to the same wrong row.
    const second = await post(`/api/workspaces/${wsId}/tasks`, {
      title: 'A different piece of work',
      author: AGENT,
    });
    expect(second.status).toBe(200);
    const otherId = ((await second.json()) as { task: { id: string } }).task.id;
    expect(otherId).not.toBe(taskId);

    const body = await postSubjectThread(`task:${otherId}`, 'Report on the other one.');
    expect(body.threadUrl).toContain(encodeURIComponent(otherId));
    expect(body.threadUrl).not.toContain(encodeURIComponent(taskId));
  });

  it('a comment on a markdown doc gets the review URL — the commonest reply path', async () => {
    // The thread that asked you for something is usually a doc comment, not
    // a task. Answering only for `task:` docs would leave the most-travelled
    // path with no link and no fallback, which is the exact friction this
    // change exists to remove.
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
    expect(body.threadUrl).toBe(`${PUBLIC_BASE}/review/${encodeURIComponent(docId)}`);
  });

  it('a doc nobody has heard of gets no link rather than a broken one', async () => {
    // The spread is conditional so an unresolvable doc simply omits the
    // field. A link built anyway would point at a 404 and read as authoritative.
    const r = await post(`/api/docs/${encodeURIComponent('task:t-does-not-exist')}/threads`, {
      author: AGENT,
      text: 'Into the void.',
      anchor: { kind: 'subject' },
    });
    const body = (await r.json()) as ThreadResponse;
    expect(body.threadUrl).toBeUndefined();
  });
});

describe('the handoff link is owner-only', () => {
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

  it('the owner gets the link and the visitor does not', async () => {
    // What this pins is narrower than it looks, and worth stating exactly.
    // Per-doc shares were removed — `POST /api/share/link` answers 410
    // `per_doc_sharing_removed` for any body naming a docId — so every
    // visitor that can reach this route is workspace-scoped and ALREADY
    // holds the board id. This is not a closed leak; it is the guard holding
    // for a visitor who happens to have the id anyway, so that the default
    // is already right on the day doc-scoped visitors come back.
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
    expect(owner.threadUrl).toContain(encodeURIComponent(boardId));

    const seen = await pubPost(`/api/docs/${encodeURIComponent(docId)}/threads`, {
      author: { id: 'visitor-1', name: 'Visitor', kind: 'anon', color: '#999999' },
      text: 'Visitor-side comment.',
      anchor: { kind: 'subject' },
    });
    expect(seen.status).toBe(200); // the visitor really can post here
    const raw = await seen.text();
    const visitor = JSON.parse(raw) as ThreadResponse;
    expect(visitor.thread?.id).toBeDefined(); // …and really got a thread back
    expect(visitor.threadUrl).toBeUndefined();
    // Belt and braces: the board id must not appear ANYWHERE in what they
    // got, not merely be absent from the field we remembered to strip.
    expect(raw).not.toContain(boardId);
  });
});
