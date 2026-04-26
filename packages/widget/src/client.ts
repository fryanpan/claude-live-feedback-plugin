import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

/**
 * Minimal Yjs WS client for the widget.
 * Mirrors packages/markdown-app/src/client.ts but kept here standalone
 * so the widget bundle doesn't import the markdown-app package.
 */

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

export interface WidgetClient {
  ydoc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  status: 'connecting' | 'open' | 'closed';
  close(): void;
  onReady(cb: () => void): void;
  onStatus(cb: (s: 'connecting' | 'open' | 'closed') => void): void;
}

export function connect(url: string): WidgetClient {
  const ydoc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(ydoc);
  let ws: WebSocket;
  let closed = false;
  let gotInitialSync = false;
  let readyCbs: (() => void)[] = [];
  const statusCbs: ((s: 'connecting' | 'open' | 'closed') => void)[] = [];
  let status: 'connecting' | 'open' | 'closed' = 'connecting';
  let reconnectDelay = 500;

  const docUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === ws || !ws || ws.readyState !== WebSocket.OPEN) return;
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_SYNC);
    syncProtocol.writeUpdate(e, update);
    ws.send(encoding.toUint8Array(e));
  };
  const awareUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === 'local' && ws?.readyState === WebSocket.OPEN) {
      const ids = [...added, ...updated, ...removed];
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_AWARENESS);
      encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(awareness, ids));
      ws.send(encoding.toUint8Array(e));
    }
  };

  ydoc.on('update', docUpdate);
  awareness.on('update', awareUpdate);

  function setStatus(s: 'connecting' | 'open' | 'closed') {
    status = s;
    statusCbs.forEach((cb) => cb(s));
  }

  function open() {
    if (closed) return;
    setStatus('connecting');
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => {
      setStatus('open');
      reconnectDelay = 500;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      syncProtocol.writeSyncStep1(e, ydoc);
      ws.send(encoding.toUint8Array(e));
    });
    ws.addEventListener('message', (ev) => {
      const data = new Uint8Array(ev.data as ArrayBuffer);
      const d = decoding.createDecoder(data);
      const kind = decoding.readVarUint(d);
      if (kind === MSG_SYNC) {
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, MSG_SYNC);
        const type = syncProtocol.readSyncMessage(d, e, ydoc, ws);
        if (encoding.length(e) > 1) ws.send(encoding.toUint8Array(e));
        if (
          !gotInitialSync &&
          (type === syncProtocol.messageYjsSyncStep2 || type === syncProtocol.messageYjsUpdate)
        ) {
          gotInitialSync = true;
          readyCbs.forEach((cb) => cb());
          readyCbs = [];
        }
      } else if (kind === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(d), ws);
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
    get status() {
      return status;
    },
    close() {
      closed = true;
      ydoc.off('update', docUpdate);
      awareness.off('update', awareUpdate);
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
      cb(status);
    },
  };
}
