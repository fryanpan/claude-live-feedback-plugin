/**
 * The environment a page's boot sequence runs against, faked.
 *
 * `app.ts` and `hub/hub-app.ts` now export their boot as a function of an
 * environment (see `src/boot-env.ts`), so a suite can drive the real sequence
 * instead of reading its source text. What it needs is a throwaway document, an
 * address that goes nowhere, a history that records instead of navigating, a
 * key/value store, and a socket that syncs when the test says so.
 *
 * Not a second implementation of anything: every fake here records what the
 * boot asked for and hands back what a server would have. The behaviour under
 * test is the boot's own.
 */
import type { ConnectionStatus, FeedbackClient } from '@feedback/core';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import type { BootHistory, BootLocation, BootStorage } from '../src/boot-env.ts';

// ── The address bar ────────────────────────────────────────────────────────

export interface FakeLocation extends BootLocation {
  /** Every place the boot tried to send the browser, in order — `assign(url)`
   *  and `href = url` alike, because the board uses both and a test asserting
   *  "it left for the next board" should not care which. */
  readonly navigations: string[];
  /**
   * Move the address the way a history traversal does: the browser has already
   * changed it by the time `popstate` fires, so a test firing that event must
   * change it first. Not a navigation — nothing here is the app leaving.
   */
  moveTo(url: string): void;
}

export function fakeLocation(url: string): FakeLocation {
  const navigations: string[] = [];
  let parsed = new URL(url);
  return {
    get pathname(): string {
      return parsed.pathname;
    },
    get search(): string {
      return parsed.search;
    },
    get origin(): string {
      return parsed.origin;
    },
    get protocol(): string {
      return parsed.protocol;
    },
    get host(): string {
      return parsed.host;
    },
    get href(): string {
      return parsed.href;
    },
    set href(next: string) {
      navigations.push(next);
    },
    assign(next: string): void {
      navigations.push(next);
    },
    moveTo(next: string): void {
      parsed = new URL(next, parsed.origin);
    },
    navigations,
  };
}

// ── Session history ────────────────────────────────────────────────────────

export type HistoryEntry =
  | { kind: 'push'; url: string; state: unknown }
  | { kind: 'replace'; url: string; state: unknown }
  | { kind: 'back' };

export interface FakeHistory extends BootHistory {
  readonly entries: HistoryEntry[];
  /** The most recent URL this history was told about, or null. */
  url(): string | null;
}

export function fakeHistory(initialState: unknown = null): FakeHistory {
  const entries: HistoryEntry[] = [];
  let state = initialState;
  return {
    get state(): unknown {
      return state;
    },
    pushState(data: unknown, _unused: string, url: string): void {
      state = data;
      entries.push({ kind: 'push', url, state: data });
    },
    replaceState(data: unknown, _unused: string, url: string): void {
      state = data;
      entries.push({ kind: 'replace', url, state: data });
    },
    back(): void {
      entries.push({ kind: 'back' });
    },
    entries,
    url(): string | null {
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e && e.kind !== 'back') return e.url;
      }
      return null;
    },
  };
}

// ── Storage ────────────────────────────────────────────────────────────────

export interface FakeStorage extends BootStorage {
  readonly values: Map<string, string>;
  /** Every key read, in order — repeats included, so "read once" is assertable. */
  readonly reads: string[];
  readonly writes: { key: string; value: string }[];
}

export function fakeStorage(seed: Record<string, string> = {}): FakeStorage {
  const values = new Map(Object.entries(seed));
  const reads: string[] = [];
  const writes: { key: string; value: string }[] = [];
  return {
    getItem(key: string): string | null {
      reads.push(key);
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      writes.push({ key, value });
      values.set(key, value);
    },
    values,
    reads,
    writes,
  };
}

// ── The Yjs socket ─────────────────────────────────────────────────────────

export interface FakeClient extends FeedbackClient {
  /** The URL the boot asked to connect to. */
  readonly url: string;
  /** Deliver the initial sync — what `onReady` waits for. */
  sync(): void;
  /** Move the connection, firing every `onStatus` subscriber. */
  moveTo(next: ConnectionStatus): void;
  readonly closed: boolean;
}

function makeClient(url: string): FakeClient {
  const ydoc = new Y.Doc();
  const awareness = new Awareness(ydoc);
  const readyCbs: (() => void)[] = [];
  const statusCbs: ((s: ConnectionStatus) => void)[] = [];
  let ready = false;
  let status: ConnectionStatus = 'connecting';
  let closed = false;
  const client: FakeClient = {
    url,
    ydoc,
    awareness,
    // Nothing in a boot reads the socket object itself; it is only ever
    // compared by identity to tell a remote update from a local one.
    ws: {} as WebSocket,
    get status(): ConnectionStatus {
      return status;
    },
    get closed(): boolean {
      return closed;
    },
    close(): void {
      closed = true;
    },
    onReady(cb: () => void): void {
      if (ready) cb();
      else readyCbs.push(cb);
    },
    onStatus(cb: (s: ConnectionStatus) => void): void {
      statusCbs.push(cb);
      // The real client calls back immediately with the current status.
      cb(status);
    },
    sync(): void {
      ready = true;
      for (const cb of readyCbs.splice(0)) cb();
    },
    moveTo(next: ConnectionStatus): void {
      status = next;
      for (const cb of [...statusCbs]) cb(next);
    },
  };
  return client;
}

export interface FakeSockets {
  /** Pass this as the boot's `connect`. */
  connect: (url: string) => FakeClient;
  /** Every client opened, in the order the boot opened them. */
  readonly opened: FakeClient[];
  /** The first client, which is the board room / the document room. */
  first(): FakeClient;
}

export function fakeSockets(): FakeSockets {
  const opened: FakeClient[] = [];
  return {
    connect(url: string): FakeClient {
      const client = makeClient(url);
      opened.push(client);
      return client;
    },
    opened,
    first(): FakeClient {
      const c = opened[0];
      if (!c) throw new Error('the boot never opened a socket');
      return c;
    },
  };
}

// ── The server ─────────────────────────────────────────────────────────────

export interface ServerCall {
  url: string;
  method: string;
  body: unknown;
}

export interface FakeServer {
  /** Answer any request whose path STARTS WITH `path` with this JSON body.
   *  Later routes win over earlier ones, so a test can override a default. */
  on(path: string, body: unknown, status?: number): void;
  /** Every request the app made, in order. */
  readonly calls: ServerCall[];
  /** Drop the routes and the log; the dispatcher itself stays installed. */
  reset(): void;
}

interface Route {
  path: string;
  status: number;
  body: unknown;
}

let routes: Route[] = [];
let calls: ServerCall[] = [];

/**
 * Install ONE fetch dispatcher on the global, for the life of the module.
 *
 * It has to be one function and it has to be installed before any boot runs:
 * `installWriteGateNotice` wraps `window.fetch` exactly once per process and
 * binds whatever it finds, so a suite that replaced the global per test would
 * have every later test's requests routed to the first test's stub.
 */
export function installFakeServer(): FakeServer {
  const dispatcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.startsWith('http') ? new URL(url).pathname : (url.split('?')[0] ?? url);
    let parsed: unknown = null;
    if (typeof init?.body === 'string') {
      try {
        parsed = JSON.parse(init.body);
      } catch {
        parsed = init.body;
      }
    }
    calls.push({ url, method: init?.method ?? 'GET', body: parsed });
    let match: Route | undefined;
    for (const route of routes) if (path.startsWith(route.path)) match = route;
    const status = match?.status ?? 200;
    return new Response(JSON.stringify(match?.body ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  (globalThis as { fetch: typeof fetch }).fetch = dispatcher as unknown as typeof fetch;
  return {
    on(path: string, body: unknown, status = 200): void {
      routes.push({ path, status, body });
    },
    get calls(): ServerCall[] {
      return calls;
    },
    reset(): void {
      routes = [];
      calls = [];
    },
  };
}

// ── Server-sent events ─────────────────────────────────────────────────────

/**
 * The board's live feed, as an event target that never opens a connection.
 *
 * `EventSource` does not exist under happy-dom at all, so without this the
 * board's boot throws at `wireHubLive` and nothing after it runs. Every
 * instance is recorded, and dispatching at one drives the real listeners the
 * boot registered.
 */
export class FakeEventSource extends EventTarget {
  static readonly opened: FakeEventSource[] = [];
  closed = false;
  constructor(readonly url: string) {
    super();
    FakeEventSource.opened.push(this);
  }
  close(): void {
    this.closed = true;
  }
  /** The most recently opened feed, which is the one the last boot wired. */
  static last(): FakeEventSource {
    const es = FakeEventSource.opened[FakeEventSource.opened.length - 1];
    if (!es) throw new Error('the boot never opened an event feed');
    return es;
  }
}

export function installFakeEventSource(): typeof FakeEventSource {
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  return FakeEventSource;
}

// ── The beacon ─────────────────────────────────────────────────────────────────

/** Every beacon the page sent, in order. */
export const beacons: { url: string; body: unknown }[] = [];

/**
 * Give the fake browser a `navigator.sendBeacon`, because a real one has it.
 *
 * The reading tracker flushes its session on `pagehide` and prefers a beacon
 * exactly so the report survives the page going away; happy-dom ships no
 * `sendBeacon` at all, so without this the flush falls through to `fetch` and
 * runs during environment teardown, after the runner has put the real network
 * back — an unhandled `NetworkError` against localhost with nothing to do with
 * the boot under test.
 */
export function installFakeBeacon(): typeof beacons {
  const nav = globalThis.navigator as Navigator;
  Object.defineProperty(nav, 'sendBeacon', {
    configurable: true,
    writable: true,
    value: (url: string, data?: BodyInit): boolean => {
      beacons.push({ url, body: data });
      return true;
    },
  });
  return beacons;
}

/** Paths the fake server was asked for, deduped, in first-ask order. */
export function pathsAsked(server: FakeServer): string[] {
  const seen: string[] = [];
  for (const call of server.calls) {
    const path = call.url.startsWith('http') ? new URL(call.url).pathname : call.url.split('?')[0];
    if (path && !seen.includes(path)) seen.push(path);
  }
  return seen;
}

/**
 * Let every already-queued microtask and timer callback run.
 *
 * A boot is a chain of awaits over the fake server; nothing here waits on wall
 * time, so one macrotask turn per await is enough and the count is the depth of
 * that chain, not a duration. No `setTimeout(…, N)` with an N: a test that
 * slept would be asserting on the machine instead of on the boot.
 */
export async function settle(turns = 12): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
