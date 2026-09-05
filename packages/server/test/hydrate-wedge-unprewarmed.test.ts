/**
 * The doors into hydration that the per-request prewarm does not cover.
 *
 * `server.ts` prewarms every docId it can read out of the request URL, so the
 * routes addressed as `/events/<id>` or `/api/docs/<id>` reach a synchronous
 * hydrate with the bytes already in hand. `hydrate-wedge.test.ts` covers those.
 *
 * Three ways in are left, and each one reaches `attachFile` with no preread at
 * all — which on the pre-fix code meant `readFileSync` on the main thread:
 *
 *   - A docId that arrives in the request BODY rather than the URL.
 *     `POST /api/docs` re-binding an existing doc is the shape measured at
 *     328 s on production.
 *   - A route that FANS OUT over a board's docIds. `listThreads` is called
 *     for every doc on the board by the home queue (`home-pane.ts`), the
 *     workspace listing (`doc-store-workspaces.ts`) and the archive route; none
 *     of those ids is in the URL, so none of them is prewarmed.
 *   - A background TIMER. The stall scan walks the same docIds on its own
 *     clock with no request anywhere, so there is nothing to prewarm it.
 *
 * A FIFO with no writer reproduces the sick file provider exactly: `stat`
 * answers, `open` blocks until somebody opens the other end, and nobody here
 * ever does. The doc, the paths and the content are invented.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { boundFiles } from '../src/slow-fs.ts';
import { makeFifo, releaseFifosIn } from './fifo.ts';
import { waitFor } from './wait-for.ts';

const DOC_ID = 'unprewarmed-source-doc';

/**
 * The health probe's budget while a bound read is parked.
 *
 * The supervisor's own liveness check is a TCP BIND probe, not an HTTP route
 * (`scripts/serve.ts`, "bind-health watchdog"), so there is no `/api/health`
 * to call. What it is really asking is whether the event loop is still
 * running, and the way to ask that from a test is to make an UNRELATED route
 * answer — `GET /api/docs` reads the index and hydrates nothing, so the only
 * thing that can delay it is a blocked loop.
 */
const HEALTH_MS = 100;

describe('hydration doors the request prewarm does not cover', () => {
  let dataDir: string;
  let scratch: string;
  let boundPath: string;
  let handle: ServerHandle | undefined;

  beforeEach(async () => {
    boundFiles.reset();
    dataDir = mkdtempSync(join(tmpdir(), 'unprewarmed-data-'));
    scratch = mkdtempSync(join(tmpdir(), 'unprewarmed-files-'));
    boundPath = join(scratch, 'notes.md');
    writeFileSync(boundPath, '# Notes\n\nA readable first version.\n');

    // Round one: an ordinary readable file, bound and persisted, then the
    // server goes away. This is the state the machine is in before the sync
    // folder stops answering.
    const first = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    const created = await fetch(`http://localhost:${first.port}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: DOC_ID, type: 'markdown', sourceUrl: boundPath }),
    });
    expect(created.status).toBe(200);
    await first.stop();

    // The folder goes bad. `open` on this path now blocks forever; it still
    // exists and still stats, which is what made the real failure invisible.
    unlinkSync(boundPath);
    makeFifo(boundPath);
  });

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    // A read parked on a pipe that has been unlinked can never be released,
    // and it owns its pool thread until it is. This throws rather than
    // letting the runner hang on one.
    await releaseFifosIn(scratch);
    boundFiles.reset();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  /** An unrelated route answers within its budget; never rejects. */
  function healthAnswers(base: string): Promise<string> {
    const probe = fetch(`${base}/api/docs`).then((r) => `answered:${r.status}`);
    const tooSlow = new Promise<string>((resolve) =>
      setTimeout(() => resolve('wedged'), HEALTH_MS),
    );
    return Promise.race([probe, tooSlow]);
  }

  it('a docId in the request BODY parks its doc and leaves health answering', async () => {
    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    const base = `http://localhost:${handle.port}`;

    // Nothing in this URL names a doc, so `docIdsAddressedBy` finds nothing
    // and the prewarm does not run. The route still hydrates DOC_ID to
    // re-bind it — straight into the synchronous read.
    const rebind = fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: DOC_ID, type: 'markdown', sourceUrl: boundPath }),
    });

    expect(await healthAnswers(base)).toBe('answered:200');

    const res = await rebind;
    expect(res.status).toBeLessThan(500);
    // The file is not bound, so nothing will write over bytes we never read.
    expect(handle.rooms.boundPathOf(DOC_ID)).toBeUndefined();
  });

  it('a fan-out over board docIds parks its doc and leaves health answering', async () => {
    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    const base = `http://localhost:${handle.port}`;

    // `listThreads` is the exact call the home queue, the workspace listing
    // and the archive route make for EVERY docId on a board. None of those
    // ids reaches the URL, so none is prewarmed. Called directly here so the
    // assertion is about the door rather than about which route found it.
    const fanOut = (async () => handle?.rooms.listThreads(DOC_ID, { status: 'open' }))();

    expect(await healthAnswers(base)).toBe('answered:200');

    await fanOut;
    expect(handle.rooms.boundPathOf(DOC_ID)).toBeUndefined();
  });

  it('a background hydrate never blocks the loop, so timers keep firing', async () => {
    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });

    // The stall scan has no request behind it and nothing prewarms it. What
    // it must not do is stop the event loop: a timer armed before the scan
    // has to fire even though the scan touched a wedged file.
    let ticked = false;
    setTimeout(() => {
      ticked = true;
    }, 20);

    handle.rooms.listThreads(DOC_ID, { status: 'open' });
    handle.rooms.readMarkdownBody(DOC_ID);

    // The poll IS the assertion. A blocked loop runs neither the timer above
    // nor this loop, so `waitFor` returning at all is the proof — and it
    // fails by name instead of hanging the runner the way the pre-fix code
    // did.
    await waitFor(() => (ticked ? 'the timer fired' : false), {
      describe: 'a timer armed before a background hydrate to fire',
    });
    expect(ticked).toBe(true);
  });

  it('positive control: the same doors bind and read a healthy file', async () => {
    // Same fixture, same doors, with the FIFO swapped back for a real file.
    // Without this every test above would pass on a server that had simply
    // stopped binding anything at all.
    unlinkSync(boundPath);
    writeFileSync(boundPath, '# Notes\n\nA readable first version.\n');

    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    const base = `http://localhost:${handle.port}`;

    const rebind = await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: DOC_ID, type: 'markdown', sourceUrl: boundPath }),
    });
    expect(rebind.status).toBe(200);

    // The doc binds, and its body is the file's content — so the door did a
    // real read rather than merely declining to hang.
    expect(handle.rooms.boundPathOf(DOC_ID)).toBe(boundPath);
    expect(handle.rooms.readMarkdownBody(DOC_ID) ?? '').toContain('A readable first version.');
    expect(boundFiles.quarantined(boundPath)).toBe(false);
  });
});
