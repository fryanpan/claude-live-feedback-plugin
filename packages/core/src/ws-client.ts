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

/**
 * How long a single connection attempt gets before it is declared stuck and
 * force-retried. Two phases, two timers, because a hung handshake and a
 * socket that opened but never got synced are different failures with the
 * same symptom: a board that paints and never gets a projection.
 *
 * Neither the WebSocket spec nor any browser guarantees a timeout on a
 * pending connection — a dead proxy, a backgrounded tab, or a Cloudflare
 * Tunnel edge that swallows the upgrade can leave `readyState === CONNECTING`
 * with no 'open', 'error', or 'close' ever firing. The exponential backoff
 * below only re-triggers from 'close', so without a forced timeout that
 * socket sits there until the OS's own TCP timeout (minutes), which reads as
 * "never" to anyone watching a 15-second load budget. Measured on real board
 * loads 2026-08-29: 4 of 120 opens never got a projection at all.
 */
export const CONNECT_TIMEOUT_MS = 10_000;
/**
 * Same failure, later stage: the handshake completed but the sync-step-1/2
 * round trip never delivered. Started fresh on every 'open' rather than
 * continuing the connect timer, since a slow-but-genuine sync (a large board
 * over a poor link) is not the same event as a hung handshake — and it must
 * NOT be mistaken for one: codex review on this change flagged that a
 * WebSocket 'message' event only fires once a full frame has arrived, so
 * there is no partial-progress signal to reset the clock on mid-transfer,
 * and every retry re-requests the same diff from scratch. A deadline close
 * to a genuine transfer's real duration would abort it every attempt and
 * loop forever — worse than the bug this exists to fix. Set well above the
 * measured tail (p95 5041ms, max 13647ms end-to-end, board loads
 * 2026-08-29) rather than tight to it, so it only ever fires on a
 * connection that is actually stuck, not one that is merely slow.
 */
export const SYNC_TIMEOUT_MS = 25_000;

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
    const thisWs = ws;

    // Stuck-handshake watchdog: force a close if 'open' never comes. See
    // CONNECT_TIMEOUT_MS above for why this can't rely on a browser default.
    let syncTimer: ReturnType<typeof setTimeout> | null = null;
    // Per-ATTEMPT, unlike `gotInitialSync` below: a reconnect after a server
    // restart re-opens with `gotInitialSync` already true forever (it only
    // ever gates the one-shot onReady callbacks), so the watchdog needs its
    // own flag or a reconnect that opens but never re-syncs would sail past
    // it silently — open() looks healthy, the board just stops updating.
    let syncedThisAttempt = false;
    const connectTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
      if (thisWs.readyState === thisWs.CONNECTING) {
        try {
          thisWs.close();
        } catch {}
      }
    }, CONNECT_TIMEOUT_MS);
    connectTimer.unref?.();

    ws.addEventListener('open', () => {
      clearTimeout(connectTimer);
      reconnectDelay = 500;
      setStatus('open');
      // Stuck-sync watchdog: the handshake completed but sync step 1/2 never
      // round-tripped. Cleared the moment THIS attempt's sync lands.
      syncTimer = setTimeout(() => {
        if (!syncedThisAttempt) {
          try {
            thisWs.close();
          } catch {}
        }
      }, SYNC_TIMEOUT_MS);
      syncTimer.unref?.();
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
        if (type === syncProtocol.messageYjsSyncStep2 || type === syncProtocol.messageYjsUpdate) {
          // Disarms the watchdog on EVERY attempt, including a reconnect
          // long after the first sync — `gotInitialSync` below stays
          // one-shot for onReady, which is a different contract.
          syncedThisAttempt = true;
          if (syncTimer !== null) clearTimeout(syncTimer);
          if (!gotInitialSync) {
            gotInitialSync = true;
            for (const cb of readyCbs) cb();
            readyCbs = [];
          }
        }
      } else if (kind === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(dec), ws);
      }
    });

    ws.addEventListener('close', () => {
      clearTimeout(connectTimer);
      if (syncTimer !== null) clearTimeout(syncTimer);
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
