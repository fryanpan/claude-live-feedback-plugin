/**
 * `block_task` — say what a ticket is waiting for.
 *
 * It replaces `park_task`: "not now" belongs to whatever the work is waiting
 * for, and triage goes back to meaning "nobody has vetted this". The verb
 * still POSTs to `/api/tasks/:id/park`, because the shared server's REST
 * callers cannot be restarted and that route keeps accepting the old payload
 * alongside the new one; the tool sends only the new one.
 *
 * What nothing else checks is the pair this file asserts: the ROUTE and the
 * BODY the tool sends, and that the reply carries the edges the store read
 * back rather than an echo of what was asked for.
 *
 * Driven from source, on the harness `post-status-tool.test.ts` uses.
 *
 * Fixtures are synthetic; the agent name is fictional.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_ENTRY = join(HERE, '../src/mcp.ts');
const AGENT = 'Beacon Bot';

type Recorded = { method: string; path: string; body: Record<string, unknown> };
type Reply = {
  result?: { isError?: boolean; content?: Array<{ text: string }> };
  error?: { message: string };
};

const seen: Recorded[] = [];
let stub: Server;
let child: ChildProcess;
let nextId = 100;
let pending = '';
const waiters = new Map<number, (value: unknown) => void>();

/** The store's answer: the edges as they stand AFTER the write, which is
 *  deliberately not what the caller sent — the tool must report the stored
 *  set, so a blocker the row already had reads as "nothing moved". */
function replyFor(path: string, body: Record<string, unknown>): unknown {
  if (/^\/api\/tasks\/[^/]+\/park$/.test(path)) {
    const asked = (body.blockedBy as string[] | undefined) ?? [];
    return {
      ok: true,
      task: { id: 't-1', title: 'Rename a huddle', status: 'todo' },
      changed: asked.length > 0 && !asked.includes('t-already'),
      after: ['t-already', ...asked.filter((id) => id !== 't-already')],
    };
  }
  return { ok: true };
}

function send(msg: unknown) {
  child.stdin?.write(`${JSON.stringify(msg)}\n`);
}

function rpc(method: string, params: unknown): Promise<Reply> {
  const id = nextId++;
  return new Promise((resolve) => {
    waiters.set(id, (v) => resolve(v as Reply));
    send({ jsonrpc: '2.0', id, method, params });
  });
}

function call(name: string, args: Record<string, unknown>): Promise<Reply> {
  return rpc('tools/call', { name, arguments: args });
}

function payload(reply: Reply): Record<string, unknown> {
  expect(reply.result?.isError, reply.result?.content?.[0]?.text).not.toBe(true);
  return JSON.parse(reply.result?.content?.[0]?.text ?? '{}') as Record<string, unknown>;
}

/** Only the park POSTs — the child also restores watches on initialize. */
function parkPosts(): Recorded[] {
  return seen.filter((r) => r.method === 'POST' && /\/park$/.test(r.path));
}

function last(): Recorded {
  const r = parkPosts().at(-1);
  expect(r, 'the stub server received no park POST at all').toBeTruthy();
  return r as Recorded;
}

beforeAll(async () => {
  stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => {
      raw += d;
    });
    req.on('end', () => {
      const path = req.url ?? '';
      let body: Record<string, unknown> = {};
      try {
        body = raw.length > 0 ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }
      seen.push({ method: req.method ?? '', path, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(replyFor(path, body)));
    });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  const port = (stub.address() as AddressInfo).port;

  child = spawn('bun', ['run', MCP_ENTRY], {
    env: {
      ...process.env,
      CW_BASE_URL: `http://127.0.0.1:${port}`,
      FEEDBACK_BASE_URL: `http://127.0.0.1:${port}`,
      CW_AGENT_NAME: AGENT,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d) => {
    pending += d.toString();
    let nl = pending.indexOf('\n');
    while (nl !== -1) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (line.startsWith('{')) {
        const msg = JSON.parse(line) as { id?: number };
        if (typeof msg.id === 'number') waiters.get(msg.id)?.(msg);
        waiters.delete(msg.id as number);
      }
      nl = pending.indexOf('\n');
    }
  });

  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'block-task-tool-test', version: '0' },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}, 30_000);

afterAll(async () => {
  child?.kill();
  await new Promise<void>((r) => stub?.close(() => r()));
});

describe('block_task — the ticket a row is waiting for', () => {
  it('sends one blocker as an array, and reports the edges the store read back', async () => {
    const before = parkPosts().length;
    const out = payload(await call('block_task', { taskId: 't-1', blockedBy: 't-dep' }));
    expect(parkPosts().length).toBe(before + 1);
    expect(last().path).toBe('/api/tasks/t-1/park');
    // The new payload only — nothing that would trip the route's park arm.
    expect(last().body.blockedBy).toEqual(['t-dep']);
    expect(last().body).not.toHaveProperty('parkedUntil');
    expect(last().body).not.toHaveProperty('reason');
    // The STORED edges, which include one the caller never named.
    expect(out.blockedBy).toEqual(['t-already', 't-dep']);
    expect(out.changed).toBe(true);
    // The status is reported and is NOT moved: blocked is derived from the
    // edges, so this verb changes no status at all.
    expect(out.status).toBe('todo');
  });

  it('takes several blockers at once', async () => {
    const out = payload(await call('block_task', { taskId: 't-1', blockedBy: ['t-a', 't-b'] }));
    expect(last().body.blockedBy).toEqual(['t-a', 't-b']);
    expect(out.blockedBy).toEqual(['t-already', 't-a', 't-b']);
  });

  it('reports changed: false when the row already waits on that ticket', async () => {
    const out = payload(await call('block_task', { taskId: 't-1', blockedBy: 't-already' }));
    expect(out.changed).toBe(false);
    expect(out.blockedBy).toEqual(['t-already']);
  });

  it('refuses an empty or malformed blocker list without calling the server', async () => {
    for (const bad of [[], [''], [42]]) {
      const before = parkPosts().length;
      const reply = await call('block_task', { taskId: 't-1', blockedBy: bad });
      expect(reply.result?.isError, JSON.stringify(bad)).toBe(true);
      expect(parkPosts().length, JSON.stringify(bad)).toBe(before);
    }
  });

  it('park_task is gone — one verb for one thing', async () => {
    const reply = await call('park_task', { taskId: 't-1', reason: 'later' });
    expect(reply.result?.isError || reply.error).toBeTruthy();
  });
});
