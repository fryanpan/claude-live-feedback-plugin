import * as encoding from 'lib0/encoding';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { CONNECT_TIMEOUT_MS, SYNC_TIMEOUT_MS, connect } from '../src/ws-client.ts';

/**
 * The bug this file guards: a hung WebSocket handshake (a dead proxy, a
 * backgrounded tab, a Cloudflare Tunnel edge that swallows the upgrade) never
 * fires 'open', 'error', OR 'close' on its own. ws-client's exponential
 * backoff only re-triggers from the 'close' listener, so without a forced
 * timeout the socket sat in CONNECTING (or open-but-never-synced) forever —
 * the board painted and the tasks never arrived, with no retry and no
 * recovery short of a manual reload. Measured on real loads 2026-08-29: 4 of
 * 120 board opens never got a projection at all.
 *
 * StubWebSocket dispatches events itself (unlike ws-client-close.test.ts's
 * stub, which deliberately never does) so these tests can drive it through
 * connecting → stuck, and open → stuck-unsynced.
 */
class StubWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: StubWebSocket[] = [];
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  binaryType = 'blob';
  readyState = 0;
  sent: unknown[] = [];
  private listeners = new Map<string, Set<(ev?: unknown) => void>>();

  constructor(public url: string) {
    StubWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: (ev?: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }

  removeEventListener(type: string, cb: (ev?: unknown) => void): void {
    this.listeners.get(type)?.delete(cb);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === StubWebSocket.CLOSED) return;
    this.readyState = StubWebSocket.CLOSED;
    for (const cb of this.listeners.get('close') ?? []) cb();
  }

  /** Test helper: simulate the server completing the handshake. */
  triggerOpen(): void {
    this.readyState = StubWebSocket.OPEN;
    for (const cb of this.listeners.get('open') ?? []) cb();
  }

  /** Test helper: simulate a binary sync-step-2 frame from the server. */
  triggerSyncStep2(): void {
    const src = new Y.Doc();
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0); // MSG_SYNC
    syncProtocol.writeSyncStep2(enc, src);
    const payload = encoding.toUint8Array(enc);
    for (const cb of this.listeners.get('message') ?? []) {
      cb({
        data: payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
      });
    }
  }

  /**
   * Test helper: simulate an ordinary broadcast update — what this socket
   * receives when a CONCURRENT peer edits the room, not this connection's own
   * sync-step-2 answer. Distinguishing these two is the point of the codex
   * finding below.
   */
  triggerUpdate(): void {
    const src = new Y.Doc();
    src.getMap('tasks').set('t-1', 'x'); // produce a non-empty update
    const update = Y.encodeStateAsUpdate(src);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0); // MSG_SYNC
    syncProtocol.writeUpdate(enc, update);
    const payload = encoding.toUint8Array(enc);
    for (const cb of this.listeners.get('message') ?? []) {
      cb({
        data: payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
      });
    }
  }
}

let originalWebSocket: unknown;
beforeEach(() => {
  vi.useFakeTimers();
  StubWebSocket.instances = [];
  originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = StubWebSocket;
});
afterEach(() => {
  (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
  vi.useRealTimers();
});

describe('connect() stall recovery', () => {
  it('force-closes and retries a socket stuck in CONNECTING', () => {
    const client = connect('ws://localhost:0/y/test');
    expect(StubWebSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS + 1);
    // The forced close schedules a reconnect at the backoff delay (500ms).
    vi.advanceTimersByTime(600);

    expect(StubWebSocket.instances).toHaveLength(2);
    client.close();
  });

  it('force-closes and retries a socket that opened but never delivered sync', () => {
    const client = connect('ws://localhost:0/y/test');
    const first = StubWebSocket.instances[0]!;
    first.triggerOpen();
    expect(client.status).toBe('open');

    vi.advanceTimersByTime(SYNC_TIMEOUT_MS + 1);
    vi.advanceTimersByTime(600);

    expect(StubWebSocket.instances).toHaveLength(2);
    client.close();
  });

  it('does not force-close a socket that opens within the connect timeout', () => {
    const client = connect('ws://localhost:0/y/test');
    const first = StubWebSocket.instances[0]!;
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS - 100);
    first.triggerOpen();
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS + SYNC_TIMEOUT_MS);

    // Opened, but never synced — the sync timeout (started fresh at open)
    // still fires and retries exactly once.
    expect(StubWebSocket.instances).toHaveLength(2);
    client.close();
  });

  it('does not force-close a socket that syncs within the sync timeout', () => {
    const client = connect('ws://localhost:0/y/test');
    const first = StubWebSocket.instances[0]!;
    first.triggerOpen();
    first.triggerSyncStep2();

    vi.advanceTimersByTime(SYNC_TIMEOUT_MS + CONNECT_TIMEOUT_MS + 1000);

    // Synced in time — no forced retry, ever, for this connection.
    expect(StubWebSocket.instances).toHaveLength(1);
    client.close();
  });

  it('fires onReady once the delayed retry actually syncs', () => {
    const client = connect('ws://localhost:0/y/test');
    let ready = false;
    client.onReady(() => {
      ready = true;
    });

    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS + 1);
    vi.advanceTimersByTime(600);
    expect(StubWebSocket.instances).toHaveLength(2);
    expect(ready).toBe(false);

    const second = StubWebSocket.instances[1]!;
    second.triggerOpen();
    second.triggerSyncStep2();
    expect(ready).toBe(true);

    client.close();
  });

  it('retries a RECONNECT that opens but never re-syncs, after an earlier successful sync', () => {
    // Regression for a codex review catch: `gotInitialSync` is a one-shot
    // lifetime flag for onReady and stays true forever after the first sync,
    // so a watchdog keyed on it would never fire again on any later
    // reconnect — a server-restart reconnect that opens but never re-syncs
    // would look identical to a healthy connection.
    const client = connect('ws://localhost:0/y/test');
    const first = StubWebSocket.instances[0]!;
    first.triggerOpen();
    first.triggerSyncStep2();
    expect(client.status).toBe('open');

    // The network drops (server restart, tab sleep/wake, etc.) — a real
    // close, not the watchdog's forced one.
    first.close();
    vi.advanceTimersByTime(600); // backoff before the reconnect attempt
    expect(StubWebSocket.instances).toHaveLength(2);

    const second = StubWebSocket.instances[1]!;
    second.triggerOpen();
    // ...but this attempt never delivers sync step 2.
    vi.advanceTimersByTime(SYNC_TIMEOUT_MS + 1);
    vi.advanceTimersByTime(600);

    expect(StubWebSocket.instances).toHaveLength(3);
    client.close();
  });

  it("a concurrent peer update does NOT disarm the watchdog — only this attempt's own step-2 does", () => {
    // codex review catch: the server broadcasts another peer's edit as a
    // plain messageYjsUpdate, which this socket can receive before its OWN
    // sync-step-1 request has been answered. gotInitialSync/onReady already
    // treat that update as good enough (unchanged, pre-existing behavior) —
    // but the watchdog must NOT, or a stalled step-2 response would go
    // undetected forever because an unrelated update satisfied it first.
    const client = connect('ws://localhost:0/y/test');
    const first = StubWebSocket.instances[0]!;
    first.triggerOpen();

    let ready = false;
    client.onReady(() => {
      ready = true;
    });

    // An incidental broadcast from a concurrent peer's edit arrives first.
    first.triggerUpdate();
    expect(ready).toBe(true); // pre-existing onReady contract, unchanged

    // This attempt's real sync-step-2 never arrives — the watchdog must
    // still fire and force a retry, not be silenced by the update above.
    vi.advanceTimersByTime(SYNC_TIMEOUT_MS + 1);
    vi.advanceTimersByTime(600);

    expect(StubWebSocket.instances).toHaveLength(2);
    client.close();
  });

  it('leaves no forced-close timer running after close()', () => {
    const client = connect('ws://localhost:0/y/test');
    client.close();
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS + SYNC_TIMEOUT_MS + 10_000);
    // A stray forced-close firing after close() would call open() again via
    // the retry path and create a second instance despite the client being
    // torn down.
    expect(StubWebSocket.instances).toHaveLength(1);
  });
});
