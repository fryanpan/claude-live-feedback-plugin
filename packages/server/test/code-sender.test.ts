import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CodeSendRequest,
  type CodeSender,
  createLogCodeSender,
  loginCodeSubject,
  loginCodeText,
} from '../src/auth/code-sender.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A server with a sender a test controls, torn down after the test. */
function serverWith(codeSender: CodeSender): { base: string; handle: ServerHandle } {
  const dataDir = mkdtempSync(join(tmpdir(), 'code-sender-test-'));
  const handle = createServer({ port: 0, dataDir, codeSender });
  cleanups.push(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { base: `http://localhost:${handle.port}`, handle };
}

async function start(base: string, email: string): Promise<Response> {
  return await fetch(`${base}/api/auth/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
}

describe('the log sender', () => {
  it('prints the code, the recipient, and how long it lasts', async () => {
    const lines: string[] = [];
    await createLogCodeSender((l) => lines.push(l)).send({
      to: 'alice@example.com',
      code: '424242',
      expiresInMinutes: 10,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('alice@example.com');
    expect(lines[0]).toContain('424242');
    expect(lines[0]).toContain('10m');
  });

  it('is what the server uses when nothing else is passed', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'code-sender-default-'));
    const handle = createServer({ port: 0, dataDir });
    cleanups.push(async () => {
      await handle.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });
    const res = await start(`http://localhost:${handle.port}`, 'default@example.com');
    expect(res.status).toBe(200);
  });
});

describe('the message', () => {
  it('leads with the code, because that is what a notification shows', () => {
    expect(loginCodeSubject('424242')).toContain('424242');
    const body = loginCodeText({ to: 'a@example.com', code: '424242', expiresInMinutes: 10 });
    expect(body).toContain('424242');
    expect(body).toContain('10 minutes');
  });
});

describe('a send failure', () => {
  it('is a 502, never a silent 200', async () => {
    const { base } = serverWith({
      name: 'always-fails',
      async send(): Promise<void> {
        throw new Error('provider said no');
      },
    });
    const res = await start(base, 'unreachable@example.com');
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'code_send_failed' });
  });

  it('does not leak the code it failed to send', async () => {
    let attempted: CodeSendRequest | null = null;
    const { base } = serverWith({
      name: 'always-fails',
      async send(req: CodeSendRequest): Promise<void> {
        attempted = req;
        throw new Error('provider said no');
      },
    });
    const text = await (await start(base, 'unreachable@example.com')).text();
    const sent = attempted as CodeSendRequest | null;
    // Positive control for the search: there IS a six-digit code to look for.
    expect(sent?.code).toMatch(/^\d{6}$/);
    expect(text).not.toContain(sent?.code as string);
  });

  it('leaves the challenge usable, so a retry is not a dead end', async () => {
    let failNext = true;
    let lastCode = '';
    const { base } = serverWith({
      name: 'flaky',
      async send(req: CodeSendRequest): Promise<void> {
        lastCode = req.code;
        if (failNext) {
          failNext = false;
          throw new Error('transient');
        }
      },
    });
    expect((await start(base, 'flaky@example.com')).status).toBe(502);
    // The code minted by the FAILED send still verifies — nothing was
    // consumed by the provider's problem.
    const res = await fetch(`${base}/api/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'flaky@example.com', code: lastCode }),
    });
    expect(res.status).toBe(200);
  });
});

describe('what the sender is given', () => {
  it('is the normalized address, not what the caller typed', async () => {
    let seen: CodeSendRequest | null = null;
    const { base } = serverWith({
      name: 'capture',
      async send(req: CodeSendRequest): Promise<void> {
        seen = req;
      },
    });
    await start(base, '  Alice@Example.COM ');
    const sent = seen as CodeSendRequest | null;
    expect(sent?.to).toBe('alice@example.com');
    expect(sent?.expiresInMinutes).toBe(10);
  });

  it('is never called at all for an address that cannot be one', async () => {
    let calls = 0;
    const { base } = serverWith({
      name: 'counter',
      async send(): Promise<void> {
        calls += 1;
      },
    });
    expect((await start(base, 'alice')).status).toBe(400);
    expect(calls).toBe(0);
  });
});
