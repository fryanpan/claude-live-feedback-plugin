/**
 * GET /api/docs resolves every row's board from ONE pass over the workspaces.
 *
 * It used to take two per row. `withReviewUrl` → `resolveWorkspaceForDoc` →
 * `backTargetFor` called `hubWorkspacesHolding` twice for every doc, and each
 * call ran `listWorkspaces().filter(w => w.docIds.includes(id))` — a fresh
 * array of every board, then a linear scan of its docIds. Quadratic in the
 * doc count, and paid in full by the docs no board holds, which once a server
 * accumulates diff-review members is most of them.
 *
 * That is worse than a slow endpoint. Bun runs JS on one thread, so a listing
 * that takes tens of seconds is tens of seconds in which the server answers
 * nothing else at all. The process stays alive and stays bound throughout, so
 * a supervisor sees a healthy server — including the bind-health watchdog,
 * which asks whether the port is listening and never whether it answers.
 *
 * The invariant is asserted by COUNTING the passes rather than by timing the
 * request. A wall-clock budget would encode this machine's speed and would go
 * red on a loaded CI box for a reason that has nothing to do with the bug;
 * the number of times a listing re-reads the workspace set is the thing that
 * must not scale with the number of rows.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { TaskStore } from '../src/tasks.ts';

interface DocMetaOut {
  docId: string;
  reviewUrl?: string;
}

/** How many docs the fixture creates. Large enough that a per-row pass is
 *  unmistakable against the ceiling below, small enough to stay quick. */
const DOC_COUNT = 30;

describe('GET /api/docs does not re-list the workspaces per row', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let listCalls = 0;
  const mintedIds: string[] = [];

  const realListWorkspaces = TaskStore.prototype.listWorkspaces;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  beforeAll(async () => {
    // Count every pass over the workspace set, wherever it is made from.
    // Patching the prototype rather than injecting a double keeps the server
    // under test assembled exactly as production assembles it.
    TaskStore.prototype.listWorkspaces = function countedListWorkspaces(
      this: TaskStore,
    ): ReturnType<typeof realListWorkspaces> {
      listCalls += 1;
      return realListWorkspaces.call(this);
    };

    dataDir = mkdtempSync(join(tmpdir(), 'list-docs-linear-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;

    // A board exists, so the workspace set is non-empty and a pass over it
    // costs something. None of the docs are attached to it — which is the
    // production shape: the docs that dominate the listing are diff-review
    // members no board holds, and they are the rows that used to pay for
    // BOTH lookups, the docId one and the review-id fallback.
    const ws = await local('/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Board holding nothing' }),
    });
    expect(ws.status).toBe(200);

    for (let i = 0; i < DOC_COUNT; i += 1) {
      const name = `linear-doc-${i}`;
      const path = join(dataDir, `${name}.md`);
      writeFileSync(path, `# ${name}\n\nBody.\n`);
      const r = await local('/api/docs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: name, type: 'markdown', sourceUrl: path }),
      });
      expect(r.status).toBe(200);
      mintedIds.push(((await r.json()) as { docId: string }).docId);
    }
  });

  afterAll(() => {
    TaskStore.prototype.listWorkspaces = realListWorkspaces;
    handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('reads the workspace set a bounded number of times, not once per row', async () => {
    listCalls = 0;
    const r = await local('/api/docs');
    expect(r.status).toBe(200);
    const docs = ((await r.json()) as { docs: DocMetaOut[] }).docs;

    // Positive control: the listing really did carry every row, so a low
    // call count below is a claim about the lookup and not about an empty
    // answer. This is the check that would have caught a "fix" that made
    // the route cheap by making it wrong.
    expect(docs.length).toBeGreaterThanOrEqual(DOC_COUNT);

    // The ceiling is a small constant, deliberately loose: the point is that
    // it does not TRACK the row count. The old code made two passes per row,
    // so this fixture drove it past 60.
    expect(listCalls).toBeLessThanOrEqual(8);
  });

  it('resolves the same reviewUrl the single-doc route resolves', async () => {
    // The batched lookup must not be a second, subtly different answer to the
    // question `GET /api/docs/<id>` already answers. Equivalence is the whole
    // safety argument for replacing the per-row path.
    const listed = ((await (await local('/api/docs')).json()) as { docs: DocMetaOut[] }).docs;
    const byId = new Map(listed.map((d) => [d.docId, d.reviewUrl]));

    for (const id of mintedIds) {
      const one = await local(`/api/docs/${encodeURIComponent(id)}`);
      expect(one.status).toBe(200);
      const meta = ((await one.json()) as { meta: DocMetaOut }).meta;
      expect(byId.get(id)).toBe(meta.reviewUrl);
    }
  });
});
