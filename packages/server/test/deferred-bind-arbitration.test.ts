import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rooms } from '../src/doc-store.ts';
import { SseHub } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { waitFor } from './wait-for.ts';

/**
 * What a doc edited WHILE its deferred bind was in flight is worth.
 *
 * A hydrate that cannot read its file inline hands the read to the pool and
 * lets the doc come back unbound, so the doc is readable — and writable —
 * for as long as the read takes. `attachFile` then meets a doc that differs
 * from disk with no write-back bookkeeping to explain the difference, and
 * with nothing else to go on it arbitrates by mtime. A `.md` and a `.ydoc`
 * written in the same millisecond hand that round to disk, which reverts the
 * edit made in the gap and drops any suggestion it touched as an "external
 * edit". The blocking hydrate never met this, because it left no gap.
 *
 * Both tests pin the mtimes EQUAL rather than racing them: the tie is the
 * losing case, so making it certain is what keeps these from passing by luck.
 */

const MD = '# Title\n\nAlpha beta gamma.\n\nSecond paragraph here.\n';
const author = { id: 'agent-7', name: 'Redline Bot', color: '#3aa675' };

function makeRooms(dataDir: string): Rooms {
  return new Rooms({
    dataDir,
    sse: new SseHub(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
    decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
  });
}

/** Give the `.md` and the `.ydoc` the same mtime, to the millisecond. */
function tieMtimes(mdPath: string, ydocPath: string): void {
  const t = statSync(ydocPath).mtimeMs / 1000;
  utimesSync(mdPath, t, t);
  utimesSync(ydocPath, t, t);
}

describe('a doc edited while its deferred bind is in flight', () => {
  let dataDir: string;
  let mdPath: string;
  let ydocPath: string;
  let first: Rooms;
  let second: Rooms | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-deferred-bind-'));
    mdPath = join(dataDir, 'notes.md');
    ydocPath = join(dataDir, 'db1.ydoc');
    writeFileSync(mdPath, MD);
    first = makeRooms(dataDir);
    first.getOrCreate('db1', { type: 'markdown', sourceUrl: mdPath });
    expect(first.attachFile('db1', mdPath).ok).toBe(true);
  });

  afterEach(() => {
    second?.stop();
    first.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('keeps the edit and its suggestion when the bind lands after the accept', async () => {
    const created = first.createSuggestion('db1', { find: 'beta', replace: 'delta', author });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    first.flush();
    first.stop();
    tieMtimes(mdPath, ydocPath);

    second = makeRooms(dataDir);
    // The read is handed to the pool here, so the doc comes back UNBOUND —
    // this assertion is the seam the test turns on. Everything below happens
    // in the gap, deterministically, because a pool read cannot land in the
    // same synchronous run.
    const list = second.listSuggestions('db1');
    expect(list).toHaveLength(1);
    expect(second.boundPathOf('db1')).toBeUndefined();

    expect(second.acceptSuggestion('db1', created.suggestionId)).toEqual({ ok: true });

    // Now let the bind land. Before the fix it applied the file's "beta" over
    // the accepted "delta" and reported the suggestion as dropped.
    await waitFor(() => second?.boundPathOf('db1') === mdPath, {
      describe: 'the deferred bind to land',
    });
    expect(second.getSyncError('db1')).toBeUndefined();
    expect(second.listSuggestions('db1')).toHaveLength(0);
    const disk = await waitFor(
      () => {
        const text = readFileSync(mdPath, 'utf8');
        return text.includes('delta') ? text : false;
      },
      { describe: 'the accepted text to reach disk' },
    );
    expect(disk).toBe('# Title\n\nAlpha delta gamma.\n\nSecond paragraph here.\n');
  });

  it('still lets disk win when the gap held no edit of ours', async () => {
    // The positive control for the branch above: an edit made while the
    // server was DOWN must still be picked up. Nothing authors in the gap, so
    // the deferred bind must not claim the live doc is the newer side.
    first.flush();
    first.stop();
    writeFileSync(mdPath, '# Title\n\nAlpha beta gamma.\n\nEdited while down.\n');
    tieMtimes(mdPath, ydocPath);

    second = makeRooms(dataDir);
    // Reaching for the doc is what hydrates it and starts the pool read.
    expect(second.listSuggestions('db1')).toHaveLength(0);
    expect(second.boundPathOf('db1')).toBeUndefined();
    await waitFor(() => second?.boundPathOf('db1') === mdPath, {
      describe: 'the deferred bind to land',
    });
    const body = await waitFor(
      () => {
        const text = second?.readMarkdownBody('db1');
        return text?.includes('Edited while down.') ? text : false;
      },
      { describe: 'the offline edit to reach the live doc' },
    );
    expect(body).toContain('Edited while down.');
  });

  it('a deferred bind that lands after stop() binds nothing', async () => {
    first.flush();
    first.stop();

    second = makeRooms(dataDir);
    expect(second.listSuggestions('db1')).toHaveLength(0);
    expect(second.boundPathOf('db1')).toBeUndefined();
    // The read is in flight. Stopping here is what a shutdown — or a test's
    // teardown — does, and the landing must not re-hydrate the doc or
    // schedule a persist into a data dir that is about to be removed.
    second.stop();

    await new Promise((r) => setTimeout(r, 300));
    expect(second.boundPathOf('db1')).toBeUndefined();
  });
});
