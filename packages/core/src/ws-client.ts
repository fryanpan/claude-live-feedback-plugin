import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

/**
 * Browser-side Yjs websocket client for the feedback server's minimal
 * protocol (varuint kind prefix: 0 = sync, 1 = awareness). THE single
 * implementation — consumed by both the markdown-app SPA and the injectable
 * widget, which previously carried a drifting copy each. Deliberately
 * DOM-free beyond WebSocket so it stays safe for the widget bundle.
 */

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

export interface FeedbackClient {
  ydoc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  /** The CURRENT socket — replaced on every reconnect. */
  ws: WebSocket;
  status: ConnectionStatus;
  close(): void;
  /** Fires once, after the first sync-step-2/update lands (doc hydrated). */
  onReady(cb: () => void): void;
  /** Fires on every transition; also called immediately with the current status. */
  onStatus(cb: (s: ConnectionStatus) => void): void;
}

export function connect(url: string): FeedbackClient {
  const ydoc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(ydoc);
  let ws: WebSocket;
  let closed = false;
  let gotInitialSync = false;
  let readyCbs: (() => void)[] = [];
  const statusCbs: ((s: ConnectionStatus) => void)[] = [];
  let status: ConnectionStatus = 'connecting';
  let reconnectDelay = 500;

  const docUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === ws || !ws || ws.readyState !== WebSocket.OPEN) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    ws.send(encoding.toUint8Array(enc));
  };
  const awareUpdate = (
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

  ydoc.on('update', docUpdate);
  awareness.on('update', awareUpdate);

  function setStatus(s: ConnectionStatus) {
    status = s;
    for (const cb of statusCbs) cb(s);
  }

  function open() {
    if (closed) return;
    setStatus('connecting');
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => {
      reconnectDelay = 500;
      setStatus('open');
      // sync step 1
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeSyncStep1(enc, ydoc);
      ws.send(encoding.toUint8Array(enc));
      // Push our local awareness so peers see us after a (re)connect. No-op
      // for clients (like the widget) that never set local awareness state.
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
          for (const cb of readyCbs) cb();
          readyCbs = [];
        }
      } else if (kind === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(dec), ws);
      }
    });

    ws.addEventListener('close', () => {
      setStatus('closed');
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
    get status() {
      return status;
    },
    close() {
      if (closed) return;
      closed = true;
      ydoc.off('update', docUpdate);
      awareness.off('update', awareUpdate);
      // Drop pending ready callbacks so a late reconnect/sync can't fire into
      // a disposed surface.
      readyCbs = [];
      try {
        ws.close();
      } catch {}
      // Release the doc + awareness eagerly so navigation between docs doesn't
      // accumulate live Y.Docs and their internal timers.
      awareness.destroy();
      ydoc.destroy();
    },
    onReady(cb) {
      if (gotInitialSync) cb();
      else readyCbs.push(cb);
    },
    onStatus(cb) {
      statusCbs.push(cb);
      cb(status);
    },
  };
}
