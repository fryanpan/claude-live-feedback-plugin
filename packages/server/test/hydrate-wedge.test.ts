/**
 * A bound file that never answers must not stop the server answering.
 *
 * The 2026-09-04 outage: a doc bound into a cloud-sync folder whose file
 * provider had stopped responding. The SSE subscribe route hydrated the doc,
 * hydration called `readFileSync`, and the main thread parked in `openat`. The
 * server answered nothing at all — not other docs, not the health route — the
 * supervisor restarted it, the subscriber reconnected, and it wedged again.
 * Twenty-one times.
 *
 * A FIFO with no writer reproduces that exactly and without any cloud storage:
 * `stat` answers, and `open` blocks until somebody opens the other end, which
 * in this file nobody ever does. Measured on the pre-fix code, `readFileSync`
 * on such a path never returns and no timer on the loop fires again.
 *
 * The doc, the paths and the content here are invented.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { boundFiles } from '../src/slow-fs.ts';
import { makeFifo, releaseFifosIn } from './fifo.ts';

const DOC_ID = 'stalled-source-doc';

describe('a bound file that never answers', () => {
  let dataDir: string;
  let scratch: string;
  let boundPath: string;
  let handle: ServerHandle | undefined;

  beforeEach(async () => {
    boundFiles.reset();
    dataDir = mkdtempSync(join(tmpdir(), 'hydrate-wedge-data-'));
    scratch = mkdtempSync(join(tmpdir(), 'hydrate-wedge-files-'));
    boundPath = join(scratch, 'notes.md');
    writeFileSync(boundPath, '# Notes\n\nA readable first version.\n');

    // Round one: an ordinary readable file, bound and persisted. This is the
    // state the machine is in before the sync folder goes bad.
    const first = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    const created = await fetch(`http://localhost:${first.port}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: DOC_ID, type: 'markdown', sourceUrl: boundPath }),
    });
    expect(created.status).toBe(200);
    await first.stop();

    // The folder goes bad. `open` on this path now blocks forever; everything
    // else about it — it exists, it stats, it is the doc's recorded source —
    // is unchanged, which is what made the real failure so hard to see.
    unlinkSync(boundPath);
    makeFifo(boundPath);
  });

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    // Before the directory goes: a read parked on a pipe that has been
    // unlinked can never be released, and it owns a pool thread until it is.
    // `releaseFifosIn` throws rather than letting the runner hang on one.
    await releaseFifosIn(scratch);
    boundFiles.reset();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  it('parks its own doc and leaves every other route answering', async () => {
    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    const base = `http://localhost:${handle.port}`;

    // The request that wedged production: an SSE subscribe on a doc that is
    // not resident, so answering it means hydrating from disk.
    const subscribe = fetch(`${base}/events/${DOC_ID}`);

    // While that is in flight, an UNRELATED route — the doc listing, which
    // reads the index and hydrates nothing — has to answer. A race, not
    // an elapsed-time assertion: what matters is that the response beats the
    // window, not how many milliseconds it took.
    const unrelated = fetch(`${base}/api/docs`).then((r) => `answered:${r.status}`);
    const tooSlow = new Promise<string>((resolve) => setTimeout(() => resolve('wedged'), 1_000));
    expect(await Promise.race([unrelated, tooSlow])).toBe('answered:200');

    // And the stalled doc itself resolves rather than hanging forever.
    const res = await subscribe;
    expect(res.status).toBeLessThan(500);
    await res.body?.cancel();

    // "Source unavailable, writes parked": the doc came back from its `.ydoc`
    // with no binding, so nothing will be written over the file we could not
    // read. The path is quarantined, which is what stops the next reconnect
    // starting the same doomed read.
    expect(handle.docStore.boundPathOf(DOC_ID)).toBeUndefined();
    expect(boundFiles.quarantined(boundPath)).toBe(true);
    // And the file itself is untouched. This is the half that matters most:
    // a doc that binds without having read its file will overwrite that file
    // on its next write-back, so "no binding" and "the bytes on disk survive"
    // are the same guarantee seen from two sides.
    expect(statSync(boundPath).isFIFO()).toBe(true);
    // The read is parked, not abandoned: `afterEach` hands it end-of-file and
    // gets the pool thread back, and fails loudly by name if it cannot. The
    // count itself is process-wide (one runner process, every test file), so
    // it is not something this test can assert an exact number for.
  });

  it('parks the doc on an /api route too, not just the five prewarmed prefixes', async () => {
    // The prewarm used to be a list of five path prefixes — `/events/`,
    // `/y/`, `/review/`, `/audio/`, `/mockup/`. Every other way of naming a
    // doc went the unprewarmed way and hydrated on the main thread, which is
    // most of the surface: this route, and the canonical
    // `/workspaces/<ws>/docs/<docId>` address with it. `GET /api/docs/<id>`
    // reaches the same `docStore.get` the SSE route does, so on a build that
    // only prewarms by prefix this request parks the whole server and the
    // unrelated one below never answers.
    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    const base = `http://localhost:${handle.port}`;

    const viaApi = fetch(`${base}/api/docs/${DOC_ID}`);
    const unrelated = fetch(`${base}/api/docs`).then((r) => `answered:${r.status}`);
    const tooSlow = new Promise<string>((resolve) => setTimeout(() => resolve('wedged'), 1_000));
    expect(await Promise.race([unrelated, tooSlow])).toBe('answered:200');

    const res = await viaApi;
    expect(res.status).toBeLessThan(500);
    await res.body?.cancel();

    expect(handle.docStore.boundPathOf(DOC_ID)).toBeUndefined();
    expect(boundFiles.quarantined(boundPath)).toBe(true);
  });

  it('positive control: the same doc on a readable file binds as before', async () => {
    // Same fixture, same route, with the FIFO swapped back for a real file.
    // Without this the test above would pass on a server that had simply
    // stopped binding anything.
    unlinkSync(boundPath);
    writeFileSync(boundPath, '# Notes\n\nA readable first version.\n');

    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    const base = `http://localhost:${handle.port}`;
    const res = await fetch(`${base}/events/${DOC_ID}`);
    expect(res.status).toBeLessThan(500);
    await res.body?.cancel();

    expect(handle.docStore.boundPathOf(DOC_ID)).toBe(boundPath);
    expect(boundFiles.quarantined(boundPath)).toBe(false);
  });
});
