/**
 * A review's API answers under `/api/reviews/<setId>/…`, and ONLY there.
 *
 * The endpoints once existed under `/api/workspaces/<id>/…` too, because a
 * diff review and a bound folder used to BE a second kind of workspace. That
 * alias was kept alive for callers nobody could restart. It is gone now: the
 * canonical-routes cutover moved the whole `/api/workspaces/*` family to
 * `/workspaces/*`, which is a board's address, and an attachment set is not a
 * board. Keeping the alias would have re-created the confusion the split was
 * for — a review id answering at a board's path.
 *
 * So each route is asserted twice, and the second half is the one with teeth:
 * the review spelling answers, AND the retired workspace spelling does not.
 * A test that only checked the live path would still pass on the day the
 * alias came back.
 *
 * The delete pair is asserted the other way round as well — `delete_attachment_set`
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
import { seedBoard } from './workspace-seed.ts';

/** The board this file's docs, tasks and reviews are filed under. */
let WS = '';

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
    WS = await seedBoard(base);

    const board = await post('/workspaces', { name: 'a board', goal: 'Ship it.' });
    boardId = ((await board.json()) as { workspace: { id: string } }).workspace.id;
    WS = boardId;

    const bound = await post('/workspaces', { folderPath: folder, hubWorkspaceId: boardId });
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

  describe('answers at the review spelling, and only there', () => {
    for (const sub of ['tree', 'files', 'threads'] as const) {
      it(`GET /${sub}`, async () => {
        const now = await local(`/workspaces/${WS}/reviews/${encodeURIComponent(setId)}/${sub}`);
        expect(now.status, `review /${sub}`).toBe(200);
        // The retired alias. A review id is not a board id, so the board
        // family refuses it before any handler runs.
        const retired = await local(`/workspaces/${encodeURIComponent(setId)}/${sub}`);
        expect(retired.status, `retired /${sub}`).toBe(404);
      });
    }

    it('POST /refresh', async () => {
      expect(
        (await post(`/workspaces/${WS}/reviews/${encodeURIComponent(setId)}/refresh`, {})).status,
      ).toBe(200);
      expect((await post(`/workspaces/${encodeURIComponent(setId)}/refresh`, {})).status).toBe(404);
    });

    it('POST /context-file opens a member lazily', async () => {
      const r = await post(`/workspaces/${WS}/reviews/${encodeURIComponent(setId)}/context-file`, {
        relPath: 'sub/two.md',
      });
      expect(r.status).toBe(200);
      expect(((await r.json()) as { docId: string }).docId).toContain('two.md');
    });

    it('POST /groups refuses a bad payload from the handler, not the router', async () => {
      // A 400 rather than a 404 is what proves the request reached the
      // review's own handler; the retired spelling gets the 404 instead,
      // which is what proves it reached nothing.
      expect((await post(`/workspaces/${WS}/reviews/${setId}/groups`, {})).status).toBe(400);
      expect((await post(`/workspaces/${setId}/groups`, {})).status).toBe(404);
    });
  });

  it('reports a review id it has never heard of as not-found', async () => {
    // The scope middleware answers this now, before the review handler is
    // reached — a review id this board does not hold is refused by the same
    // rule, and with the same body, as a doc id it does not hold. The old
    // reply echoed the id back; one refusal shape is what replaces it, and a
    // refusal that varied by collection was a way to tell a real foreign id
    // from an invented one.
    const r = await local(`/workspaces/${WS}/reviews/no-such-review/tree`);
    expect(r.status).toBe(404);
    expect((await r.json()) as { error?: string }).toEqual({ error: 'not-found' });
  });

  describe('delete is two verbs because it deletes two things', () => {
    it('DELETE /workspaces/<ws>/reviews/<setId> drops the review and its board row', async () => {
      const r = await local(`/workspaces/${WS}/reviews/${encodeURIComponent(setId)}?force=true`, {
        method: 'DELETE',
      });
      expect(r.status).toBe(200);
      expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
      // The review was ONE row on the board; deleting it takes the row.
      const board = await local(`/workspaces/${boardId}?format=json`);
      const docIds = ((await board.json()) as { workspace: { docIds: string[] } }).workspace.docIds;
      expect(docIds).not.toContain(setId);
    });

    it('DELETE /workspaces/<ws>/reviews/<boardId> cannot touch a board', async () => {
      const r = await local(`/workspaces/${WS}/reviews/${encodeURIComponent(boardId)}?force=true`, {
        method: 'DELETE',
      });
      expect(r.status).toBe(404);
      // Positive control on the same id, same pass: the board really is there,
      // so the 404 above is a refusal rather than a board that never existed.
      expect((await local(`/workspaces/${boardId}?format=json`)).status).toBe(200);
    });

    it('DELETE /workspaces/<id> no longer fronts a review — it is a board verb only', async () => {
      // The two-store compatibility on this path is gone (owner decision, this
      // cutover): `/workspaces/<id>` is a BOARD address, and a review is
      // deleted at the review's own address. A set id here now names a board
      // nothing knows.
      expect(
        (
          await local(`/workspaces/${encodeURIComponent(setId)}?force=true`, {
            method: 'DELETE',
          })
        ).status,
      ).toBe(404);
      // Positive control in the same pass: the set really is still there, so
      // the 404 is the address being wrong rather than the review being gone.
      expect(
        (await local(`/workspaces/${boardId}/reviews/${encodeURIComponent(setId)}/tree`)).status,
      ).toBe(200);
      // …and the board verb itself still works on a board.
      expect(
        (
          await local(`/workspaces/${encodeURIComponent(boardId)}?force=true`, {
            method: 'DELETE',
          })
        ).status,
      ).toBe(200);
      expect((await local(`/workspaces/${boardId}`)).status).toBe(404);
    });
  });
});
