/**
 * A parked doc says WHY, on a surface its owner has.
 *
 * When a bound file stops answering, the doc comes back from its `.ydoc` with
 * no binding. That is the right outcome — nothing overwrites bytes we could
 * not read — but until now it was invisible: `syncError` lives on the
 * BINDING, and the whole shape of a park is that no binding was made. So a
 * doc whose cloud-sync folder had stopped answering and a doc that was never
 * file-backed both reported `bound: false` with nothing to tell them apart,
 * and the only account of the park was a `console.warn` in a server log the
 * doc's owner does not read.
 *
 * `sourceParked` is that account, reported by `doc_status` and `get_doc`.
 *
 * The reason names the path it declined to open, so it follows the same rule
 * `syncError` and `sourceUrl` already do: host-machine paths are not
 * workspace content, and a share visitor does not get it.
 *
 * The board, the doc and the paths here are invented.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { boundFiles } from '../src/slow-fs.ts';
import { type AccessHarness, accessHarness, mintAccessShare } from './access-share.ts';
import { makeFifo, releaseFifosIn } from './fifo.ts';

const DOC_ID = 'parked-with-a-reason';
const LEAD = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };

describe('a doc parked because its file would not answer', () => {
  let dataDir: string;
  let scratch: string;
  let boundPath: string;
  let workspaceId: string;
  let access: AccessHarness;
  let handle: ServerHandle | undefined;

  beforeEach(async () => {
    boundFiles.reset();
    dataDir = mkdtempSync(join(tmpdir(), 'park-reason-data-'));
    scratch = mkdtempSync(join(tmpdir(), 'park-reason-files-'));
    boundPath = join(scratch, 'design.md');
    writeFileSync(boundPath, '# Design\n\nA readable first version.\n');
    access = await accessHarness();

    const first = createServer({ port: 0, dataDir, ...access.serverOptions });
    const base = `http://localhost:${first.port}`;
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const ws = await post('/workspaces', { name: 'search-revamp', leadAgentId: LEAD.id });
    workspaceId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    expect(
      (await post('/api/docs', { docId: DOC_ID, type: 'markdown', sourceUrl: boundPath })).status,
    ).toBe(200);
    expect((await post(`/workspaces/${workspaceId}/docs`, { docId: DOC_ID })).status).toBe(200);
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

  it('reports the reason to its owner on doc_status, and clears it when the file comes back', async () => {
    handle = createServer({ port: 0, dataDir, ...access.serverOptions });
    const base = `http://localhost:${handle.port}`;

    const res = await fetch(`${base}/api/docs/${DOC_ID}/status`);
    expect(res.status).toBe(200);
    const parked = (await res.json()) as {
      bound: boolean;
      sourceParked?: { reason: string; at: number };
    };
    // Unbound AND accounted for. `bound: false` alone is the state this
    // change exists to disambiguate, so asserting it without the reason
    // would assert nothing new.
    expect(parked.bound).toBe(false);
    expect(parked.sourceParked?.reason).toContain('.ydoc');
    expect(parked.sourceParked?.at).toBeGreaterThan(0);

    // Now the folder comes back. The reason must not outlive the park — a
    // stale one is worse than none, because it says a healthy doc is not
    // being written.
    //
    // A resident-but-unbound doc does not re-hydrate on its own: `resolveRoom`
    // finds it in memory and returns it, and the deferred bind that parked it
    // has already had its one retry. The recovery is an explicit re-bind,
    // which is what an owner does (`attach_markdown` on the same path), so
    // that is what this drives. `boundFiles.reset()` stands in for the
    // quarantine backoff expiring.
    unlinkSync(boundPath);
    writeFileSync(boundPath, '# Design\n\nBack from the dead.\n');
    boundFiles.reset();
    const rebind = await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: DOC_ID, type: 'markdown', sourceUrl: boundPath }),
    });
    expect(rebind.status).toBe(200);

    const healthy = (await (await fetch(`${base}/api/docs/${DOC_ID}/status`)).json()) as {
      bound: boolean;
      sourceParked?: unknown;
    };
    expect(healthy.bound).toBe(true);
    expect(healthy.sourceParked).toBeUndefined();
  });

  it('does not hand the reason to a share visitor — it names a host path', async () => {
    handle = createServer({ port: 0, dataDir, ...access.serverOptions });
    const base = `http://localhost:${handle.port}`;
    const share = await mintAccessShare(base, access, workspaceId);

    // The owner sees it...
    const owner = (await (await fetch(`${base}/api/docs/${DOC_ID}/status`)).json()) as {
      sourceParked?: { reason: string };
    };
    expect(owner.sourceParked?.reason).toBeDefined();

    // ...the visitor sees the doc, but not where it lives on this machine.
    const res = await fetch(`${base}/api/docs/${DOC_ID}/status`, { headers: share.headers });
    expect(res.status).toBe(200);
    const seen = (await res.json()) as Record<string, unknown>;
    expect(seen.bound).toBe(false);
    expect(seen.sourceParked).toBeUndefined();
    expect(seen.path).toBeUndefined();
    // The strip is about the PATH, not about hiding the doc: the visitor
    // still gets a usable status. (`docId` comes back canonical rather than
    // as the alias that was asked for, which is the store's own addressing
    // and not this test's subject.)
    expect(seen.type).toBe('markdown');
    expect(seen.threads).toBeDefined();
  });
});
