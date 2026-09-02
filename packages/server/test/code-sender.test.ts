import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CodeSendRequest,
  type CodeSender,
  createLogCodeSender,
  loginCodeLoggingEnabled,
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
  const REQ: CodeSendRequest = {
    to: 'alice@example.com',
    code: '424242',
    expiresInMinutes: 10,
  };

  // `printCode` is passed explicitly on both sides rather than read from the
  // environment: `CW_LOG_LOGIN_CODES` is a process-wide variable other suites
  // in this run set for themselves, so a test that read the default would
  // pass or fail on which file ran first.
  it('MASKS the code by default: the recipient and the expiry, never the digits', async () => {
    // Whoever can read the service log could otherwise complete a sign-in for
    // any address they can start a challenge for, including the owner's.
    const lines: string[] = [];
    await createLogCodeSender((l) => lines.push(l), { printCode: false }).send(REQ);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('alice@example.com');
    expect(lines[0]).toContain('10m');
    expect(lines[0]).not.toContain('424242');
    // …and names the flag, so a developer who needs it is one variable away.
    expect(lines[0]).toContain('CW_LOG_LOGIN_CODES=1');
  });

  it('prints the code, the recipient, and how long it lasts when asked to', async () => {
    const lines: string[] = [];
    await createLogCodeSender((l) => lines.push(l), { printCode: true }).send(REQ);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('alice@example.com');
    expect(lines[0]).toContain('424242');
    expect(lines[0]).toContain('10m');
  });

  it('reads the flag off the environment when nothing is passed', async () => {
    // The default's own wiring, exercised through an injected env so it does
    // not depend on this process's.
    expect(loginCodeLoggingEnabled({ CW_LOG_LOGIN_CODES: '1' })).toBe(true);
    expect(loginCodeLoggingEnabled({ CW_LOG_LOGIN_CODES: 'yes' })).toBe(true);
    expect(loginCodeLoggingEnabled({})).toBe(false);
    expect(loginCodeLoggingEnabled({ CW_LOG_LOGIN_CODES: '0' })).toBe(false);
    expect(loginCodeLoggingEnabled({ CW_LOG_LOGIN_CODES: 'maybe' })).toBe(false);
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
