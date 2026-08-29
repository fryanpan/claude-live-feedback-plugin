/**
 * The server owns authorship.
 *
 * `authorFor` used to be commented "the body is trusted", and it was: `?as=`
 * on any URL minted `known-bryan`, and `kind: 'known'` meant "typed a name"
 * rather than "verified". These tests pin the new rule and, just as
 * importantly, pin what did NOT change — a request with no session cookie has
 * to behave exactly as it does today whichever way the flag is set, because
 * that is every agent and every MCP call in the fleet.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ElementAnchor, type User, emailIdentityId } from '@feedback/core';
import { activityLogPath, resetOwnerIdentities } from '../src/activity.ts';
import { SESSION_COOKIE } from '../src/auth/session.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const bryan: User = { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' };

const fakeAnchor: ElementAnchor = {
  kind: 'element',
  fingerprint: {
    tag: 'BUTTON',
    stableAttrs: {},
    classes: [],
    text: 'Go',
    path: 'BUTTON[0] > BODY[0]',
    dataAttrs: {},
  },
  snippet: { text: 'Go' },
};

interface ActivityRow {
  type: string;
  actorId: string;
  actorName: string;
  isOwner: boolean;
  doc: { docId: string };
}

const cleanups: Array<() => void | Promise<void>> = [];
const codes: string[] = [];
const originalLog = console.log;
console.log = (...args: unknown[]) => {
  const m = args
    .map(String)
    .join(' ')
    .match(/login code for \S+: (\d{6})/);
  if (m?.[1]) codes.push(m[1]);
  originalLog(...(args as []));
};

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  resetOwnerIdentities();
});

function boot(options: { requireEmailAuth?: boolean; ownerEmail?: string } = {}): {
  base: string;
  dataDir: string;
  handle: ServerHandle;
} {
  const dataDir = mkdtempSync(join(tmpdir(), 'auth-authorship-'));
  const handle = createServer({ port: 0, dataDir, ...options });
  cleanups.push(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { base: `http://localhost:${handle.port}`, dataDir, handle };
}

/** Sign in and return the cookie pair to send back. */
async function signIn(base: string, email: string): Promise<string> {
  const before = codes.length;
  const started = await fetch(`${base}/api/auth/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  expect(started.status).toBe(200);
  expect(codes.length).toBe(before + 1);
  const res = await fetch(`${base}/api/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, code: codes[codes.length - 1] }),
  });
  expect(res.status).toBe(200);
  const pair = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  expect(pair.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
  return pair;
}

/** Bind a doc and post a thread on it, claiming to be Bryan. */
async function commentAsBryan(
  base: string,
  dataDir: string,
  docId: string,
  cookie?: string,
): Promise<void> {
  const file = join(dataDir, `${docId}.md`);
  writeFileSync(file, '# Heading\n\nSome prose to comment on.\n');
  const created = await fetch(`${base}/api/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ docId, type: 'markdown', sourceUrl: file }),
  });
  expect(created.status).toBe(200);
  const res = await fetch(`${base}/api/docs/${docId}/threads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ author: bryan, text: 'this needs more detail', anchor: fakeAnchor }),
  });
  expect(res.status).toBe(200);
}

function rowsFor(dataDir: string, type: string): ActivityRow[] {
  return readFileSync(activityLogPath(dataDir), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as ActivityRow)
    .filter((r) => r.type === type);
}

describe('with CW_REQUIRE_EMAIL_AUTH on', () => {
  it('records the verified identity, not the identity the body claimed', async () => {
    const { base, dataDir } = boot({ requireEmailAuth: true });
    const cookie = await signIn(base, 'reviewer@example.com');
    await commentAsBryan(base, dataDir, 'owned-doc', cookie);
    const [row] = rowsFor(dataDir, 'comment');
    // The body said known-bryan. The cookie said otherwise, and the cookie is
    // the thing the server can check.
    expect(row?.actorId).toBe(emailIdentityId('reviewer@example.com'));
    expect(row?.actorName).toBe('Reviewer');
  });

  it('still trusts the body when there is no session at all', async () => {
    const { base, dataDir } = boot({ requireEmailAuth: true });
    await commentAsBryan(base, dataDir, 'unauthed-doc');
    // The compatibility guarantee: every agent and every MCP call in the
    // fleet lands here, and the flag must not change what happens to them.
    expect(rowsFor(dataDir, 'comment')[0]?.actorId).toBe('known-bryan');
  });

  it('ignores a session cookie that does not verify', async () => {
    const { base, dataDir } = boot({ requireEmailAuth: true });
    const forged = `${SESSION_COOKIE}=v1.${emailIdentityId('mallory@example.com')}.1.99999999999999.nope`;
    await commentAsBryan(base, dataDir, 'forged-doc', forged);
    expect(rowsFor(dataDir, 'comment')[0]?.actorId).toBe('known-bryan');
  });
});

describe('with the flag off (the default)', () => {
  it('a verified session still wins over the claimed body — the flag governs REQUIREMENT, not attribution', async () => {
    // Bryan, 2026-08-29: a verified name is never worse than a typed one.
    // Signing in without the requirement on used to change nothing about
    // who a comment was attributed to, so the browser kept minting anon-*
    // for a person the server had just verified.
    const { base, dataDir } = boot();
    const cookie = await signIn(base, 'reviewer@example.com');
    await commentAsBryan(base, dataDir, 'flagoff-doc', cookie);
    const [row] = rowsFor(dataDir, 'comment');
    expect(row?.actorId).toBe(emailIdentityId('reviewer@example.com'));
    expect(row?.actorName).toBe('Reviewer');
    // On the thread too, not only in the activity stream.
    const listed = await fetch(`${base}/api/docs/flagoff-doc/threads`);
    const { threads } = (await listed.json()) as {
      threads: Array<{ comments: Array<{ author: { id: string; name: string } }> }>;
    };
    expect(threads[0]?.comments[0]?.author).toMatchObject({
      id: emailIdentityId('reviewer@example.com'),
      name: 'Reviewer',
    });
  });

  it('POSITIVE CONTROL: with no cookie the body is trusted, flag off', async () => {
    const { base, dataDir } = boot();
    await commentAsBryan(base, dataDir, 'flagoff-nocookie-doc');
    expect(rowsFor(dataDir, 'comment')[0]?.actorId).toBe('known-bryan');
  });
});

describe('owner recognition survives the rename', () => {
  it('counts the owner email identity as the owner', async () => {
    const { base, dataDir } = boot({
      requireEmailAuth: true,
      ownerEmail: 'owner@example.com',
    });
    const cookie = await signIn(base, 'owner@example.com');
    await commentAsBryan(base, dataDir, 'owner-doc', cookie);
    const [row] = rowsFor(dataDir, 'comment');
    expect(row?.actorId).toBe(emailIdentityId('owner@example.com'));
    // The whole point. Hardcoded to `known-bryan`, this reads false and
    // NOTHING reports it — the owner-activity view just goes quiet.
    expect(row?.isOwner).toBe(true);
  });

  it('negative control: another signed-in person is not the owner', async () => {
    const { base, dataDir } = boot({
      requireEmailAuth: true,
      ownerEmail: 'owner@example.com',
    });
    const cookie = await signIn(base, 'somebody-else@example.com');
    await commentAsBryan(base, dataDir, 'other-doc', cookie);
    expect(rowsFor(dataDir, 'comment')[0]?.isOwner).toBe(false);
  });
});

/**
 * A category is not an author. `known-agent` is what every session launched
 * without CW_AGENT_NAME collapses into — 1,031 comments on the live corpus
 * are signed by it and belong to nobody in particular. Tasks already refuse
 * it as an owner; the comment routes accepted it, which is how the seat and
 * the comment log stayed out of step. Refused loudly, with the fix named.
 */
describe('comment routes refuse the shared "agent" identity', () => {
  const unnamed: User = { id: 'known-agent', name: 'Agent', kind: 'known', color: '#e36f1e' };
  const named: User = { id: 'agent-relay', name: 'Relay', kind: 'known', color: '#888888' };

  async function bindDoc(base: string, dataDir: string, docId: string): Promise<void> {
    const file = join(dataDir, `${docId}.md`);
    writeFileSync(file, '# Heading\n\nSome prose to comment on.\n');
    const created = await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId, type: 'markdown', sourceUrl: file }),
    });
    expect(created.status).toBe(200);
  }
  const post = (base: string, path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('refuses a thread, a reply, and a resolve signed by the category, naming CW_AGENT_NAME', async () => {
    const { base, dataDir } = boot();
    await bindDoc(base, dataDir, 'refused-doc');
    const refused = await post(base, '/api/docs/refused-doc/threads', {
      author: unnamed,
      text: 'anonymous words',
      anchor: fakeAnchor,
    });
    expect(refused.status).toBe(400);
    const body = (await refused.json()) as { error: string; message: string };
    expect(body.error).toBe('author-required');
    expect(body.message).toContain('CW_AGENT_NAME');

    // POSITIVE CONTROL: the named agent posts the same thread.
    const okRes = await post(base, '/api/docs/refused-doc/threads', {
      author: named,
      text: 'named words',
      anchor: fakeAnchor,
    });
    expect(okRes.status).toBe(200);
    const { thread } = (await okRes.json()) as { thread: { id: string } };

    const reply = await post(base, `/api/docs/refused-doc/threads/${thread.id}/comments`, {
      author: unnamed,
      text: 'anonymous reply',
    });
    expect(reply.status).toBe(400);
    expect(((await reply.json()) as { error: string }).error).toBe('author-required');

    const resolve = await post(base, `/api/docs/refused-doc/threads/${thread.id}/resolve`, {
      author: unnamed,
    });
    expect(resolve.status).toBe(400);

    // Nothing from the category landed; the named reply does.
    const namedReply = await post(base, `/api/docs/refused-doc/threads/${thread.id}/comments`, {
      author: named,
      text: 'named reply',
    });
    expect(namedReply.status).toBe(200);
    const listed = await fetch(`${base}/api/docs/refused-doc/threads`);
    const { threads } = (await listed.json()) as {
      threads: Array<{ comments: Array<{ author: { id: string }; text: string }> }>;
    };
    expect(threads).toHaveLength(1);
    expect(threads[0]?.comments.map((c) => c.author.id)).toEqual(['agent-relay', 'agent-relay']);
    expect(rowsFor(dataDir, 'comment').map((r) => r.actorId)).toEqual(['agent-relay']);
  });

  it('also refuses the bare NAME "agent" under any id — the word is the category', async () => {
    const { base, dataDir } = boot();
    await bindDoc(base, dataDir, 'bare-name-doc');
    const refused = await post(base, '/api/docs/bare-name-doc/threads', {
      author: { id: 'agent-x1', name: 'agent', kind: 'known' },
      text: 'words',
      anchor: fakeAnchor,
    });
    expect(refused.status).toBe(400);
  });
});
