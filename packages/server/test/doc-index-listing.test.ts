/**
 * The listing served from `<docId>.index.json` must equal the listing served
 * from hydrated rooms, field for field.
 *
 * This is the load-bearing test of the index. Every other benefit — a board
 * that renders without loading 5,600 CRDTs, and later a server that does not
 * hold them all — is only safe if the two listings cannot disagree. If they
 * can, the board shows a doc that is not what it says it is, and nobody
 * suspects the listing: they suspect the doc.
 *
 * So the fixture is built for FIELD VARIETY, not just row count. Every
 * optional field on `DocMeta` that a listing can carry is populated on some
 * doc, including the ones that live in the private sidecar rather than the
 * CRDT, because those are exactly the ones a naive index would drop.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DocMeta, createThread, setStatus } from '@feedback/core';
import type * as Y from 'yjs';
import { Rooms } from '../src/rooms.ts';
import { SseHub } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

function makeRooms(dataDir: string): Rooms {
  return new Rooms({
    dataDir,
    sse: new SseHub(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
  });
}

const byId = (rows: DocMeta[]) => new Map(rows.map((r) => [r.docId, r] as const));

/** One thread in a known status, so the counts under test are deterministic. */
function addThread(ydoc: Y.Doc, threadId: string, status: 'open' | 'resolved'): void {
  createThread(ydoc, {
    threadId,
    anchor: {
      kind: 'element',
      fingerprint: {
        tag: 'P',
        stableAttrs: {},
        classes: [],
        text: `fp-${threadId}`,
        path: 'P[0]',
        dataAttrs: {},
      },
      snippet: { text: 'x' },
    },
    createdBy: { id: 'u1', name: 'Tester', kind: 'known', color: '#111' },
    firstComment: { id: `c-${threadId}`, text: 'a point' },
  });
  if (status === 'resolved') setStatus(ydoc, threadId, 'resolved');
}

describe('an index-backed listing equals the hydrated listing', () => {
  let dataDir: string;
  let srcDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'doc-index-'));
    srcDir = mkdtempSync(join(tmpdir(), 'doc-index-src-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  /**
   * Docs covering every shape a listing has to carry: plain, titled, aliased,
   * set members, workspace members with a relPath, bound markdown, diff rows
   * with their counts, mockups, and docs with open and resolved threads.
   */
  function seed(rooms: Rooms, count: number): string[] {
    const docIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const docId = `idx-${i}`;
      docIds.push(docId);
      const shape = i % 8;
      if (shape === 0) {
        rooms.getOrCreate(docId, { type: 'markdown' });
      } else if (shape === 1) {
        rooms.getOrCreate(docId, { type: 'markdown', title: `Titled ${i}` });
      } else if (shape === 2) {
        rooms.getOrCreate(docId, {
          type: 'markdown',
          alias: `readable-${i}`,
          setId: `set-${i % 3}`,
        });
      } else if (shape === 3) {
        rooms.getOrCreate(docId, {
          type: 'markdown',
          workspaceId: `ws-${i % 4}`,
          relPath: `packages/server/src/f${i}.ts`,
          workspaceRoot: srcDir,
        });
      } else if (shape === 4) {
        const path = join(srcDir, `${docId}.md`);
        writeFileSync(path, `# Doc ${i}\n\nbody\n`);
        rooms.getOrCreate(docId, { type: 'markdown', title: `Bound ${i}` });
        rooms.attachFile(docId, path);
      } else if (shape === 5) {
        rooms.getOrCreate(docId, {
          type: 'diff',
          relPath: `src/changed-${i}.ts`,
          diffStatus: 'modified',
          diffAdditions: i,
          diffDeletions: i % 7,
          diffTarget: 'HEAD',
        });
      } else if (shape === 6) {
        rooms.getOrCreate(docId, { type: 'mockup', title: `Mock ${i}` });
      } else {
        const room = rooms.getOrCreate(docId, { type: 'markdown', title: `Threaded ${i}` });
        addThread(room.ydoc, `${docId}-open`, 'open');
        addThread(room.ydoc, `${docId}-done`, 'resolved');
      }
    }
    rooms.flush();
    return docIds;
  }

  it('matches on a fixture covering every listing field', () => {
    const first = makeRooms(dataDir);
    const docIds = seed(first, 120);
    const hydrated = first.list();
    expect(hydrated.length).toBeGreaterThanOrEqual(docIds.length);

    // Control: the fixture actually exercises the optional fields. Without
    // this, two listings of nothing but `{docId, type, createdAt}` would
    // match perfectly and prove nothing.
    const present = new Set<string>();
    for (const row of hydrated) for (const k of Object.keys(row)) present.add(k);
    for (const field of [
      'title',
      'alias',
      'setId',
      'workspaceId',
      'relPath',
      'sourceUrl',
      'workspaceRoot',
      'diffStatus',
      'diffAdditions',
      'diffDeletions',
      'diffTarget',
      'lastActivityAt',
    ]) {
      expect(present.has(field)).toBe(true);
    }

    const fromIndex = first.listFromIndex();
    const a = byId(hydrated);
    const b = byId(fromIndex);
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
    for (const [docId, hydratedRow] of a) {
      expect(b.get(docId)).toEqual(hydratedRow);
    }
  });

  it('survives a restart: the index alone still describes every doc', () => {
    const first = makeRooms(dataDir);
    const docIds = seed(first, 40);
    const before = first.list();

    // Control: the rows must already be ON DISK before the restart. A fresh
    // Rooms also runs the write-missing migration, so without this the test
    // would pass on rows the second instance manufactured from the hydrated
    // docs — proving the migration works and the persist path not at all.
    const onDisk = readdirSync(dataDir).filter((f) => f.endsWith('.index.json'));
    expect(onDisk.length).toBe(docIds.length);

    // A fresh Rooms over the same data dir is what a restart does.
    const second = makeRooms(dataDir);
    const a = byId(before);
    const b = byId(second.listFromIndex());
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
    for (const [docId, row] of a) expect(b.get(docId)).toEqual(row);
  });

  it('lists a doc whose index row is all there is', () => {
    const first = makeRooms(dataDir);
    const docIds = seed(first, 40);
    const before = first.list();

    // Only the index rows — no .ydoc to hydrate. This is what `list()` has to
    // answer from once a doc stops being resident, and the one arrangement in
    // which hydration cannot quietly supply the answer.
    const indexOnly = mkdtempSync(join(tmpdir(), 'doc-index-only-'));
    try {
      for (const f of readdirSync(dataDir).filter((n) => n.endsWith('.index.json'))) {
        copyFileSync(join(dataDir, f), join(indexOnly, f));
      }
      expect(readdirSync(indexOnly).length).toBe(docIds.length);

      const rows = byId(makeRooms(indexOnly).list());
      expect([...rows.keys()].sort()).toEqual([...byId(before).keys()].sort());
      for (const [docId, hydratedRow] of byId(before)) {
        // lastActivityAt is the .ydoc's mtime, which by construction is not
        // here; it falls back to createdAt. Every other field must match.
        const { lastActivityAt: _drop, ...expected } = hydratedRow;
        const { lastActivityAt: _also, ...actual } = rows.get(docId) as DocMeta;
        expect(actual).toEqual(expected);
      }
    } finally {
      rmSync(indexOnly, { recursive: true, force: true });
    }
  });

  it('carries open and total thread counts without loading the doc', () => {
    const rooms = makeRooms(dataDir);
    const room = rooms.getOrCreate('counted', { type: 'markdown', title: 'Counted' });
    addThread(room.ydoc, 'still-open', 'open');
    addThread(room.ydoc, 'done', 'resolved');
    rooms.flush();

    const counts = rooms.threadCountsFromIndex('counted');
    expect(counts).toEqual({ open: 1, total: 2 });
  });

  it('drops the index when the doc is purged, so a listing cannot resurrect it', () => {
    const rooms = makeRooms(dataDir);
    rooms.getOrCreate('doomed', { type: 'markdown', title: 'Doomed' });
    rooms.flush();
    // Control: it is in the index to begin with.
    expect(rooms.listFromIndex().some((r) => r.docId === 'doomed')).toBe(true);

    rooms.deleteDoc('doomed', { force: true });
    expect(rooms.listFromIndex().some((r) => r.docId === 'doomed')).toBe(false);
    expect(
      makeRooms(dataDir)
        .listFromIndex()
        .some((r) => r.docId === 'doomed'),
    ).toBe(false);
  });
});
