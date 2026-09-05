/**
 * The write half of the bound-file gate: what a doc→disk write-back may cost
 * the process, and what it may claim afterwards.
 *
 * The read half has `slow-fs.test.ts` and `hydrate-wedge.test.ts`. This file
 * covers the two ways the write side can go wrong once the write itself runs
 * on the thread pool: a shutdown that cannot see it, and a failure that
 * punishes the wrong operation.
 *
 * The pool write is held open by replacing `boundFiles.write` with one that
 * waits on a promise this file resolves. That is deliberate — the alternative
 * is a real unresponsive path, and the write side of that is what hung a
 * runner once already. Every test restores the method in a `finally`.
 *
 * Paths and contents are invented.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rooms } from '../src/rooms.ts';
import { type BoundStatResult, boundFiles } from '../src/slow-fs.ts';
import { SseHub } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { waitFor } from './wait-for.ts';

type PoolWrite = (path: string, text: string) => Promise<BoundStatResult>;

/**
 * `boundFiles` with its write seen as replaceable, so a test can hold one
 * open. Restoring assigns the original back rather than deleting the
 * property: an own `write` of `undefined` would shadow the class method and
 * break every later caller in the suite, which shares this one object.
 */
const patchable = boundFiles as unknown as { write?: PoolWrite };

describe('the bound-file write lane', () => {
  let dataDir: string;
  let path: string;
  let rooms: Rooms;
  const original: PoolWrite = boundFiles.write.bind(boundFiles);

  beforeEach(() => {
    boundFiles.reset();
    dataDir = mkdtempSync(join(tmpdir(), 'cw-write-lane-'));
    path = join(dataDir, 'Notes.md');
    writeFileSync(path, 'first line\n');
    rooms = new Rooms({
      dataDir,
      sse: new SseHub(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
      decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
    });
    rooms.getOrCreate('n1', { type: 'code', sourceUrl: path });
    expect(rooms.attachFlatFile('n1', path, { writeBack: true }).ok).toBe(true);
  });

  afterEach(() => {
    // Belt and braces: a leaked patch would break every later test file, since
    // the whole server suite shares one process and one `boundFiles`.
    patchable.write = original;
    rooms.stop();
    boundFiles.reset();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('counts a write still on the pool as pending, and flushes it on the way down', async () => {
    // The bug: a write-back that has STARTED has no timer any more — the
    // timer is what started it — so every question about pending writes
    // answered no while the bytes were still in the air. `flush()` skipped
    // the doc, and SIGTERM took the edit with it.
    let started = 0;
    let open!: () => void;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    patchable.write = async (p, text) => {
      started++;
      await held;
      return original(p, text);
    };

    try {
      rooms.get('n1')?.ydoc.getText('content').insert(0, 'an unsaved sentence\n');
      // Before the debounce fires this is pending because a timer is armed —
      // the positive control for the assertion below, which must hold for a
      // different reason.
      expect(rooms.pendingFileWrites()).toHaveLength(1);

      await waitFor(() => started === 1, { describe: 'the write-back to reach the pool' });
      // No timer now, and nothing on disk yet. This is the state that used to
      // read as "nothing to do".
      expect(readFileSync(path, 'utf8')).toBe('first line\n');
      expect(rooms.pendingFileWrites().map((w) => w.docId)).toEqual(['n1']);

      // `flush()` cannot await the pool, so it writes synchronously. What it
      // must not do is skip.
      rooms.flush();
      expect(readFileSync(path, 'utf8')).toContain('an unsaved sentence');
    } finally {
      open();
      patchable.write = original;
    }
  });

  it('leaves one complete version and no temp file when both lanes write', async () => {
    // A GUARD, not a regression test, and it is worth saying which: it passes
    // against the shared-temp-name code too. The corruption a shared name
    // allows needs one writer's `writeFile` to be interrupted by the other's,
    // and the only place a test can hold a write is on either side of the
    // whole operation — never between the write and the rename inside it.
    // Reaching in there would mean a seam in production code that exists for
    // this test alone.
    //
    // What it does pin is cheap and real: after both lanes have run, the file
    // holds one COMPLETE version rather than a mixture, and neither lane has
    // left its temp file behind.
    let started = 0;
    let open!: () => void;
    let landed: Promise<BoundStatResult> | undefined;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    patchable.write = (p, text) => {
      started++;
      landed = held.then(() => original(p, text));
      return landed;
    };

    const doc = rooms.get('n1')?.ydoc.getText('content');
    try {
      doc?.insert(0, 'version one\n');
      await waitFor(() => started === 1, { describe: 'the first write to reach the pool' });
      // A second edit while the first is still out. Its write-back re-arms
      // rather than racing, so the flush below is what carries it out.
      doc?.insert(0, 'version two\n');
      rooms.flush();
    } finally {
      open();
    }

    // Let the held write land ON TOP of what the flush already wrote — the
    // two renames have to actually overlap, so the test must not tear the
    // directory down before the second one runs.
    await landed;
    patchable.write = original;
    const onDisk = readFileSync(path, 'utf8');
    const pool = 'version one\nfirst line\n';
    const flushed = 'version two\nversion one\nfirst line\n';
    expect([pool, flushed]).toContain(onDisk);
    // And no temp file survives either lane.
    expect(readdirSync(dataDir).filter((f) => f.includes('~'))).toEqual([]);
  });

  it('does not quarantine a readable path because a write to it failed', async () => {
    // A write fails for reasons that say nothing about reading: no
    // permission, a read-only volume, no space, a parent directory renamed
    // away. Parking every READ of the file for the backoff would turn a
    // failed save into a doc that cannot even be opened.
    const orphan = join(dataDir, 'gone', 'Child.md');
    const failed = await boundFiles.write(orphan, 'never lands\n');
    expect(failed).toEqual({ status: 'unavailable', reason: 'error' });
    expect(boundFiles.quarantined(orphan)).toBe(false);

    // Positive control, on the same reader in the same test: a READ that
    // fails for a reason other than "not there" still does earn the backoff.
    // Without this the assertion above would also pass on a reader whose
    // quarantine had stopped working altogether.
    const dir = join(dataDir, 'a-directory');
    mkdirSync(dir);
    const unreadable = await boundFiles.read(dir);
    expect(unreadable).toEqual({ status: 'unavailable', reason: 'error' });
    expect(boundFiles.quarantined(dir)).toBe(true);
  });

  it('refuses to bind a flat doc whose path is quarantined', async () => {
    // `attachFlatFile` is the door the folder-bind loop walks, and it had no
    // quarantine check at all: a known-hostile file was opened on the main
    // thread once per member of the bound tree.
    const member = join(dataDir, 'Member.kt');
    // Quarantine the path while it is unreadable, then make it a perfectly
    // ordinary file. The refusal has to come from what the reader knows, not
    // from the file being unreadable at the moment of the attach.
    mkdirSync(member);
    expect((await boundFiles.read(member)).status).toBe('unavailable');
    expect(boundFiles.quarantined(member)).toBe(true);
    rmSync(member, { recursive: true, force: true });
    writeFileSync(member, 'fun member() {}\n');

    rooms.getOrCreate('m1', { type: 'code', sourceUrl: member });
    expect(rooms.attachFlatFile('m1', member)).toMatchObject({
      ok: false,
      error: 'read-failed',
    });
    // Refused means unbound and unseeded — the doc keeps its .ydoc content.
    expect(rooms.get('m1')?.ydoc.getText('content').toString()).toBe('');

    // Positive control: the same call on the same file succeeds once the
    // backoff is forgotten, so the refusal above is the quarantine talking
    // and not something else about this path.
    boundFiles.reset();
    expect(rooms.attachFlatFile('m1', member).ok).toBe(true);
    expect(rooms.get('m1')?.ydoc.getText('content').toString()).toBe('fun member() {}\n');
  });
});
