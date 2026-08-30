/**
 * Enumerating docs is not reaching for one.
 *
 * `rooms.get` marks a doc as accessed, which puts its file binding in the
 * poll's fast lane (a stat every 500ms) for `FILE_POLL_ACTIVE_MS`. That is
 * right for a reader opening a doc and wrong for a route that reads
 * `meta.title` for every docId on a board: one such scan drags the whole
 * corpus into the fast lane, and a client polling that route keeps it there.
 *
 * Measured on a copy of the production data directory: a single `GET /`
 * touched 144 docs and moved `activeBindings` from 0 to 122, and production
 * itself reported all 2,549 bound docs active five minutes after boot with
 * nobody connected. `rooms.peek` is the same lookup without the access.
 *
 * Synthetic fixtures, port 0. No production server is touched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rooms } from '../src/rooms.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SseHub } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

describe('a scan does not activate the docs it enumerates', () => {
  let dataDir: string;
  let srcDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'scan-data-'));
    srcDir = mkdtempSync(join(tmpdir(), 'scan-src-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  it('peek reads a doc without putting it in the fast lane; get still does', () => {
    const rooms = new Rooms({
      dataDir,
      sse: new SseHub(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
    });
    const docIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const docId = `scan-${i}`;
      const path = join(srcDir, `${docId}.md`);
      writeFileSync(path, `# Doc ${i}\n\nbody\n`);
      rooms.getOrCreate(docId, { type: 'markdown' });
      rooms.attachFile(docId, path);
      docIds.push(docId);
    }
    expect(rooms.stats().bindings).toBe(6);

    // Control FIRST: this fixture can be activated at all, and `get` is what
    // does it. Without this the assertion below would pass on a fixture whose
    // bindings could never go active for some unrelated reason.
    rooms.resetDerivedCaches();
    expect(rooms.stats().activeBindings).toBe(0);
    expect(rooms.get(docIds[0])).toBeDefined();
    expect(rooms.stats().activeBindings).toBe(1);

    rooms.resetDerivedCaches();
    expect(rooms.stats().activeBindings).toBe(0);
    // The scan: every doc's metadata read, nothing activated.
    for (const docId of docIds) expect(rooms.peek(docId)?.meta).toBeDefined();
    expect(rooms.stats().activeBindings).toBe(0);
  });

  it('peek resolves the same ids and aliases as get', () => {
    const rooms = new Rooms({
      dataDir,
      sse: new SseHub(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
    });
    // `get` now routes through `peek`, so alias resolution has exactly one
    // implementation — this pins that it is the RIGHT one. A peek that
    // missed an alias would 404 every readable URL ever handed out.
    rooms.getOrCreate('minted-id', { type: 'markdown', alias: 'readable-name' });
    // Positive control: the two strings differ, so the assertions below
    // cannot pass by the alias simply BEING the id.
    expect(rooms.peek('readable-name')?.docId).toBe('minted-id');
    expect(rooms.peek('readable-name')?.docId).toBe(rooms.get('readable-name')?.docId);
    expect(rooms.peek('minted-id')?.docId).toBe('minted-id');
    expect(rooms.peek('no-such-doc')).toBeUndefined();
  });

  describe('over HTTP', () => {
    let handle: ServerHandle;
    let base: string;

    beforeEach(() => {
      handle = createServer({ port: 0, dataDir });
      base = `http://localhost:${handle.port}`;
    });
    afterEach(async () => {
      await handle.stop();
    });

    const local = (path: string) =>
      fetch(`${base}${path}`, { headers: { host: `localhost:${handle.port}` } });

    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    it('a board-wide listing leaves every bound doc idle', async () => {
      const ws = (await (await post('/api/workspaces', { name: 'scan-board' })).json()) as {
        workspace: { id: string };
      };
      const docIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const docId = `scan-http-${i}`;
        const path = join(srcDir, `${docId}.md`);
        writeFileSync(path, `# Doc ${i}\n\nbody\n`);
        expect((await post('/api/docs', { docId, type: 'markdown', sourceUrl: path })).status).toBe(
          200,
        );
        // On the board, which is what makes it part of the listing the
        // review-items builder walks.
        expect((await post(`/api/workspaces/${ws.workspace.id}/docs`, { docId })).status).toBe(200);
        docIds.push(docId);
      }

      // Control: a doc CAN be activated through HTTP alone, and reading one
      // is what does it. Creating a doc deliberately does not — hydration
      // binds the whole corpus at boot and warming it there was the storm
      // this change exists to remove — so the control has to be a read.
      handle.rooms.resetDerivedCaches();
      expect((await local(`/api/docs/${docIds[0]}`)).status).toBe(200);
      const opened = (await (await local('/api/metrics')).json()) as { activeBindings: number };
      expect(opened.activeBindings).toBe(1);

      // Control: the scan below has something to enumerate. A board holding
      // no docs would make the assertion vacuous. (The board stores the ids
      // the server MINTED; `scan-http-N` is the readable alias each doc also
      // answers to, which is exactly why `peek` must resolve aliases too.)
      const holder = handle.tasks.getWorkspace(ws.workspace.id);
      expect(holder?.docIds.length).toBe(docIds.length);
      if (!holder) throw new Error('workspace missing');

      handle.rooms.resetDerivedCaches();
      const idle = (await (await local('/api/metrics')).json()) as { activeBindings: number };
      expect(idle.activeBindings).toBe(0);

      // The two routes that read every docId on a board: the landing page and
      // the review-items builder behind it.
      expect((await local('/')).status).toBe(200);
      expect(
        (await local(`/api/workspaces/${encodeURIComponent(holder.id)}/review-items`)).status,
      ).toBe(200);

      const after = (await (await local('/api/metrics')).json()) as { activeBindings: number };
      expect(after.activeBindings).toBe(0);
    });
  });
});
