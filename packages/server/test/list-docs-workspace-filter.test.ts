/**
 * GET /api/docs?workspaceId=<id> scopes the listing to one workspace.
 *
 * Before this route learned the param, `list_docs` accepted a workspaceId
 * from callers and silently dropped it — a board-scoped question answered
 * with every doc on the server, and nothing said so. The filter matches a
 * doc either by its hub-board membership (the board `attach_doc` /
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

interface DocMetaOut {
  docId: string;
  workspaceId?: string;
}

describe('GET /api/docs honours its workspaceId filter', () => {
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
    dataDir = mkdtempSync(join(tmpdir(), 'list-docs-ws-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;

    const a = await post('/api/workspaces', { name: 'board-a', goal: 'Ship A.' });
    wsA = ((await a.json()) as { workspace: { id: string } }).workspace.id;
    const b = await post('/api/workspaces', { name: 'board-b', goal: 'Ship B.' });
    wsB = ((await b.json()) as { workspace: { id: string } }).workspace.id;

    for (const [docId, ws] of [
      ['doc-in-a', wsA],
      ['doc-in-b', wsB],
    ] as const) {
      const r = await post('/api/docs', {
        docId,
        type: 'markdown',
        sourceUrl: mdFile(`${docId}.md`),
        hubWorkspaceId: ws,
      });
      expect(r.status).toBe(200);
      mintedId[docId] = ((await r.json()) as { docId: string }).docId;
    }
  });

  afterAll(() => {
    handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns only the named workspace’s docs, not the whole server', async () => {
    // Positive control first: without the param both docs are in the listing,
    // so "absent when filtered" below is a claim about the filter.
    const all = (await listDocs()).map((d) => d.docId);
    expect(all).toContain(mintedId['doc-in-a']);
    expect(all).toContain(mintedId['doc-in-b']);

    const scoped = (await listDocs(`?workspaceId=${encodeURIComponent(wsA)}`)).map((d) => d.docId);
    expect(scoped).toContain(mintedId['doc-in-a']);
    expect(scoped).not.toContain(mintedId['doc-in-b']);

    // …and the readable name the caller chose still addresses the doc it
    // named, which is the other half of the alias contract.
    const byName = await local('/api/docs/doc-in-a');
    expect(byName.status).toBe(200);
    expect(((await byName.json()) as { meta: DocMetaOut }).meta.docId).toBe(mintedId['doc-in-a']);
  });

  it('matches the meta.workspaceId grouping tag too, not just board membership', async () => {
    // Folder binds and diff reviews stamp their members with a GROUPING
    // workspaceId in meta — a different id namespace from hub boards, held by
    // real callers asking the same scoped question.
    const r = await post('/api/docs', {
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
    expect(await listDocs('?workspaceId=w-does-not-exist')).toEqual([]);
  });
});
