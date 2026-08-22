/**
 * The restore notice has to reach the SESSION, not merely the wire.
 *
 * Measured 2026-08-20: a respawned peer with 26 watches confirmed
 * `restore.status: 'restored'` inside a `list_watched_docs` result and never
 * saw the `watches.restored` frame in its context — while `agent.attached`
 * frames from the same session start did arrive. The difference is WHEN each
 * one is written: `ensureWatchesRestored` is kicked off at `oninitialized`,
 * but the first tool call awaits the same in-flight promise, so the notice is
 * written to stdout in the window between a `tools/call` request and its
 * response. `agent.attached` rides an SSE loop and lands outside that window.
 *
 * This test measures that window directly. It runs the real MCP server over
 * stdio against a stub feedback server whose `/watches` answer is deliberately
 * slow, so the restore reliably completes while a tool call is in flight — the
 * respawned peer's exact shape. The assertion is ordering on the wire: the
 * `watches.restored` notification must not be written between the tool-call
 * request and its response.
 *
 * The positive control is an `agent.attached` frame pushed on the SSE stream
 * AFTER the tool call has answered. It proves this probe can see a channel
 * notification at all, so a missing `watches.restored` is a real absence
 * rather than a blind harness.
 *
 * All fixtures synthetic; nothing here touches the real server or its data.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { type Server, createServer } from 'node:http';
import { type AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const MCP_ENTRY = resolve(__dirname, '../src/mcp.ts');

/** Long enough that the first tool call is always still in flight when the
 *  restore finishes, short enough to keep the test quick. */
const WATCHES_DELAY_MS = 400;
/** When the stub pushes the positive-control frame — comfortably after the
 *  tool call has been answered. */
const CONTROL_FRAME_AT_MS = 1_400;

interface Received {
  /** Order of arrival on stdout. */
  index: number;
  id?: number;
  method?: string;
  event?: string;
}

interface Harness {
  child: ChildProcess;
  http: Server;
  received: Received[];
  send: (msg: unknown) => void;
  waitFor: (pred: (r: Received) => boolean, timeoutMs?: number) => Promise<Received>;
}

let harness: Harness | undefined;

afterEach(async () => {
  if (!harness) return;
  harness.child.kill('SIGKILL');
  await new Promise<void>((r) => harness?.http.close(() => r()));
  harness = undefined;
});

/** A stub feedback server: a slow watch set, one SSE stream that stays open
 *  and pushes the control frame on a timer, and `{}` for everything else. */
function startStubServer(): Promise<Server> {
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    if (/^\/api\/agents\/[^/]+\/watches$/.test(url) && req.method === 'GET') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ watches: [{ key: 'doc-alpha' }], pruned: [], workspaces: [] }));
      }, WATCHES_DELAY_MS);
      return;
    }
    if (url.startsWith('/events/')) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': ok\n\n');
      const timer = setTimeout(() => {
        res.write(
          'id: stub:1\nevent: agent.attached\n' +
            'data: {"event":"agent.attached","workspaceId":"w-stub","agentId":"probe"}\n\n',
        );
      }, CONTROL_FRAME_AT_MS);
      req.on('close', () => clearTimeout(timer));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

async function startHarness(): Promise<Harness> {
  const http = await startStubServer();
  const port = (http.address() as AddressInfo).port;
  const child = spawn('bun', ['run', MCP_ENTRY], {
    env: {
      ...process.env,
      CW_BASE_URL: `http://127.0.0.1:${port}`,
      CW_AGENT_NAME: 'Restore Probe',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const received: Received[] = [];
  const waiters: Array<{ pred: (r: Received) => boolean; resolve: (r: Received) => void }> = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.length > 0) {
        try {
          const msg = JSON.parse(line) as {
            id?: number;
            method?: string;
            params?: { meta?: { event?: string } };
          };
          const rec: Received = {
            index: received.length,
            id: msg.id,
            method: msg.method,
            event: msg.params?.meta?.event,
          };
          received.push(rec);
          for (let i = waiters.length - 1; i >= 0; i--) {
            const w = waiters[i];
            if (w?.pred(rec)) {
              waiters.splice(i, 1);
              w.resolve(rec);
            }
          }
        } catch {
          // Not JSON-RPC — ignore.
        }
      }
      nl = buf.indexOf('\n');
    }
  });

  const send = (msg: unknown) => child.stdin?.write(`${JSON.stringify(msg)}\n`);
  const waitFor = (pred: (r: Received) => boolean, timeoutMs = 10_000) =>
    new Promise<Received>((res, rej) => {
      const already = received.find(pred);
      if (already) return res(already);
      const timer = setTimeout(
        () => rej(new Error(`timed out waiting; saw ${JSON.stringify(received)}`)),
        timeoutMs,
      );
      waiters.push({
        pred,
        resolve: (r) => {
          clearTimeout(timer);
          res(r);
        },
      });
    });

  harness = { child, http, received, send, waitFor };
  return harness;
}

describe('watches.restored reaches the session', () => {
  it('is written outside the tool-call window, with agent.attached as the control', async () => {
    const h = await startHarness();

    h.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'restore-notice-test', version: '0' },
      },
    });
    await h.waitFor((r) => r.id === 1);

    // The respawn's shape: `initialized` kicks the restore off, and the very
    // first tool call lands while it is still running.
    h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    h.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'list_watched_docs', arguments: {} },
    });

    const toolResponse = await h.waitFor((r) => r.id === 2);
    const control = await h.waitFor((r) => r.event === 'agent.attached');
    const notice = await h.waitFor((r) => r.event === 'watches.restored');

    // Positive control first: if this probe cannot see a channel notification
    // it knows arrives, nothing below means anything.
    expect(control.method).toBe('notifications/claude/channel');
    expect(notice.method).toBe('notifications/claude/channel');

    // The measurement. Everything written after the `tools/call` request and
    // before its response is inside the window a session does not read.
    expect(notice.index).toBeGreaterThan(toolResponse.index);
  }, 30_000);
});
