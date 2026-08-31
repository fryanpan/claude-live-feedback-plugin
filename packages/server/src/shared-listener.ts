/**
 * ===== ONE LISTENER FOR A WHOLE TEST RUN =====
 *
 * `bun test packages/server/test` stands up 626 `Bun.serve` listeners in a
 * 260-second run — measured 2026-08-30: a listener per test file, plus one
 * per `beforeEach`. That is not a leak. Opens balance closes and every
 * fixture tears down. It is a RATE. `net.inet.tcp.msl` on this machine is
 * 15000, so every socket a teardown closes sits in TIME_WAIT for thirty
 * seconds — and each of those 626 servers is its own fetch ORIGIN, which
 * means its own keep-alive pool, its own connections, and its own pile of
 * dead sockets thirty seconds deep. Nine agents running suites at once put
 * that pile past a kernel ceiling on 2026-08-30 and the box lost every new
 * outbound connection for four and a half hours: `socket(AF_INET,
 * SOCK_STREAM)` returned ENOBUFS to every process on the machine.
 *
 * The fix is to stop paying per server. Under `bun test` a server no longer
 * binds a port of its own: it registers its handlers here and is handed a
 * VIRTUAL port, one real `Bun.serve` fronts the whole process, and a `fetch`
 * shim rewrites `http://localhost:<virtual>` to that front door with a header
 * naming which registration should answer. Every fetch in the suite then
 * shares one origin, so the whole run reuses a handful of connections instead
 * of standing up a pool per test.
 *
 * What this deliberately does NOT share is server STATE. Each `createServer`
 * still builds its own stores over its own `dataDir` and answers only its own
 * requests; only the socket is shared. Test isolation is exactly what it was.
 *
 * Three things keep it off the production path:
 *   - it engages only when `process.env.NODE_ENV === 'test'`, which `bun test`
 *     and vitest set and nothing else here does;
 *   - it engages only for a caller that asked for port 0. Prod is 8787 and
 *     staging is 8788, so neither can reach this branch even under a stray
 *     NODE_ENV;
 *   - `CW_DEDICATED_TEST_LISTENERS=1` turns it off everywhere at once, which
 *     is the control to reach for when a failure looks like it might be the
 *     transport rather than the code under test.
 *
 * A test that needs a REAL port passes `dedicatedListener: true` to
 * `createServer` and gets today's behaviour untouched. That is anything not
 * speaking through `globalThis.fetch`: a `WebSocket`, an `EventSource`, or a
 * raw socket. The shim can only rewrite what it can see.
 */

import { HTTP_IDLE_TIMEOUT_SEC } from './sse.ts';

/** Names the registration a request belongs to. Set by the fetch shim. */
export const TEST_LISTENER_HEADER = 'x-cw-test-listener';

/**
 * Virtual ports start above the privileged range and far below macOS's
 * ephemeral range (49152–65535), so a number handed out here can never
 * collide with a port the kernel assigns to a dedicated listener in the same
 * process. The shim rewrites only ports it has actually registered, so an
 * unregistered one — a webhook receiver a test stood up with its own
 * `Bun.serve`, say — passes straight through to the real fetch.
 */
const FIRST_VIRTUAL_PORT = 2000;

/** Upgrade data carries the registration that should get the socket. */
interface CoreTaggedData {
  __cwCore?: string;
}

type FetchHandler = (
  req: Request,
  server: Bun.Server<CoreTaggedData>,
) => Response | Promise<Response>;

interface Registration {
  id: string;
  port: number;
  fetch: FetchHandler;
  websocket?: Bun.WebSocketHandler<CoreTaggedData>;
}

const byId = new Map<string, Registration>();
const byPort = new Map<number, Registration>();

let shared: Bun.Server<CoreTaggedData> | null = null;
let sharedPort: number | null = null;
let nextVirtualPort = FIRST_VIRTUAL_PORT;
let nextId = 0;
let shimInstalled = false;

/**
 * Whether this `createServer` call should share the process listener.
 *
 * `port` is the ORIGINAL request, before `createServer` defaults it — a
 * caller that named 8787 wants that port bound and must not be handed a
 * virtual one.
 */
export function shouldShareListener(
  port: number | undefined,
  dedicated: boolean | undefined,
): boolean {
  if (dedicated) return false;
  if (port !== 0) return false;
  if (process.env.CW_DEDICATED_TEST_LISTENERS === '1') return false;
  return process.env.NODE_ENV === 'test';
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

function dispatchWs(ws: Bun.ServerWebSocket<CoreTaggedData>): Registration | undefined {
  return byId.get(ws.data?.__cwCore ?? '');
}

function ensureShared(): Bun.Server<CoreTaggedData> {
  if (shared) return shared;
  shared = Bun.serve<CoreTaggedData>({
    port: 0,
    hostname: '127.0.0.1',
    // The same number the real listener uses. `sse-keepalive.test.ts` asserts
    // the relationship between this and the SSE keepalive, and a front door
    // with its own idle timeout would quietly change what that test measures.
    idleTimeout: HTTP_IDLE_TIMEOUT_SEC,
    fetch(req, server) {
      const id = req.headers.get(TEST_LISTENER_HEADER);
      const reg = id ? byId.get(id) : undefined;
      if (!reg) {
        // A request that reached the front door without a live registration
        // is a bug in the shim, or a fetch issued after teardown. Answer with
        // something that names itself — a bare 404 would read as a routing
        // assertion and send the next reader into the router.
        return new Response(`shared test listener: no registration ${id ?? '(none)'}`, {
          status: 502,
        });
      }
      return reg.fetch(req, serverFor(reg, server));
    },
    websocket: {
      open(ws) {
        dispatchWs(ws)?.websocket?.open?.(ws);
      },
      message(ws, msg) {
        dispatchWs(ws)?.websocket?.message?.(ws, msg);
      },
      close(ws, code, reason) {
        dispatchWs(ws)?.websocket?.close?.(ws, code, reason);
      },
      drain(ws) {
        dispatchWs(ws)?.websocket?.drain?.(ws);
      },
    },
  });
  sharedPort = shared.port ?? null;
  // The front door must not be what keeps a finished test process alive.
  shared.unref();
  installFetchShim();
  return shared;
}

/**
 * The `server` a registration's own handler sees.
 *
 * Two things are rewritten and everything else passes through to the real
 * front door. `port` reports the VIRTUAL port, because the handler builds its
 * own public base URL out of it and tests assert against that. `upgrade` tags
 * the socket with the registration, so the shared websocket handlers know
 * whose socket it is. `requestIP` deliberately passes through — the
 * connection really is from loopback, and the loopback guards in the routes
 * are exactly what those tests mean to exercise.
 */
function serverFor(
  reg: Registration,
  actual: Bun.Server<CoreTaggedData>,
): Bun.Server<CoreTaggedData> {
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'port') return reg.port;
      if (prop === 'upgrade') {
        return (req: Request, options?: { data?: unknown; headers?: HeadersInit }) =>
          target.upgrade(req, {
            ...options,
            data: { ...(options?.data as object | undefined), __cwCore: reg.id },
          });
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function installFetchShim(): void {
  if (shimInstalled) return;
  shimInstalled = true;
  const original = globalThis.fetch;
  const shim = ((input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return original(input as RequestInfo, init);
    }
    if (!isLoopbackHost(url.hostname)) return original(input as RequestInfo, init);
    const reg = byPort.get(Number(url.port));
    if (!reg || sharedPort === null) return original(input as RequestInfo, init);
    url.port = String(sharedPort);
    if (input instanceof Request && init === undefined) {
      const rewritten = new Request(url.href, input);
      rewritten.headers.set(TEST_LISTENER_HEADER, reg.id);
      return original(rewritten);
    }
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set(TEST_LISTENER_HEADER, reg.id);
    return original(url.href, { ...init, headers });
  }) as typeof globalThis.fetch;
  globalThis.fetch = shim;
}

/**
 * A stand-in for `Bun.serve` that binds nothing.
 *
 * Registers the caller's handlers behind the process front door and returns a
 * `Bun.Server` reporting a virtual port. `stop()` retires the registration —
 * the front door itself lives for the process, which is the whole point: it
 * is the socket that stops being paid for per test.
 */
export const sharedServe = ((options: {
  fetch: FetchHandler;
  websocket?: Bun.WebSocketHandler<CoreTaggedData>;
}): Bun.Server<CoreTaggedData> => {
  const front = ensureShared();
  const id = `cw${nextId++}`;
  const port = nextVirtualPort++;
  const reg: Registration = { id, port, fetch: options.fetch, websocket: options.websocket };
  byId.set(id, reg);
  byPort.set(port, reg);
  const handle = serverFor(reg, front);
  return new Proxy(handle, {
    get(target, prop) {
      if (prop === 'stop') {
        return () => {
          byId.delete(id);
          byPort.delete(port);
        };
      }
      // Refusing to ref/unref the shared door on one registration's behalf:
      // it is unref'd once, at creation, and a single test must not be able
      // to hold the process open for everybody else.
      if (prop === 'ref' || prop === 'unref') return () => handle;
      return Reflect.get(target, prop);
    },
  });
}) as unknown as typeof Bun.serve;

/** How many registrations are live. Exists so a test can assert the sharing. */
export function sharedListenerRegistrationCount(): number {
  return byId.size;
}

/** The real port the process front door is bound to, or null when unstarted. */
export function sharedListenerPort(): number | null {
  return sharedPort;
}
