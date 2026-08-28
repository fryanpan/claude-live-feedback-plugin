/**
 * The abuse ceilings on `/api/auth/start`, at the HTTP layer.
 *
 * `email-code.test.ts` pins the counting. This file pins the two halves the
 * route owns: a tripped ceiling answers EXACTLY like a success — same status,
 * same body shape — while no mail is handed to the sender, and the refusal
 * lands loudly in the server log. A 429 here would hand an attacker a
 * progress meter for a mail-bomb; the 200 hands them nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodeSendRequest, CodeSender } from '../src/auth/code-sender.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

/** A sender that records instead of delivering — the seam the route trusts. */
function captureSender(): { sender: CodeSender; sent: CodeSendRequest[] } {
  const sent: CodeSendRequest[] = [];
  return {
    sent,
    sender: {
      name: 'capture',
      send: async (req) => {
        sent.push(req);
      },
    },
  };
}

async function startAt(base: string, email: string, xff?: string): Promise<Response> {
  return await fetch(`${base}/api/auth/start`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(xff ? { 'x-forwarded-for': xff } : {}),
    },
    body: JSON.stringify({ email }),
  });
}

describe('the global sends-per-hour ceiling', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  const capture = captureSender();
  const errors: string[] = [];
  let restoreError: (() => void) | null = null;

  beforeAll(() => {
    const original = console.error;
    restoreError = () => {
      console.error = original;
    };
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
      original(...(args as []));
    };
    dataDir = mkdtempSync(join(tmpdir(), 'auth-ceiling-global-test-'));
    handle = createServer({
      port: 0,
      dataDir,
      codeSender: capture.sender,
      authCeilings: { globalStartsPerHour: 2 },
    });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    restoreError?.();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('answers a tripped ceiling exactly like a success, and mails nothing', async () => {
    // Distinct emails AND distinct forwarded peers, so no other limit fires.
    const real = await startAt(base, 'one@example.com', '203.0.113.1');
    expect(real.status).toBe(200);
    const realBody = (await real.json()) as Record<string, unknown>;
    await startAt(base, 'two@example.com', '203.0.113.2');
    expect(capture.sent.length).toBe(2);

    const tripped = await startAt(base, 'Three@Example.com', '203.0.113.3');
    expect(tripped.status).toBe(200);
    const body = (await tripped.json()) as Record<string, unknown>;
    // Same keys as the real success, and the same normalization discipline.
    expect(Object.keys(body).sort()).toEqual(Object.keys(realBody).sort());
    expect(body).toMatchObject({ ok: true, email: 'three@example.com' });
    expect(body.expiresInSeconds as number).toBeGreaterThan(0);
    // But nothing was handed to the sender.
    expect(capture.sent.length).toBe(2);
    // And the refusal is loud where the operator reads.
    expect(errors.some((line) => line.includes('ceiling'))).toBe(true);
  });
});

describe('the per-peer sends-per-hour ceiling', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  const capture = captureSender();

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'auth-ceiling-peer-test-'));
    handle = createServer({
      port: 0,
      dataDir,
      codeSender: capture.sender,
      authCeilings: { globalStartsPerHour: 1000, peerStartsPerHour: 2 },
    });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('caps one peer without touching another, and stays indistinguishable', async () => {
    await startAt(base, 'a@example.com', '203.0.113.10');
    await startAt(base, 'b@example.com', '203.0.113.10');
    expect(capture.sent.length).toBe(2);

    const tripped = await startAt(base, 'c@example.com', '203.0.113.10');
    expect(tripped.status).toBe(200);
    expect(await tripped.json()).toMatchObject({ ok: true, email: 'c@example.com' });
    expect(capture.sent.length).toBe(2);

    // Positive control: a different peer still gets real mail.
    const other = await startAt(base, 'd@example.com', '203.0.113.11');
    expect(other.status).toBe(200);
    expect(capture.sent.length).toBe(3);
  });
});
