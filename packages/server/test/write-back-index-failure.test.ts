/**
 * What a write-back does when the DATA dir is unwritable.
 *
 * The pool write-back lands in an async callback, and the last thing that
 * callback does is clear the `pendingFileWrite` flag from the doc's index
 * row — a `writeFileSync` into the data dir. That write had no guard, so a
 * data dir that had gone away turned the callback into an unhandled
 * rejection.
 *
 * Under `bun test` an unhandled rejection arriving between tests is charged
 * to whichever test is running, so this took an unrelated, innocent test red:
 *
 *   (pass) flat write-back through bindDiff > working-tree members get …
 *   ENOENT … at writeDocIndex … at clearPendingFileWrite … at file-binding.ts
 *   (fail) flat write-back through bindDiff > write-back survives a server
 *          restart (hydrate re-arms it) [22.00ms]
 *
 * — CI run 34013067801, attempt 1. The named test never ran long enough to do
 * anything wrong; it was 22ms of somebody else's leaked timer.
 *
 * The `.ydoc` persist next to it has always caught and logged its own
 * failure. This is the one background write that did not.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocStore } from '../src/doc-store.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { afterPersist, waitForFile } from './wait-for.ts';

const DOC = `# Notes

First line.
`;

describe('a write-back whose data dir has gone', () => {
  let root: string;
  let dataDir: string;
  let path: string;
  let docStore: DocStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cw-idxfail-'));
    dataDir = mkdtempSync(join(tmpdir(), 'cw-idxfail-data-'));
    path = join(root, 'doc.md');
    writeFileSync(path, DOC);
    docStore = new DocStore({
      dataDir,
      sse: new SseBus(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
      decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
    });
    docStore.getOrCreate('d1', { type: 'markdown', sourceUrl: path });
    expect(docStore.attachFile('d1', path).ok).toBe(true);
  });

  afterEach(() => {
    docStore.stop();
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  /**
   * POSITIVE CONTROL. The case below only means anything if the write-back
   * reaches the file at all in this harness.
   */
  it('positive control: the write-back reaches the bound file', async () => {
    expect(docStore.findAndReplace('d1', { find: 'First line.', replace: 'Edited once.' }).ok).toBe(
      true,
    );
    await waitForFile(path, (t) => t.includes('Edited once.'));
  });

  it('still writes the file, and the binding keeps working afterwards', async () => {
    // The bound file's own directory stays; only the data dir goes. That is
    // the shape the failure had: the write to the DOCUMENT succeeds and the
    // bookkeeping write that follows it is the one that cannot land.
    expect(docStore.findAndReplace('d1', { find: 'First line.', replace: 'Edited once.' }).ok).toBe(
      true,
    );
    // Land INSIDE the gap between the two debounces. The `.ydoc` persist has
    // to run first — it is what stamps `pendingFileWrite` on the index row,
    // and `clearPendingFileWrite` returns early on a row without it, so a
    // data dir removed any earlier never reaches the write this test is about.
    await new Promise((r) => setTimeout(r, afterPersist()));
    expect(docStore.pendingFileWrites().some((p) => p.docId === 'd1')).toBe(true);
    rmSync(dataDir, { recursive: true, force: true });
    expect(existsSync(dataDir)).toBe(false);

    // The document still reaches disk — losing the index row must not lose
    // the edit.
    await waitForFile(path, (t) => t.includes('Edited once.'));

    // And the binding is not wedged: a second edit still flows. Before the
    // guard the callback threw before `writeInFlight` was cleared's siblings
    // ran, and the throw escaped as an unhandled rejection that bun charged
    // to whatever test was running next.
    expect(
      docStore.findAndReplace('d1', { find: 'Edited once.', replace: 'Edited twice.' }).ok,
    ).toBe(true);
    await waitForFile(path, (t) => t.includes('Edited twice.'));
    expect(readFileSync(path, 'utf8')).toContain('Edited twice.');
  });
});
