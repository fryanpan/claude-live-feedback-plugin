/**
 * A behavioural harness for the committed MCP bundle.
 *
 * The tests in this package used to assert `BUNDLE.toContain('some string')`
 * over `packages/plugin/mcp/index.js`. That passes on a tool whose handler was
 * deleted, on a description that no client ever sees, and on a route literal
 * that nothing calls — the string survives every one of those. It also fails
 * on a rename that keeps the feature working.
 *
 * So instead: run the bundle the way `.mcp.json` runs it — through
 * `packages/plugin/bin/claude-workspaces-mcp.sh` — speak MCP over its stdio,
 * and point `CW_BASE_URL` at a stub HTTP server that records every request.
 * A declaration is then what `tools/list` returns, and a route is what the
 * handler actually asks for.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '../../../..');
const LAUNCHER = resolve(REPO, 'packages/plugin/bin/claude-workspaces-mcp.sh');
const BUNDLE = resolve(REPO, 'packages/plugin/mcp/index.js');

/** One request the bundle made of the server, as the stub saw it. */
export type Recorded = {
  method: string;
  /** Path without the query string. */
  path: string;
  /** The raw path, query included. */
  url: string;
  query: URLSearchParams;
  body: unknown;
};

/** What the stub answers with. Returning undefined falls through to `{}`. */
export type Responder = (req: Recorded) => unknown;

export type ToolDecl = {
  name: string;
  description?: string;
  inputSchema?: {
    properties?: Record<string, { description?: string; type?: string; [k: string]: unknown }>;
    required?: string[];
    [k: string]: unknown;
  };
};

/**
 * The bundle asks the server for this identity's watch set as soon as the
 * client finishes initializing, so a GET of it can land inside any call's
 * window. It is the harness's own startup noise, not the tool's doing, so it
 * is waited for and then kept out of `sent`.
 */
const RESTORE_GET = /^\/api\/agents\/[^/]+\/watches$/;
const isRestore = (r: Recorded) => r.method === 'GET' && RESTORE_GET.test(r.path);

export type BundleHarness = {
  /** Every request the bundle has made, oldest first. */
  requests: Recorded[];
  /** The declarations a real MCP client receives from the running bundle. */
  tools: ToolDecl[];
  tool(name: string): ToolDecl | undefined;
  /** Calls a tool and returns the parsed result plus the requests it made. */
  call(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{ isError: boolean; text: string; json: unknown; sent: Recorded[] }>;
  stop(): Promise<void>;
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((res) => {
    let buf = '';
    req.on('data', (d) => {
      buf += d.toString();
    });
    req.on('end', () => res(buf));
  });
}

async function startStub(
  requests: Recorded[],
  respond: Responder,
): Promise<{ server: Server; port: number }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const raw = await readBody(req);
      const url = new URL(req.url ?? '/', 'http://stub');
      const rec: Recorded = {
        method: req.method ?? 'GET',
        path: url.pathname,
        url: req.url ?? '/',
        query: url.searchParams,
        body: raw ? JSON.parse(raw) : undefined,
      };
      requests.push(rec);
      let payload: unknown;
      try {
        payload = respond(rec);
      } catch (e) {
        res.writeHead(500).end(String(e));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload ?? {}));
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('stub did not bind a port');
  return { server, port: addr.port };
}

/**
 * Boots the committed bundle against a stub server and completes the MCP
 * handshake. Call `stop()` in an `afterAll`.
 */
export async function startBundle(
  respond: Responder = () => ({}),
  env: Record<string, string> = {},
): Promise<BundleHarness> {
  const requests: Recorded[] = [];
  const { server, port } = await startStub(requests, respond);

  const child: ChildProcess = spawn('/bin/sh', [LAUNCHER, BUNDLE], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      CW_BASE_URL: `http://127.0.0.1:${port}`,
      CW_AGENT_NAME: 'Harness Agent',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map<number, (m: Record<string, unknown>) => void>();
  let buf = '';
  let stderr = '';
  child.stderr?.on('data', (d) => {
    stderr += d.toString();
  });
  child.stdout?.on('data', (d) => {
    buf += d.toString();
    let nl = buf.indexOf('\n');
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith('{')) {
        const msg = JSON.parse(line) as Record<string, unknown>;
        const id = msg.id;
        if (typeof id === 'number') pending.get(id)?.(msg);
      }
      nl = buf.indexOf('\n');
    }
  });

  let nextId = 1;
  const rpc = (method: string, params: unknown): Promise<Record<string, unknown>> => {
    const id = nextId++;
    return new Promise((res, rej) => {
      const timer = setTimeout(
        () => rej(new Error(`${method} timed out. stderr: ${stderr.slice(0, 400)}`)),
        30_000,
      );
      pending.set(id, (m) => {
        clearTimeout(timer);
        pending.delete(id);
        res(m);
      });
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };

  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp-bundle-harness', version: '0' },
  });
  if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
  child.stdin?.write(
    `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
  );

  // Let the watch restore land before any test measures a call's requests.
  // It is best-effort on the bundle's side, so a miss here is not fatal.
  for (let i = 0; i < 100 && !requests.some(isRestore); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }

  const listed = await rpc('tools/list', {});
  const tools = ((listed.result as { tools?: ToolDecl[] } | undefined)?.tools ?? []) as ToolDecl[];

  return {
    requests,
    tools,
    tool: (name) => tools.find((t) => t.name === name),
    async call(name, args = {}) {
      const before = requests.length;
      const reply = await rpc('tools/call', { name, arguments: args });
      if (reply.error) {
        return {
          isError: true,
          text: JSON.stringify(reply.error),
          json: undefined,
          sent: requests.slice(before).filter((r) => !isRestore(r)),
        };
      }
      const result = reply.result as {
        isError?: boolean;
        content?: Array<{ type: string; text?: string }>;
      };
      const text = result.content?.map((c) => c.text ?? '').join('\n') ?? '';
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return {
        isError: result.isError === true,
        text,
        json,
        sent: requests.slice(before).filter((r) => !isRestore(r)),
      };
    },
    async stop() {
      child.kill();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
