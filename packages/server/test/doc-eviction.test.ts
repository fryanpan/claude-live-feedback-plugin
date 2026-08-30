/**
 * Eviction is where this feature can lose Bryan's work, so these tests are
 * about the four named ways it does that — not about whether memory went
 * down.
 *
 * The one that matters most is the last: a bound doc evicted while an edit is
 * still inside its debounce window, then edited on disk by someone else, must
 * end up with BOTH edits. Every other guard exists so that cannot happen by a
 * different route.
 *
 * Two days is Bryan's number ("drop idle docs after two days, but if the user
 * opens the doc again or interacts with it that resets the clock"), so these
 * drive an injected clock rather than waiting, and reset it through the real
 * `get` rather than by writing to the map behind it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rooms } from '../src/rooms.ts';
import { SseHub } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** Read a bound doc's markdown back off disk. */
const onDisk = (p: string) => readFileSync(p, 'utf8');

describe('evicting an idle doc', () => {
  let dataDir: string;
  let srcDir: string;
  let rooms: Rooms;
  let clock: number;

  function makeRooms(dir: string): Rooms {
    return new Rooms({
      dataDir: dir,
      sse: new SseHub(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
      now: () => clock,
    });
  }

  beforeEach(() => {
    clock = Date.now();
    dataDir = mkdtempSync(join(tmpdir(), 'evict-data-'));
    srcDir = mkdtempSync(join(tmpdir(), 'evict-src-'));
    rooms = makeRooms(dataDir);
  });
  afterEach(() => {
    rooms.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  /** A file-bound markdown doc — the shape with something to lose. */
  function bound(docId: string, body = '# Title\n\nfirst line\n'): string {
    const path = join(srcDir, `${docId}.md`);
    writeFileSync(path, body);
    rooms.getOrCreate(docId, { type: 'markdown', title: docId });
    expect(rooms.attachFile(docId, path).ok).toBe(true);
    return path;
  }

  const resident = (docId: string) => rooms.peek(docId) !== undefined;

  it('drops a doc idle for two days and keeps one touched an hour ago', () => {
    bound('stale');
    bound('fresh');
    rooms.flush();

    // Three days on, then a real interaction with one of them an hour ago.
    clock += 3 * DAY - HOUR;
    expect(rooms.get('fresh')).toBeDefined();
    clock += HOUR;

    expect(rooms.evictIdleRooms()).toEqual(['stale']);
    expect(resident('stale')).toBe(false);
    expect(resident('fresh')).toBe(true);
  });

  it('an interaction resets the clock, so a doc opened today survives', () => {
    bound('reopened');
    rooms.flush();

    clock += 3 * DAY;
    // "if the user opens the doc again or interacts with it that resets the
    // clock" — `get` is that open.
    expect(rooms.get('reopened')).toBeDefined();

    expect(rooms.evictIdleRooms()).toEqual([]);
    expect(resident('reopened')).toBe(true);

    // Control: the clock really is what is holding it — three more days with
    // nobody touching it and the same doc goes.
    clock += 3 * DAY;
    expect(rooms.evictIdleRooms()).toEqual(['reopened']);
  });

  it('still resolves every docId after eviction, by id and by alias', () => {
    const room = rooms.getOrCreate('minted-id', { type: 'markdown', alias: 'readable-name' });
    expect(room.meta.alias).toBe('readable-name');
    rooms.flush();

    clock += 3 * DAY;
    expect(rooms.evictIdleRooms()).toEqual(['minted-id']);
    // Control: it really is gone from memory, so the lookups below are doing
    // work rather than reading a room that never left.
    expect(resident('minted-id')).toBe(false);

    // A captured alias URL must not 404. `teardownRoom` releases aliases;
    // eviction must not.
    expect(rooms.get('readable-name')?.docId).toBe('minted-id');
    expect(rooms.get('minted-id')?.docId).toBe('minted-id');
    expect(rooms.list().some((m) => m.docId === 'minted-id')).toBe(true);
  });

  it('refuses to evict a doc that is connected, mid-write, just edited, or wedged', () => {
    // 1. A live connection.
    bound('connected');
    (rooms.peek('connected') as { conns: Set<unknown> }).conns.add({ data: {} });

    // 2. A pending write-back — an edit still inside its debounce window.
    const midPath = bound('mid-write');

    // 3. A doc a person edited moments ago (the stale-write window).
    bound('just-edited');

    // 4. A doc whose last reconcile hit a conflict.
    const wedgedPath = bound('wedged');

    rooms.flush();
    clock += 3 * DAY;

    expect(
      rooms.findAndReplace('mid-write', { find: 'first line', replace: 'typed, not yet flushed' })
        .ok,
    ).toBe(true);
    (rooms.peek('just-edited') as { lastHumanEditAt?: number }).lastHumanEditAt = clock;
    expect(rooms.findAndReplace('wedged', { find: 'first line', replace: 'live edit' }).ok).toBe(
      true,
    );
    writeFileSync(wedgedPath, '# Title\n\nexternal edit\n');
    expect(rooms.reconcileNow('wedged')).toBe('conflict');
    expect(rooms.getDoc('wedged')?.syncError).toBeDefined();

    expect(rooms.evictIdleRooms()).toEqual([]);

    // POSITIVE CONTROL: with every hold released, the same four DO evict — so
    // the empty list above is the guards, not a sweep that never ran.
    (rooms.peek('connected') as { conns: Set<unknown> }).conns.clear();
    rooms.flush();
    (rooms.peek('just-edited') as { lastHumanEditAt?: number }).lastHumanEditAt = clock - 3 * DAY;
    writeFileSync(wedgedPath, '# Title\n\nexternal edit, uncontested\n');
    expect(rooms.reconcileNow('wedged')).toBe('apply');
    expect(rooms.getDoc('wedged')?.syncError).toBeUndefined();
    rooms.flush();
    // Clearing the wedge means reconciling, and a reconcile IS an
    // interaction — it resets the idle clock, exactly as an open does. So
    // idle them all again; the guards are the only thing that differs
    // between this call and the one above.
    clock += 3 * DAY;

    expect(rooms.evictIdleRooms().sort()).toEqual([
      'connected',
      'just-edited',
      'mid-write',
      'wedged',
    ]);
    // And the pending edit reached the file rather than being cancelled.
    expect(onDisk(midPath)).toContain('typed, not yet flushed');
  });

  it('flushes a pending save instead of cancelling it', () => {
    const path = bound('flushme');
    rooms.flush();
    expect(
      rooms.findAndReplace('flushme', {
        find: 'first line',
        replace: 'the sentence that must survive',
      }).ok,
    ).toBe(true);

    // Control: it is genuinely still pending — nothing has written it yet.
    expect(onDisk(path)).not.toContain('the sentence that must survive');

    expect(rooms.evictRoom('flushme')).toBe(true);
    expect(resident('flushme')).toBe(false);
    expect(onDisk(path)).toContain('the sentence that must survive');

    // The .ydoc got the same treatment, so a restart agrees with the file.
    const back = makeRooms(dataDir);
    expect(back.getDoc('flushme')?.plainText).toContain('the sentence that must survive');
    back.stop();
  });

  it('re-attaches a re-opened doc so it still writes back', () => {
    const path = bound('rebind');
    rooms.flush();
    expect(rooms.evictRoom('rebind')).toBe(true);
    expect(resident('rebind')).toBe(false);

    // Re-open, then edit. The 2026-05-09 bug is a doc that comes back
    // READABLE but never writes to disk again, which no read can detect.
    expect(rooms.get('rebind')).toBeDefined();
    expect(
      rooms.findAndReplace('rebind', { find: 'first line', replace: 'written after coming back' })
        .ok,
    ).toBe(true);
    rooms.flush();

    expect(onDisk(path)).toContain('written after coming back');
  });

  /**
   * THE ONE THAT MATTERS.
   *
   * A bound doc is evicted while an edit is still inside its debounce window,
   * and then someone edits the file on disk while the doc is not in memory.
   * Both edits have to be there afterwards.
   *
   * The eviction must flush (not cancel) the pending write, and it must clear
   * `lastMtimeMs` so the external edit reconciles as an APPLY rather than
   * being mistaken for the write we just made.
   */
  it('keeps both edits when a doc is evicted mid-edit and then edited externally', () => {
    const path = bound('both', '# Both\n\nbaseline\n');
    rooms.flush();

    // In-memory edit, still inside its debounce window.
    expect(rooms.findAndReplace('both', { find: 'baseline', replace: 'from the editor' }).ok).toBe(
      true,
    );
    expect(onDisk(path)).not.toContain('from the editor');

    // Evicted mid-edit.
    expect(rooms.evictRoom('both')).toBe(true);
    expect(resident('both')).toBe(false);

    // The flush landed, so the external editor sees the in-memory edit.
    const flushed = onDisk(path);
    expect(flushed).toContain('from the editor');

    // Someone edits the file while the doc is out of memory.
    writeFileSync(path, `${flushed.trimEnd()}\n\nfrom the filesystem\n`);

    // Re-open. The doc must reconcile FROM disk, not assert its own stale
    // copy — which is what a stale `lastMtimeMs` would make it do.
    expect(rooms.get('both')).toBeDefined();
    const text = rooms.getDoc('both')?.plainText ?? '';
    expect(text).toContain('from the editor');
    expect(text).toContain('from the filesystem');

    // And the file still holds both once the doc settles: the re-attach must
    // not write its pre-eviction state back over the external edit.
    rooms.flush();
    const after = onDisk(path);
    expect(after).toContain('from the editor');
    expect(after).toContain('from the filesystem');
  });
});

describe('booting against docs that are not loaded', () => {
  let dataDir: string;
  let srcDir: string;

  const make = (dir: string) =>
    new Rooms({
      dataDir: dir,
      sse: new SseHub(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
    });

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'lazy-data-'));
    srcDir = mkdtempSync(join(tmpdir(), 'lazy-src-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  it('loads nothing at boot, and still answers for every doc', () => {
    const first = make(dataDir);
    for (let i = 0; i < 40; i++) {
      const docId = `lazy-${i}`;
      const path = join(srcDir, `${docId}.md`);
      writeFileSync(path, `# Doc ${i}\n\nbody ${i}\n`);
      first.getOrCreate(docId, { type: 'markdown', title: `Doc ${i}`, alias: `name-${i}` });
      first.attachFile(docId, path);
    }
    first.flush();
    const before = first.list();
    first.stop();

    const second = make(dataDir);
    try {
      // Nothing hydrated. This is the whole point: a listing must not cost
      // 5,000 decoded CRDTs.
      expect(second.residentCount()).toBe(0);
      // ...yet the listing is complete and equal to the hydrated one.
      expect(second.list().length).toBe(before.length);

      // And a doc still resolves, by id and by the alias somebody saved.
      expect(second.get('lazy-7')?.docId).toBe('lazy-7');
      expect(second.get('name-9')?.docId).toBe('lazy-9');
      expect(second.getDoc('lazy-7')?.plainText).toContain('body 7');

      // Reaching for two docs loads two docs, not forty.
      expect(second.residentCount()).toBe(2);
    } finally {
      second.stop();
    }
  });

  it('gives a .ydoc with no index a row at boot without keeping it resident', () => {
    const first = make(dataDir);
    first.getOrCreate('legacy', { type: 'markdown', title: 'Legacy' });
    first.flush();
    first.stop();
    // The pre-index world: a .ydoc with no row beside it.
    rmSync(join(dataDir, 'legacy.index.json'), { force: true });
    expect(existsSync(join(dataDir, 'legacy.ydoc'))).toBe(true);

    const second = make(dataDir);
    try {
      expect(existsSync(join(dataDir, 'legacy.index.json'))).toBe(true);
      expect(second.list().some((m) => m.docId === 'legacy')).toBe(true);
      // Hydrated once to write the row, then let go again.
      expect(second.residentCount()).toBe(0);
    } finally {
      second.stop();
    }
  });
});
