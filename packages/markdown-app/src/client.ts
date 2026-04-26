import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

/**
 * Browser-side y-websocket client for our minimal protocol.
 * Shared by the markdown-app and (in a trimmed form) the widget.
 */
const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

export interface FeedbackClient {
  ydoc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  ws: WebSocket;
  close(): void;
  onReady(cb: () => void): void;
  onStatus(cb: (s: 'connecting' | 'open' | 'closed') => void): void;
}

export function connect(url: string): FeedbackClient {
  const ydoc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(ydoc);
  let ws: WebSocket;
  let readyCbs: (() => void)[] = [];
  const statusCbs: ((s: 'connecting' | 'open' | 'closed') => void)[] = [];
  let gotInitialSync = false;
  let closed = false;
  let reconnectDelay = 500;

  const docUpdateHandler = (update: Uint8Array, origin: unknown) => {
    if (origin === ws) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    ws.send(encoding.toUint8Array(enc));
  };

  const awarenessHandler = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === 'local' && ws?.readyState === WebSocket.OPEN) {
      const ids = [...added, ...updated, ...removed];
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, ids));
      ws.send(encoding.toUint8Array(enc));
    }
  };

  ydoc.on('update', docUpdateHandler);
  awareness.on('update', awarenessHandler);

  function open() {
    if (closed) return;
    statusCbs.forEach((cb) => cb('connecting'));
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => {
      reconnectDelay = 500;
      statusCbs.forEach((cb) => cb('open'));
      // sync step 1
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeSyncStep1(enc, ydoc);
      ws.send(encoding.toUint8Array(enc));
      // send our local awareness
      const states = awareness.getStates();
      if (states.size > 0) {
        const enc2 = encoding.createEncoder();
        encoding.writeVarUint(enc2, MSG_AWARENESS);
        encoding.writeVarUint8Array(
          enc2,
          awarenessProtocol.encodeAwarenessUpdate(awareness, Array.from(states.keys())),
        );
        ws.send(encoding.toUint8Array(enc2));
      }
    });

    ws.addEventListener('message', (ev) => {
      const data = new Uint8Array(ev.data as ArrayBuffer);
      const dec = decoding.createDecoder(data);
      const kind = decoding.readVarUint(dec);
      if (kind === MSG_SYNC) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        const type = syncProtocol.readSyncMessage(dec, enc, ydoc, ws);
        if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
        if (
          !gotInitialSync &&
          (type === syncProtocol.messageYjsSyncStep2 || type === syncProtocol.messageYjsUpdate)
        ) {
          gotInitialSync = true;
          readyCbs.forEach((cb) => cb());
          readyCbs = [];
        }
      } else if (kind === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(dec), ws);
      }
    });

    ws.addEventListener('close', () => {
      statusCbs.forEach((cb) => cb('closed'));
      if (closed) return;
      setTimeout(open, Math.min(reconnectDelay, 10000));
      reconnectDelay = Math.min(reconnectDelay * 2, 10000);
    });

    ws.addEventListener('error', () => {
      try {
        ws.close();
      } catch {}
    });
  }

  open();

  return {
    ydoc,
    awareness,
    get ws() {
      return ws;
    },
    close() {
      closed = true;
      ydoc.off('update', docUpdateHandler);
      awareness.off('update', awarenessHandler);
      try {
        ws.close();
      } catch {}
    },
    onReady(cb) {
      if (gotInitialSync) cb();
      else readyCbs.push(cb);
    },
    onStatus(cb) {
      statusCbs.push(cb);
    },
  };
}
