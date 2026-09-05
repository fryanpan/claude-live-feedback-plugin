/**
 * ── Socket handlers: what an open connection DOES ──
 *
 * A19's partner, and the last slice of the `server.ts` split. A19 moved the
 * decision that a socket may open and the stamp it carries;  this is the
 * trio Bun then calls for the life of that connection. Bun routes every
 * upgraded path into ONE `open` / `message` / `close`, so the first thing
 * each of them does is read back the `kind` the upgrade attached — which is
 * why these three and `upgrade-stream.ts` are two halves of one contract and
 * neither reads correctly without the other.
 *
 * ── Nothing here is snapshotted ──
 *
 * The context holds three LIVE stores, not values read out of them. A room
 * is looked up per frame (`rooms.get(ws.data.docId)`), because `ws.data.docId`
 * is re-resolved on every message for the reason the `/y/` upgrade documents,
 * and because a room can be created, evicted or rehydrated while a socket is
 * open. The meeting relay's session map and the bot relay's token registry
 * are the same: per-connection state that must be read at call time. Hoisting
 * any of it to factory time would bind every socket this server ever opens to
 * the state that existed when it booted.
 *
 * ── The synchronous close is load-bearing ──
 *
 * `close` is NOT async, and must not become async. `createServer`'s shutdown
 * calls `server.stop(true)`, which force-closes every open connection and
 * fires this handler SYNCHRONOUSLY inside that call — before
 * `meetingRelay.dispose()`, before `taskStore.stop()`, before `rooms.flush()`.
 * Those handlers write: a meeting flushes its last sentence into the doc. They
 * run there precisely so the subsystems that receive those writes are still
 * live. An `async close` would return a promise nothing awaits, and the writes
 * would land after the stores they need had already been flushed and stopped,
 * or not at all. The ordering inside the drain is `createServer`'s to keep;
 * the synchronous shape of this handler is this file's.
 */
import type { WebSocketHandler } from 'bun';
import type { MeetingRelay } from './meeting-protocol.ts';
import type { RecallMeetingRelay } from './recall-meeting.ts';
import { type FeedbackWs, type Rooms } from './rooms.ts';
import type { UpgradeData } from './upgrade-stream.ts';
import { onClose, onMessage, onOpen } from './yjs-protocol.ts';

/** What the socket handlers read. All three are live stores, read at call
 *  time — see the note above on why none of it may be snapshotted. */
export interface SocketHandlersContext {
  /** Doc rooms. The room for a frame is looked up per frame, never held. */
  rooms: Rooms;
  /** Live meeting sessions, keyed by socket. */
  meetingRelay: MeetingRelay;
  /** The bot relay's per-bot token registry. */
  recallRelay: RecallMeetingRelay;
}

/**
 * The `websocket` half of `Bun.serve`, for the sockets `upgrade-stream.ts`
 * opened.
 *
 * Returned as one object rather than three functions because Bun takes it as
 * one, and because `perMessageDeflate` belongs with the handlers it applies
 * to — it is a property of what these sockets do with their frames, and its
 * measurement is about the very frame `open` sends first.
 */
export function createSocketHandlers(ctx: SocketHandlersContext): WebSocketHandler<UpgradeData> {
  const { rooms, meetingRelay, recallRelay } = ctx;

  return {
    // Yjs sync step 2 hands a fresh tab the WHOLE room state in one binary
    // frame. Measured over the live hub board's persisted state on
    // 2026-08-29: 1,264,566 bytes, deflating to 431,733 — 2.9×, or 813 KB
    // this server stops sending on every board open, every tab, every
    // reconnect. Every browser offers the extension already; the server
    // only had to accept it and ask for compression per send.
    //
    // How much WALL TIME that buys is a property of the reader's link, and
    // this repo has no trustworthy measurement of Bryan's — so the claim
    // here is the byte count, which is measured, and not a number of
    // seconds, which would not be. Audio frames are opaque and already
    // codec-compressed; they do not shrink, and the cost is one deflate
    // context per socket.
    perMessageDeflate: true,
    open(ws) {
      if (ws.data.kind === 'recall') return;
      if (ws.data.kind === 'audio') {
        // Before the relay, because the relay's own bookkeeping is a
        // WeakMap nothing can enumerate: this is what makes the socket
        // reachable by the share sweeps in `rooms.ts`. A socket carrying
        // neither stamp — the owner's — is not tracked at all.
        rooms.trackShareSocket(ws);
        meetingRelay.onOpen(ws);
        return;
      }
      const typed = ws as unknown as FeedbackWs;
      const room = rooms.get(typed.data.docId);
      if (!room) {
        ws.close(1008, 'no room');
        return;
      }
      onOpen(room, typed);
    },
    message(ws, message) {
      if (ws.data.kind === 'recall') {
        // Text only. Recall's realtime transcript events are JSON frames;
        // this endpoint subscribes no binary media, so a binary frame here
        // is not ours to interpret.
        if (typeof message === 'string' && ws.data.token) {
          recallRelay.onSocketText(ws.data.token, message);
        }
        return;
      }
      if (ws.data.kind === 'audio') {
        if (typeof message === 'string') {
          meetingRelay.onText(ws, message);
          return;
        }
        const buf = message as unknown as ArrayBufferView;
        // COPIED, unlike the yjs path below: audio can be held in the
        // relay's pending queue across the handshake, and Bun is free to
        // reuse the receive buffer the moment this returns.
        meetingRelay.onAudio(
          ws,
          new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
        );
        return;
      }
      const typed = ws as unknown as FeedbackWs;
      const room = rooms.get(typed.data.docId);
      if (!room) return;
      let data: Uint8Array;
      if (typeof message === 'string') {
        data = new TextEncoder().encode(message);
      } else {
        // Bun's Buffer extends Uint8Array; copy to plain Uint8Array for y-protocols
        const buf = message as unknown as ArrayBufferView;
        data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      }
      onMessage(room, typed, data);
    },
    close(ws) {
      if (ws.data.kind === 'recall') {
        // NOT the end of the meeting — see RecallMeetingRelay.onSocketClose.
        if (ws.data.token) recallRelay.onSocketClose(ws.data.token);
        return;
      }
      if (ws.data.kind === 'audio') {
        rooms.untrackShareSocket(ws);
        meetingRelay.onClose(ws);
        return;
      }
      onClose(ws as unknown as FeedbackWs);
    },
  };
}
