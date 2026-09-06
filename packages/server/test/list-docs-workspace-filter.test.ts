/**
 * GET /api/docs?workspaceId=<id> scopes the listing to one workspace.
 *
 * Before this route learned the param, `list_docs` accepted a workspaceId
 * from callers and silently dropped it — a board-scoped question answered
 * with every doc on the server, and nothing said so. The filter matches a
 * doc either by its board membership (the board `attach_doc` /
 * `hubWorkspaceId` files it under) or by its `meta.workspaceId` grouping tag
 * (folder binds and diff reviews), because callers hold both kinds of id and
 * both are called "workspace".
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

interface DocMetaOut {
  docId: string;
  workspaceId?: string;
}

/** The board this file's docs, tasks and reviews are filed under. */
let WS = '';

describe(`GET /workspaces/${WS}/docs honours its workspaceId filter`, () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsA: string;
  let wsB: string;
  /** Readable name → the id the server minted for it. The name a caller posts
   *  is an alias now; the listing answers in minted ids. */
  const mintedId: Record<string, string> = {};

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
    const r = await local(`/workspaces/${WS}/docs${qs}`);
    expect(r.status).toBe(200);
    return ((await r.json()) as { docs: DocMetaOut[] }).docs;
  };
  const mdFile = (name: string): string => {
    const p = join(dataDir, name);
    writeFileSync(p, `# ${name}\n\nBody.\n`);
    return p;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'list-docs-ws-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    WS = await seedBoard(base);

    const a = await post('/workspaces', { name: 'board-a', goal: 'Ship A.' });
    wsA = ((await a.json()) as { workspace: { id: string } }).workspace.id;
    const b = await post('/workspaces', { name: 'board-b', goal: 'Ship B.' });
    wsB = ((await b.json()) as { workspace: { id: string } }).workspace.id;
    // The listings below are addressed under board A. `WS` is what `listDocs`
    // spells in the path, and the path is now the OUTER scope of the listing.
    WS = wsA;

    for (const [docId, ws] of [
      ['doc-in-a', wsA],
      ['doc-in-b', wsB],
    ] as const) {
      const r = await post(`/workspaces/${ws}/docs`, {
        docId,
        type: 'markdown',
        sourceUrl: mdFile(`${docId}.md`),
      });
      expect(r.status).toBe(200);
      mintedId[docId] = ((await r.json()) as { docId: string }).docId;
    }
  });

  afterAll(() => {
    handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns only the board in the PATH, and the param can only narrow it', async () => {
    // The path is the scope now, before any query filter. `?workspaceId=` used
    // to be the ONLY scope this listing had, and leaving it that way under
    // `/workspaces/<id>/docs` would have let a member of one board read
    // another board's listing through it.
    const all = (await listDocs()).map((d) => d.docId);
    expect(all).toContain(mintedId['doc-in-a']);
    expect(all).not.toContain(mintedId['doc-in-b']);

    // The param survives as a FILTER on top — a review set's grouping tag is
    // spelled the same way (the test below) — and naming board A again is a
    // no-op rather than a second scope.
    const scoped = (await listDocs(`?workspaceId=${encodeURIComponent(wsA)}`)).map((d) => d.docId);
    expect(scoped).toContain(mintedId['doc-in-a']);
    expect(scoped).not.toContain(mintedId['doc-in-b']);

    // …and naming the OTHER board through it widens nothing: board B's doc
    // stays out of board A's listing however the param is spelled.
    const crossed = (await listDocs(`?workspaceId=${encodeURIComponent(wsB)}`)).map((d) => d.docId);
    expect(crossed).not.toContain(mintedId['doc-in-b']);
    expect(crossed).not.toContain(mintedId['doc-in-a']);

    // …and the readable name the caller chose still addresses the doc it
    // named, which is the other half of the alias contract.
    const byName = await local(`/workspaces/${WS}/docs/doc-in-a?format=json`);
    expect(byName.status).toBe(200);
    expect(((await byName.json()) as { meta: DocMetaOut }).meta.docId).toBe(mintedId['doc-in-a']);
  });

  it('matches the meta.workspaceId grouping tag too, not just board membership', async () => {
    // Folder binds and diff reviews stamp their members with a GROUPING
    // workspaceId in meta — a different id namespace from boards, held by
    // real callers asking the same scoped question.
    const r = await post(`/workspaces/${WS}/docs`, {
      docId: 'doc-grouped',
      type: 'markdown',
      sourceUrl: mdFile('grouped.md'),
      workspaceId: 'grouping-tag-1',
    });
    expect(r.status).toBe(200);
    const groupedId = ((await r.json()) as { docId: string }).docId;
    // Positive control: the tag really landed in meta.
    const created = (await listDocs()).find((d) => d.docId === groupedId);
    expect(created?.workspaceId).toBe('grouping-tag-1');

    const scoped = (await listDocs('?workspaceId=grouping-tag-1')).map((d) => d.docId);
    expect(scoped).toContain(groupedId);
    expect(scoped).not.toContain(mintedId['doc-in-a']);
  });

  it('an unknown workspaceId returns an empty list, not everything', async () => {
    // The old behaviour was precisely "unmatchable filter → whole server", so
    // this is the regression the ticket is about, stated directly.
    expect(await listDocs('?workspaceId=w-missing')).toEqual([]);
  });
});
