/**
 * The whole-request proof of the fail-closed decision (Bryan, 2026-08-28,
 * refined by security review the same day): a server booted over a
 * revoked-sessions file it cannot read must not let any pre-existing session
 * keep validating — a revoked id could be hiding in the unreadable file. It
 * self-heals rather than locking up: every outstanding session is ended
 * through the roster's sessionsValidFrom watermark, the broken file is moved
 * aside as evidence, and the denylist restarts empty — so old cookies die,
 * new logins work, and nothing revoked can resurrect. A denylist deleted at
 * runtime fails closed outright. A data dir with no denylist yet (every
 * first boot) authenticates normally.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESSION_COOKIE } from '../src/auth/session.ts';
import { createServer } from '../src/server.ts';

/** Every login code this process logged — the log sender is the default. */
const logged: string[] = [];
let restoreLog: (() => void) | null = null;
const dirs: string[] = [];

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
});

afterAll(() => {
  restoreLog?.();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'fail-closed-e2e-'));
  dirs.push(d);
  return d;
}

/** Run the email login flow against one server and return the session cookie. */
async function login(base: string, email: string): Promise<string> {
  const start = await fetch(`${base}/api/auth/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  expect(start.status).toBe(200);
  const code = logged[logged.length - 1] as string;
  const verify = await fetch(`${base}/api/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, code }),
  });
  expect(verify.status).toBe(200);
  const pair = (verify.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  expect(pair.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
  return pair;
}

async function authenticated(base: string, cookie: string): Promise<boolean> {
  const res = await fetch(`${base}/api/auth/session`, { headers: { cookie } });
  return ((await res.json()) as { authenticated: boolean }).authenticated;
}

describe('an unreadable revoked-sessions file self-heals by ending every session', () => {
  it('kills pre-existing cookies via the watermark, then lets people sign back in', async () => {
    const dataDir = freshDir();

    // A healthy first boot: the denylist file is created eagerly and a
    // session works — the positive control for everything below.
    const first = createServer({ port: 0, dataDir });
    const base1 = `http://localhost:${first.port}`;
    const oldCookie = await login(base1, 'healed@example.com');
    expect(await authenticated(base1, oldCookie)).toBe(true);
    expect(existsSync(join(dataDir, 'revoked-sessions.json'))).toBe(true);
    await first.stop();

    // The denylist rots on disk between boots.
    writeFileSync(join(dataDir, 'revoked-sessions.json'), 'not json{{{');

    const second = createServer({ port: 0, dataDir });
    const base2 = `http://localhost:${second.port}`;
    try {
      // The old cookie still verifies cryptographically (same key file),
      // but the boot-time watermark bump ended it: a revoked id could be
      // hiding in the unreadable file, so every pre-boot session dies.
      expect(await authenticated(base2, oldCookie)).toBe(false);
      // Self-healed, not locked out: a fresh login on the same identity
      // works immediately.
      const newCookie = await login(base2, 'healed@example.com');
      expect(await authenticated(base2, newCookie)).toBe(true);
      // And the broken file was kept aside as evidence.
      expect(readdirSync(dataDir).some((f) => f.includes('corrupt'))).toBe(true);
    } finally {
      await second.stop();
    }
  });

  it('a denylist deleted at runtime refuses sessions outright', async () => {
    const dataDir = freshDir();
    const handle = createServer({ port: 0, dataDir });
    const base = `http://localhost:${handle.port}`;
    try {
      const cookie = await login(base, 'runtime-delete@example.com');
      expect(await authenticated(base, cookie)).toBe(true);
      rmSync(join(dataDir, 'revoked-sessions.json'));
      expect(await authenticated(base, cookie)).toBe(false);
    } finally {
      await handle.stop();
    }
  });
});
