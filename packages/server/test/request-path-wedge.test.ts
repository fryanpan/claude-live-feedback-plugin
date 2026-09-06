/**
 * Every way a REQUEST can name a doc, against a file that never answers.
 *
 * `hydrate-wedge.test.ts` proves the shape on two routes. This file is the
 * enumeration: each address the server accepts for a doc gets its own pass,
 * and after each one an unrelated route has to still answer. The point is not
 * that any single route is safe — it is that no route is special, because the
 * guarantee lives below all of them. A hydrate that has no bytes in hand
 * defers to the thread pool and parks the doc (`DocStore.prereadFor`), so the
 * main thread is never the thing waiting on the file.
 *
 * ON "THE HEALTH ROUTE". There is no `/health` endpoint on this server, and
 * the supervisor's own check is a TCP connect (`probePortListening` in
 * `scripts/serve.ts`) which a wedged-but-listening process would still pass —
 * the kernel completes the handshake whether or not the event loop is alive.
 * So the liveness question has to be asked with a real HTTP request, and
 * `GET /api/metrics` is the one that asks it most cleanly: it sits above the
 * doc routes in the chain, hydrates nothing, and cannot answer unless the
 * event loop is free.
 *
 * A FIFO with no writer is the failing file: `stat` answers, `open` blocks
 * until somebody opens the other end, and nobody here ever does.
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

const DOC_ID = 'wedged-across-every-address';
const LEAD = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };

/** How long an unrelated route may take while a doc read is parked. */
const ANSWER_WITHIN_MS = 100;

/** The board this file's docs, tasks and reviews are filed under. */
let WS = '';

describe('a doc whose file never answers, reached by every request address', () => {
  let dataDir: string;
  let scratch: string;
  let boundPath: string;
  let workspaceId: string;
  let handle: ServerHandle | undefined;

  beforeEach(async () => {
    boundFiles.reset();
    dataDir = mkdtempSync(join(tmpdir(), 'request-wedge-data-'));
    scratch = mkdtempSync(join(tmpdir(), 'request-wedge-files-'));
    boundPath = join(scratch, 'notes.md');
    writeFileSync(boundPath, '# Notes\n\nA readable first version.\n');

    const first = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    const base = `http://localhost:${first.port}`;
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const ws = await post('/workspaces', { name: 'search-revamp', leadAgentId: LEAD.id });
    workspaceId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    WS = workspaceId;
    expect(
      (
        await post(`/workspaces/${WS}/docs`, {
          docId: DOC_ID,
          type: 'markdown',
          sourceUrl: boundPath,
        })
      ).status,
    ).toBe(200);
    expect((await post(`/workspaces/${workspaceId}/docs:attach`, { docId: DOC_ID })).status).toBe(
      200,
    );
    // Board writes are debounced; the rounds below boot a fresh server on this
    // same data dir and read the board back off disk.
    first.tasks.flush();
    await first.stop();

    unlinkSync(boundPath);
    makeFifo(boundPath);
  });

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    await releaseFifosIn(scratch);
    boundFiles.reset();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  it('answers an unrelated route throughout, whichever address named the doc', async () => {
    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    const base = `http://localhost:${handle.port}`;

    // Every address the server accepts for this doc. The last one names it in
    // the BODY rather than the URL, which is the case the per-request prewarm
    // structurally cannot cover (see `docIdsAddressedBy`) and which is held
    // instead by `attachFileAsync` doing its own pooled read.
    const addresses: Array<{ what: string; fire: () => Promise<Response> }> = [
      {
        what: 'SSE subscribe',
        fire: () => fetch(`${base}/workspaces/${WS}/docs/${DOC_ID}/events:stream`),
      },
      { what: 'doc GET', fire: () => fetch(`${base}/workspaces/${WS}/docs/${DOC_ID}?format=json`) },
      { what: 'doc status', fire: () => fetch(`${base}/workspaces/${WS}/docs/${DOC_ID}/status`) },
      {
        what: 'the doc PAGE — the same address without ?format=json',
        fire: () => fetch(`${base}/workspaces/${workspaceId}/docs/${DOC_ID}`),
      },
      {
        what: 'docId in the request body',
        fire: () =>
          fetch(`${base}/workspaces/${WS}/docs`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ docId: DOC_ID, type: 'markdown', sourceUrl: boundPath }),
          }),
      },
    ];

    for (const { what, fire } of addresses) {
      const inFlight = fire();
      // A race, not an elapsed-time assertion: what matters is that the
      // unrelated route beats the window, not the exact millisecond count.
      const unrelated = fetch(`${base}/api/metrics`).then((r) => `answered:${r.status}`);
      const tooSlow = new Promise<string>((resolve) =>
        setTimeout(() => resolve('wedged'), ANSWER_WITHIN_MS),
      );
      expect(`${what}: ${await Promise.race([unrelated, tooSlow])}`).toBe(`${what}: answered:200`);

      const res = await inFlight;
      expect(res.status).toBeLessThan(500);
      await res.body?.cancel();
    }

    // The doc took no binding, so nothing will write over the file we could
    // not read — and the file is still the pipe we made it.
    expect(handle.docStore.boundPathOf(DOC_ID)).toBeUndefined();
    expect(statSync(boundPath).isFIFO()).toBe(true);
    // Quarantined on the FIRST hang, which is what stops a reconnecting
    // client re-arming the stall once a second.
    expect(boundFiles.quarantined(boundPath)).toBe(true);
  });

  it('positive control: every one of those addresses works on a readable file', async () => {
    // Without this the test above would pass on a server that had stopped
    // serving docs entirely — every route would answer fast and bind nothing.
    unlinkSync(boundPath);
    writeFileSync(boundPath, '# Notes\n\nA readable first version.\n');

    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    const base = `http://localhost:${handle.port}`;

    const res = await fetch(`${base}/workspaces/${WS}/docs/${DOC_ID}?format=json`);
    expect(res.status).toBe(200);
    for (let i = 0; i < 50 && handle.docStore.boundPathOf(DOC_ID) === undefined; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(handle.docStore.boundPathOf(DOC_ID)).toBe(boundPath);
    expect(boundFiles.quarantined(boundPath)).toBe(false);
  });
});
