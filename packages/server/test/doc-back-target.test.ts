/**
 * "Back" from a doc should return to the BOARD that links it, not to the
 * machine-wide landing page.
 *
 * Reproduced on a running server before this existed: the review app's `←`
 * is a static `href="/"` in `packages/workspaces-app/index.html`, so opening
 * any doc from a board and tapping back lands on the list of everything on
 * the machine. The client cannot fix that alone — nothing in the page says
 * which board owns the doc, and `document.referrer` is empty for a URL that
 * arrived in a message. So the server answers it, on the payload the review
 * app already fetches before it mounts a surface.
 *
 * Two shapes have to resolve, and they are NOT the same lookup:
 *   - a plain doc is attached to the board by its own docId;
 *   - a diff review / folder browse goes on a board as ONE row, attached by
 *     its GROUPING id, so a member doc is never in `docIds` and a direct
 *     lookup answers null for every file in the review.
 *
 * Everything here goes through the real HTTP routes: the route layer
 * hand-copies fields and is the layer no unit test covers.
 *
 * All fixtures are synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type AccessHarness, accessHarness, mintAccessShare } from './access-share.ts';
import { seedBoard } from './workspace-seed.ts';

interface DocResponse {
  hubWorkspaceId?: string;
  backTo?: { workspaceId: string; name: string };
  meta: { workspaceId?: string; type?: string };
}

/** The board this file's docs, tasks and reviews are filed under. */
let WS = '';

describe('a doc knows which board to go back to', () => {
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
  const getDoc = async (docId: string): Promise<DocResponse> => {
    const r = await local(`/workspaces/${WS}/docs/${encodeURIComponent(docId)}?format=json`);
    expect(r.status).toBe(200);
    return (await r.json()) as DocResponse;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'doc-back-'));
    folder = mkdtempSync(join(tmpdir(), 'doc-back-src-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    WS = await seedBoard(base);
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

  it('names the board a plain doc is attached to, with the board name', async () => {
    const ws = await post('/workspaces', { name: 'search-revamp', goal: 'Ship search.' });
    const wsId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    WS = wsId;
    expect(
      (
        await post(`/workspaces/${wsId}/docs`, {
          docId: 'doc-on-a-board',
          type: 'markdown',
          sourceUrl: mdFile('on-a-board.md'),
          hubWorkspaceId: wsId,
        })
      ).status,
    ).toBe(200);

    const body = await getDoc('doc-on-a-board');
    expect(body.backTo?.workspaceId).toBe(wsId);
    // The NAME travels too: the arrow is icon-only on a phone, so the
    // destination can only be spoken in its label.
    expect(body.backTo?.name).toBe('search-revamp');
  });

  it('names the board holding the REVIEW for a member of one', async () => {
    // Assert the shape before the behaviour: a review is filed as one row by
    // its grouping id, so the member doc is NOT in the board's docIds and a
    // direct lookup cannot find it. Without this the assertion below would
    // pass against a resolver that only ever does the direct lookup, on a
    // server that happened to file members individually.
    writeFileSync(join(folder, 'README.md'), '# Fixture\n\nbody\n');
    mkdirSync(join(folder, 'src'));
    writeFileSync(join(folder, 'src', 'util.ts'), 'export const y = 2;\n');

    const ws = await post('/workspaces', { name: 'review-home', goal: 'Review it.' });
    const boardId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    WS = boardId;

    const bound = await post(`/workspaces/${boardId}/reviews`, {
      repo: folder,
      hubWorkspaceId: boardId,
    });
    expect(bound.status).toBe(200);
    const res = (await bound.json()) as {
      reviewId: string;
      hubWorkspaceId: string;
      files: Array<{ docId: string }>;
    };
    const memberDocId = res.files[0]?.docId as string;
    expect(memberDocId).toBeTruthy();
    expect(res.reviewId).toBeTruthy();
    expect(res.hubWorkspaceId).toBe(boardId);

    const board = await local(`/workspaces/${boardId}?format=json`);
    const docIds = ((await board.json()) as { workspace: { docIds: string[] } }).workspace.docIds;
    expect(docIds).toContain(res.reviewId); // the grouping IS the row
    expect(docIds).not.toContain(memberDocId); // the member is not

    const body = await getDoc(memberDocId);
    // The premise of the whole fallback, measured rather than assumed.
    expect(body.hubWorkspaceId).toBeUndefined();
    expect(body.meta.workspaceId).toBe(res.reviewId);
    // …and the back target resolves through the grouping anyway.
    expect(body.backTo?.workspaceId).toBe(boardId);
    expect(body.backTo?.name).toBe('review-home');
  });

  it("names a task body's own board", async () => {
    const ws = await post('/workspaces', { name: 'task-home', goal: 'Do the work.' });
    const wsId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    WS = wsId;
    const t = await post(`/workspaces/${wsId}/tasks`, {
      title: 'Agent can read the body so that the work is unambiguous',
      author: { id: 'person-1', name: 'Reviewer', kind: 'known' },
      body: 'Body prose.',
    });
    expect(t.status).toBe(200);
    const taskId = ((await t.json()) as { task: { id: string } }).task.id;

    const body = await getDoc(`task:${taskId}`);
    expect(body.backTo?.workspaceId).toBe(wsId);
    expect(body.backTo?.name).toBe('task-home');
  });
});

/**
 * A board id is an unguessable URL capability. `hubWorkspaceId` is owner-only
 * on this route for exactly that reason, and the back target has to obey the
 * same rule or it becomes a second door onto the id the first one closed.
 */
describe('the back target is not handed to a share visitor', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let boardId: string;
  let visitorHeaders: Record<string, string>;
  let access: AccessHarness;
  /** The id the server minted for the doc posted as `shared-doc` — the name
   *  is an alias, and every URL the server emits carries the minted id. */
  let sharedId: string;

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
  const pub = (path: string) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      headers: { ...visitorHeaders },
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'doc-back-share-'));
    access = await accessHarness();
    handle = createServer({
      port: 0,
      dataDir,
      ...access.serverOptions,
    });
    base = `http://localhost:${handle.port}`;
    WS = await seedBoard(base);

    const p = join(dataDir, 'shared.md');
    writeFileSync(p, '# Shared\n\nBody.\n');
    const createdShared = await post(`/workspaces/${WS}/docs`, {
      docId: 'shared-doc',
      type: 'markdown',
      sourceUrl: p,
    });
    expect(createdShared.status).toBe(200);
    sharedId = ((await createdShared.json()) as { docId: string }).docId;

    const ws = await post('/workspaces', { name: 'shared-board', goal: 'Ship it.' });
    boardId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    WS = boardId;
    expect((await post(`/workspaces/${boardId}/docs:attach`, { docId: 'shared-doc' })).status).toBe(
      200,
    );

    visitorHeaders = (await mintAccessShare(base, access, boardId, { label: 'a share' })).headers;
  });

  afterAll(() => {
    handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('gives the owner the board id and the visitor none of it', async () => {
    // Presence, on the same doc in the same pass: without this, the
    // `undefined` below is equally consistent with a resolver that never
    // resolves anything for anybody.
    // Addressed by the readable name on purpose: the owner's half of the
    // alias contract, answered by the same doc the visitor reads below.
    const owner = (await (await local(`/workspaces/${WS}/docs/shared-doc?format=json`)).json()) as {
      meta?: { docId: string };
      backTo?: { workspaceId: string };
    };
    expect(owner.meta?.docId).toBe(sharedId);
    expect(owner.backTo?.workspaceId).toBe(boardId);

    // The canonical id for the visitor: share scope is decided from the raw
    // path segment against the board's membership, which holds minted ids.
    const seen = await pub(`/workspaces/${WS}/docs/${sharedId}?format=json`);
    expect(seen.status).toBe(200); // the visitor really can read this doc
    const visitor = (await seen.json()) as {
      meta?: unknown;
      backTo?: { workspaceId: string };
    };
    expect(visitor.meta).toBeDefined(); // …and really got the payload
    expect(visitor.backTo).toBeUndefined();
  });

  it('never names a board the visitor was not shared', async () => {
    // The sharper form of "no board ids for visitors", and the one that
    // survives docs being addressed under a workspace. A visitor's own board
    // id is not a secret from them — they are standing on `/workspaces/<it>`,
    // having been redirected there by the share link they redeemed — so a
    // reviewUrl carrying it discloses nothing. A SECOND board holding the
    // same doc is a different matter: nobody shared it, its id is an
    // unguessable capability, and it is exactly what a resolver that answers
    // "the first workspace holding this doc" would hand over.
    const other = await post('/workspaces', { name: 'other-board', goal: 'Not shared.' });
    const otherId = ((await other.json()) as { workspace: { id: string } }).workspace.id;
    expect((await post(`/workspaces/${otherId}/docs:attach`, { docId: 'shared-doc' })).status).toBe(
      200,
    );

    // Read through the board the visitor WAS shared: the second board's id
    // must not appear in the payload of the address they legitimately hold.
    const body = await (await pub(`/workspaces/${boardId}/docs/${sharedId}?format=json`)).text();
    expect(body).not.toContain(otherId);
    // Control, same payload: the resolver IS producing workspace-addressed
    // URLs here, so the absence above is a refusal rather than a URL shape
    // that happens to carry no workspace id at all.
    expect(body).toContain(`/workspaces/${boardId}/docs/${sharedId}`);
  });
});
