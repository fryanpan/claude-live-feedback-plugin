import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { User } from '@feedback/core';
import { type ServerHandle, createServer } from '../src/server.ts';

/**
 * HTTP-level tests for `replaceAll: true` on find_and_replace — exercised
 * through the REAL route, not rooms.ts. A rooms-level unit test proves
 * nothing about whether the HTTP layer actually forwards a new param — only
 * a real fetch() through server.ts does (the "groups" param the API accepted
 * and discarded is the incident behind this pattern).
 *
 * The feature exists so a mechanical sweep — the same stale SHA in dozens of
 * places — is ONE safe call instead of a raw disk write against a bound doc.
 */

const author: User = { id: 'agent-1', name: 'Docs Agent', kind: 'known', color: '#7c5cff' };

describe('find_and_replace — replaceAll over HTTP', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'feedback-far-bulk-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function j<T>(res: Response): Promise<T> {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  }

  async function makeDoc(docId: string, md: string): Promise<string> {
    const file = join(dataDir, `${docId}.md`);
    writeFileSync(file, md);
    await j(
      await fetch(`${base}/api/docs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId, type: 'markdown', sourceUrl: file }),
      }),
    );
    return file;
  }

  it('replaceAll:true replaces every occurrence and reports the count', async () => {
    await makeDoc(
      'far-bulk',
      'Pinned to sha1111aaaa.\n\nBuild sha1111aaaa, then verify sha1111aaaa again.\n',
    );
    const res = await j<{ ok: boolean; replaced: number }>(
      await fetch(`${base}/api/docs/far-bulk/find_and_replace`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ find: 'sha1111aaaa', replace: 'sha2222bbbb', replaceAll: true }),
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.replaced).toBe(3);

    const doc = await j<{ plainText: string }>(await fetch(`${base}/api/docs/far-bulk/content`));
    expect(doc.plainText).not.toContain('sha1111aaaa');
    expect(doc.plainText).toContain('sha2222bbbb, then verify sha2222bbbb');
  });

  it('without replaceAll, a repeated find still answers 409 ambiguous (old behavior intact)', async () => {
    await makeDoc('far-ambig', 'tok here.\n\ntok there.\n');
    const res = await fetch(`${base}/api/docs/far-ambig/find_and_replace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ find: 'tok', replace: 'x' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('ambiguous');
  });

  it('suggest:true + replaceAll:true is refused with 400 — one proposal per span is the suggestion model', async () => {
    await makeDoc('far-suggest', 'tok here.\n\ntok there.\n');
    const res = await fetch(`${base}/api/docs/far-suggest/find_and_replace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ find: 'tok', replace: 'x', replaceAll: true, suggest: true, author }),
    });
    expect(res.status).toBe(400);
    // And no suggestion was created.
    const list = await j<{ suggestions: unknown[] }>(
      await fetch(`${base}/api/docs/far-suggest/suggestions`),
    );
    expect(list.suggestions).toHaveLength(0);
  });

  it('occurrence + replaceAll answers 409 replace-all-with-occurrence', async () => {
    await makeDoc('far-occ', 'tok tok tok.\n');
    const res = await fetch(`${base}/api/docs/far-occ/find_and_replace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ find: 'tok', replace: 'x', replaceAll: true, occurrence: 2 }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('replace-all-with-occurrence');
  });
});
