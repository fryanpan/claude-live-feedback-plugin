/**
 * GET /api/docs?setId=<id> scopes the listing to one review set.
 *
 * The review sidebar's legacy flat-set path asks this route for EVERY doc on
 * the server and keeps the handful that share its `setId` — measured
 * 2026-08-21 as 4,205,683 bytes downloaded to select 6 rows out of 4,062. The
 * client already knew the answer it wanted; only the server could narrow it.
 *
 * Matching goes through `reviewIdOf`, the same predicate every other set query
 * on this server uses (`listGroupedDiff`, `listRepoFiles`, the tree builder),
 * so `?setId=` cannot answer a different question from the routes beside it.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

interface DocMetaOut {
  docId: string;
  setId?: string;
  workspaceId?: string;
}

describe('GET /api/docs honours its setId filter', () => {
  let handle: ServerHandle;
  let dataDir: string;
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
  const listDocs = async (qs = ''): Promise<DocMetaOut[]> => {
    const r = await local(`/api/docs${qs}`);
    expect(r.status).toBe(200);
    return ((await r.json()) as { docs: DocMetaOut[] }).docs;
  };
  const mdFile = (name: string): string => {
    const p = join(dataDir, name);
    writeFileSync(p, `# ${name}\n\nBody.\n`);
    return p;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'list-docs-set-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;

    for (const [docId, setId] of [
      ['doc-set-a-1', 'set-a'],
      ['doc-set-a-2', 'set-a'],
      ['doc-set-b-1', 'set-b'],
    ] as const) {
      const r = await post('/api/docs', {
        docId,
        type: 'markdown',
        sourceUrl: mdFile(`${docId}.md`),
        setId,
      });
      expect(r.status).toBe(200);
    }
    // A doc in no set at all — the 99.8% the sidebar throws away today.
    const loose = await post('/api/docs', {
      docId: 'doc-loose',
      type: 'markdown',
      sourceUrl: mdFile('loose.md'),
    });
    expect(loose.status).toBe(200);
  });

  afterAll(() => {
    handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns only that set’s docs, not the whole server', async () => {
    // Positive control first: unfiltered, everything is in the listing — so
    // "absent when filtered" below is a claim about the filter and not about
    // an empty server.
    const all = (await listDocs()).map((d) => d.docId);
    expect(all).toEqual(
      expect.arrayContaining(['doc-set-a-1', 'doc-set-a-2', 'doc-set-b-1', 'doc-loose']),
    );

    const scoped = (await listDocs('?setId=set-a')).map((d) => d.docId);
    expect(scoped.sort()).toEqual(['doc-set-a-1', 'doc-set-a-2']);
  });

  it('matches a doc carrying only the deprecated workspaceId spelling', async () => {
    // `reviewIdOf` reads setId first and falls back to workspaceId, for a doc
    // restored from an archive written before the rename. The filter must not
    // be the one place that forgets the fallback.
    const r = await post('/api/docs', {
      docId: 'doc-old-spelling',
      type: 'markdown',
      sourceUrl: mdFile('old-spelling.md'),
      workspaceId: 'set-legacy',
    });
    expect(r.status).toBe(200);
    const created = (await listDocs()).find((d) => d.docId === 'doc-old-spelling');
    expect(created?.workspaceId).toBe('set-legacy');

    expect((await listDocs('?setId=set-legacy')).map((d) => d.docId)).toEqual(['doc-old-spelling']);
  });

  it('an unknown setId returns an empty list, not everything', async () => {
    // The failure mode a silently-ignored filter has: an unmatchable query
    // answered with the entire server, which is what the sidebar downloads
    // today.
    expect(await listDocs('?setId=set-does-not-exist')).toEqual([]);
  });

  it('still answers the whole listing when no filter is given', async () => {
    // Callers that pass neither param must keep the behaviour they have.
    expect((await listDocs()).length).toBeGreaterThan(3);
  });
});
