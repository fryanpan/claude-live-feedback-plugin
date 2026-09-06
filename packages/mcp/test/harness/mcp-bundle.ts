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
 *
 * The same stub also serves the session's ONE event stream
 * (`/events/agent/<id>`, see `packages/mcp/src/mux-loop.ts`) and keeps it
 * open, so `pushFrame` puts a real SSE frame through the bundle's own reader,
 * dedup, kind gate and renderer. What comes back out is a
 * `notifications/claude/channel` line on stdout — the thing a session
 * actually reads — collected in `channel`. That is what lets a frame-handling
 * test assert on the delivered line rather than on a literal surviving in the
 * bundle's text.
 *
 * The stream only opens if this session has a watch, and the bundle learns
 * its watch set from the restore GET. A test that pushes frames therefore
 * has to answer that route with one — `restoredWatches` builds the body.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { resolve } from 'node:path';
import { isBackgroundRequest } from './background-requests.ts';

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

/** One `notifications/claude/channel` line, as a session receives it. */
export type ChannelLine = {
  /** Arrival order across everything the child wrote to stdout. */
  index: number;
  /** The sentence the agent reads. */
  content: string;
  /** The event slug the renderer tagged it with, when it set one. */
  event?: string;
};

/** One SSE frame to put down the stream, in the mux route's shape. */
export type Frame = {
  /** The replay id. Frames without one still deliver; only the cursor cares. */
  id?: string;
  event: string;
  /** Serialised as the frame's `data:` line. `watchKey` is added when absent,
   *  because the mux route tags every frame with the key it arrived on. */
  data: Record<string, unknown>;
};

/**
 * A restore body that gives this session one watch, so the mux loop opens.
 *
 * Without a watch there is no stream, and a `pushFrame` would have nothing to
 * write to — which would present as a test that silently asserts nothing.
 */
export function restoredWatches(...keys: string[]): {
  watches: Array<{ key: string }>;
  pruned: string[];
  workspaces: string[];
} {
  return { watches: keys.map((key) => ({ key })), pruned: [], workspaces: [] };
}

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

/**
 * Everything the child does on its own clock, the restore included. `sent`
 * excludes all of it, because callers index into `sent` positionally
 * (`sent[0]`) and the event stream redials mid-call — see
 * `background-requests.ts` for the two CI failures that came of it.
 */
const isBackground = (r: Recorded) => isBackgroundRequest(r);

export type BundleHarness = {
  /** Every request the bundle has made, oldest first — background traffic
   *  (token mints, the event stream, the restore) included. */
  requests: Recorded[];
  /** The declarations a real MCP client receives from the running bundle. */
  tools: ToolDecl[];
  tool(name: string): ToolDecl | undefined;
  /** Calls a tool and returns the parsed result plus the requests it made. */
  call(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{ isError: boolean; text: string; json: unknown; sent: Recorded[] }>;
  /** Every channel line the bundle has written to stdout, oldest first. */
  channel: ChannelLine[];
  /** Resolve once the bundle has opened its event stream against the stub.
   *  Rejects rather than hanging, so a test that pushes into nothing says so. */
  streamOpen(timeoutMs?: number): Promise<void>;
  /** Write one SSE frame down that stream. */
  pushFrame(frame: Frame): void;
  /** Wait for a channel line matching `pred`. Rejects on timeout, naming
   *  every line seen — a miss is usually a payload the renderer dropped. */
  waitForChannel(pred: (c: ChannelLine) => boolean, timeoutMs?: number): Promise<ChannelLine>;
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

/** The one open event-stream response, once the bundle has dialled it. */
type StreamHolder = { res: ServerResponse | null };

async function startStub(
  requests: Recorded[],
  respond: Responder,
  stream: StreamHolder,
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
      // The event stream is a held connection, not a request/response pair:
      // answer the SSE preamble and keep the socket for `pushFrame`. A
      // redial replaces the holder, so a frame always goes down the live one.
      if (url.pathname.startsWith('/events/')) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(': ok\n\n');
        stream.res = res;
        req.on('close', () => {
          if (stream.res === res) stream.res = null;
        });
        return;
      }
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
  const stream: StreamHolder = { res: null };
  const { server, port } = await startStub(requests, respond, stream);

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
  const channel: ChannelLine[] = [];
  const channelWaiters: Array<{
    pred: (c: ChannelLine) => boolean;
    hit: (c: ChannelLine) => void;
  }> = [];
  let written = 0;
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
        const index = written++;
        const id = msg.id;
        if (typeof id === 'number') pending.get(id)?.(msg);
        else if (msg.method === 'notifications/claude/channel') {
          const params = (msg.params ?? {}) as {
            content?: string;
            meta?: { event?: string };
          };
          const rec: ChannelLine = {
            index,
            content: params.content ?? '',
            event: params.meta?.event,
          };
          channel.push(rec);
          for (let i = channelWaiters.length - 1; i >= 0; i--) {
            const w = channelWaiters[i];
            if (w?.pred(rec)) {
              channelWaiters.splice(i, 1);
              w.hit(rec);
            }
          }
        }
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
    channel,
    tool: (name) => tools.find((t) => t.name === name),
    async streamOpen(timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (stream.res === null) {
        if (Date.now() > deadline) {
          throw new Error(
            `no event stream after ${timeoutMs}ms. Did the restore hand back a watch? ` +
              `paths seen: ${requests.map((r) => r.path).join(', ')}`,
          );
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    pushFrame({ id, event, data }) {
      const res = stream.res;
      if (res === null) throw new Error('pushFrame before the event stream opened');
      const payload = { watchKey: 'doc-1', ...data };
      res.write(
        `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\n` +
          `data: ${JSON.stringify(payload)}\n\n`,
      );
    },
    waitForChannel(pred, timeoutMs = 10_000) {
      const already = channel.find(pred);
      if (already) return Promise.resolve(already);
      return new Promise<ChannelLine>((res, rej) => {
        const timer = setTimeout(() => {
          rej(
            new Error(`no matching channel line in ${timeoutMs}ms; saw ${JSON.stringify(channel)}`),
          );
        }, timeoutMs);
        channelWaiters.push({
          pred,
          hit: (c) => {
            clearTimeout(timer);
            res(c);
          },
        });
      });
    },
    async call(name, args = {}) {
      const before = requests.length;
      const reply = await rpc('tools/call', { name, arguments: args });
      if (reply.error) {
        return {
          isError: true,
          text: JSON.stringify(reply.error),
          json: undefined,
          sent: requests.slice(before).filter((r) => !isBackground(r)),
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
        sent: requests.slice(before).filter((r) => !isBackground(r)),
      };
    },
    async stop() {
      child.kill();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
