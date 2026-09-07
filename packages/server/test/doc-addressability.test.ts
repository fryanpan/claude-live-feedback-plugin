/**
 * A document that holds content must have an address.
 *
 * 46 live documents on prod are addressable by no URL at all. The diagnosis
 * (2026-09-06) found no live leak — 36 of them pre-date boards entirely and
 * 10 are the fallout of two boards removed by hand — but nothing in the suite
 * would have NOTICED a leak, which is the reason those 46 accumulated in
 * silence for three months rather than reddening a build the first week.
 *
 * So this file is the alarm rather than a fix. It drives the ways a document
 * is born on a board, then asks the server for every live document's address
 * and fails on any that holds content and has none.
 *
 * "Address" is the server's own answer, not a rule restated here: the board
 * listing decorates each row with `reviewUrl`, which `withReviewUrl` mints
 * from the board holding the doc and omits when no board does. Asking the
 * routes rather than the membership helpers is deliberate — a helper that
 * agreed with a broken listing would let this pass while the doc stayed
 * unreachable in a browser.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

/**
 * The doc kinds the server holds content FOR.
 *
 * A mockup or dev-server doc is a comment surface over something hosted
 * elsewhere; losing its board loses no writing. Markdown, code and diff docs
 * carry the text itself, so an unreachable one is content nobody can open —
 * which is exactly the loss the 10 stranded documents took.
 */
const HOLDS_CONTENT = new Set(['markdown', 'code', 'diff']);

describe('every live document that holds content has an address', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let srcDir: string;
  let base: string;
  let ws = '';
  let markdownDoc = '';

  const headers = () => ({
    'content-type': 'application/json',
    host: `localhost:${handle.port}`,
  });

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });

  /**
   * Every live content-holding document the server will not give a URL for.
   *
   * Built the way a person would have to: ask each board what it lists, keep
   * the ids that came back with a `reviewUrl`, and subtract them from every
   * live document the store actually holds. A document filed nowhere appears
   * in no board's listing, so it survives the subtraction — which is the
   * whole failure this file is here to catch.
   */
  const unaddressable = async (): Promise<string[]> => {
    const addressed = new Set<string>();
    for (const board of handle.tasks.listWorkspaces()) {
      const res = await fetch(`${base}/workspaces/${board.id}/docs`, { headers: headers() });
      if (!res.ok) continue;
      const rows = ((await res.json()) as { docs?: Array<{ docId: string; reviewUrl?: string }> })
        .docs;
      for (const row of rows ?? []) {
        if (typeof row.reviewUrl === 'string') addressed.add(row.docId);
      }
    }
    return handle.docStore
      .list()
      .filter((meta) => HOLDS_CONTENT.has(meta.type))
      .map((meta) => meta.docId)
      .filter((docId) => !addressed.has(docId))
      .sort();
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'doc-address-'));
    srcDir = mkdtempSync(join(tmpdir(), 'doc-address-src-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;

    const wsRes = await post('/workspaces', { name: 'addresses', goal: 'Hold every doc.' });
    ws = ((await wsRes.json()) as { workspace: { id: string } }).workspace.id;

    // 1. A markdown doc bound to a file — the only creation path for one.
    const md = join(srcDir, 'notes.md');
    writeFileSync(md, '# Notes\n\nSomething worth keeping.\n');
    const mdRes = await post(`/workspaces/${ws}/docs`, {
      docId: 'address-notes',
      type: 'markdown',
      sourceUrl: md,
    });
    expect(mdRes.status).toBe(200);
    // The caller NAMES a doc; the server decides its id. Reading the id back
    // rather than assuming the name is the id is what keeps the detach below
    // addressing the same document the listing does.
    markdownDoc = ((await mdRes.json()) as { docId: string }).docId;

    // 2. A mockup, which holds no content of its own. It is here so the
    //    kind filter is exercised rather than assumed: if `HOLDS_CONTENT`
    //    ever swallowed everything, the assertion below would pass on a
    //    server that addressed nothing at all.
    const mock = join(srcDir, 'preview.html');
    writeFileSync(mock, '<h1>A surface to comment on</h1>\n');
    const mockRes = await post(`/workspaces/${ws}/docs`, {
      docId: 'address-mockup',
      type: 'mockup',
      sourceUrl: mock,
    });
    expect(mockRes.status).toBe(200);

    // 3. A task, whose body document the projection creates for it. Nobody
    //    asks for this one, which is what makes it worth covering.
    const taskRes = await post(`/workspaces/${ws}/tasks`, {
      title: 'A row with a body',
      goal: 'chores',
      assignee: 'human',
    });
    expect(taskRes.status).toBe(200);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  it('the fixture really did create content-holding documents', async () => {
    // The positive control for the test below, which would otherwise pass
    // just as happily on a server holding nothing. It also pins the
    // subtraction's other side: these ids have to be IN the listing.
    const held = handle.docStore
      .list()
      .filter((meta) => HOLDS_CONTENT.has(meta.type))
      .map((meta) => meta.docId);
    expect(held).toContain(markdownDoc);
    expect(held.length).toBeGreaterThan(1);
  });

  it('no document holds content while having no address', async () => {
    expect(await unaddressable()).toEqual([]);
  });

  it('the address is a real URL under the board that holds the doc', async () => {
    // What this does NOT do is fetch it. A doc address is a client route, and
    // a test server has no built client bundle to serve one from, so every
    // such URL 404s here whether or not it is right — a fetch would be a
    // control that cannot fail. What is checkable is the shape the cutover
    // fixed on: the board in the path, the doc under it.
    const res = await fetch(`${base}/workspaces/${ws}/docs`, { headers: headers() });
    const rows = ((await res.json()) as { docs: Array<{ docId: string; reviewUrl?: string }> })
      .docs;
    const url = rows.find((row) => row.docId === markdownDoc)?.reviewUrl;
    expect(url).toBeDefined();
    expect(new URL(String(url)).pathname).toBe(`/workspaces/${ws}/docs/${markdownDoc}`);
  });

  it('NEGATIVE CONTROL: a document whose board lets go of it is reported', async () => {
    // The shape of the real incident, minus the hand-moved folder: the
    // document stays live and keeps its content, and the only thing it loses
    // is the board that gave it a URL. Runs last because it leaves the
    // fixture stranded on purpose.
    expect(handle.tasks.detachDoc(ws, markdownDoc)).toEqual({ ok: true, removed: true });
    expect(handle.docStore.peekMeta(markdownDoc)).toBeDefined();
    expect(await unaddressable()).toEqual([markdownDoc]);
  });
});
