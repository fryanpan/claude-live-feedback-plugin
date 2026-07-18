import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type * as Y from 'yjs';
import { connect } from '../src/ws-client.ts';

// happy-dom does not provide a WebSocket constructor, so stub a minimal one.
// It stays in CONNECTING (readyState 0) and never dispatches events — exactly
// the state the teardown tests need (docUpdate never sends, no reconnect fires).
class StubWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  binaryType = 'blob';
  readyState = 0;
  constructor(public url: string) {}
  addEventListener(): void {}
  removeEventListener(): void {}
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
}

let originalWebSocket: unknown;
beforeEach(() => {
  originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = StubWebSocket;
});
afterEach(() => {
  (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
});

describe('connect().close()', () => {
  it('detaches doc + awareness update handlers so a closed client leaks nothing', () => {
    const client = connect('ws://localhost:0/y/test');
    const ydoc = client.ydoc as Y.Doc & { _observers: Map<string, Set<unknown>> };
    // Sanity: the doc-update handler is attached while open.
    expect(ydoc._observers.get('update')?.size ?? 0).toBeGreaterThan(0);
    client.close();
    // After close, no doc-update observers remain.
    expect(ydoc._observers.get('update')?.size ?? 0).toBe(0);
  });

  it('destroys the Y.Doc on close so it is not left live', () => {
    const client = connect('ws://localhost:0/y/test');
    const ydoc = client.ydoc;
    let destroyed = false;
    ydoc.on('destroy', () => {
      destroyed = true;
    });
    client.close();
    expect(destroyed).toBe(true);
  });

  it('does not fire a ready callback registered after close', () => {
    const client = connect('ws://localhost:0/y/test');
    client.close();
    let fired = false;
    client.onReady(() => {
      fired = true;
    });
    // close() dropped readyCbs and the socket never synced, so a post-close
    // onReady must not resolve into the disposed surface.
    expect(fired).toBe(false);
  });

  it('is safe to call close() twice', () => {
    const client = connect('ws://localhost:0/y/test');
    client.close();
    expect(() => client.close()).not.toThrow();
  });
});
