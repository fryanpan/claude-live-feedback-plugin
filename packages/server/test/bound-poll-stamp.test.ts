/**
 * What the disk→doc poll calls "unchanged".
 *
 * The poll detects an external edit by stat'ing the bound file and comparing
 * against the stamp it recorded last time. For as long as that stamp was the
 * mtime ALONE, a write that landed in the same filesystem timestamp granule
 * as the stamp was invisible — and invisible FOREVER, because the mtime it
 * found is the mtime it left, so no later tick ever sees a change either. The
 * doc silently stops tracking its file, and nothing is logged.
 *
 * That is not a hypothetical granule. `statSync().mtimeMs` on this machine
 * moves in whole-millisecond steps (5,000 back-to-back writes produced 175
 * distinct mtimes), so two writes less than a millisecond apart already
 * collide; a kernel stamping inodes from a coarse timer tick gives a wider
 * window still. It is what made `git-ops-vs-bound.test.ts` time out on CI at
 * ~5.02s while passing locally, and it is why `flat-sync.test.ts` carries a
 * `writeExternal` helper that pushes the mtime forward by hand.
 *
 * The stamp is now (mtime, size). These tests pin both halves.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocStore } from '../src/doc-store.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { waitFor } from './wait-for.ts';

const DOC = `# Design note

Intro paragraph on main.

## Section

Keep this sentence intact.
`;

describe('the poll’s change detection', () => {
  let root: string;
  let dataDir: string;
  let path: string;
  let docStore: DocStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cw-stamp-'));
    dataDir = mkdtempSync(join(tmpdir(), 'cw-stamp-data-'));
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
    // Stop before the directories go: a live store keeps sweeping and keeps
    // firing write-backs into a data dir that is no longer there.
    docStore.stop();
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  const liveText = () => docStore.getDoc('d1')?.plainText ?? '';
  const untilLive = (needle: string) =>
    waitFor(() => liveText().includes(needle), {
      describe: `the live doc to hold ${needle}`,
      timeout: 3000,
    });

  /**
   * POSITIVE CONTROL. Everything below asserts that a write with a COLLIDING
   * mtime still lands; a harness where no write ever reached the doc would
   * report the same success on the negative-sounding half.
   */
  it('positive control: an ordinary write with a fresh mtime reaches the doc', async () => {
    writeFileSync(path, DOC.replace('Intro paragraph on main.', 'An ordinary save.'));
    await untilLive('An ordinary save.');
  });

  it('sees a write that left the mtime exactly where it found it', async () => {
    // What `armFileWatcher` recorded a moment ago, in beforeEach.
    const recorded = statSync(path);
    writeFileSync(path, DOC.replace('Intro paragraph on main.', 'Working-tree scratch.'));
    // Pin the mtime back — which is what a filesystem whose granularity is
    // coarser than the gap does on its own, for free.
    utimesSync(path, recorded.atime, recorded.mtime);

    // The premise the test rests on: the mtime really is unchanged, and the
    // size really did move. Assert it, or a platform that quietly refuses the
    // utimes would make this pass without ever building the case.
    expect(statSync(path).mtimeMs).toBe(recorded.mtimeMs);
    expect(statSync(path).size).not.toBe(recorded.size);

    await untilLive('Working-tree scratch.');
  });

  it('still suppresses the echo of its own write-back', async () => {
    // The stamp's other job. A doc→disk flush must not read back as an
    // external edit — that arm backs the user's own document up as though a
    // stranger had written it.
    expect(
      docStore.findAndReplace('d1', {
        find: 'Keep this sentence intact.',
        replace: 'Edited in the live doc.',
      }).ok,
    ).toBe(true);
    await waitFor(
      () => require('node:fs').readFileSync(path, 'utf8').includes('Edited in the live doc.'),
      { describe: 'the write-back to reach disk', timeout: 3000 },
    );
    // Give the poll several ticks to misread our own bytes.
    await new Promise((r) => setTimeout(r, 400));
    expect(docStore.getSyncError('d1')).toBeUndefined();
    expect(liveText()).toContain('Edited in the live doc.');
  });
});
