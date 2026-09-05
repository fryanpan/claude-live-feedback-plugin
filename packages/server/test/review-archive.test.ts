/**
 * Archiving a finished review — the SOFT half of retiring one.
 *
 * The project rule is "never hard delete, use soft delete", and the reason is
 * that the `.ydoc` is the durable record the Weekly Review analyses are
 * rebuilt from: `activity-backfill` reconstructs `activity.jsonl` from those
 * files, so a purge silently truncates a historical window nobody can rebuild.
 *
 * The mechanism was half-built before this suite: `hydrateFromDisk` reads only
 * the TOP LEVEL of the data dir (so a doc under `_archive/` stops loading and
 * stops costing a poll) while `activity-backfill` explicitly scans `_archive`
 * (so it still feeds analysis). What was missing was a writer. These tests
 * pin what that writer must guarantee — above all that the activity stream
 * over an archived review is BYTE-IDENTICAL to the stream before archiving.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBackfill } from '../src/activity-backfill.ts';
import { listArchivedReviews, readArchiveManifest } from '../src/review-archive.ts';
import { Rooms } from '../src/rooms.ts';
import { SseHub } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

const REVIEWER = { id: 'u1', name: 'Reviewer', kind: 'known' as const, color: '#2e7dd7' };

/** Let the 200ms debounced persist land — assertions about what is ON DISK
 *  are meaningless before it, and every one of them failed on the first run
 *  for exactly that reason rather than for anything the code got wrong. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 260));

function makeRooms(dataDir: string): Rooms {
  return new Rooms({
    dataDir,
    sse: new SseHub(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
    decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
  });
}

/** Bind every file in the folder as a member doc (bindFolder binds lazily). */
function bindAllFiles(
  rooms: Rooms,
  folderPath: string,
): { setId: string; docIds: string[]; byPath: Map<string, string> } {
  const bound = rooms.bindFolder({ folderPath, owner: '/cwd' });
  if (!bound.ok) throw new Error('bindFolder failed');
  const byPath = new Map<string, string>();
  for (const f of rooms.listRepoFiles(bound.workspaceId).files ?? []) {
    const opened = rooms.openContextFile(bound.workspaceId, f.relPath);
    if (opened.ok) byPath.set(f.relPath, opened.docId);
  }
  return { setId: bound.workspaceId, docIds: [...byPath.values()], byPath };
}

/** Wipe activity.jsonl, rebuild it from the .ydoc files, return the bytes. */
function backfilledStream(dataDir: string): string {
  rmSync(join(dataDir, 'activity.jsonl'), { force: true });
  runBackfill({ dataDir, write: true });
  const p = join(dataDir, 'activity.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

describe('Rooms.archiveReview / unarchiveReview', () => {
  let dataDir: string;
  let folder: string;
  let rooms: Rooms;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'ar-data-'));
    folder = mkdtempSync(join(tmpdir(), 'ar-src-'));
    rooms = makeRooms(dataDir);
    mkdirSync(join(folder, 'src'));
    writeFileSync(join(folder, 'README.md'), '# Project\n\nthe unique md line\n');
    writeFileSync(join(folder, 'src', 'index.ts'), 'export const answer = 42;\n');
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  it('returns not-found for an id no review is bound under', () => {
    const res = rooms.archiveReview('nope', { archivedBy: 'Tester' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('not-found');
  });

  it('archives OVER open threads — that is the point of the verb', async () => {
    const bound = bindAllFiles(rooms, folder);
    const mdDocId = bound.byPath.get('README.md')!;
    await rooms.createThreadByFind(
      mdDocId,
      { find: 'the unique md line' },
      REVIEWER,
      'still unresolved',
    );

    const res = rooms.archiveReview(bound.setId, {
      archivedBy: 'Tester',
      reason: 'merged in #123',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.archived).toBe(bound.docIds.length);
    // Gone from memory, so gone from rooms.list() and from the home page.
    expect(rooms.list().length).toBe(0);
    for (const id of bound.docIds) expect(rooms.get(id)).toBeUndefined();
    // The ydoc still exists — under _archive, where hydrate cannot see it.
    for (const id of bound.docIds) {
      expect(existsSync(join(dataDir, `${id}.ydoc`))).toBe(false);
      expect(existsSync(join(dataDir, '_archive', `${id}.ydoc`))).toBe(true);
    }
  });

  it('moves the private-meta sidecar alongside the ydoc', async () => {
    const bound = bindAllFiles(rooms, folder);
    await settle();
    const sidecars = bound.docIds.filter((id) => existsSync(join(dataDir, `${id}.private.json`)));
    expect(sidecars.length).toBeGreaterThan(0);
    expect(rooms.archiveReview(bound.setId, { archivedBy: 'Tester' }).ok).toBe(true);
    for (const id of sidecars) {
      expect(existsSync(join(dataDir, `${id}.private.json`))).toBe(false);
      expect(existsSync(join(dataDir, '_archive', `${id}.private.json`))).toBe(true);
    }
  });

  it('records who archived it and why, and lists it as archived', () => {
    const bound = bindAllFiles(rooms, folder);
    rooms.archiveReview(bound.setId, { archivedBy: 'Tester', reason: 'merged in #123' });

    const manifest = readArchiveManifest(dataDir, bound.setId);
    expect(manifest).toBeTruthy();
    expect(manifest?.archivedBy).toBe('Tester');
    expect(manifest?.reason).toBe('merged in #123');
    expect(new Set(manifest?.docIds)).toEqual(new Set(bound.docIds));
    expect(Date.parse(manifest?.archivedAt ?? '')).toBeGreaterThan(0);

    const listed = listArchivedReviews(dataDir);
    expect(listed.map((r) => r.setId)).toEqual([bound.setId]);
  });

  it('appends an archive event to the activity log', () => {
    const bound = bindAllFiles(rooms, folder);
    rooms.archiveReview(bound.setId, { archivedBy: 'Tester', reason: 'merged in #123' });
    const log = readFileSync(join(dataDir, 'activity.jsonl'), 'utf8');
    const archiveRows = log
      .split('\n')
      .filter(Boolean)
      .map(
        (l) =>
          JSON.parse(l) as { type: string; actorName?: string; payload: Record<string, unknown> },
      )
      .filter((e) => e.type === 'archive');
    expect(archiveRows.length).toBe(1);
    expect(archiveRows[0]?.actorName).toBe('Tester');
    expect(archiveRows[0]?.payload.reason).toBe('merged in #123');
    expect(archiveRows[0]?.payload.reviewId).toBe(bound.setId);
  });

  it('unarchive brings the review back: rooms, threads and all', async () => {
    const bound = bindAllFiles(rooms, folder);
    const mdDocId = bound.byPath.get('README.md')!;
    await rooms.createThreadByFind(
      mdDocId,
      { find: 'the unique md line' },
      REVIEWER,
      'still unresolved',
    );
    expect(rooms.archiveReview(bound.setId, { archivedBy: 'Tester' }).ok).toBe(true);

    const back = rooms.unarchiveReview(bound.setId, { archivedBy: 'Tester' });
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.restored).toBe(bound.docIds.length);
    expect(rooms.list().length).toBe(bound.docIds.length);
    // The thread survived the round trip.
    const threads = rooms.listThreads(mdDocId, { status: 'open' });
    expect(threads.length).toBe(1);
    expect(threads[0]?.comments[0]?.text).toBe('still unresolved');
    // Nothing is left behind in _archive, manifest included.
    for (const id of bound.docIds) {
      expect(existsSync(join(dataDir, `${id}.ydoc`))).toBe(true);
      expect(existsSync(join(dataDir, '_archive', `${id}.ydoc`))).toBe(false);
    }
    expect(listArchivedReviews(dataDir)).toEqual([]);
  });

  it('unarchive of an id that was never archived is not-found', () => {
    const res = rooms.unarchiveReview('nope', { archivedBy: 'Tester' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('not-found');
  });

  it('refuses rather than overwrites when the id is ALREADY in _archive', async () => {
    const bound = bindAllFiles(rooms, folder);
    const mdDocId = bound.byPath.get('README.md')!;
    // An older snapshot of the same docId is already parked in _archive —
    // the state 5 docIds on the production box are in, from a hand-move in
    // June. Whatever it holds, archiving must not silently write over it.
    mkdirSync(join(dataDir, '_archive'), { recursive: true });
    writeFileSync(join(dataDir, '_archive', `${mdDocId}.ydoc`), 'older-snapshot');
    await settle();

    const res = rooms.archiveReview(bound.setId, { archivedBy: 'Tester' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('archive-collision');
    if (res.error !== 'archive-collision') return;
    expect(res.docIds).toEqual([mdDocId]);
    // ALL-OR-NOTHING: not one member moved, and the older snapshot is intact.
    expect(rooms.list().length).toBe(bound.docIds.length);
    for (const id of bound.docIds) expect(existsSync(join(dataDir, `${id}.ydoc`))).toBe(true);
    expect(readFileSync(join(dataDir, '_archive', `${mdDocId}.ydoc`), 'utf8')).toBe(
      'older-snapshot',
    );
  });

  it('refuses to unarchive onto a live doc of the same id', () => {
    const bound = bindAllFiles(rooms, folder);
    rooms.archiveReview(bound.setId, { archivedBy: 'Tester' });
    // Something re-minted one of the ids while the review was archived.
    const revived = bound.docIds[0]!;
    writeFileSync(join(dataDir, `${revived}.ydoc`), 'live-again');

    const res = rooms.unarchiveReview(bound.setId, { archivedBy: 'Tester' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('restore-collision');
    if (res.error !== 'restore-collision') return;
    expect(res.docIds).toEqual([revived]);
    // Nothing moved: the archive is still whole.
    for (const id of bound.docIds.slice(1)) {
      expect(existsSync(join(dataDir, '_archive', `${id}.ydoc`))).toBe(true);
      expect(existsSync(join(dataDir, `${id}.ydoc`))).toBe(false);
    }
  });
});

describe('archived docs keep feeding activity-backfill', () => {
  let dataDir: string;
  let folder: string;
  let rooms: Rooms;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'arb-data-'));
    folder = mkdtempSync(join(tmpdir(), 'arb-src-'));
    rooms = makeRooms(dataDir);
    writeFileSync(join(folder, 'README.md'), '# Project\n\nthe unique md line\n');
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  it('the backfilled stream over an archived review is BYTE-IDENTICAL', async () => {
    const bound = bindAllFiles(rooms, folder);
    const mdDocId = bound.byPath.get('README.md')!;
    const created = await rooms.createThreadByFind(
      mdDocId,
      { find: 'the unique md line' },
      REVIEWER,
      'a comment that must survive archiving',
    );
    expect(created.ok).toBe(true);
    await settle();

    const before = backfilledStream(dataDir);
    // Positive control: the probe can see something real. Without this a
    // byte-comparison of two empty strings passes while proving nothing.
    expect(before.length).toBeGreaterThan(0);
    expect(before).toContain('a comment that must survive archiving');
    // ...and it carries the sidecar-sourced fields, which is exactly what a
    // move into _archive threatens: readPrivateMeta looks NEXT TO the .ydoc.
    expect(before).toContain('"producedBy"');

    expect(rooms.archiveReview(bound.setId, { archivedBy: 'Tester' }).ok).toBe(true);

    const after = backfilledStream(dataDir);
    expect(after).toBe(before);
  });

  it('still reads a HAND-MOVED archive whose sidecar stayed at the top level', async () => {
    // The 174 ydocs moved into _archive by hand in June left their
    // `.private.json` sidecars behind in the data dir. Resolving the sidecar
    // next to the .ydoc must not blind the backfill to those.
    const bound = bindAllFiles(rooms, folder);
    const mdDocId = bound.byPath.get('README.md')!;
    await rooms.createThreadByFind(
      mdDocId,
      { find: 'the unique md line' },
      REVIEWER,
      'a hand-moved comment',
    );
    await settle();
    const before = backfilledStream(dataDir);
    expect(before).toContain('"producedBy"');

    // Hand-move: the ydoc goes, the sidecar stays.
    rooms.archiveReview(bound.setId, { archivedBy: 'Tester' });
    const archivedSidecar = join(dataDir, '_archive', `${mdDocId}.private.json`);
    if (existsSync(archivedSidecar)) {
      writeFileSync(join(dataDir, `${mdDocId}.private.json`), readFileSync(archivedSidecar));
      rmSync(archivedSidecar);
    }

    const after = backfilledStream(dataDir);
    expect(after).toBe(before);
  });
});
