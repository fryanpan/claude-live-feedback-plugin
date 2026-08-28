import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESSION_COOKIE } from '../src/auth/session.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

/**
 * The sign-in UI's two server additions: `firstSignIn` on the verify
 * response (what routes a person to the display-name screen exactly once),
 * and `POST /api/auth/profile` (what that screen saves). Plus the /signin
 * shell the page is served from.
 *
 * Its own server: the sign-in flows here each burn starts and verifies from
 * the per-peer budget the routes suite already spends.
 */

let handle: ServerHandle;
let dataDir: string;
let base: string;
const logged: string[] = [];
let restoreLog: (() => void) | null = null;

beforeAll(() => {
  const original = console.log;
  restoreLog = () => {
    console.log = original;
  };
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    const m = line.match(/login code for (\S+): (\d{6})/);
    if (m?.[2]) logged.push(m[2]);
    original(...(args as []));
  };
  dataDir = mkdtempSync(join(tmpdir(), 'auth-profile-test-'));
  handle = createServer({ port: 0, dataDir });
  base = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  restoreLog?.();
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

async function start(email: string): Promise<void> {
  const res = await fetch(`${base}/api/auth/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  expect(res.status).toBe(200);
}

async function verify(email: string): Promise<Response> {
  return await fetch(`${base}/api/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, code: logged[logged.length - 1] }),
  });
}

function sessionCookie(res: Response): string {
  const header = res.headers.get('set-cookie') ?? '';
  const pair = header.split(';')[0] ?? '';
  expect(pair.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
  return pair;
}

async function setName(displayName: unknown, cookie?: string): Promise<Response> {
  return await fetch(`${base}/api/auth/profile`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ displayName }),
  });
}

describe('firstSignIn on POST /api/auth/verify', () => {
  it('is true exactly once — the display-name screen never re-asks', async () => {
    const email = 'first-time@example.com';
    await start(email);
    const first = (await (await verify(email)).json()) as { firstSignIn: boolean };
    expect(first.firstSignIn).toBe(true);
    await start(email);
    const again = (await (await verify(email)).json()) as { firstSignIn: boolean };
    expect(again.firstSignIn).toBe(false);
  });
});

describe('POST /api/auth/profile', () => {
  it('refuses without a session — a name write must prove who is writing', async () => {
    const res = await setName('Somebody');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'not_signed_in' });
  });

  it('renames only the session identity, and the name sticks across sign-ins', async () => {
    const email = 'renamer@example.com';
    await start(email);
    const cookie = sessionCookie(await verify(email));
    const res = await setName('Case E. Jones', cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, user: { name: 'Case E. Jones' } });
    // The session reads the chosen name back…
    const session = await fetch(`${base}/api/auth/session`, { headers: { cookie } });
    expect(await session.json()).toMatchObject({ user: { name: 'Case E. Jones' } });
    // …and a LATER sign-in must not reset it to the derived default.
    await start(email);
    const again = (await (await verify(email)).json()) as { user: { name: string } };
    expect(again.user.name).toBe('Case E. Jones');
  });

  it('refuses an empty or missing name', async () => {
    const email = 'no-name@example.com';
    await start(email);
    const cookie = sessionCookie(await verify(email));
    expect((await setName('   ', cookie)).status).toBe(400);
    expect((await setName(42, cookie)).status).toBe(400);
  });

  it('caps the stored name at the roster limit', async () => {
    const email = 'long-name@example.com';
    await start(email);
    const cookie = sessionCookie(await verify(email));
    const res = await setName('x'.repeat(80), cookie);
    const body = (await res.json()) as { user: { name: string } };
    expect(body.user.name.length).toBe(40);
  });
});

describe('GET /signin', () => {
  it('serves the shell that loads the sign-in bundle', async () => {
    const res = await fetch(`${base}/signin`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('id="signin-root"');
    expect(html).toContain('/app/signin.js');
    expect(html).toContain('/app/styles.css');
    // Bryan's rename — this UI names itself Fryanpan Workspaces everywhere.
    expect(html).toContain('Fryanpan Workspaces');
  });
});
