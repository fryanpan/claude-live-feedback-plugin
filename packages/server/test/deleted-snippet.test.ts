import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { type ServerHandle, createServer } from '../src/server.ts';

/**
 * `deletedSnippet` round-trips through the REAL REST routes.
 *
 * The point of this test is the ROUTE, not the rooms method. `docs/process/
 * learnings.md` records how `groups` shipped broken: it was added to the MCP
 * tool schema and to bindDiff, but the route that fronts bindDiff never
 * forwarded it — the API returned ok:true and discarded the value, and unit
 * tests passed because they called the rooms method directly.
 *
 * A comment on struck-through text in the redline view has no position in
 * `content` (deleted text exists only on the base side), so its anchor snaps
 * to the nearest following retained line and carries `deletedSnippet` to
 * record what the comment was actually about. If the route drops it, the
 * comment silently reads as being about an unrelated surviving line — the
 * exact failure the field exists to prevent.
 *
 * Anchored against a `code` doc: like a diff doc it is a FLAT surface whose
 * content is the `content` Y.Text, so the anchor shape here is the one the
 * redline surface will actually produce.
 */
describe('deletedSnippet anchor hint (HTTP)', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let folder: string;
  let base: string;
  let docId: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'delsnip-data-'));
    folder = mkdtempSync(join(tmpdir(), 'delsnip-src-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;

    mkdirSync(join(folder, 'src'));
    writeFileSync(join(folder, 'README.md'), '# Project\n');
    writeFileSync(join(folder, 'src', 'index.ts'), 'export const answer = 42;\nconst x = 1;\n');

    const r = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderPath: folder, owner: '/cwd' }),
    });
    const bind = (await r.json()) as { ok: boolean; workspaceId: string };
    if (!bind.ok) throw new Error(`bind failed: ${JSON.stringify(bind)}`);

    // The bind is lazy — open the code file the way the all-files tree does.
    const cr = await fetch(
      `${base}/api/workspaces/${encodeURIComponent(bind.workspaceId)}/context-file`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relPath: 'src/index.ts' }),
      },
    );
    const opened = (await cr.json()) as { docId: string; meta: { type: string } };
    expect(opened.meta.type).toBe('code');
    docId = opened.docId;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  /** Build a text-range anchor over the doc's first line, exactly the way the
   *  flat surfaces do (CM offsets are byte-identical to `content` indices). */
  function anchorFirstLine(extra: Record<string, unknown> = {}) {
    const room = handle.rooms.get(docId);
    if (!room) throw new Error('room missing');
    const content = room.ydoc.getText('content');
    const source = content.toString();
    expect(source.length).toBeGreaterThan(0);
    const to = source.indexOf('\n') === -1 ? source.length : source.indexOf('\n');
    return {
      kind: 'text-range',
      startRel: Array.from(
        Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(content, 0)),
      ),
      endRel: Array.from(
        Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(content, to)),
      ),
      snippet: { text: source.slice(0, to) },
      ...extra,
    };
  }

  it('survives a round trip through the REST thread routes', async () => {
    const post = await fetch(`${base}/api/docs/${encodeURIComponent(docId)}/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author: { id: 'u1', name: 'Reviewer', kind: 'known', color: '#2e7dd7' },
        text: 'why did you cut this?',
        anchor: anchorFirstLine({ deletedSnippet: 'the removed words' }),
      }),
    });
    expect(post.ok, `${post.status} ${await post.clone().text()}`).toBe(true);
    const created = (await post.json()) as {
      thread: { id: string; anchor: { deletedSnippet?: string } };
    };
    // The create response must already carry it — a 200 that silently dropped
    // the field is exactly how the `groups` bug looked to its caller.
    expect(created.thread.anchor.deletedSnippet).toBe('the removed words');

    // And it must still be there when read back out of the CRDT via the route.
    const get = await fetch(`${base}/api/docs/${encodeURIComponent(docId)}/threads`);
    const listed = (await get.json()) as {
      threads: Array<{ id: string; anchor: { deletedSnippet?: string } }>;
    };
    const mine = listed.threads.find((t) => t.id === created.thread.id);
    expect(mine?.anchor.deletedSnippet).toBe('the removed words');
  });

  it('omits deletedSnippet on an ordinary comment', async () => {
    const post = await fetch(`${base}/api/docs/${encodeURIComponent(docId)}/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author: { id: 'u1', name: 'Reviewer', kind: 'known', color: '#2e7dd7' },
        text: 'ordinary comment',
        anchor: anchorFirstLine(),
      }),
    });
    const created = (await post.json()) as { thread: { anchor: { deletedSnippet?: string } } };
    expect(created.thread.anchor.deletedSnippet).toBeUndefined();
  });
});
