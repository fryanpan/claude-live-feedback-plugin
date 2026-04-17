import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { DocRoom, FeedbackWs } from './rooms.ts';

/**
 * Minimal y-websocket protocol implementation for Bun's native WebSocket.
 * Framing: messages are Uint8Array with a leading varuint indicating kind.
 *   0 = sync  (see y-protocols/sync)
 *   1 = awareness (see y-protocols/awareness)
 */

export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;

export function onOpen(room: DocRoom, ws: FeedbackWs): void {
  room.conns.add(ws);

  // sync step 1 — ask the client for updates it has that we don't
  {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, room.ydoc);
    ws.sendBinary(encoding.toUint8Array(enc));
  }

  // send current awareness state
  const states = room.awareness.getStates();
  if (states.size > 0) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(
      enc,
      awarenessProtocol.encodeAwarenessUpdate(
        room.awareness,
        Array.from(states.keys()),
      ),
    );
    ws.sendBinary(encoding.toUint8Array(enc));
  }

  // broadcast doc updates originating from this connection to peers
  const onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === ws) return; // already has its own update
    for (const peer of room.conns) {
      if (peer === ws) continue;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      try {
        peer.sendBinary(encoding.toUint8Array(enc));
      } catch (e) {
        console.error('[ws] doc send failed', e);
      }
    }
  };
  const onAwareness = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === ws) return;
    const ids = [...added, ...updated, ...removed];
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(
      enc,
      awarenessProtocol.encodeAwarenessUpdate(room.awareness, ids),
    );
    for (const peer of room.conns) {
      if (peer === ws) continue;
      try {
        peer.sendBinary(encoding.toUint8Array(enc));
      } catch (e) {
        console.error('[ws] awareness send failed', e);
      }
    }
  };
  room.ydoc.on('update', onUpdate);
  room.awareness.on('update', onAwareness);
  (ws as FeedbackWs & { _cleanup?: () => void })._cleanup = () => {
    room.ydoc.off('update', onUpdate);
    room.awareness.off('update', onAwareness);
    awarenessProtocol.removeAwarenessStates(
      room.awareness,
      Array.from(room.awareness.getStates().keys()).filter(
        (clientId) => clientId !== room.ydoc.clientID,
      ),
      ws,
    );
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
          ws.sendBinary(encoding.toUint8Array(enc));
        }
        return;
      }
      case MSG_AWARENESS: {
        awarenessProtocol.applyAwarenessUpdate(
          room.awareness,
          decoding.readVarUint8Array(dec),
          ws,
        );
        return;
      }
      default:
        console.warn('[ws] unknown message kind', kind);
    }
  } catch (err) {
    console.error('[ws] message handler error:', err);
  }
}

export function onClose(ws: FeedbackWs): void {
  const cleanup = (ws as FeedbackWs & { _cleanup?: () => void })._cleanup;
  cleanup?.();
}
