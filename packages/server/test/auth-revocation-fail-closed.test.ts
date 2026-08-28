/**
 * The whole-request proof of the fail-closed decision (Bryan, 2026-08-28):
 * a server booted over a revoked-sessions file it cannot read refuses EVERY
 * session cookie — even one it just minted — because an unreadable denylist
 * means no cookie can prove it was never revoked. A server whose data dir
 * simply has no denylist yet (every first boot) authenticates normally; the
 * two boot paths must stay distinguishable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESSION_COOKIE } from '../src/auth/session.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

let brokenHandle: ServerHandle;
let cleanHandle: ServerHandle;
let brokenDir: string;
let cleanDir: string;
/** Every login code this process logged — the log sender is the default. */
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
  brokenDir = mkdtempSync(join(tmpdir(), 'fail-closed-broken-'));
  cleanDir = mkdtempSync(join(tmpdir(), 'fail-closed-clean-'));
  // The file exists but does not parse — the boot path under test.
  writeFileSync(join(brokenDir, 'revoked-sessions.json'), 'not json{{{');
  brokenHandle = createServer({ port: 0, dataDir: brokenDir });
  cleanHandle = createServer({ port: 0, dataDir: cleanDir });
});

afterAll(async () => {
  restoreLog?.();
  await brokenHandle.stop();
  await cleanHandle.stop();
  rmSync(brokenDir, { recursive: true, force: true });
  rmSync(cleanDir, { recursive: true, force: true });
});

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

async function sessionState(base: string, cookie: string): Promise<{ authenticated: boolean }> {
  const res = await fetch(`${base}/api/auth/session`, { headers: { cookie } });
  return (await res.json()) as { authenticated: boolean };
}

describe('an unreadable revoked-sessions file fails the whole session layer closed', () => {
  it('refuses even a session the server itself just minted', async () => {
    const base = `http://localhost:${brokenHandle.port}`;
    const cookie = await login(base, 'closed@example.com');
    expect((await sessionState(base, cookie)).authenticated).toBe(false);
  });

  it('positive control: the same flow on a first-boot data dir (no file) authenticates', async () => {
    const base = `http://localhost:${cleanHandle.port}`;
    const cookie = await login(base, 'open@example.com');
    expect((await sessionState(base, cookie)).authenticated).toBe(true);
  });
});
