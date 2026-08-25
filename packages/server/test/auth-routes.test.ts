import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emailIdentityId } from '@feedback/core';
import { MAX_ATTEMPTS, MAX_STARTS_PER_EMAIL } from '../src/auth/email-code.ts';
import { SESSION_COOKIE } from '../src/auth/session.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

let handle: ServerHandle;
let dataDir: string;
let base: string;
/** Every code this server logged, in order — the log sender is the default. */
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
  dataDir = mkdtempSync(join(tmpdir(), 'auth-routes-test-'));
  handle = createServer({ port: 0, dataDir });
  base = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  restoreLog?.();
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

async function start(email: string): Promise<Response> {
  return await fetch(`${base}/api/auth/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
}

async function verify(email: string, code: string, cookie?: string): Promise<Response> {
  return await fetch(`${base}/api/auth/verify`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ email, code }),
  });
}

/** The `cw_session=…` pair from a Set-Cookie header, ready to send back. */
function sessionCookie(res: Response): string {
  const header = res.headers.get('set-cookie') ?? '';
  const pair = header.split(';')[0] ?? '';
  expect(pair.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
  return pair;
}

describe('POST /api/auth/start', () => {
  it('accepts an address and never puts the code in the response', async () => {
    const before = logged.length;
    const res = await start('start-secrecy@example.com');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(logged.length).toBe(before + 1);
    const code = logged[logged.length - 1] as string;
    // The needle is a whole six-digit code that we know exists — a positive
    // control for the search itself, not just a grep that found nothing.
    expect(code).toMatch(/^\d{6}$/);
    expect(text).not.toContain(code);
    expect(JSON.parse(text)).toMatchObject({ ok: true, email: 'start-secrecy@example.com' });
    // Nor in any header — a 302 or a cookie would be just as public.
    expect(JSON.stringify([...res.headers])).not.toContain(code);
  });

  it('refuses something that is not an address', async () => {
    const res = await start('alice');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_email' });
  });

  it('rate-limits an address and says how long to wait', async () => {
    const email = 'flooded@example.com';
    for (let i = 0; i < MAX_STARTS_PER_EMAIL; i++) {
      expect((await start(email)).status).toBe(200);
    }
    const res = await start(email);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(await res.json()).toMatchObject({ error: 'rate_limited' });
  });
});

describe('POST /api/auth/verify', () => {
  it('mints a session for the right code, and the identity is the derived one', async () => {
    const email = 'verify-ok@example.com';
    await start(email);
    const res = await verify(email, logged[logged.length - 1] as string);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; user: { id: string; name: string } };
    expect(body.user.id).toBe(emailIdentityId(email));
    expect(body.user.name).toBe('Verify Ok');
    const cookie = sessionCookie(res);
    const session = await fetch(`${base}/api/auth/session`, { headers: { cookie } });
    expect(await session.json()).toMatchObject({
      authenticated: true,
      required: false,
      user: { id: emailIdentityId(email) },
    });
  });

  it('refuses a wrong code without minting anything', async () => {
    const email = 'verify-wrong@example.com';
    await start(email);
    const res = await verify(email, '000000');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'invalid_code' });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('refuses a code for an address that never asked', async () => {
    const res = await verify('never-asked@example.com', '123456');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'no_challenge' });
  });

  it('locks the challenge out after the attempt ceiling', async () => {
    const email = 'verify-grind@example.com';
    await start(email);
    const real = logged[logged.length - 1] as string;
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      expect((await verify(email, '000000')).status).toBe(401);
    }
    expect((await verify(email, '000000')).status).toBe(429);
    // Positive control: the code that WOULD have worked no longer does.
    expect((await verify(email, real)).status).toBe(401);
  });
});

describe('the session cookie', () => {
  it('is HttpOnly and carries no Secure over plain http', async () => {
    const email = 'cookie-flags@example.com';
    await start(email);
    const res = await verify(email, logged[logged.length - 1] as string);
    const header = res.headers.get('set-cookie') ?? '';
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    // The test server is reached over plain http. Hardcoding Secure here is
    // exactly the bug that would make http sessions vanish silently.
    expect(header).not.toContain('Secure');
  });

  it('carries Secure when the request arrived over https through a proxy', async () => {
    const email = 'cookie-https@example.com';
    await start(email);
    const res = await fetch(`${base}/api/auth/verify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({ email, code: logged[logged.length - 1] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('; Secure');
  });

  it('is not fooled by an injected forwarded scheme', async () => {
    const email = 'cookie-injection@example.com';
    await start(email);
    const res = await fetch(`${base}/api/auth/verify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Not in the allowlist `policyFor` applies, so it must be ignored
        // rather than concatenated into an origin.
        'x-forwarded-proto': 'https://evil.example.com#',
      },
      body: JSON.stringify({ email, code: logged[logged.length - 1] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).not.toContain('Secure');
  });

  it('is refused once its identity is archived', async () => {
    const email = 'archived-session@example.com';
    await start(email);
    const cookie = sessionCookie(await verify(email, logged[logged.length - 1] as string));
    // Archive through the roster on disk the running server already loaded —
    // so go through the store the server itself holds by restarting it.
    const { Identities } = await import('../src/identities.ts');
    const store = new Identities({ dataDir });
    store.archive(emailIdentityId(email), 'test');
    const fresh = createServer({ port: 0, dataDir });
    try {
      const res = await fetch(`http://localhost:${fresh.port}/api/auth/session`, {
        headers: { cookie },
      });
      expect(await res.json()).toMatchObject({ authenticated: false });
    } finally {
      await fresh.stop();
    }
  });

  it('is refused after the identity revokes its sessions', async () => {
    const email = 'revoked-session@example.com';
    await start(email);
    const cookie = sessionCookie(await verify(email, logged[logged.length - 1] as string));
    const { Identities } = await import('../src/identities.ts');
    // A watermark in the future stands in for "revoked after this cookie was
    // minted" without a test having to sleep.
    const store = new Identities({ dataDir, now: () => Date.now() + 60_000 });
    store.revokeSessions(emailIdentityId(email));
    const fresh = createServer({ port: 0, dataDir });
    try {
      const res = await fetch(`http://localhost:${fresh.port}/api/auth/session`, {
        headers: { cookie },
      });
      expect(await res.json()).toMatchObject({ authenticated: false });
      // Positive control: an un-revoked identity on the same server is fine.
      await fetch(`http://localhost:${fresh.port}/api/auth/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'control@example.com' }),
      });
      const ctl = await fetch(`http://localhost:${fresh.port}/api/auth/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'control@example.com', code: logged[logged.length - 1] }),
      });
      expect(ctl.status).toBe(200);
    } finally {
      await fresh.stop();
    }
  });

  it('is refused when it was signed with another key', async () => {
    const forged = `${SESSION_COOKIE}=v1.${emailIdentityId('alice@example.com')}.1.99999999999999.notamac`;
    const res = await fetch(`${base}/api/auth/session`, { headers: { cookie: forged } });
    expect(await res.json()).toMatchObject({ authenticated: false });
  });
});

describe('GET /api/auth/session', () => {
  it('answers plainly with no cookie at all', async () => {
    const res = await fetch(`${base}/api/auth/session`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ required: false, authenticated: false });
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the cookie in this browser', async () => {
    const email = 'logout@example.com';
    await start(email);
    const cookie = sessionCookie(await verify(email, logged[logged.length - 1] as string));
    const res = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(200);
    const header = res.headers.get('set-cookie') ?? '';
    expect(header).toContain(`${SESSION_COOKIE}=;`);
    expect(header).toContain('Max-Age=0');
  });
});
