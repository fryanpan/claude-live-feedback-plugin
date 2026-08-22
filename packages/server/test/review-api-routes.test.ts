/**
 * A review's API answers under `/api/reviews/<setId>/…`.
 *
 * The endpoints existed under `/api/workspaces/<id>/…` because a diff review
 * and a bound folder used to BE a second kind of workspace. They are reviews,
 * and this is where they live now.
 *
 * Two things are asserted for every route, and the second is the one with
 * teeth: the new spelling works, AND the old spelling still works. The old
 * callers are plugin bundles inside sessions nobody can restart and browser
 * tabs already open, so an alias that quietly stopped answering would fail on
 * a machine none of us is looking at.
 *
 * The delete pair is asserted the other way round as well — `delete_review`
 * must NOT be able to destroy a board — because that is the whole reason the
 * verb was split rather than renamed.
 *
 * All fixtures are synthetic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

describe('the review API', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let folder: string;
  let base: string;
  let setId: string;
  let boardId: string;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  const post = (path: string, body: unknown) =>
    local(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'review-api-'));
    folder = mkdtempSync(join(tmpdir(), 'review-api-src-'));
    mkdirSync(join(folder, 'sub'), { recursive: true });
    writeFileSync(join(folder, 'README.md'), '# Entry\n\nbody\n');
    writeFileSync(join(folder, 'sub', 'two.md'), '# Two\n\nmore\n');
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;

    const board = await post('/api/workspaces', { name: 'a board', goal: 'Ship it.' });
    boardId = ((await board.json()) as { workspace: { id: string } }).workspace.id;

    const bound = await post('/api/workspaces', { folderPath: folder, hubWorkspaceId: boardId });
    expect(bound.status).toBe(200);
    const body = (await bound.json()) as { setId?: string; workspaceId?: string };
    // The response names the review under the key the CRDT stores it as…
    expect(typeof body.setId).toBe('string');
    // …and keeps the old key at the SAME value. A key that changed meaning
    // would be worse than one that disappeared.
    expect(body.workspaceId).toBe(body.setId);
    setId = body.setId as string;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  describe('answers at both spellings', () => {
    for (const sub of ['tree', 'files', 'threads'] as const) {
      it(`GET /${sub}`, async () => {
        const now = await local(`/api/reviews/${encodeURIComponent(setId)}/${sub}`);
        expect(now.status, `new /${sub}`).toBe(200);
        const before = await local(`/api/workspaces/${encodeURIComponent(setId)}/${sub}`);
        expect(before.status, `old /${sub}`).toBe(200);
        expect(await before.text()).toBe(await now.text());
      });
    }

    it('POST /refresh', async () => {
      expect((await post(`/api/reviews/${encodeURIComponent(setId)}/refresh`, {})).status).toBe(
        200,
      );
      expect((await post(`/api/workspaces/${encodeURIComponent(setId)}/refresh`, {})).status).toBe(
        200,
      );
    });

    it('POST /context-file opens a member lazily', async () => {
      const r = await post(`/api/reviews/${encodeURIComponent(setId)}/context-file`, {
        relPath: 'sub/two.md',
      });
      expect(r.status).toBe(200);
      expect(((await r.json()) as { docId: string }).docId).toContain('two.md');
    });

    it('POST /groups refuses a bad payload the same way at both', async () => {
      // A 400 from the shared handler, not a 404 from a route that isn't
      // there: this is what proves the alias reaches the SAME code.
      for (const p of [`/api/reviews/${setId}/groups`, `/api/workspaces/${setId}/groups`]) {
        expect((await post(p, {})).status, p).toBe(400);
      }
    });
  });

  it('reports a review id it has never heard of as not-found', async () => {
    const r = await local('/api/reviews/no-such-review/tree');
    expect(r.status).toBe(404);
    const body = (await r.json()) as { setId?: string; workspaceId?: string };
    expect(body.setId).toBe('no-such-review');
    expect(body.workspaceId).toBe('no-such-review'); // deprecated, same value
  });

  describe('delete is two verbs because it deletes two things', () => {
    it('DELETE /api/reviews/<setId> drops the review and its board row', async () => {
      const r = await local(`/api/reviews/${encodeURIComponent(setId)}?force=true`, {
        method: 'DELETE',
      });
      expect(r.status).toBe(200);
      expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
      // The review was ONE row on the board; deleting it takes the row.
      const board = await local(`/api/workspaces/${boardId}`);
      const docIds = ((await board.json()) as { workspace: { docIds: string[] } }).workspace.docIds;
      expect(docIds).not.toContain(setId);
    });

    it('DELETE /api/reviews/<boardId> cannot touch a board', async () => {
      const r = await local(`/api/reviews/${encodeURIComponent(boardId)}?force=true`, {
        method: 'DELETE',
      });
      expect(r.status).toBe(404);
      // Positive control on the same id, same pass: the board really is there,
      // so the 404 above is a refusal rather than a board that never existed.
      expect((await local(`/api/workspaces/${boardId}`)).status).toBe(200);
    });

    it('DELETE /api/workspaces/<id> still fronts both, for callers we cannot restart', async () => {
      expect(
        (
          await local(`/api/workspaces/${encodeURIComponent(setId)}?force=true`, {
            method: 'DELETE',
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await local(`/api/workspaces/${encodeURIComponent(boardId)}?force=true`, {
            method: 'DELETE',
          })
        ).status,
      ).toBe(200);
      expect((await local(`/api/workspaces/${boardId}`)).status).toBe(404);
    });
  });
});
