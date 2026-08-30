/**
 * The per-doc cost of a hydrated room.
 *
 * On 2026-08-29 the server reached 2.6 GB and was killed by jetsam. Hydration
 * loads every persisted doc, and each hydrated room used to construct a
 * y-protocols `Awareness` (a 3s interval per room, never unref'd) and, if the
 * doc was file-bound, a 500ms stat poll — both running forever whether or not
 * anybody had the doc open. These tests pin the three costs down: no presence
 * timer without a connection, no stat syscalls for a doc nobody is looking at,
 * and no stat-per-doc on a list.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose } from '@feedback/core';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';
import { Rooms, maintainAwareness } from '../src/rooms.ts';
import { SseHub } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

function makeRooms(dataDir: string): Rooms {
  return new Rooms({
    dataDir,
    sse: new SseHub(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function markdownOf(rooms: Rooms, docId: string): string {
  const room = rooms.get(docId);
  if (!room) throw new Error(`no room ${docId}`);
  return prose.serializeFragmentToMarkdown(prose.getProseFragment(room.ydoc));
}

describe('per-room timers', () => {
  let dataDir: string;
  let srcDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'prt-data-'));
    srcDir = mkdtempSync(join(tmpdir(), 'prt-src-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  /** Bind `count` markdown files, then restart the server over the same dir. */
  function seedBound(count: number): { rooms: Rooms; docIds: string[]; paths: string[] } {
    const first = makeRooms(dataDir);
    const docIds: string[] = [];
    const paths: string[] = [];
    for (let i = 0; i < count; i++) {
      const docId = `bound-${i}`;
      const path = join(srcDir, `${docId}.md`);
      writeFileSync(path, `# Doc ${i}\n\nbody\n`);
      first.getOrCreate(docId, { type: 'markdown' });
      first.attachFile(docId, path);
      docIds.push(docId);
      paths.push(path);
    }
    first.flush();
    // A fresh Rooms over the same data dir is exactly what a restart does.
    // Since lazy hydration, a restart loads NOTHING — so open each doc, which
    // is what these tests were really about: what a server holds once the
    // docs are in memory. `seedBoundCold` is the same fixture unopened.
    const rooms = makeRooms(dataDir);
    for (const docId of docIds) rooms.get(docId);
    // Opening put every doc in the poll's fast lane; drop the access stamps
    // so the fixture starts where a restart used to leave it — resident and
    // bound, with nobody looking at anything.
    rooms.resetDerivedCaches();
    return { rooms, docIds, paths };
  }

  /** The same fixture, restarted and NOT opened. */
  function seedBoundCold(count: number): { rooms: Rooms; docIds: string[]; paths: string[] } {
    const { rooms, docIds, paths } = seedBound(count);
    for (const docId of docIds) rooms.evictRoom(docId);
    return { rooms, docIds, paths };
  }

  it('a restart holds nothing until somebody reaches for a doc', () => {
    const { rooms, docIds } = seedBoundCold(5);
    // The boot that used to load every doc on the server now loads none, and
    // that is the whole memory change: no rooms, no bindings, no timers that
    // scale with the corpus.
    expect(rooms.stats().rooms).toBe(0);
    expect(rooms.stats().bindings).toBe(0);
    // ...and every one of them still resolves and still lists.
    expect(rooms.list().length).toBeGreaterThanOrEqual(docIds.length);
    expect(rooms.get(docIds[0] as string)).toBeDefined();
    expect(rooms.stats().rooms).toBe(1);
  });

  it('opening rooms constructs no Awareness (no presence timer)', () => {
    const { rooms, docIds } = seedBound(5);
    expect(rooms.stats().rooms).toBeGreaterThanOrEqual(docIds.length);
    expect(rooms.stats().awareness).toBe(0);
    for (const docId of docIds) {
      // The peek must not be the thing that creates one.
      expect(rooms.get(docId)?.peekAwareness()).toBeNull();
    }
    expect(rooms.stats().awareness).toBe(0);
  });

  it('creates the Awareness on first read and keeps returning the same one', () => {
    const { rooms, docIds } = seedBound(2);
    const room = rooms.get(docIds[0]);
    if (!room) throw new Error('room missing');
    const first = room.awareness;
    expect(first).toBeDefined();
    expect(room.peekAwareness()).toBe(first);
    expect(room.awareness).toBe(first);
    // Only the room that was read has one.
    expect(rooms.stats().awareness).toBe(1);
  });

  it('maintainAwareness does what y-protocols own interval did', () => {
    const doc = new Y.Doc();
    const aw = new awarenessProtocol.Awareness(doc);
    const remote = new Y.Doc();
    const remoteAw = new awarenessProtocol.Awareness(remote);
    remoteAw.setLocalState({ name: 'peer' });
    awarenessProtocol.applyAwarenessUpdate(
      aw,
      awarenessProtocol.encodeAwarenessUpdate(remoteAw, [remoteAw.clientID]),
      'test',
    );
    expect(aw.getStates().has(remoteAw.clientID)).toBe(true);

    // Nothing is outdated yet, so a tick at "now" must not evict anybody.
    maintainAwareness(aw, Date.now());
    expect(aw.getStates().has(remoteAw.clientID)).toBe(true);

    // 31s later the remote is outdated and the local clock is due a renewal.
    const localClockBefore = aw.meta.get(aw.clientID)?.clock ?? 0;
    maintainAwareness(aw, Date.now() + 31_000);
    expect(aw.getStates().has(remoteAw.clientID)).toBe(false);
    expect(aw.meta.get(aw.clientID)?.clock ?? 0).toBeGreaterThan(localClockBefore);

    aw.destroy();
    remoteAw.destroy();
    doc.destroy();
    remote.destroy();
  });

  it('expires stale presence on a room with NO sockets left', async () => {
    // codex P2: skipping maintenance for socketless rooms let a state left
    // behind by a socket whose cleanup never ran survive indefinitely, and
    // `onOpen` hands `getStates()` to the next joiner before any sweep — so
    // the joiner would see a ghost peer. The library's own timer expired
    // those whether or not anyone was connected.
    const { rooms, docIds } = seedBound(1);
    const room = rooms.get(docIds[0]);
    if (!room) throw new Error('room missing');
    const aw = room.awareness;

    // A peer's state arrives, then its socket vanishes without cleanup.
    const ghostDoc = new Y.Doc();
    const ghost = new awarenessProtocol.Awareness(ghostDoc);
    ghost.setLocalState({ name: 'ghost' });
    awarenessProtocol.applyAwarenessUpdate(
      aw,
      awarenessProtocol.encodeAwarenessUpdate(ghost, [ghost.clientID]),
      'test',
    );
    expect(room.conns.size).toBe(0);
    // Control: the ghost really is present, so the assertion below has
    // something to fail on.
    expect(aw.getStates().has(ghost.clientID)).toBe(true);

    // The sweep is what must clear it. Drive the same function the ticker
    // does, at a time past the outdated window.
    maintainAwareness(aw, Date.now() + 31_000);
    expect(aw.getStates().has(ghost.clientID)).toBe(false);

    ghost.destroy();
    ghostDoc.destroy();
  });

  it('a bound doc nobody is looking at is not in the fast lane', () => {
    const { rooms } = seedBound(10);
    const after = rooms.stats();
    expect(after.bindings).toBe(10);
    // All ten bindings armed, none of them active: they are swept on the
    // idle budget, not stat'd on every tick.
    expect(after.activeBindings).toBe(0);
    // Three timers for ten bindings, and the same three for ten thousand:
    // the memory line, the one shared file sweep, and the idle-eviction
    // sweep. The count is the point, not the number.
    expect(after.timers).toBe(3);
  });

  it('still applies an external edit to a bound doc nobody is WATCHING', async () => {
    // The guarantee `git-ops-vs-bound.test.ts` depends on: a git checkout or
    // an editor save against a bound file reaches the live doc even though no
    // reader, socket or tool is looking at it. It holds for every doc the
    // server is holding — which, since lazy hydration, means every doc that
    // has been opened at least once. The cold case is the test below.
    const { rooms, docIds, paths } = seedBound(1);
    expect(rooms.stats().activeBindings).toBe(0);
    writeFileSync(paths[0], '# Doc 0\n\narrived with nobody watching\n');
    // Same control as above: the seed and this write can share a millisecond,
    // and an mtime that did not move is invisible to any mtime poll, old or
    // new. Forcing it forward makes a failure here mean "not detected".
    const t = new Date(Date.now() + 2000);
    utimesSync(paths[0], t, t);
    await sleep(1500);
    expect(markdownOf(rooms, docIds[0])).toContain('arrived with nobody watching');
  });

  it('a doc nobody has OPENED is not polled — and the edit is read on open', async () => {
    // A behaviour change from lazy hydration, recorded here on purpose
    // rather than left to be discovered. A doc the server has never opened
    // has no room and no binding, so nothing stats its file: an external
    // edit to it is NOT picked up live, and no `watch_doc` subscriber is
    // notified. What is preserved is the thing that matters — the edit is
    // not lost. `attachFile` arbitrates on open, the file is the source of
    // truth at rest, and the content is there the moment somebody reaches.
    const { rooms, docIds, paths } = seedBoundCold(1);
    expect(rooms.stats().rooms).toBe(0);
    expect(rooms.stats().bindings).toBe(0);

    writeFileSync(paths[0], '# Doc 0\n\nedited while cold\n');
    const t = new Date(Date.now() + 2000);
    utimesSync(paths[0], t, t);
    await sleep(1500);
    // Nothing woke up: no poll ran, because there was no binding to run one.
    expect(rooms.stats().rooms).toBe(0);

    // And the edit survived — reaching for the doc reads it off disk.
    expect(markdownOf(rooms, docIds[0])).toContain('edited while cold');
  });

  it('a bound doc that saw one external edit does not stay active forever', async () => {
    // The reconcile debounce is a `setTimeout` on the binding, and
    // `bindingIsActive` reads it as "a reconcile is still pending". The
    // callback used to leave the fired handle behind, so the FIRST external
    // edit pinned that binding in the fast lane for the life of the process
    // — a 500ms stat per changed doc, forever, with nobody watching. On
    // production this read as every bound doc active five minutes after boot.
    const { rooms, docIds, paths } = seedBound(2);
    expect(rooms.stats().activeBindings).toBe(0);

    writeFileSync(paths[0], '# Doc 0\n\nedited once\n');
    const t = new Date(Date.now() + 2000);
    utimesSync(paths[0], t, t);
    // Long enough for the sweep to see it, the 150ms read debounce to fire,
    // and the 800ms write-back debounce behind it to drain.
    await sleep(2500);

    // Control: the edit really landed. Without it, "nothing is active" could
    // just mean the poll never noticed anything at all.
    expect(markdownOf(rooms, docIds[0])).toContain('edited once');

    // `markdownOf` calls `rooms.get`, which is a genuine access — clear the
    // access stamps so only a leftover timer could still hold the binding.
    rooms.resetDerivedCaches();
    expect(rooms.stats().activeBindings).toBe(0);
  });

  it('an access activates exactly the doc that was accessed', () => {
    const { rooms, docIds } = seedBound(10);
    rooms.get(docIds[3]);
    expect(rooms.stats().activeBindings).toBe(1);
  });

  it('a live connection keeps a doc active with no access at all', () => {
    // The websocket path: `websocket.open` resolves the room and adds the
    // socket to `conns`, and from then on the doc is active for as long as
    // the socket lives — it must not fall back to the idle rotation after
    // FILE_POLL_ACTIVE_MS just because nobody made another REST call.
    const { rooms, docIds } = seedBound(3);
    const room = rooms.get(docIds[1]);
    if (!room) throw new Error('room missing');
    // Stand in for the socket; `bindingIsActive` only reads `conns.size`.
    room.conns.add({} as never);
    // Push every access stamp far into the past so ONLY the connection can
    // be keeping this binding active. Without this the assertion would pass
    // on the `rooms.get` above and prove nothing about connections.
    rooms.resetDerivedCaches();
    expect(rooms.stats().activeBindings).toBe(1);
    room.conns.clear();
    expect(rooms.stats().activeBindings).toBe(0);
  });

  it('an external edit made while idle reaches the doc after a connect', async () => {
    const { rooms, docIds, paths } = seedBound(1);
    const docId = docIds[0];
    rooms.resetDerivedCaches();
    expect(rooms.stats().activeBindings).toBe(0);

    writeFileSync(paths[0], '# Doc 0\n\nedited before anyone connected\n');
    // The seed and this write can share a millisecond, and an mtime that did
    // not move is invisible to any mtime poll, old or new. Forcing it forward
    // makes a failure here mean "not detected".
    const t = new Date(Date.now() + 2000);
    utimesSync(paths[0], t, t);

    // Exactly what `websocket.open` does: resolve the room, then add the
    // socket. Two things can carry the edit here and BOTH are the point —
    // `get` re-stats on the idle to active edge, and the connection then
    // holds the doc in the fast lane. The test above isolates the connection
    // on its own; this one asserts the outcome the upgrade path must give.
    const room = rooms.get(docId);
    if (!room) throw new Error('room missing');
    room.conns.add({} as never);
    await sleep(2000);
    expect(markdownOf(rooms, docId)).toContain('edited before anyone connected');
    room.conns.clear();
  });

  it('picks up an external edit to an IDLE bound file on the next access', async () => {
    const { rooms, docIds, paths } = seedBound(1);
    const docId = docIds[0];
    expect(rooms.stats().activeBindings).toBe(0);

    writeFileSync(paths[0], '# Doc 0\n\nedited outside the server\n');
    // Push the mtime forward explicitly: the seed and this write can land in
    // the same millisecond on a fast filesystem, and then no poll — old or
    // new — would see a change. (A control for the assertion below: without
    // this the test could pass while detecting nothing.)
    const t = new Date(Date.now() + 2000);
    utimesSync(paths[0], t, t);

    // The access is what triggers the re-stat; the reconcile is debounced.
    rooms.get(docId);
    await sleep(400);
    expect(markdownOf(rooms, docId)).toContain('edited outside the server');
  });

  it('reparse_from_disk still force-pulls an idle bound file', async () => {
    const { rooms, docIds, paths } = seedBound(1);
    writeFileSync(paths[0], '# Doc 0\n\nforced in by reparse\n');
    const res = rooms.reparseFromDisk(docIds[0]);
    expect(res.ok).toBe(true);
    expect(markdownOf(rooms, docIds[0])).toContain('forced in by reparse');
  });

  it('list() reports the .ydoc mtime and keeps reporting it after a write', () => {
    const { rooms, docIds } = seedBound(3);
    const rows = rooms.list().filter((m) => docIds.includes(m.docId));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const onDisk = Math.round(statSync(join(dataDir, `${row.docId}.ydoc`)).mtimeMs);
      expect(row.lastActivityAt).toBe(onDisk);
    }
    // Same rows on a second call — the cache must not change the answer.
    const again = rooms.list().filter((m) => docIds.includes(m.docId));
    expect(again.map((m) => m.lastActivityAt)).toEqual(rows.map((m) => m.lastActivityAt));
  });

  it('list() is byte-identical cold-cache and warm-cache', () => {
    // The cache is populated lazily by the first read, so a fresh Rooms over
    // the same data dir serves the FIRST list from statSync and the second
    // from the cache. Serialising both is the strongest form of "GET
    // /api/docs returns the same rows": not the same values field by field,
    // the same bytes.
    const { rooms, docIds } = seedBound(4);
    expect(docIds).toHaveLength(4);
    const cold = JSON.stringify(rooms.list());
    const warm = JSON.stringify(rooms.list());
    expect(warm).toBe(cold);
    // And a doc whose entry is dropped re-stats to the same answer rather
    // than falling back to createdAt.
    rooms.resetDerivedCaches();
    expect(JSON.stringify(rooms.list())).toBe(cold);
  });

  it('list() picks up a doc that has just been written', async () => {
    const { rooms, docIds } = seedBound(1);
    const before = rooms.list().find((m) => m.docId === docIds[0])?.lastActivityAt;
    await sleep(20);
    const room = rooms.get(docIds[0]);
    if (!room) throw new Error('room missing');
    room.ydoc.transact(() => room.ydoc.getMap('meta').set('title', 'renamed'));
    rooms.flush();
    const after = rooms.list().find((m) => m.docId === docIds[0])?.lastActivityAt;
    expect(after).toBeGreaterThanOrEqual(before ?? 0);
    expect(after).toBe(Math.round(statSync(join(dataDir, `${docIds[0]}.ydoc`)).mtimeMs));
  });
});

describe('hydration cost at corpus scale', () => {
  it('holds no per-doc timers for a few hundred hydrated bound docs', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'prt-scale-data-'));
    const srcDir = mkdtempSync(join(tmpdir(), 'prt-scale-src-'));
    mkdirSync(srcDir, { recursive: true });
    try {
      const first = makeRooms(dataDir);
      for (let i = 0; i < 200; i++) {
        const docId = `scale-${i}`;
        const path = join(srcDir, `${docId}.md`);
        writeFileSync(path, `# ${docId}\n\nbody\n`);
        first.getOrCreate(docId, { type: 'markdown' });
        first.attachFile(docId, path);
      }
      first.flush();

      const rooms = makeRooms(dataDir);
      // A restart now loads nothing — assert that before opening them, so
      // this file records the boot cost as well as the held cost.
      expect(rooms.stats().rooms).toBe(0);
      for (let i = 0; i < 200; i++) rooms.get(`scale-${i}`);
      rooms.resetDerivedCaches();
      const s = rooms.stats();
      expect(s.rooms).toBe(200);
      expect(s.bindings).toBe(200);
      // The whole point: the timer count does not scale with the corpus.
      // 200 rooms, 200 bindings, no presence instances, three timers — the
      // memory line, the shared file sweep and the idle-eviction sweep.
      // Before this change the same fixture held 400 (one Awareness interval
      // and one stat poll per doc), which is what took the server to 2.6 GB
      // at 5,600 docs.
      expect(s.awareness).toBe(0);
      expect(s.activeBindings).toBe(0);
      expect(s.timers).toBe(3);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(srcDir, { recursive: true, force: true });
    }
  });
});
