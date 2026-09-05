/**
 * `list_docs` asks the server for a PAGE, every time.
 *
 * Reported 2026-08-26: a fresh session in a new repo called `list_docs` and
 * got ~6.4 MB back — the whole server, pretty-printed, as its opening tool
 * call. The route now pages when `limit` is on the wire, so the handler's
 * one job is to put it there on every call, along with every filter the
 * caller named. This drives the handler from SOURCE against a stub that
 * records the request line, the way post-status-tool.test.ts does.
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

type Recorded = { method: string; path: string };
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

const PAGE_REPLY = {
  docs: [{ docId: 'd-1', type: 'markdown', title: 'One', threads: { open: 1, total: 2 } }],
  total: 1,
  limit: 50,
  nextCursor: null,
  hasMore: false,
  full: false,
};

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
/** The listing GETs only — the child also restores watches on initialize. */
function lastListing(): URL {
  const r = seen.filter((x) => x.method === 'GET' && x.path.startsWith('/api/docs')).at(-1);
  expect(r, 'the stub received no GET /api/docs').toBeTruthy();
  return new URL(`http://stub${(r as Recorded).path}`);
}

beforeAll(async () => {
  stub = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      const path = req.url ?? '';
      seen.push({ method: req.method ?? '', path });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(path.startsWith('/api/docs?') ? PAGE_REPLY : { ok: true }));
    });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  const port = (stub.address() as AddressInfo).port;
  child = spawn('bun', ['run', MCP_ENTRY], {
    env: {
      ...process.env,
      CW_BASE_URL: `http://127.0.0.1:${port}`,
      FEEDBACK_BASE_URL: `http://127.0.0.1:${port}`,
      CW_AGENT_NAME: 'Beacon Bot',
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
    clientInfo: { name: 'list-docs-paging-test', version: '0' },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}, 30_000);

afterAll(async () => {
  child?.kill();
  await new Promise<void>((r) => stub?.close(() => r()));
});

describe('list_docs — a page, never the server', () => {
  it('asks for a 50-row page by default and hands the page back untouched', async () => {
    const out = payload(await call('list_docs', {}));
    const url = lastListing();
    expect(url.pathname).toBe('/api/docs');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.has('full')).toBe(false);
    expect(url.searchParams.has('cursor')).toBe(false);
    expect(out).toEqual(PAGE_REPLY);
  });

  it('puts every filter, the cursor and full on the wire', async () => {
    payload(
      await call('list_docs', {
        workspaceId: 'w-1',
        kind: 'diff',
        query: 'plan.md',
        sourcePrefix: '/repo/docs',
        limit: 20,
        cursor: 'eyJ0IjoxfQ',
        full: true,
      }),
    );
    const p = lastListing().searchParams;
    expect(p.get('workspaceId')).toBe('w-1');
    expect(p.get('kind')).toBe('diff');
    expect(p.get('query')).toBe('plan.md');
    expect(p.get('sourcePrefix')).toBe('/repo/docs');
    expect(p.get('limit')).toBe('20');
    expect(p.get('cursor')).toBe('eyJ0IjoxfQ');
    expect(p.get('full')).toBe('1');
  });

  it('clamps a limit above 500 and ignores a non-positive one', async () => {
    payload(await call('list_docs', { limit: 9999 }));
    expect(lastListing().searchParams.get('limit')).toBe('500');
    payload(await call('list_docs', { limit: 0 }));
    expect(lastListing().searchParams.get('limit')).toBe('50');
  });

  it('tells the caller in the tool description that the answer is a page', async () => {
    const reply = (await rpc('tools/list', {})) as unknown as {
      result: { tools: Array<{ name: string; description: string; inputSchema: unknown }> };
    };
    const tool = reply.result.tools.find((t) => t.name === 'list_docs');
    expect(tool).toBeTruthy();
    expect(tool?.description).toMatch(/nextCursor/);
    expect(tool?.description).toMatch(/full: true/);
    const props = (tool?.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props).sort()).toEqual(
      ['cursor', 'full', 'kind', 'limit', 'query', 'sourcePrefix', 'workspaceId'].sort(),
    );
  });
});
