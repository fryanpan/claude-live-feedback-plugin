/**
 * The stall scan walks every doc on a board. One that will not answer must
 * not stop it.
 *
 * `hydrate-wedge.test.ts` covers the REQUEST paths — an SSE subscribe, a doc
 * GET. This file covers the other half of the 2026-09-04 shape, and the half
 * with no client on the end of it: a TIMER. `nudgeStalls` runs on a 60s
 * interval, and `heldThreadReviewItems` inside it calls `docStore.listThreads`
 * once per task body, once per goal body and once per attached doc — none of
 * which reaches a URL, so nothing prewarms them. On the pre-fix code the first
 * cold doc bound into a sick folder parked the whole process from a timer
 * callback, with no request to blame it on.
 *
 * A FIFO with no writer is the reproduction: `stat` answers, `open` blocks
 * until somebody opens the other end, and in this file nobody ever does.
 *
 * NOTE ON FAILURE MODE: a regression here does not fail this test, it HANGS
 * it — `nudgeStalls` is synchronous, so a blocking read inside it parks the
 * runner and the assertions below are never reached. The runner's own timeout
 * is what turns that into a red test. That is inherent to asserting on a
 * synchronous call; there is no way to race a timer against code that owns
 * the only thread. Verified by mutation: restoring the synchronous fallback
 * in `DocStore.prereadFor` hangs this file rather than failing it.
 *
 * The criterion behind this file asks for a scan "under 100ms". It is
 * asserted here as a COUNT — a pool read outstanding when the scan returns —
 * because testing-standards §3 bans elapsed-time assertions, and because the
 * count is the stronger claim: a scan that skipped the doc would also be
 * fast.
 *
 * The board, the doc and the paths here are invented.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { boundFiles } from '../src/slow-fs.ts';
import { makeFifo, releaseFifosIn } from './fifo.ts';

const DOC_ID = 'board-doc-that-stopped-answering';
const LEAD = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };

describe('the stall scan over a board holding an unreadable doc', () => {
  let dataDir: string;
  let scratch: string;
  let boundPath: string;
  let workspaceId: string;
  let handle: ServerHandle | undefined;

  /** Round one: an ordinary board with an ordinary readable doc on it. */
  beforeEach(async () => {
    boundFiles.reset();
    dataDir = mkdtempSync(join(tmpdir(), 'stall-scan-data-'));
    scratch = mkdtempSync(join(tmpdir(), 'stall-scan-files-'));
    boundPath = join(scratch, 'design.md');
    writeFileSync(boundPath, '# Design\n\nA readable first version.\n');

    const first = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    const base = `http://localhost:${first.port}`;
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    const created = await post('/workspaces', { name: 'search-revamp', leadAgentId: LEAD.id });
    expect(created.status).toBe(200);
    workspaceId = ((await created.json()) as { workspace: { id: string } }).workspace.id;

    expect(
      (await post('/api/docs', { docId: DOC_ID, type: 'markdown', sourceUrl: boundPath })).status,
    ).toBe(200);
    // Onto the board itself: `heldThreadReviewItems` walks `workspace.docIds`,
    // which is the loop this test is about. A doc merely LINKED to a row is
    // reached by a different walk.
    expect((await post(`/workspaces/${workspaceId}/docs`, { docId: DOC_ID })).status).toBe(200);
    await first.stop();

    // The folder goes bad. Everything else about the path is unchanged — it
    // exists, it stats, it is still the doc's recorded source.
    unlinkSync(boundPath);
    makeFifo(boundPath);
  });

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    // A read parked on an unlinked pipe can never be released and owns a pool
    // thread until it is; this throws rather than letting the runner hang.
    await releaseFifosIn(scratch);
    boundFiles.reset();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  it('finishes a pass in well under 100ms and parks the doc it could not read', async () => {
    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    // The doc is COLD: neither boot pass opens it (nothing had an un-flushed
    // write, and its `.ydoc` already has an index row), so the scan below is
    // the first thing to ask for it.
    expect(handle.docStore.boundPathOf(DOC_ID)).toBeUndefined();

    handle.nudgeStalls();

    // The scan RETURNED, and it returned with a read still outstanding on the
    // thread pool. That pair is the whole property: it went through the async
    // door rather than opening the file itself. Asserting it as a count
    // rather than as an elapsed time is required by testing-standards §3 (a
    // wall-clock assertion fails on a loaded runner and passes on a broken
    // fast path), and it is also the stronger claim — "fast" would still be
    // true of a scan that skipped the doc entirely.
    expect(boundFiles.stats().inflight).toBeGreaterThan(0);

    // Not a vacuous pass. Without this the test would also go green on a scan
    // that never looked at the doc at all — which is the other way to be fast.
    // A park reason means the scan reached this doc, decided against opening
    // it on the main thread, and said so.
    const status = handle.docStore.getDocStatus(DOC_ID);
    expect(status?.bound).toBe(false);
    expect(status?.sourceParked?.reason).toContain('.ydoc');

    // And the file is untouched: a doc that binds without having read its file
    // overwrites that file on the next write-back.
    expect(statSync(boundPath).isFIFO()).toBe(true);
  });

  it('positive control: the same scan binds the doc when the file answers', async () => {
    // Same board, same pass, with the FIFO swapped back for a real file.
    // Without this the test above would pass on a server that had simply
    // stopped hydrating board docs at all.
    unlinkSync(boundPath);
    writeFileSync(boundPath, '# Design\n\nA readable first version.\n');

    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    handle.nudgeStalls();

    // The bind is deferred onto the pool even on the happy path, so give the
    // read a turn to land before asking.
    for (let i = 0; i < 50 && handle.docStore.boundPathOf(DOC_ID) === undefined; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(handle.docStore.boundPathOf(DOC_ID)).toBe(boundPath);
    expect(handle.docStore.getDocStatus(DOC_ID)?.sourceParked).toBeUndefined();
  });
});
