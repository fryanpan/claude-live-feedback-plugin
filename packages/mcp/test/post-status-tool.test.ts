/**
 * `post_status` — an agent's own words on where the work stands, landing on
 * the task's Activity tab and never on the comment thread.
 *
 * The comment feed had become the place agents narrated progress, and a
 * comment is meant to be an ask, a decision, or a reply to a person. A
 * status is a NOTE (kind `status`, beside the hooks' `turn` and `denial`):
 * with `taskId` it goes to the row the agent names
 * (`POST /api/tasks/:id/notes`); without, to the hook route
 * (`POST /api/agent-notes`), which pins it to the agent's current claim.
 *
 * Driven from SOURCE (`bun run src/mcp.ts`, the pattern
 * restore-notice-delivery.test.ts uses) rather than the committed bundle:
 * this stage adds the verb and the bundle is rebuilt with the version bump
 * in the stage that follows, so a bundle-driven case would only assert
 * that the rebuild had not happened yet. The stub records what reached it;
 * the assertions are the route and the body, which nothing else checks.
 *
 * Fixtures are synthetic; the agent name is fictional.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { type Server, createServer } from 'node:http';
import { type AddressInfo } from 'node:net';
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

function replyFor(path: string): unknown {
  if (/^\/api\/tasks\/[^/]+\/notes$/.test(path)) {
    return { ok: true, taskId: 't-1', workspaceId: 'w-1' };
  }
  // The hook route with no current claim: recorded on the ring, no row.
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

/** Only the note POSTs — the child also restores its watches against the
 *  stub on initialize, and that GET races the first tool call. */
function notePosts(): Recorded[] {
  return seen.filter((r) => r.method === 'POST' && /\/(agent-)?notes$/.test(r.path));
}

function last(): Recorded {
  const r = notePosts().at(-1);
  expect(r, 'the stub server received no note POST at all').toBeTruthy();
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
      res.end(JSON.stringify(replyFor(path)));
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
    clientInfo: { name: 'post-status-tool-test', version: '0' },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}, 30_000);

afterAll(async () => {
  child?.kill();
  await new Promise<void>((r) => stub?.close(() => r()));
});

describe('post_status — where the work stands, as a note', () => {
  it('lands on the named row as a status note under this session name', async () => {
    const before = notePosts().length;
    const reply = await call('post_status', {
      taskId: 't-1',
      text: 'Tests green; opening the PR.',
    });
    const out = payload(reply);
    expect(notePosts().length).toBe(before + 1);
    expect(last().path).toBe('/api/tasks/t-1/notes');
    expect(last().body).toEqual({
      agent: AGENT,
      kind: 'status',
      text: 'Tests green; opening the PR.',
      at: expect.any(Number),
    });
    // Never the comment door.
    expect(last().path).not.toContain('/threads/');
    expect(out.posted).toBe(true);
    expect(out.taskId).toBe('t-1');
  });

  it('goes to the current-claim route when taskId is omitted, and says when no row took it', async () => {
    const reply = await call('post_status', { text: 'Blocked on the redirect decision.' });
    const out = payload(reply);
    expect(last().path).toBe('/api/agent-notes');
    expect(last().body).toEqual({
      agent: AGENT,
      kind: 'status',
      text: 'Blocked on the redirect decision.',
      at: expect.any(Number),
    });
    expect(out.posted).toBe(true);
    expect('taskId' in out).toBe(false);
    expect(String(out.note)).toMatch(/taskId/);
  });

  it('refuses empty text and over-cap text before anything leaves the process', async () => {
    const before = notePosts().length;
    const empty = await call('post_status', { taskId: 't-1', text: '   ' });
    expect(empty.result?.isError).toBe(true);
    const long = await call('post_status', { taskId: 't-1', text: 'x'.repeat(4001) });
    expect(long.result?.isError).toBe(true);
    expect(long.result?.content?.[0]?.text).toContain('4000');
    expect(notePosts().length).toBe(before);
    // Positive control for the cap: exactly 4000 goes through.
    const atCap = await call('post_status', { taskId: 't-1', text: 'x'.repeat(4000) });
    payload(atCap);
    expect(notePosts().length).toBe(before + 1);
  });

  it('is advertised to an agent as an Activity-tab verb with taskId optional', async () => {
    const reply = (await rpc('tools/list', {})) as unknown as {
      result: {
        tools: Array<{
          name: string;
          description: string;
          inputSchema: { properties: Record<string, unknown>; required?: string[] };
        }>;
      };
    };
    const tool = reply.result.tools.find((t) => t.name === 'post_status');
    expect(tool, 'post_status is not in tools/list').toBeTruthy();
    expect(tool?.description).toMatch(/Activity tab/);
    expect(tool?.description).toMatch(/never as a comment/);
    expect(tool?.inputSchema.required).toEqual(['text']);
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(['taskId', 'text']);
  });
});
