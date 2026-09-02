/**
 * The y-websocket framing, driven directly.
 *
 * Everything here runs against a real `Y.Doc` and a real `Awareness` with fake
 * sockets, because the properties worth holding are about what arrives on the
 * wire and what lands in the doc — not about how the server is wired to Bun.
 *
 * Three of them have each been a live defect: a broadcast that skipped the
 * wrong peer (so B's edits never reached A), a disconnect that removed EVERY
 * peer's awareness rather than the leaving socket's, and a read-only socket
 * that could still write. None is reachable through an HTTP route, so a route
 * test cannot hold any of them.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import type { DocRoom, FeedbackWs } from '../src/rooms.ts';
import { MSG_AWARENESS, MSG_SYNC, onClose, onMessage, onOpen } from '../src/yjs-protocol.ts';

/** Everything created in a test, torn down after it. Awareness starts a 3s
 *  interval in its constructor, so leaking one keeps the runner alive. */
const opened: Array<{ destroy: () => void }> = [];
afterEach(() => {
  while (opened.length > 0) opened.pop()?.destroy();
});

function room(): DocRoom {
  const ydoc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(ydoc);
  opened.push({
    destroy: () => {
      awareness.destroy();
      ydoc.destroy();
    },
  });
  return {
    docId: 'd-1',
    ydoc,
    awareness,
    peekAwareness: () => awareness,
    conns: new Set<FeedbackWs>(),
  } as unknown as DocRoom;
}

/** A socket that records every frame it was handed. */
function socket(opts: { readOnly?: boolean; failSend?: boolean } = {}) {
  const sent: Uint8Array[] = [];
  const ws = {
    data: { docId: 'd-1', readOnly: opts.readOnly === true },
    sendBinary: (payload: Uint8Array) => {
      if (opts.failSend) throw new Error('socket closed');
      sent.push(payload.slice());
    },
  } as unknown as FeedbackWs;
  return { ws, sent };
}

/**
 * The REMOTE peers in a room.
 *
 * `new Awareness(ydoc)` gives itself a local state, so a room always carries
 * one entry of its own — the server's — and every joiner is told about it.
 * That is production's shape (`RoomStore.createAwareness` constructs it the
 * same way and only clears the library's timer), so the fake keeps it and the
 * assertions subtract it rather than pretending rooms start empty.
 */
const peers = (r: DocRoom) =>
  [...r.awareness.getStates().keys()].filter((id) => id !== r.awareness.clientID).sort();

/** Decode an awareness frame the way a browser would, and say who it names. */
function peersIn(frame: Uint8Array, exclude: number): number[] {
  const dec = decoding.createDecoder(frame);
  decoding.readVarUint(dec);
  const payload = decoding.readVarUint8Array(dec);
  const doc = new Y.Doc();
  const mirror = new awarenessProtocol.Awareness(doc);
  awarenessProtocol.applyAwarenessUpdate(mirror, payload, null);
  const ids = [...mirror.getStates().keys()].filter(
    (id) => id !== mirror.clientID && id !== exclude,
  );
  mirror.destroy();
  doc.destroy();
  return ids.sort();
}

/** The message kind byte at the head of a frame. */
const kindOf = (frame: Uint8Array) => decoding.readVarUint(decoding.createDecoder(frame));

/** The sync sub-kind, after the leading MSG_SYNC. */
function syncStepOf(frame: Uint8Array): number {
  const dec = decoding.createDecoder(frame);
  decoding.readVarUint(dec);
  return decoding.readVarUint(dec);
}

/** A client-side doc carrying `text`, and the update frame that ships it. */
function updateFrame(text: string): Uint8Array {
  const client = new Y.Doc();
  client.getText('t').insert(0, text);
  const update = Y.encodeStateAsUpdate(client);
  client.destroy();
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeUpdate(enc, update);
  return encoding.toUint8Array(enc);
}

/** A sync step 1 frame — the read half of the protocol. */
function step1Frame(): Uint8Array {
  const client = new Y.Doc();
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeSyncStep1(enc, client);
  client.destroy();
  return encoding.toUint8Array(enc);
}

/** An awareness frame announcing one client id. */
function awarenessFrame(clientId: number, name: string): Uint8Array {
  const doc = new Y.Doc();
  doc.clientID = clientId;
  const aw = new awarenessProtocol.Awareness(doc);
  aw.setLocalStateField('user', { name });
  const payload = awarenessProtocol.encodeAwarenessUpdate(aw, [clientId]);
  aw.destroy();
  doc.destroy();
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_AWARENESS);
  encoding.writeVarUint8Array(enc, payload);
  return encoding.toUint8Array(enc);
}

describe('onOpen', () => {
  it('joins the room and opens with sync step 1 — the server asking what it is missing', () => {
    const r = room();
    const a = socket();
    onOpen(r, a.ws);
    expect(r.conns.has(a.ws)).toBe(true);
    expect(kindOf(a.sent[0] as Uint8Array)).toBe(MSG_SYNC);
    expect(syncStepOf(a.sent[0] as Uint8Array)).toBe(syncProtocol.messageYjsSyncStep1);
  });

  it('tells a joiner who is already in the room', () => {
    // Presence has to arrive on connect, not on the next keystroke: a second
    // tab that learned about nobody shows an empty strip until somebody moves.
    const r = room();
    const first = socket();
    onOpen(r, first.ws);
    onMessage(r, first.ws, awarenessFrame(4242, 'Alice'));

    const joiner = socket();
    onOpen(r, joiner.ws);
    expect(joiner.sent.map((f) => kindOf(f))).toEqual([MSG_SYNC, MSG_AWARENESS]);
    expect(peersIn(joiner.sent[1] as Uint8Array, r.awareness.clientID)).toEqual([4242]);
  });
});

describe('onMessage — sync', () => {
  it('applies an update from a writable socket', () => {
    const r = room();
    const a = socket();
    onOpen(r, a.ws);
    onMessage(r, a.ws, updateFrame('hello'));
    expect(r.ydoc.getText('t').toString()).toBe('hello');
  });

  it('broadcasts an update to every OTHER connection, never back to its origin', () => {
    // The defect this holds: registering one handler per connection skipped
    // the wrong peer, so updates originating from B never reached A.
    const r = room();
    const a = socket();
    const b = socket();
    const c = socket();
    for (const s of [a, b, c]) onOpen(r, s.ws);
    const before = { a: a.sent.length, b: b.sent.length, c: c.sent.length };
    onMessage(r, a.ws, updateFrame('hello'));
    expect(b.sent.length).toBe(before.b + 1);
    expect(c.sent.length).toBe(before.c + 1);
    // Nothing at all goes back to the sender: an update needs no reply, and
    // an echo of its own edit is the shape the wrong-peer bug had.
    expect(a.sent.length).toBe(before.a);
    expect(b.sent.slice(before.b).map((f) => kindOf(f))).toEqual([MSG_SYNC]);
    // And the broadcast really carried the edit: a fresh doc fed the frame
    // ends up with the same text.
    const mirror = new Y.Doc();
    const dec = decoding.createDecoder(b.sent[before.b] as Uint8Array);
    decoding.readVarUint(dec);
    syncProtocol.readSyncMessage(dec, encoding.createEncoder(), mirror, null);
    expect(mirror.getText('t').toString()).toBe('hello');
    mirror.destroy();
  });

  it('a peer whose socket has died does not stop the broadcast reaching the others', () => {
    const r = room();
    const a = socket();
    const dead = socket({ failSend: true });
    const c = socket();
    onOpen(r, a.ws);
    // `dead` throws on its step-1 open too; the room still holds it.
    expect(() => onOpen(r, dead.ws)).toThrow();
    r.conns.add(dead.ws);
    onOpen(r, c.ws);
    const before = c.sent.length;
    onMessage(r, a.ws, updateFrame('hello'));
    expect(c.sent.length).toBe(before + 1);
  });
});

describe('onMessage — a read-only socket may read and may not write', () => {
  it('answers step 1, so a view-only client still loads the doc', () => {
    const r = room();
    r.ydoc.getText('t').insert(0, 'server side');
    const viewer = socket({ readOnly: true });
    onOpen(r, viewer.ws);
    const before = viewer.sent.length;
    onMessage(r, viewer.ws, step1Frame());
    expect(viewer.sent.length).toBe(before + 1);
    const reply = viewer.sent[before] as Uint8Array;
    expect(syncStepOf(reply)).toBe(syncProtocol.messageYjsSyncStep2);
    // And the reply carries the content, not an empty step 2.
    const mirror = new Y.Doc();
    const dec = decoding.createDecoder(reply);
    decoding.readVarUint(dec);
    syncProtocol.readSyncMessage(dec, encoding.createEncoder(), mirror, null);
    expect(mirror.getText('t').toString()).toBe('server side');
    mirror.destroy();
  });

  it('drops an update, leaving the doc exactly as it was', () => {
    const r = room();
    r.ydoc.getText('t').insert(0, 'server side');
    const viewer = socket({ readOnly: true });
    onOpen(r, viewer.ws);
    const before = viewer.sent.length;
    onMessage(r, viewer.ws, updateFrame('vandalism'));
    expect(r.ydoc.getText('t').toString()).toBe('server side');
    // Dropped in silence: no frame goes back for a write that was refused.
    expect(viewer.sent.length).toBe(before);
  });

  it('the SAME frame does land when the socket may write — the control on the two tests above', () => {
    const r = room();
    r.ydoc.getText('t').insert(0, 'server side');
    const writer = socket();
    onOpen(r, writer.ws);
    onMessage(r, writer.ws, updateFrame('vandalism'));
    expect(r.ydoc.getText('t').toString()).not.toBe('server side');
  });
});

describe('onMessage — awareness', () => {
  it('applies a peer’s presence into the room', () => {
    const r = room();
    const a = socket();
    onOpen(r, a.ws);
    onMessage(r, a.ws, awarenessFrame(4242, 'Alice'));
    expect(r.awareness.getStates().get(4242)).toEqual({ user: { name: 'Alice' } });
  });

  it('broadcasts presence to the other peers but not to its origin', () => {
    const r = room();
    const a = socket();
    const b = socket();
    onOpen(r, a.ws);
    onOpen(r, b.ws);
    const before = { a: a.sent.length, b: b.sent.length };
    onMessage(r, a.ws, awarenessFrame(4242, 'Alice'));
    expect(a.sent.length).toBe(before.a);
    expect(b.sent.slice(before.b).map((f) => kindOf(f))).toEqual([MSG_AWARENESS]);
  });
});

describe('onClose', () => {
  it('removes only the leaving socket’s peers, and leaves everyone else present', () => {
    // The defect: a disconnect used to clear every peer's awareness, so one
    // person closing a tab emptied the presence strip for the whole room.
    const r = room();
    const a = socket();
    const b = socket();
    onOpen(r, a.ws);
    onOpen(r, b.ws);
    onMessage(r, a.ws, awarenessFrame(111, 'Alice'));
    onMessage(r, b.ws, awarenessFrame(222, 'Bo'));
    expect(peers(r)).toEqual([111, 222]);

    onClose(a.ws);
    expect(peers(r)).toEqual([222]);
    expect(r.conns.has(a.ws)).toBe(false);
    expect(r.conns.has(b.ws)).toBe(true);
  });

  it('is safe on a socket that never opened', () => {
    const stray = socket();
    expect(() => onClose(stray.ws)).not.toThrow();
  });
});

describe('a frame the server cannot make sense of', () => {
  it('ignores an unknown message kind instead of throwing', () => {
    const r = room();
    const a = socket();
    onOpen(r, a.ws);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 99);
    const before = a.sent.length;
    expect(() => onMessage(r, a.ws, encoding.toUint8Array(enc))).not.toThrow();
    expect(a.sent.length).toBe(before);
  });

  it('swallows a malformed sync frame rather than taking the socket down', () => {
    const r = room();
    const a = socket();
    onOpen(r, a.ws);
    r.ydoc.getText('t').insert(0, 'intact');
    expect(() => onMessage(r, a.ws, new Uint8Array([MSG_SYNC, 200, 200, 200]))).not.toThrow();
    expect(r.ydoc.getText('t').toString()).toBe('intact');
  });
});
