/**
 * The route half of archiving one free-standing doc.
 *
 * `Rooms.archiveDoc` moves files and writes a manifest; it knows nothing about
 * BOARDS. Taking the doc's row off every board on the way out, and putting it
 * back on the way in, happens only in the route — so it is only testable here,
 * through the real HTTP surface, the same way the back-target suite covers the
 * hand-copied fields no unit test reaches.
 *
 * All fixtures are synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

interface ArchivedListing {
  archived: Array<{ setId: string }>;
  docs: Array<{ docId: string; archivedBy: string; reason?: string; linkedWorkspaces: string[] }>;
}

describe('POST /api/docs/:id/archive', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let folder: string;
  let base: string;

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
  const boardDocIds = async (boardId: string): Promise<string[]> => {
    const r = await local(`/api/workspaces/${boardId}`);
    return ((await r.json()) as { workspace: { docIds?: string[] } }).workspace.docIds ?? [];
  };
  const archivedListing = async (): Promise<ArchivedListing> => {
    const r = await local('/api/reviews/archived');
    expect(r.status).toBe(200);
    return (await r.json()) as ArchivedListing;
  };

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'doc-arch-'));
    folder = mkdtempSync(join(tmpdir(), 'doc-arch-src-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(() => {
    handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  const mdFile = (name: string): string => {
    const p = join(dataDir, name);
    writeFileSync(p, `# ${name}\n\nBody.\n`);
    return p;
  };

  it('takes the doc off its board, and unarchive puts it back', async () => {
    const ws = await post('/api/workspaces', { name: 'drafts', goal: 'Ship the draft.' });
    const boardId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    expect(
      (
        await post('/api/docs', {
          docId: 'draft-doc',
          type: 'markdown',
          title: 'The Draft',
          sourceUrl: mdFile('draft.md'),
          hubWorkspaceId: boardId,
        })
      ).status,
    ).toBe(200);
    // Positive control: the row is on the board BEFORE we archive. Without it
    // "the row is gone" passes against a board that never had one.
    expect(await boardDocIds(boardId)).toContain('draft-doc');

    const archived = await post('/api/docs/draft-doc/archive', {
      author: { name: 'Tester' },
      reason: 'published',
    });
    expect(archived.status).toBe(200);
    expect(await boardDocIds(boardId)).not.toContain('draft-doc');
    // The doc no longer loads — that is what taking it out of the top level
    // of the data dir buys.
    expect((await local('/api/docs/draft-doc')).status).toBe(404);

    const listing = await archivedListing();
    expect(listing.docs.map((d) => d.docId)).toContain('draft-doc');
    const entry = listing.docs.find((d) => d.docId === 'draft-doc');
    expect(entry?.archivedBy).toBe('Tester');
    expect(entry?.reason).toBe('published');
    // The board it will return to is recorded, which is what makes the round
    // trip land where it started rather than orphaned.
    expect(entry?.linkedWorkspaces).toContain(boardId);
    // A doc is not a review: the review listing stays empty.
    expect(listing.archived).toEqual([]);

    const back = await post('/api/docs/draft-doc/unarchive', { author: { name: 'Tester' } });
    expect(back.status).toBe(200);
    expect((await local('/api/docs/draft-doc')).status).toBe(200);
    expect(await boardDocIds(boardId)).toContain('draft-doc');
    expect((await archivedListing()).docs).toEqual([]);
  });

  it('404s an unknown id, and 409s a doc that belongs to a review', async () => {
    expect((await post('/api/docs/no-such-doc/archive', {})).status).toBe(404);
    expect((await post('/api/docs/no-such-doc/unarchive', {})).status).toBe(404);

    writeFileSync(join(folder, 'README.md'), '# Fixture\n\nbody\n');
    mkdirSync(join(folder, 'src'));
    writeFileSync(join(folder, 'src', 'util.ts'), 'export const y = 2;\n');
    const bound = await post('/api/diffs', { repo: folder });
    expect(bound.status).toBe(200);
    const res = (await bound.json()) as { reviewId: string; files: Array<{ docId: string }> };
    const memberDocId = res.files[0]?.docId as string;
    expect(memberDocId).toBeTruthy();

    const refused = await post(`/api/docs/${encodeURIComponent(memberDocId)}/archive`, {
      author: { name: 'Tester' },
    });
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { error: string; setId?: string };
    expect(body.error).toBe('review-member');
    // Name the review, so the caller knows to reach for archive_review.
    expect(body.setId).toBe(res.reviewId);
    expect((await local(`/api/docs/${encodeURIComponent(memberDocId)}`)).status).toBe(200);
  });
});
