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
  it('attributes a cookie-carrying request exactly as it does today', async () => {
    const { base, dataDir } = boot();
    const cookie = await signIn(base, 'reviewer@example.com');
    await commentAsBryan(base, dataDir, 'flagoff-doc', cookie);
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
