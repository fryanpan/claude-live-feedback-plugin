/**
 * One listener fronts the whole test run.
 *
 * A full `bun test packages/server/test` opened 626 `Bun.serve` listeners on
 * 2026-08-30 — one per test file, plus one per `beforeEach` — and each was its
 * own fetch origin with its own keep-alive pool and its own thirty-second
 * TIME_WAIT tail. Nine agents doing that at once took the machine's network
 * down for four and a half hours. shared-listener.ts collapses them onto one
 * real socket; this file is what keeps them collapsed.
 *
 * The assertion that matters is not "the servers answer" — they would answer
 * on dedicated listeners too, and this whole file would pass while proving
 * nothing. It is that two servers answering through the SAME real port still
 * answer for themselves: a board created against one lands in that one's
 * store and is absent from the other's. Routing by header is the only thing
 * standing between those two, so if the shim ever misroutes, this goes red.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import {
  sharedListenerPort,
  sharedListenerRegistrationCount,
  shouldShareListener,
} from '../src/shared-listener.ts';

/** macOS hands `port: 0` a number from here up; a virtual port never can. */
const EPHEMERAL_FLOOR = 49152;

describe('shouldShareListener', () => {
  it('shares only an ephemeral request, under a test runner', () => {
    expect(shouldShareListener(0, undefined)).toBe(true);
    expect(shouldShareListener(0, false)).toBe(true);
  });

  it('refuses the ports prod and staging name', () => {
    // The real guard against this ever engaging outside a test: prod is 8787
    // and staging is 8788, so neither can reach the shared branch even if
    // NODE_ENV were somehow 'test'.
    expect(shouldShareListener(8787, undefined)).toBe(false);
    expect(shouldShareListener(8788, undefined)).toBe(false);
    expect(shouldShareListener(undefined, undefined)).toBe(false);
  });

  it('honours a caller that asked for its own listener', () => {
    expect(shouldShareListener(0, true)).toBe(false);
  });

  it('honours the process-wide escape hatch', () => {
    const before = process.env.CW_DEDICATED_TEST_LISTENERS;
    process.env.CW_DEDICATED_TEST_LISTENERS = '1';
    try {
      expect(shouldShareListener(0, undefined)).toBe(false);
    } finally {
      if (before === undefined) Reflect.deleteProperty(process.env, 'CW_DEDICATED_TEST_LISTENERS');
      else process.env.CW_DEDICATED_TEST_LISTENERS = before;
    }
  });

  it('only engages under a test runner', () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(shouldShareListener(0, undefined)).toBe(false);
    } finally {
      process.env.NODE_ENV = before;
    }
  });
});

describe('two servers behind one real socket', () => {
  let dirA: string;
  let dirB: string;
  let dirOwn: string;
  let a: ServerHandle;
  let b: ServerHandle;
  let own: ServerHandle;

  beforeAll(async () => {
    dirA = mkdtempSync(join(tmpdir(), 'shared-listener-a-'));
    dirB = mkdtempSync(join(tmpdir(), 'shared-listener-b-'));
    dirOwn = mkdtempSync(join(tmpdir(), 'shared-listener-own-'));
    a = createServer({ port: 0, dataDir: dirA });
    b = createServer({ port: 0, dataDir: dirB });
    own = createServer({ port: 0, dataDir: dirOwn, dedicatedListener: true });
    await Promise.all([a.parkMigration, b.parkMigration, own.parkMigration]);
  });

  afterAll(async () => {
    await a.stop();
    await b.stop();
    await own.stop();
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
    rmSync(dirOwn, { recursive: true, force: true });
  });

  it('gives each a virtual port and binds only the front door', () => {
    const front = sharedListenerPort();
    expect(front).not.toBeNull();
    expect(front).toBeGreaterThanOrEqual(EPHEMERAL_FLOOR);
    expect(a.port).not.toBe(b.port);
    for (const p of [a.port, b.port]) {
      expect(p).toBeGreaterThanOrEqual(2000);
      expect(p).toBeLessThan(EPHEMERAL_FLOOR);
      expect(p).not.toBe(front);
    }
    expect(sharedListenerRegistrationCount()).toBeGreaterThanOrEqual(2);
  });

  /**
   * The positive control for everything above. `dedicatedListener: true` must
   * still bind for real — if it silently shared, the twenty files that talk to
   * the server over a websocket, an EventSource, a raw socket or a child
   * process would fail in ways that read as product bugs.
   */
  it('still binds a real ephemeral port when a caller opts out', () => {
    expect(own.port).toBeGreaterThanOrEqual(EPHEMERAL_FLOOR);
    expect(own.port).not.toBe(sharedListenerPort());
  });

  const makeBoard = async (handle: ServerHandle, name: string): Promise<string> => {
    const res = await fetch(`http://localhost:${handle.port}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, goal: 'Ship the index.' }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { workspace: { id: string } }).workspace.id;
  };

  it('routes a request to the server whose virtual port it named', async () => {
    const inA = await makeBoard(a, 'only-in-a');
    const inB = await makeBoard(b, 'only-in-b');

    const namesOf = (h: ServerHandle) => h.tasks.listWorkspaces().map((w) => w.name);
    expect(namesOf(a)).toContain('only-in-a');
    expect(namesOf(a)).not.toContain('only-in-b');
    expect(namesOf(b)).toContain('only-in-b');
    expect(namesOf(b)).not.toContain('only-in-a');
    expect(inA).not.toBe(inB);
  });

  it('reaches an opted-out server over its own socket, unshimmed', async () => {
    await makeBoard(own, 'only-in-own');
    expect(own.tasks.listWorkspaces().map((w) => w.name)).toContain('only-in-own');
    expect(a.tasks.listWorkspaces().map((w) => w.name)).not.toContain('only-in-own');
  });
});
