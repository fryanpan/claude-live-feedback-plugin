import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import type { DocRoom, FeedbackWs } from './rooms.ts';
import { captureServerError } from './sentry.ts';

/**
 * Minimal y-websocket protocol implementation for Bun's native WebSocket.
 * Framing: messages are Uint8Array with a leading varuint indicating kind.
 *   0 = sync  (see y-protocols/sync)
 *   1 = awareness (see y-protocols/awareness)
 */

export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;

/**
 * Per-connection state attached to the WebSocket. We track the set of
 * Yjs client IDs that have contributed awareness via this specific WS
 * so we only remove those on disconnect — not every peer's awareness.
 */
type WsState = {
  cleanup?: () => void;
  /** clientIDs we've seen incoming awareness from on this ws. */
  knownClientIds: Set<number>;
};

function state(ws: FeedbackWs): WsState {
  const typed = ws as FeedbackWs & { _state?: WsState };
  if (!typed._state) typed._state = { knownClientIds: new Set() };
  return typed._state;
}

/**
 * One broadcaster per room (not per connection). When the room's Y.Doc
 * or Awareness emits an update, send it to every connection *except*
 * the origin connection. Registering N handlers with per-ws closures
 * (the previous approach) skipped the wrong peer on the broadcast loop —
 * updates originating from peer B never reached peer A.
 */
const roomBroadcasters = new WeakMap<DocRoom, () => void>();

function ensureBroadcaster(room: DocRoom): void {
  if (roomBroadcasters.has(room)) return;
  const onUpdate = (update: Uint8Array, origin: unknown) => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    const payload = encoding.toUint8Array(enc);
    for (const peer of room.conns) {
      if (peer === origin) continue;
      try {
        peer.sendBinary(payload, true);
      } catch (e) {
        console.error('[ws] doc send failed', e);
      }
    }
  };
  const onAwareness = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    const ids = [...added, ...updated, ...removed];
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(room.awareness, ids));
    const payload = encoding.toUint8Array(enc);
    for (const peer of room.conns) {
      if (peer === origin) continue;
      try {
        peer.sendBinary(payload, true);
      } catch (e) {
        console.error('[ws] awareness send failed', e);
      }
    }
  };
  room.ydoc.on('update', onUpdate);
  room.awareness.on('update', onAwareness);
  // Keep the handlers alive for the life of the server; rooms are long-lived.
  roomBroadcasters.set(room, () => {
    room.ydoc.off('update', onUpdate);
    room.awareness.off('update', onAwareness);
  });
}

export function onOpen(room: DocRoom, ws: FeedbackWs): void {
  ensureBroadcaster(room);
  room.conns.add(ws);

  // sync step 1 — ask the client for updates it has that we don't
  {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, room.ydoc);
    ws.sendBinary(encoding.toUint8Array(enc), true);
  }

  // send current awareness state
  const states = room.awareness.getStates();
  if (states.size > 0) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(
      enc,
      awarenessProtocol.encodeAwarenessUpdate(room.awareness, Array.from(states.keys())),
    );
    ws.sendBinary(encoding.toUint8Array(enc), true);
  }

  state(ws).cleanup = () => {
    const { knownClientIds } = state(ws);
    if (knownClientIds.size > 0) {
      awarenessProtocol.removeAwarenessStates(room.awareness, Array.from(knownClientIds), ws);
    }
    room.conns.delete(ws);
  };
}

export function onMessage(room: DocRoom, ws: FeedbackWs, data: Uint8Array): void {
  try {
    const dec = decoding.createDecoder(data);
    const kind = decoding.readVarUint(dec);
    const enc = encoding.createEncoder();
    switch (kind) {
      case MSG_SYNC: {
        encoding.writeVarUint(enc, MSG_SYNC);
        syncProtocol.readSyncMessage(dec, enc, room.ydoc, ws);
        if (encoding.length(enc) > 1) {
          ws.sendBinary(encoding.toUint8Array(enc), true);
        }
        return;
      }
      case MSG_AWARENESS: {
        const payload = decoding.readVarUint8Array(dec);
        // Track which client IDs this ws is contributing so disconnect only
        // removes *their* awareness states, not every peer's.
        const before = new Set(room.awareness.getStates().keys());
        awarenessProtocol.applyAwarenessUpdate(room.awareness, payload, ws);
        const after = room.awareness.getStates().keys();
        const ws_state = state(ws);
        for (const id of after) {
          if (!before.has(id)) ws_state.knownClientIds.add(id);
        }
        return;
      }
      default:
        console.warn('[ws] unknown message kind', kind);
    }
  } catch (err) {
    console.error('[ws] message handler error:', err);
    // The sync flow's error path — a genuine desync/protocol bug, not the
    // expected-on-disconnect send failures above (those stay off Sentry on
    // purpose; a peer closing mid-broadcast would otherwise spam it). No
    // docId, no content — a sync protocol error doesn't need either to be
    // actionable.
    captureServerError(err, { phase: 'ws.message' });
  }
}

export function onClose(ws: FeedbackWs): void {
  state(ws).cleanup?.();
}
