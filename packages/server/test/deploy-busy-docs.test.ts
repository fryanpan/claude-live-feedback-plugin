/**
 * `DocStore.pendingFileWrites` — the signal a deploy uses to decide whether a
 * `git pull` would silently lose someone's un-flushed sentence.
 *
 * The whole value of this is timing, so the tests do not fake it: a real
 * binding, a real edit, and the real 800ms debounce. The assertions run
 * either side of that window in both directions, because "returns nothing"
 * is the answer a function that always returns nothing also gives.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocStore } from '../src/doc-store.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { waitFor } from './wait-for.ts';

describe('pendingFileWrites', () => {
  let dataDir: string;
  let path: string;
  let docStore: DocStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-busy-'));
    path = join(dataDir, 'Main.kt');
    writeFileSync(path, 'fun main() {}\n');
    docStore = new DocStore({
      dataDir,
      sse: new SseBus(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
      decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
    });
    docStore.getOrCreate('c1', { type: 'code', sourceUrl: path });
    expect(docStore.attachFlatFile('c1', path, { writeBack: true }).ok).toBe(true);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('is empty on an idle binding, names the doc mid-edit, and empties again', async () => {
    // Negative, positive, negative — in one test, on one binding, so the
    // empty answers are demonstrably not the only answer this can give.
    expect(docStore.pendingFileWrites()).toEqual([]);

    docStore.get('c1')?.ydoc.getText('content').insert(0, '// half a thought\n');
    const busy = docStore.pendingFileWrites();
    expect(busy).toHaveLength(1);
    expect(busy[0]?.docId).toBe('c1');
    expect(busy[0]?.path).toBe(path);

    await waitFor(() => docStore.pendingFileWrites().length === 0, {
      describe: 'the pending write-back to drain',
    });
  });

  it('reports only bindings under the root it was asked about', () => {
    docStore.get('c1')?.ydoc.getText('content').insert(0, 'x');
    // Positive control: with no root, and with the containing root, it is
    // there — so the absence below is about the root and nothing else.
    expect(docStore.pendingFileWrites()).toHaveLength(1);
    expect(docStore.pendingFileWrites(dataDir)).toHaveLength(1);

    const elsewhere = mkdtempSync(join(tmpdir(), 'cw-other-'));
    try {
      expect(docStore.pendingFileWrites(elsewhere)).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('does not mistake a sibling directory whose name shares a prefix', () => {
    // Both roots must EXIST, or the absence proves only that realpath failed.
    const parent = mkdtempSync(join(tmpdir(), 'cw-roots-'));
    try {
      const repo = join(parent, 'repo');
      const lookalike = join(parent, 'repo-evil');
      mkdirSync(repo);
      mkdirSync(lookalike);
      const bound = join(lookalike, 'Main.kt');
      writeFileSync(bound, 'fun main() {}\n');
      docStore.getOrCreate('c2', { type: 'code', sourceUrl: bound });
      expect(docStore.attachFlatFile('c2', bound, { writeBack: true }).ok).toBe(true);
      docStore.get('c2')?.ydoc.getText('content').insert(0, 'x');

      // Positive control on the root that really does contain it.
      expect(docStore.pendingFileWrites(lookalike).map((d) => d.docId)).toEqual(['c2']);
      // …and the prefix-sharing sibling sees nothing.
      expect(docStore.pendingFileWrites(repo)).toEqual([]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
