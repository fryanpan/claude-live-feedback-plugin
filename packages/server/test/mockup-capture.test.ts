import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockupCapturePath } from '../src/mockup-capture.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

// A mockup is bound to a docId while its HTML lives outside the repo, by
// project rule — in practice inside an agent session's scratch directory.
// Clean that directory up and the binding survives while the content does
// not: the link still looks valid and serves a 404 to whoever opens it, which
// is the reviewer, weeks later. That happened.
//
// Two halves, and the second is the one that gets skipped:
//   1. a bound mockup still renders after its source file is DELETED —
//      proven by deleting the file and fetching the page, never by reading a
//      cached copy while the original is still sitting there;
//   2. binding a mockup whose path is already unreachable fails at BIND time,
//      naming the path, instead of at read time.
describe('mockup durability', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let scratch: string;
  let base: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'feedback-mock-capture-'));
    // A separate directory, deleted independently of the data dir — this is
    // the agent scratch folder whose cleanup is the whole incident.
    scratch = mkdtempSync(join(tmpdir(), 'agent-scratch-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  async function bind(body: Record<string, unknown>) {
    return await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function bindOk(body: Record<string, unknown>) {
    const res = await bind(body);
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return (await res.json()) as { meta: { docId: string; sourceUrl?: string } };
  }

  describe('half 1 — the page outlives its source file', () => {
    it('still renders after the source file is deleted', async () => {
      const src = join(scratch, 'vanishing.html');
      writeFileSync(src, '<!doctype html><html><body><h1>Round one body</h1></body></html>');
      await bindOk({ docId: 'mock-vanishing', type: 'mockup', sourceUrl: src });

      // Positive control: with the file present, the live file is what serves.
      const before = await fetch(`${base}/mockup/mock-vanishing`);
      expect(before.status).toBe(200);
      expect(before.headers.get('x-mockup-source')).toBe('live');
      expect(await before.text()).toContain('Round one body');

      // The scratch folder gets cleaned up. This is the actual deletion —
      // nothing below reads a copy while the original is still there.
      rmSync(src);
      expect(existsSync(src)).toBe(false);

      const after = await fetch(`${base}/mockup/mock-vanishing`);
      expect(after.status).toBe(200);
      expect(after.headers.get('x-mockup-source')).toBe('captured');
      const html = await after.text();
      expect(html).toContain('Round one body');
      // And it is still a reviewable page, not just bytes: the comment widget
      // is injected into the captured copy the same way it is into the live
      // one. A mockup that renders but cannot be commented on is not the
      // thing the link promised.
      expect(html).toContain('feedback-widget');
    });

    it('falls back to the LAST content served, not to what round one looked like', async () => {
      const src = join(scratch, 'iterated.html');
      writeFileSync(src, '<!doctype html><html><body><h1>Round one</h1></body></html>');
      await bindOk({ docId: 'mock-iterated', type: 'mockup', sourceUrl: src });

      // The mock is reworked in place, as mockups are, and the reviewer looks
      // at round two — that is what the serve below represents.
      writeFileSync(src, '<!doctype html><html><body><h1>Round two</h1></body></html>');
      expect(await fetch(`${base}/mockup/mock-iterated`).then((r) => r.text())).toContain(
        'Round two',
      );

      rmSync(src);
      const after = await fetch(`${base}/mockup/mock-iterated`).then((r) => r.text());
      expect(after).toContain('Round two');
      // A capture frozen at bind time would serve this, silently, to somebody
      // who was shown round two. Same failure class, new disguise.
      expect(after).not.toContain('Round one');
    });

    it('survives a server restart with the source gone — the capture is on disk, not in memory', async () => {
      const src = join(scratch, 'restart.html');
      writeFileSync(src, '<!doctype html><html><body><h1>Persisted mock body</h1></body></html>');
      const created = await bindOk({ docId: 'mock-restart', type: 'mockup', sourceUrl: src });
      const mintedId = created.meta.docId;
      // Bound and never opened. The capture has to come from the bind itself,
      // which is the case where the mock is made, shared, and only looked at
      // after the scratch dir is gone.
      expect(existsSync(mockupCapturePath(dataDir, mintedId))).toBe(true);

      rmSync(src);
      await handle.stop();
      handle = createServer({ port: 0, dataDir });
      base = `http://localhost:${handle.port}`;

      const after = await fetch(`${base}/mockup/mock-restart`);
      expect(after.status).toBe(200);
      expect(after.headers.get('x-mockup-source')).toBe('captured');
      expect(await after.text()).toContain('Persisted mock body');
    });

    it('goes back to the live file when the source comes back', async () => {
      const src = join(scratch, 'restored.html');
      writeFileSync(src, '<!doctype html><html><body><h1>Original body</h1></body></html>');
      await bindOk({ docId: 'mock-restored', type: 'mockup', sourceUrl: src });
      rmSync(src);
      expect((await fetch(`${base}/mockup/mock-restored`)).headers.get('x-mockup-source')).toBe(
        'captured',
      );

      // Re-created — an agent rebuilding the mock, or a worktree coming back.
      // The capture is a fallback, never a cache that shadows the real file.
      writeFileSync(src, '<!doctype html><html><body><h1>Rebuilt body</h1></body></html>');
      const back = await fetch(`${base}/mockup/mock-restored`);
      expect(back.headers.get('x-mockup-source')).toBe('live');
      expect(await back.text()).toContain('Rebuilt body');
    });

    it('an emptied source does not take the good capture with it', async () => {
      const src = join(scratch, 'truncated.html');
      writeFileSync(src, '<!doctype html><html><body><h1>Good body</h1></body></html>');
      await bindOk({ docId: 'mock-truncated', type: 'mockup', sourceUrl: src });

      // A half-written file caught mid-save. Serving it is honest — that is
      // what is on disk — but it must not overwrite the only copy that will
      // survive the file's deletion.
      writeFileSync(src, '');
      await fetch(`${base}/mockup/mock-truncated`);
      rmSync(src);

      const after = await fetch(`${base}/mockup/mock-truncated`);
      expect(after.headers.get('x-mockup-source')).toBe('captured');
      expect(await after.text()).toContain('Good body');
    });

    it('re-binding to an empty file drops the old capture instead of keeping it', async () => {
      // The serve-time refusal above protects a capture from ITS OWN source
      // being caught mid-write. A rebind names a different file, so the same
      // refusal would leave the link resolving to a mockup nobody pointed it
      // at — the silent-wrong-content failure, arrived at from the other side.
      const first = join(scratch, 'rebind-empty-first.html');
      const second = join(scratch, 'rebind-empty-second.html');
      writeFileSync(first, '<!doctype html><html><body><h1>Superseded body</h1></body></html>');
      writeFileSync(second, '');
      await bindOk({ docId: 'mock-rebind-empty', type: 'mockup', sourceUrl: first });
      await bindOk({ docId: 'mock-rebind-empty', type: 'mockup', sourceUrl: second });

      rmSync(first);
      rmSync(second);
      const after = await fetch(`${base}/mockup/mock-rebind-empty`);
      expect(after.headers.get('x-mockup-source')).toBe('captured');
      expect(await after.text()).not.toContain('Superseded body');
    });

    it('the etag describes the page sent, not the file read', async () => {
      // Two docs, one source file. The widget embed carries the doc id, so
      // the bytes the browser holds differ even though the file does not — a
      // source-derived tag would let one page revalidate as the other.
      const shared = join(scratch, 'shared-source.html');
      writeFileSync(shared, '<!doctype html><html><body><h1>Shared body</h1></body></html>');
      await bindOk({ docId: 'mock-etag-a', type: 'mockup', sourceUrl: shared });
      await bindOk({ docId: 'mock-etag-b', type: 'mockup', sourceUrl: shared });
      const a = await fetch(`${base}/mockup/mock-etag-a`);
      const b = await fetch(`${base}/mockup/mock-etag-b`);
      expect(a.headers.get('etag')).toBeTruthy();
      expect(a.headers.get('etag')).not.toBe(b.headers.get('etag'));
      // …and it is still stable for the same page, which is the half that
      // makes it worth sending at all.
      const again = await fetch(`${base}/mockup/mock-etag-a`);
      expect(again.headers.get('etag')).toBe(a.headers.get('etag'));
    });

    it('an unbound docId is still a 404 — the fallback invents nothing', async () => {
      const res = await fetch(`${base}/mockup/mock-never-bound`);
      expect(res.status).toBe(404);
    });
  });

  describe('half 2 — an unreachable path fails at bind time', () => {
    it('refuses a path that does not exist, naming the path', async () => {
      const missing = join(scratch, 'never-written.html');
      const res = await bind({ docId: 'mock-missing', type: 'mockup', sourceUrl: missing });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; path?: string; hint?: string };
      expect(body.error).toBe('mockup_source_unreadable');
      expect(body.path).toBe(missing);
      // The message has to carry the path: the agent that gets this back is
      // usually holding a path it built by string-joining, and the useful
      // half of the answer is which one it actually tried.
      expect(body.hint).toContain(missing);
    });

    it('refuses a path that exists but is not readable, naming the path', async () => {
      const locked = join(scratch, 'locked.html');
      writeFileSync(locked, '<!doctype html><html><body>secret</body></html>');
      chmodSync(locked, 0o000);
      try {
        const res = await bind({ docId: 'mock-locked', type: 'mockup', sourceUrl: locked });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string; path?: string; reason?: string };
        expect(body.error).toBe('mockup_source_unreadable');
        expect(body.path).toBe(locked);
        // exists() said yes, and that used to be the whole check.
        expect(existsSync(locked)).toBe(true);
      } finally {
        chmodSync(locked, 0o600);
      }
    });

    it('refuses a directory where a file was meant, naming the path', async () => {
      const dir = join(scratch, 'a-directory.html');
      mkdirSync(dir, { recursive: true });
      const res = await bind({ docId: 'mock-dir', type: 'mockup', sourceUrl: dir });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; path?: string };
      expect(body.error).toBe('mockup_source_unreadable');
      expect(body.path).toBe(dir);
    });

    it('a failed bind leaves nothing behind — no doc, no half-bound link', async () => {
      const missing = join(scratch, 'also-never-written.html');
      const failed = await bind({ docId: 'mock-no-residue', type: 'mockup', sourceUrl: missing });
      expect(failed.status).toBe(400);
      // The name is not taken, and no URL was minted that would 404 later.
      expect((await fetch(`${base}/mockup/mock-no-residue`)).status).toBe(404);
      const listed = (await fetch(`${base}/api/docs`).then((r) => r.json())) as {
        docs?: { docId: string; title?: string }[];
      };
      const docs = listed.docs ?? [];
      expect(docs.some((d) => d.docId === 'mock-no-residue')).toBe(false);
    });

    it('re-binding an existing mockup to an unreachable path is refused too', async () => {
      const good = join(scratch, 'rebind-good.html');
      writeFileSync(good, '<!doctype html><html><body><h1>Good mock body</h1></body></html>');
      await bindOk({ docId: 'mock-rebind-guard', type: 'mockup', sourceUrl: good });

      const bad = join(scratch, 'rebind-missing.html');
      const res = await bind({ docId: 'mock-rebind-guard', type: 'mockup', sourceUrl: bad });
      expect(res.status).toBe(400);
      // And the doc that was already working still works — a refused repoint
      // must not be a way to break a live link.
      const still = await fetch(`${base}/mockup/mock-rebind-guard`);
      expect(still.status).toBe(200);
      expect(await still.text()).toContain('Good mock body');
    });

    it('fails the bind when the capture itself cannot be written', async () => {
      // Durability is part of what bind_mock now promises, so a bind that
      // cannot store the copy must say so. A 200 here would hand back a link
      // that reads as durable and is not — the shape of the incident, rebuilt
      // out of a full or unwritable data dir instead of a deleted scratch dir.
      const src = join(scratch, 'capture-blocked.html');
      writeFileSync(src, '<!doctype html><html><body><h1>Blocked body</h1></body></html>');
      const created = await bindOk({
        docId: 'mock-capture-blocked',
        type: 'mockup',
        sourceUrl: src,
      });
      const capture = mockupCapturePath(dataDir, created.meta.docId);

      // Something the write cannot land on. The bound path is still perfectly
      // readable — this is the data dir refusing, not the caller.
      rmSync(capture, { force: true });
      mkdirSync(capture, { recursive: true });
      try {
        const res = await bind({ docId: 'mock-capture-blocked', type: 'mockup', sourceUrl: src });
        expect(res.status).toBe(500);
        const body = (await res.json()) as { error: string; hint?: string };
        expect(body.error).toBe('mockup_capture_failed');
        expect(body.hint).toContain(src);
      } finally {
        rmSync(capture, { recursive: true, force: true });
      }
    });

    it('POSITIVE CONTROL: a readable path still binds and still serves', async () => {
      // Without this, every assertion above passes on a route that refuses
      // everything.
      const src = join(scratch, 'ordinary.html');
      writeFileSync(src, '<!doctype html><html><body><h1>Ordinary mock body</h1></body></html>');
      const created = await bindOk({ docId: 'mock-ordinary', type: 'mockup', sourceUrl: src });
      expect(created.meta.sourceUrl).toBe(src);
      const res = await fetch(`${base}/mockup/mock-ordinary`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Ordinary mock body');
    });

    it('a mockup bound with no sourceUrl at all is unaffected', async () => {
      // Dev-server surfaces bind a mockup doc without a file; the new check
      // must not reach them.
      const res = await bind({ docId: 'mock-no-source', type: 'mockup' });
      expect(res.ok).toBe(true);
    });
  });
});
