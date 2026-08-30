/**
 * `handle.stop()` closes the connections it already has, not just the door.
 *
 * Bun's `server.stop()` stops ACCEPTING and leaves every open connection
 * alive — keep-alive HTTP and websockets both. This server starts and stops
 * hundreds of times in a test run, and each stop used to leave its sockets
 * behind: measured 2026-08-30, +733 kernel PCBs per run of the server suite
 * (`sysctl -n net.inet.tcp.pcbcount`, before/after, against a +2 idle control
 * over the same 260s). A night of parallel runs took the whole machine to
 * ENOBUFS — every process on the box refused a socket for 4.5 hours, and only
 * a reboot cleared it.
 *
 * So what is asserted here is the CONNECTION, not the listener. A test that
 * only checked "a new request is refused after stop" passes on the leaking
 * build, because refusing new connections is exactly the half `stop()` did.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

const dataDirs: string[] = [];

function boot(): ServerHandle {
  const dataDir = mkdtempSync(join(tmpdir(), 'cw-stop-sockets-'));
  dataDirs.push(dataDir);
  return createServer({ port: 0, dataDir });
}

afterEach(() => {
  for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Polls a predicate rather than sleeping a fixed time, so a pass costs the
 *  real close latency and a failure is still reported as the miss it is. */
async function within(ms: number, done: () => boolean): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (done()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return done();
}

describe('stopping the server closes its open connections', () => {
  it('a keep-alive HTTP connection is closed, not left to idle out', async () => {
    const handle = boot();
    let closed = false;
    const received: string[] = [];
    const sock = await Bun.connect({
      hostname: '127.0.0.1',
      port: handle.port,
      socket: {
        data: (_s, chunk) => {
          received.push(new TextDecoder().decode(chunk));
        },
        close: () => {
          closed = true;
        },
        error: () => {
          closed = true;
        },
      },
    });
    sock.write('GET /api/workspaces HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');
    // The control the whole test rests on: a request completed AND the socket
    // is still open afterwards. That is what a keep-alive connection is, and
    // it is the thing the leak leaves behind. If this half fails the assert
    // below proves nothing.
    expect(await within(5_000, () => received.join('').includes('200'))).toBe(true);
    expect(closed).toBe(false);

    await handle.stop();

    expect(await within(5_000, () => closed)).toBe(true);
    sock.end();
  });

  it('an open websocket is closed', async () => {
    const handle = boot();
    // Mockup docs are the one type a socket may create, which is why this
    // reaches an open room without an API call first.
    const ws = new WebSocket(`ws://localhost:${handle.port}/y/stop-sockets-mock?type=mockup`);
    let closed = false;
    ws.addEventListener('close', () => {
      closed = true;
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('socket never opened')));
    });
    // Control: open, and staying open on its own.
    expect(await within(200, () => closed)).toBe(false);

    await handle.stop();

    expect(await within(5_000, () => closed)).toBe(true);
  });
});
