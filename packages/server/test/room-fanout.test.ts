/**
 * The websocket fan-out of a doc room, driven directly rather than through a
 * `DocStore`. It came out of `doc-store.ts` as a pure move, so everything below had
 * SOME coverage through the higher layers already; what it lacked was a test
 * that can fail for the fan-out's own reasons — the frame it builds, the
 * channels it writes it to, which sockets it hangs up, and which transaction
 * origins its meta guards let through. One fake host, no data directory, no
 * `.ydoc`, no HTTP.
 */
import { describe, expect, it } from 'bun:test';
import type { DocMeta, Thread, User, WebhookPayload } from '@feedback/core';
import * as Y from 'yjs';
import type { DocRoom, FeedbackWs } from '../src/doc-store.ts';
import {
  CONTENT_REVISION_ORIGIN,
  RoomFanout,
  type RoomFanoutHost,
  maintainAwareness,
} from '../src/room-fanout.ts';
import { SseBus } from '../src/sse.ts';
import type { ThreadSummarizer } from '../src/summarize.ts';

type Closed = { code: number; reason: string };

/** A stand-in for a connected browser socket: enough of `FeedbackWs` for the
 *  sweeps, which only ever read `data` and call `close`. */
function fakeWs(data: { shareId?: string; shareMember?: string }): {
  ws: FeedbackWs;
  closes: Closed[];
} {
  const closes: Closed[] = [];
  const ws = {
    data,
    close(code: number, reason: string) {
      closes.push({ code, reason });
    },
  };
  return { ws: ws as unknown as FeedbackWs, closes };
}

/** Presence per room, held the way `DocStore` holds it: built on demand, then
 *  readable without constructing a second one. */
const awarenessOf = new WeakMap<DocRoom, DocRoom['awareness']>();

function makeRoom(docId: string, meta: Partial<DocMeta> = {}): DocRoom {
  const ydoc = new Y.Doc();
  const room = {
    docId,
    ydoc,
    get awareness(): DocRoom['awareness'] {
      const aw = awarenessOf.get(this as DocRoom);
      if (!aw) throw new Error('this test never asked the fan-out for presence');
      return aw;
    },
    peekAwareness(): DocRoom['awareness'] | null {
      return awarenessOf.get(this as DocRoom) ?? null;
    },
    conns: new Set<FeedbackWs>(),
    meta: { docId, type: 'markdown', createdAt: 0, ...meta } as DocMeta,
    seq: 0,
  } as DocRoom;
  return room;
}

/** `createAwareness` plus the caching the real `DocRoom` getter does, so
 *  `peekAwareness` answers afterwards and the ticker can find the instance. */
function givePresence(fanout: RoomFanout, room: DocRoom): DocRoom['awareness'] {
  const aw = fanout.createAwareness(room);
  awarenessOf.set(room, aw);
  return aw;
}

interface Recorder {
  host: RoomFanoutHost;
  sse: SseBus;
  webhooks: { url: string; payload: WebhookPayload }[];
  roomEvents: { docId: string; payload: WebhookPayload }[];
  persisted: string[];
  revisionBumps: string[];
  rebinds: string[];
}

function makeHost(
  resident: DocRoom[],
  opts: { summarizer?: ThreadSummarizer; companionOf?: Record<string, string> } = {},
): Recorder {
  const sse = new SseBus();
  const rec: Omit<Recorder, 'host'> = {
    sse,
    webhooks: [],
    roomEvents: [],
    persisted: [],
    revisionBumps: [],
    rebinds: [],
  };
  const host: RoomFanoutHost = {
    residentRooms: () => resident,
    sse: () => sse,
    webhooks: () => ({
      send: async (url, payload) => {
        rec.webhooks.push({ url, payload });
      },
    }),
    // Marks every frame, so a test can tell a decorated meta from the raw one.
    decorate: (meta) => ({ ...meta, title: `${meta.title ?? ''}!` }),
    emitRoomEvent: (docId, payload) => {
      rec.roomEvents.push({ docId, payload });
    },
    summarizer: () => opts.summarizer,
    thread: () => null,
    memberOfCompanion: (docId) => opts.companionOf?.[docId],
    schedulePersist: (room) => {
      rec.persisted.push(room.docId);
    },
    scheduleRevisionBump: (room) => {
      rec.revisionBumps.push(room.docId);
    },
    maybeRebindHome: (room) => {
      rec.rebinds.push(room.docId);
    },
  };
  return { ...rec, host };
}

const ANCHOR_TEXT = { kind: 'text', from: 0, to: 1 } as unknown as Thread['anchor'];
const AUTHOR = { id: 'u1', name: 'Reviewer', kind: 'human', color: '#abc' } as unknown as User;

function makeThread(id: string, anchor: Thread['anchor'] = ANCHOR_TEXT): Thread {
  return {
    id,
    anchor,
    status: 'open',
    comments: [],
    createdAt: 0,
  } as unknown as Thread;
}

describe('RoomFanout — the broadcast', () => {
  it('writes one frame, under one event id, to the doc / companion / review channels', () => {
    const room = makeRoom('d1', { setId: 'rev-7' });
    room.webhookUrl = 'https://hook.example/x';
    const rec = makeHost([room], { companionOf: { d1: 'member-9' } });
    const fanout = new RoomFanout(rec.host);

    fanout.broadcastToRoom(room, {
      event: 'doc.changed',
      docId: 'd1',
    } as unknown as WebhookPayload);

    const onDoc = rec.sse.eventsOn('d1');
    const onMember = rec.sse.eventsOn('member-9');
    const onReview = rec.sse.eventsOn('ws~rev-7');
    expect(onDoc).toHaveLength(1);
    expect(onMember).toHaveLength(1);
    expect(onReview).toHaveLength(1);
    // One wire id on every copy is what lets a subscriber collapse them.
    const eid = onDoc[0]?.id;
    expect(typeof eid).toBe('string');
    expect(onMember[0]?.id).toBe(eid as string);
    expect(onReview[0]?.id).toBe(eid as string);
    expect(rec.webhooks).toEqual([
      { url: 'https://hook.example/x', payload: onDoc[0]?.payload as WebhookPayload },
    ]);
    expect(rec.roomEvents.map((e) => e.docId)).toEqual(['d1']);
  });

  it('skips the companion and review channels when the doc has neither', () => {
    const room = makeRoom('d2');
    const rec = makeHost([room]);
    new RoomFanout(rec.host).broadcastToRoom(room, {
      event: 'doc.changed',
      docId: 'd2',
    } as unknown as WebhookPayload);

    expect(rec.sse.eventsOn('d2')).toHaveLength(1);
    expect(rec.sse.eventsOn('ws~rev-7')).toHaveLength(0);
    // No webhookUrl means nothing is dispatched, rather than a send to undefined.
    expect(rec.webhooks).toHaveLength(0);
  });

  it('gives every broadcast a distinct event id', () => {
    const room = makeRoom('d3');
    const rec = makeHost([room]);
    const fanout = new RoomFanout(rec.host);
    fanout.broadcastToRoom(room, { event: 'a', docId: 'd3' } as unknown as WebhookPayload);
    fanout.broadcastToRoom(room, { event: 'b', docId: 'd3' } as unknown as WebhookPayload);
    const ids = rec.sse.eventsOn('d3').map((e) => e.id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('RoomFanout — thread and suggestion frames', () => {
  it('bumps seq, decorates the doc meta and carries the actor', () => {
    const room = makeRoom('d4', { title: 'Plan' });
    const rec = makeHost([room]);
    const fanout = new RoomFanout(rec.host);

    fanout.fireEvent(room, 'thread.resolved', makeThread('t1'), undefined, undefined, AUTHOR);

    expect(room.seq).toBe(1);
    const frame = rec.sse.eventsOn('d4')[0]?.payload as unknown as {
      event: string;
      threadId: string;
      seq: number;
      actor?: User;
      doc: DocMeta;
      reviewItemId?: string;
    };
    expect(frame.event).toBe('thread.resolved');
    expect(frame.threadId).toBe('t1');
    expect(frame.seq).toBe(1);
    expect(frame.actor).toEqual(AUTHOR);
    // Decorated, not the raw room.meta: that is what a channel line renders.
    expect(frame.doc.title).toBe('Plan!');
    expect(frame.reviewItemId).toBeUndefined();
  });

  it('lifts reviewItemId to the top level for a thread anchored on a review item', () => {
    const room = makeRoom('d5');
    const rec = makeHost([room]);
    const anchor = { kind: 'review-item', reviewItemId: 'ri-3' } as unknown as Thread['anchor'];
    new RoomFanout(rec.host).fireEvent(room, 'thread.created', makeThread('t2', anchor));

    const frame = rec.sse.eventsOn('d5')[0]?.payload as unknown as { reviewItemId?: string };
    expect(frame.reviewItemId).toBe('ri-3');
  });

  it('schedules a summary per thread event, and never when generate is false', () => {
    const scheduled: string[] = [];
    const summarizer: ThreadSummarizer = {
      enabled: false,
      schedule: (args: { threadId: string }) => {
        scheduled.push(args.threadId);
      },
    } as unknown as ThreadSummarizer;
    const room = makeRoom('d6');
    const rec = makeHost([room], { summarizer });
    const fanout = new RoomFanout(rec.host);

    fanout.fireEvent(room, 'thread.created', makeThread('t3'));
    expect(scheduled).toEqual(['t3']);
    // Share-visitor writes come through with generate:false and must not
    // spend a summarization call.
    fanout.fireEvent(room, 'thread.replied', makeThread('t4'), undefined, { generate: false });
    expect(scheduled).toEqual(['t3']);
    expect(room.seq).toBe(2);
  });

  it('marks the thread summaryPending only when generation is enabled', () => {
    const summarizer: ThreadSummarizer = {
      enabled: true,
      schedule: () => {},
    } as unknown as ThreadSummarizer;
    const room = makeRoom('d7');
    const threads = room.ydoc.getMap('threads') as Y.Map<Y.Map<unknown>>;
    room.ydoc.transact(() => threads.set('t5', new Y.Map<unknown>()));
    const rec = makeHost([room], { summarizer });

    new RoomFanout(rec.host).fireEvent(room, 'thread.created', makeThread('t5'));
    expect(typeof threads.get('t5')?.get('summaryPendingTs')).toBe('number');
  });

  it('sends a suggestion verdict on the same channel, with its summary', () => {
    const room = makeRoom('d8');
    const rec = makeHost([room]);
    const summary = { sid: 's1', kind: 'insert' } as never;
    new RoomFanout(rec.host).fireSuggestionEvent(room, 'suggestion.accepted', 's1', summary);

    const frame = rec.sse.eventsOn('d8')[0]?.payload as unknown as {
      event: string;
      sid: string;
      suggestion: unknown;
      seq: number;
    };
    expect(frame.event).toBe('suggestion.accepted');
    expect(frame.sid).toBe('s1');
    expect(frame.suggestion).toBe(summary);
    expect(frame.seq).toBe(1);
  });
});

describe('RoomFanout — hanging up sockets', () => {
  it('closes only the named share, as a policy violation', () => {
    const mine = fakeWs({ shareId: 'sh-1' });
    const theirs = fakeWs({ shareId: 'sh-2' });
    const owner = fakeWs({});
    const room = makeRoom('d9');
    for (const c of [mine, theirs, owner]) room.conns.add(c.ws);
    const rec = makeHost([room]);

    expect(new RoomFanout(rec.host).closeSocketsForShare('sh-1')).toBe(1);
    expect(mine.closes).toEqual([{ code: 1008, reason: 'share revoked' }]);
    expect(theirs.closes).toHaveLength(0);
    expect(owner.closes).toHaveLength(0);
  });

  it('never offers a membership-less socket to the member predicate', () => {
    const seen: string[] = [];
    const member = fakeWs({ shareMember: 'ws-1:alice' });
    const owner = fakeWs({});
    const agent = fakeWs({ shareId: 'sh-9' });
    const room = makeRoom('d10');
    for (const c of [member, owner, agent]) room.conns.add(c.ws);
    const rec = makeHost([room]);

    const closed = new RoomFanout(rec.host).closeSocketsForShareMembers((key) => {
      seen.push(key);
      return true;
    });
    expect(seen).toEqual(['ws-1:alice']);
    expect(closed).toBe(1);
    expect(member.closes).toEqual([{ code: 1008, reason: 'share access ended' }]);
    expect(owner.closes).toHaveLength(0);
    expect(agent.closes).toHaveLength(0);
  });

  it('sweeps dead shares across every resident room and names them once', () => {
    const deadA = fakeWs({ shareId: 'sh-dead' });
    const deadB = fakeWs({ shareId: 'sh-dead' });
    const live = fakeWs({ shareId: 'sh-live' });
    const roomA = makeRoom('d11');
    const roomB = makeRoom('d12');
    roomA.conns.add(deadA.ws);
    roomA.conns.add(live.ws);
    roomB.conns.add(deadB.ws);
    const rec = makeHost([roomA, roomB]);

    const swept = new RoomFanout(rec.host).closeSocketsForDeadShares((id) => id === 'sh-live');
    expect(swept).toEqual(['sh-dead']);
    expect(deadA.closes).toHaveLength(1);
    expect(deadB.closes).toHaveLength(1);
    expect(live.closes).toHaveLength(0);
  });

  it('closes a torn-down room normally, not as a violation', () => {
    const a = fakeWs({});
    const b = fakeWs({ shareId: 'sh-1' });
    const room = makeRoom('d13');
    room.conns.add(a.ws);
    room.conns.add(b.ws);
    const rec = makeHost([room]);

    new RoomFanout(rec.host).closeSockets(room, 'doc deleted');
    expect(a.closes).toEqual([{ code: 1000, reason: 'doc deleted' }]);
    expect(b.closes).toEqual([{ code: 1000, reason: 'doc deleted' }]);
  });

  it('survives a socket that is already gone', () => {
    const room = makeRoom('d14');
    room.conns.add({
      data: { shareId: 'sh-1' },
      close() {
        throw new Error('already closed');
      },
    } as unknown as FeedbackWs);
    const rec = makeHost([room]);
    // Counted as closed: the close handler does the bookkeeping either way.
    expect(new RoomFanout(rec.host).closeSocketsForShare('sh-1')).toBe(1);
  });
});

describe('RoomFanout — the shared presence ticker', () => {
  it('runs ONE ticker however many rooms hold presence, and gives it up on shutdown', () => {
    const roomA = makeRoom('d15');
    const roomB = makeRoom('d16');
    const rec = makeHost([roomA, roomB]);
    const fanout = new RoomFanout(rec.host);
    expect(fanout.stats()).toEqual({ awareness: 0, timers: 0 });

    givePresence(fanout, roomA);
    givePresence(fanout, roomB);
    // Two rooms, ONE timer — the whole reason this ticker is shared.
    expect(fanout.stats()).toEqual({ awareness: 2, timers: 1 });

    fanout.forgetRoom(roomA);
    expect(fanout.stats()).toEqual({ awareness: 1, timers: 1 });
    fanout.stop();
    expect(fanout.stats()).toEqual({ awareness: 1, timers: 0 });
  });

  it('stops the Awareness instance from running its own interval', () => {
    const room = makeRoom('d17');
    const rec = makeHost([room]);
    const fanout = new RoomFanout(rec.host);
    const aw = givePresence(fanout, room);
    try {
      // y-protocols starts an unrefd 3s interval per instance in its
      // constructor; one per hydrated room took the server to 2.6 GB.
      const timer = (aw as unknown as { _checkInterval: { _destroyed?: boolean } })._checkInterval;
      expect(timer._destroyed).toBe(true);
    } finally {
      fanout.stop();
      aw.destroy();
    }
  });

  it('expires a remote client that stopped reporting, and renews the local one', () => {
    const room = makeRoom('d18');
    const rec = makeHost([room]);
    const fanout = new RoomFanout(rec.host);
    const aw = givePresence(fanout, room);
    try {
      aw.setLocalState({ user: 'me' });
      // A peer whose clock is 31s old is past outdatedTimeout.
      aw.states.set(999, { user: 'ghost' });
      aw.meta.set(999, { clock: 0, lastUpdated: Date.now() - 31_000 });
      maintainAwareness(aw, Date.now());
      expect(aw.states.has(999)).toBe(false);
      expect(aw.states.has(aw.clientID)).toBe(true);
    } finally {
      fanout.stop();
      aw.destroy();
    }
  });
});

describe('RoomFanout — wireEvents', () => {
  it('persists on every update but only counts authoring origins as work', () => {
    const room = makeRoom('d19');
    const rec = makeHost([room]);
    new RoomFanout(rec.host).wireEvents(room);

    // Server bookkeeping: persisted, but not somebody working.
    room.ydoc.transact(() => room.ydoc.getMap('meta').set('x', 1), CONTENT_REVISION_ORIGIN);
    expect(rec.persisted).toEqual(['d19']);
    expect(room.lastContentChangeAt).toBeUndefined();
    expect(rec.revisionBumps).toHaveLength(0);

    // An agent edit tool.
    room.ydoc.transact(() => room.ydoc.getMap('meta').set('y', 1), 'agent');
    expect(typeof room.lastContentChangeAt).toBe('number');
    expect(rec.revisionBumps).toEqual(['d19']);
    expect(rec.rebinds).toEqual(['d19']);
    expect(rec.persisted).toEqual(['d19', 'd19']);
  });

  it('does not count the re-anchor sweep as an edit, though its origin is agent-shaped', () => {
    const room = makeRoom('d20');
    const rec = makeHost([room]);
    new RoomFanout(rec.host).wireEvents(room);

    room.ydoc.transact(() => room.ydoc.getMap('meta').set('z', 1), 'agent-reanchor');
    expect(room.lastContentChangeAt).toBeUndefined();
    expect(rec.revisionBumps).toHaveLength(0);
    // Still persisted — the sweep's own writes must survive a restart.
    expect(rec.persisted).toEqual(['d20']);
  });

  it('counts a write whose origin is one of the room’s live sockets', () => {
    const room = makeRoom('d21');
    const { ws } = fakeWs({});
    room.conns.add(ws);
    const rec = makeHost([room]);
    new RoomFanout(rec.host).wireEvents(room);

    room.ydoc.transact(() => room.ydoc.getMap('meta').set('a', 1), ws);
    expect(typeof room.lastContentChangeAt).toBe('number');
    expect(rec.revisionBumps).toEqual(['d21']);
  });

  it('drops a private meta key a peer wrote into the synced map', () => {
    const room = makeRoom('d22');
    const rec = makeHost([room]);
    new RoomFanout(rec.host).wireEvents(room);

    const meta = room.ydoc.getMap('meta');
    room.ydoc.transact(() => {
      meta.set('sourceUrl', 'file:///home/example/notes/x.md');
      meta.set('title', 'Fine');
    });
    // A private key on the sync channel is a filesystem-layout leak, and on
    // the next load it would re-bind the room to the injected path.
    expect(meta.get('sourceUrl')).toBeUndefined();
    expect(meta.get('title')).toBe('Fine');
  });

  it('reverts a peer write to a server-owned meta key, restoring the in-memory value', () => {
    const room = makeRoom('d23');
    room.meta.planState = 'draft' as DocMeta['planState'];
    const rec = makeHost([room]);
    new RoomFanout(rec.host).wireEvents(room);

    const meta = room.ydoc.getMap('meta');
    room.ydoc.transact(() => meta.set('planState', 'approved'));
    // A peer approving its own plan would file rows straight past the hold.
    expect(meta.get('planState')).toBe('draft');
  });

  it('deletes a server-owned key the room never had, rather than inventing one', () => {
    const room = makeRoom('d24');
    const rec = makeHost([room]);
    new RoomFanout(rec.host).wireEvents(room);

    const meta = room.ydoc.getMap('meta');
    room.ydoc.transact(() => meta.set('contentRevision', 99));
    expect(meta.has('contentRevision')).toBe(false);
  });

  it('lets the server write its own meta keys through', () => {
    const room = makeRoom('d25');
    const rec = makeHost([room]);
    new RoomFanout(rec.host).wireEvents(room);

    const meta = room.ydoc.getMap('meta');
    room.ydoc.transact(() => meta.set('contentRevision', 4), CONTENT_REVISION_ORIGIN);
    expect(meta.get('contentRevision')).toBe(4);
  });
});
