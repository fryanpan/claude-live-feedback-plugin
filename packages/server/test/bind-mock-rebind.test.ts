import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

// bind_mock(docId, newPath) is documented as REPOINTING an existing mockup
// doc, but POST /api/docs routes through Rooms.getOrCreate, whose
// existing-room branch used to update only webhookUrl and setId — the doc
// kept serving the old file while the call reported success. These tests pin
// the repoint: served content follows the new path, meta.sourceUrl follows,
// and the private-meta sidecar (the durable record binding survives restarts
// through) is rewritten too.
describe('bind_mock rebind (POST /api/docs on an existing mockup doc)', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'feedback-rebind-test-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function postDoc(body: Record<string, unknown>) {
    const res = await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return (await res.json()) as { meta: { docId: string; sourceUrl?: string } };
  }

  it('re-binding with a new sourceUrl serves the new file and persists the new path', async () => {
    const docId = 'mock-rebind-1';
    const first = join(dataDir, 'rebind-first.html');
    const second = join(dataDir, 'rebind-second.html');
    writeFileSync(first, '<!doctype html><html><body><h1>First mock body</h1></body></html>');
    writeFileSync(second, '<!doctype html><html><body><h1>Second mock body</h1></body></html>');

    const created = await postDoc({ docId, type: 'mockup', sourceUrl: first });
    expect(created.meta.sourceUrl).toBe(first);
    // `mock-rebind-1` is the NAME; the server minted the id it lives at, and
    // the mockup URL below still addresses it by that name.
    const mintedId = created.meta.docId;
    const servedFirst = await fetch(`${base}/mockup/${docId}`).then((r) => r.text());
    expect(servedFirst).toContain('First mock body');

    // Same docId, new path — the documented repoint.
    const rebound = await postDoc({ docId, type: 'mockup', sourceUrl: second });
    expect(rebound.meta.sourceUrl).toBe(second);
    // …and it is the SAME doc: a repeated name resolves to the doc it already
    // names rather than minting a second one beside it.
    expect(rebound.meta.docId).toBe(mintedId);
    const servedSecond = await fetch(`${base}/mockup/${docId}`);
    expect(servedSecond.status).toBe(200);
    expect(await servedSecond.text()).toContain('Second mock body');

    // The sidecar is what a restart rehydrates sourceUrl from — a rebind that
    // only touched memory would silently revert at the next supervisor
    // restart. saveToDisk debounces ~200ms; give it room.
    await new Promise((r) => setTimeout(r, 600));
    const sidecar = JSON.parse(readFileSync(join(dataDir, `${mintedId}.private.json`), 'utf8')) as {
      sourceUrl?: string;
    };
    expect(sidecar.sourceUrl).toBe(second);
  });

  it('re-posting without a sourceUrl leaves the existing binding alone', async () => {
    const docId = 'mock-rebind-2';
    const file = join(dataDir, 'rebind-keep.html');
    writeFileSync(file, '<!doctype html><html><body><h1>Kept mock body</h1></body></html>');

    const created = await postDoc({ docId, type: 'mockup', sourceUrl: file });
    // e.g. a later call that only re-tags the set must not unbind the doc.
    const retagged = await postDoc({ docId, type: 'mockup', setId: 'batch-2' });
    expect(retagged.meta.sourceUrl).toBe(file);
    expect(retagged.meta.docId).toBe(created.meta.docId);
    const served = await fetch(`${base}/mockup/${docId}`);
    expect(served.status).toBe(200);
    expect(await served.text()).toContain('Kept mock body');
  });
});
