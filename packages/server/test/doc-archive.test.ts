/**
 * Archiving ONE free-standing doc — the half `archive_review` cannot reach.
 *
 * `archiveReview` retires a whole review, and every refusal and guarantee it
 * has is written against a MEMBER LIST. The docs it cannot express are the
 * ones with no review at all: a markdown doc bound by `create_review_doc`, a
 * mockup bound by `bind_mock`. There are a few hundred of those on the
 * production box and, before this verb, the only thing that could remove one
 * was `delete_doc` — a purge, which is the thing the project rule forbids.
 *
 * These tests pin the same property the review suite pins, because it is the
 * whole reason this is not a delete: the activity stream over an archived doc
 * is BYTE-IDENTICAL to the stream before it was archived.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBackfill } from '../src/activity-backfill.ts';
import {
  listArchivedDocs,
  listArchivedReviews,
  readDocArchiveManifest,
} from '../src/review-archive.ts';
import { Rooms } from '../src/rooms.ts';
import { SseHub } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

const REVIEWER = { id: 'u1', name: 'Reviewer', kind: 'known' as const, color: '#2e7dd7' };

/** Let the 200ms debounced persist land — assertions about what is ON DISK
 *  are meaningless before it. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 260));

function makeRooms(dataDir: string): Rooms {
  return new Rooms({
    dataDir,
    sse: new SseHub(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
    decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
  });
}

/** Wipe activity.jsonl, rebuild it from the .ydoc files, return the bytes. */
function backfilledStream(dataDir: string): string {
  rmSync(join(dataDir, 'activity.jsonl'), { force: true });
  runBackfill({ dataDir, write: true });
  const p = join(dataDir, 'activity.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

describe('Rooms.archiveDoc / unarchiveDoc', () => {
  let dataDir: string;
  let folder: string;
  let mdPath: string;
  let rooms: Rooms;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'da-data-'));
    folder = mkdtempSync(join(tmpdir(), 'da-src-'));
    mdPath = join(folder, 'notes.md');
    writeFileSync(mdPath, '# Notes\n\nthe unique md line\n');
    rooms = makeRooms(dataDir);
    // What `create_review_doc` produces: one bound markdown doc, no review.
    rooms.getOrCreate('solo', { type: 'markdown', sourceUrl: mdPath, title: 'Notes' });
    expect(rooms.attachFile('solo', mdPath).ok).toBe(true);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  it('returns not-found for an id no doc is bound under', () => {
    const res = rooms.archiveDoc('nope', { archivedBy: 'Tester' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('not-found');
  });

  it('parks the doc under _archive and takes it out of the live list', async () => {
    await rooms.createThreadByFind(
      'solo',
      { find: 'the unique md line' },
      REVIEWER,
      'still unresolved',
    );
    await settle();

    const res = rooms.archiveDoc('solo', { archivedBy: 'Tester', reason: 'draft published' });
    expect(res.ok).toBe(true);
    expect(rooms.list().length).toBe(0);
    expect(rooms.get('solo')).toBeUndefined();
    expect(existsSync(join(dataDir, 'solo.ydoc'))).toBe(false);
    expect(existsSync(join(dataDir, '_archive', 'solo.ydoc'))).toBe(true);
    // The bound SOURCE file is the user's own and is never touched.
    expect(readFileSync(mdPath, 'utf8')).toContain('the unique md line');
  });

  it('moves the private-meta sidecar alongside the ydoc', async () => {
    await settle();
    expect(existsSync(join(dataDir, 'solo.private.json'))).toBe(true);
    expect(rooms.archiveDoc('solo', { archivedBy: 'Tester' }).ok).toBe(true);
    expect(existsSync(join(dataDir, 'solo.private.json'))).toBe(false);
    expect(existsSync(join(dataDir, '_archive', 'solo.private.json'))).toBe(true);
  });

  it('flushes edits made right up to the archive, rather than losing 200ms of them', async () => {
    await rooms.createThreadByFind(
      'solo',
      { find: 'the unique md line' },
      REVIEWER,
      'typed a heartbeat before retiring it',
    );
    // No settle: the debounced write has NOT fired, so only a flush inside
    // archiveDoc can get this comment onto disk.
    expect(rooms.archiveDoc('solo', { archivedBy: 'Tester' }).ok).toBe(true);
    expect(rooms.unarchiveDoc('solo', { archivedBy: 'Tester' }).ok).toBe(true);
    const threads = rooms.listThreads('solo', { status: 'open' });
    expect(threads[0]?.comments[0]?.text).toBe('typed a heartbeat before retiring it');
  });

  it('records who archived it and why, and lists it as archived', () => {
    rooms.archiveDoc('solo', { archivedBy: 'Tester', reason: 'draft published' });

    const manifest = readDocArchiveManifest(dataDir, 'solo');
    expect(manifest).toBeTruthy();
    expect(manifest?.docId).toBe('solo');
    expect(manifest?.archivedBy).toBe('Tester');
    expect(manifest?.reason).toBe('draft published');
    expect(manifest?.title).toBe('Notes');
    expect(Date.parse(manifest?.archivedAt ?? '')).toBeGreaterThan(0);
    expect(existsSync(join(dataDir, '_archive', 'solo.doc.json'))).toBe(true);

    expect(listArchivedDocs(dataDir).map((d) => d.docId)).toEqual(['solo']);
    // A doc manifest is NOT a review, and the review listing must not invent
    // one from it — the two suffixes are what keep the kinds apart.
    expect(listArchivedReviews(dataDir)).toEqual([]);
  });

  it('remembers the boards it was on so unarchive can put it back', () => {
    rooms.archiveDoc('solo', { archivedBy: 'Tester', linkedWorkspaces: ['w-abc'] });
    expect(readDocArchiveManifest(dataDir, 'solo')?.linkedWorkspaces).toEqual(['w-abc']);
    const back = rooms.unarchiveDoc('solo', { archivedBy: 'Tester' });
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.manifest.linkedWorkspaces).toEqual(['w-abc']);
  });

  it('appends an archive event to the activity log', () => {
    rooms.archiveDoc('solo', { archivedBy: 'Tester', reason: 'draft published' });
    const rows = readFileSync(join(dataDir, 'activity.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(
        (l) =>
          JSON.parse(l) as {
            type: string;
            actorName?: string;
            doc: { docId: string };
            payload: Record<string, unknown>;
          },
      )
      .filter((e) => e.type === 'archive');
    expect(rows.length).toBe(1);
    expect(rows[0]?.actorName).toBe('Tester');
    expect(rows[0]?.doc.docId).toBe('solo');
    expect(rows[0]?.payload.reason).toBe('draft published');
    // A doc row carries no reviewId — that is what tells the two apart in a
    // log that mixes them.
    expect(rows[0]?.payload.reviewId).toBeUndefined();
  });

  it('unarchive brings the doc back: room, threads, file binding and all', async () => {
    await rooms.createThreadByFind(
      'solo',
      { find: 'the unique md line' },
      REVIEWER,
      'still unresolved',
    );
    await settle();
    expect(rooms.archiveDoc('solo', { archivedBy: 'Tester' }).ok).toBe(true);

    const back = rooms.unarchiveDoc('solo', { archivedBy: 'Tester' });
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.docId).toBe('solo');
    expect(rooms.list().map((m) => m.docId)).toEqual(['solo']);
    const threads = rooms.listThreads('solo', { status: 'open' });
    expect(threads.length).toBe(1);
    expect(threads[0]?.comments[0]?.text).toBe('still unresolved');
    // Nothing left behind in _archive, manifest included.
    expect(existsSync(join(dataDir, 'solo.ydoc'))).toBe(true);
    expect(existsSync(join(dataDir, '_archive', 'solo.ydoc'))).toBe(false);
    expect(existsSync(join(dataDir, '_archive', 'solo.doc.json'))).toBe(false);
    expect(listArchivedDocs(dataDir)).toEqual([]);
    // The binding is re-armed, so an edit still reaches the file. A doc that
    // came back read-only would look fine and silently stop writing back.
    const edited = rooms.findAndReplace('solo', {
      find: 'the unique md line',
      replace: 'the edited md line',
    });
    expect(edited.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 1100));
    expect(readFileSync(mdPath, 'utf8')).toContain('the edited md line');
  });

  it('records an unarchive event naming who restored it', () => {
    rooms.archiveDoc('solo', { archivedBy: 'Tester' });
    rooms.unarchiveDoc('solo', { archivedBy: 'Restorer' });
    const rows = readFileSync(join(dataDir, 'activity.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string; actorName?: string; doc: { docId: string } })
      .filter((e) => e.type === 'unarchive');
    expect(rows.length).toBe(1);
    expect(rows[0]?.actorName).toBe('Restorer');
    expect(rows[0]?.doc.docId).toBe('solo');
  });

  it('unarchive of an id that was never archived is not-found', () => {
    const res = rooms.unarchiveDoc('nope', { archivedBy: 'Tester' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('not-found');
  });

  it('refuses a doc that belongs to a review — that is archive_review’s job', () => {
    rooms.getOrCreate('member', {
      type: 'markdown',
      sourceUrl: mdPath,
      setId: 'repo-abc1234-live',
      relPath: 'notes.md',
    });
    const res = rooms.archiveDoc('member', { archivedBy: 'Tester' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('review-member');
    if (res.error !== 'review-member') return;
    // Name the review, so the caller knows what to call instead.
    expect(res.setId).toBe('repo-abc1234-live');
    expect(rooms.get('member')).toBeDefined();
  });

  it('refuses a task body and a board room — live furniture, not a doc', async () => {
    for (const docId of ['task:t-abc', 'ws:w-abc']) {
      // Server authority, because a CALLER may not occupy these prefixes at
      // all now — the projection is the only thing that mints them, and this
      // test is about what `archiveDoc` does once one exists.
      rooms.getOrCreate(docId, { type: 'markdown' }, { authority: 'server' });
      const res = rooms.archiveDoc(docId, { archivedBy: 'Tester' });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe('hub-owned');
      expect(rooms.get(docId)).toBeDefined();
    }
    // Let these rooms' debounced first save land before the temp dir goes, so
    // the teardown race doesn't print an ENOENT that looks like a failure.
    await settle();
  });

  it('refuses rather than overwrites when the id is ALREADY in _archive', async () => {
    // An older snapshot of the same docId is already parked — the state a
    // handful of ids on the production box are in, from a hand-move that
    // predates any of these verbs. Whatever it holds, archiving must not
    // silently write over it.
    mkdirSync(join(dataDir, '_archive'), { recursive: true });
    writeFileSync(join(dataDir, '_archive', 'solo.ydoc'), 'older-snapshot');
    await settle();

    const res = rooms.archiveDoc('solo', { archivedBy: 'Tester' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('archive-collision');
    // Nothing moved, and the older snapshot is intact.
    expect(rooms.list().length).toBe(1);
    expect(existsSync(join(dataDir, 'solo.ydoc'))).toBe(true);
    expect(readFileSync(join(dataDir, '_archive', 'solo.ydoc'), 'utf8')).toBe('older-snapshot');
  });

  it('refuses to unarchive onto a live doc of the same id', () => {
    rooms.archiveDoc('solo', { archivedBy: 'Tester' });
    // Something re-minted the id while the doc was away.
    writeFileSync(join(dataDir, 'solo.ydoc'), 'live-again');

    const res = rooms.unarchiveDoc('solo', { archivedBy: 'Tester' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('restore-collision');
    // Nothing moved: the archived copy and the newer doc are both whole.
    expect(existsSync(join(dataDir, '_archive', 'solo.ydoc'))).toBe(true);
    expect(readFileSync(join(dataDir, 'solo.ydoc'), 'utf8')).toBe('live-again');
  });
});

describe('an archived doc keeps feeding activity-backfill', () => {
  let dataDir: string;
  let folder: string;
  let rooms: Rooms;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'dab-data-'));
    folder = mkdtempSync(join(tmpdir(), 'dab-src-'));
    writeFileSync(join(folder, 'notes.md'), '# Notes\n\nthe unique md line\n');
    rooms = makeRooms(dataDir);
    rooms.getOrCreate('solo', { type: 'markdown', sourceUrl: join(folder, 'notes.md') });
    rooms.attachFile('solo', join(folder, 'notes.md'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  it('the backfilled stream over an archived doc is BYTE-IDENTICAL', async () => {
    const created = await rooms.createThreadByFind(
      'solo',
      { find: 'the unique md line' },
      REVIEWER,
      'a comment that must survive archiving',
    );
    expect(created.ok).toBe(true);
    await settle();

    const before = backfilledStream(dataDir);
    // Positive control: the probe can see something real. Without it a
    // byte-comparison of two empty strings passes while proving nothing.
    expect(before.length).toBeGreaterThan(0);
    expect(before).toContain('a comment that must survive archiving');
    // ...and it carries the sidecar-sourced fields, which is exactly what a
    // move into _archive threatens: readPrivateMeta looks NEXT TO the .ydoc.
    expect(before).toContain('"sourceUrl"');

    expect(rooms.archiveDoc('solo', { archivedBy: 'Tester' }).ok).toBe(true);

    const after = backfilledStream(dataDir);
    expect(after).toBe(before);
  });

  it('the doc manifest is invisible to the backfill', () => {
    rooms.archiveDoc('solo', { archivedBy: 'Tester' });
    // `.doc.json` does not end in `.ydoc`, so the enumerator skips it rather
    // than trying to parse it as a document and logging a failure per run.
    expect(() => backfilledStream(dataDir)).not.toThrow();
    expect(backfilledStream(dataDir)).not.toContain('doc.json');
  });
});
