/**
 * The Unfiled board cannot be shared.
 *
 * Decided on the board (answer: refuse): sharing the Unfiled board is
 * refused outright. Every review created without naming a board
 * lands on the ONE shared Unfiled board — so sharing it would share every
 * stray review from every agent with whoever holds the link. Boards became
 * the only shareable unit in the grouping removal (see
 * `grouping-share-removed.test.ts`); this closes the one board whose
 * contents nobody curated.
 *
 * The refusal covers MINTING only — both mint routes, since they differ
 * only in how a visitor is authorized, never in what may be shared. A share
 * of Unfiled already on disk (there should be none) is deliberately out of
 * scope here.
 *
 * The predicate is the board's NAME, because that is how the server itself
 * identifies the default board: `defaultHubWorkspaceId()` finds it by
 * `name === 'Unfiled'` on every call — the id is never cached, and a fresh
 * data dir has a fresh id. Any board answering to that lookup can receive
 * stray reviews, so any board answering to it is refused.
 *
 * Every refusal below pairs with a positive control on the same server — a
 * server that refused everything would otherwise pass this whole file.
 *
 * All fixtures are synthetic — invented names in the partner.example
 * register. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { CfAccessApp, CfAccessPolicy } from '../src/share/cf-api.ts';
import { CfApi } from '../src/share/cf-api.ts';
import type { Share } from '../src/share/types.ts';

const PUBLIC_HOST = 'feedback.example.test';
const BASE_HOST = 'example.test';

/** Cloudflare Access, faked. Only the two calls `create()` makes. */
function makeMockCfApi(state: { apps: CfAccessApp[]; policies: CfAccessPolicy[] }) {
  // biome-ignore lint/suspicious/noExplicitAny: Bun fetch type compatibility
  const fetchImpl: any = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    if (method === 'POST' && url.endsWith('/access/apps')) {
      const body = JSON.parse(init?.body as string);
      const app: CfAccessApp = {
        id: `app-${state.apps.length + 1}`,
        name: body.name,
        domain: body.domain,
        aud: `aud-${state.apps.length + 1}`,
        session_duration: body.session_duration,
      };
      state.apps.push(app);
      return new Response(JSON.stringify({ success: true, result: app }), { status: 200 });
    }
    const policyMatch = url.match(/access\/apps\/([^/]+)\/policies$/);
    if (method === 'POST' && policyMatch) {
      const body = JSON.parse(init?.body as string);
      const policy: CfAccessPolicy = {
        id: `policy-${state.policies.length + 1}`,
        name: body.name,
        decision: body.decision,
      };
      state.policies.push(policy);
      return new Response(JSON.stringify({ success: true, result: policy }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 });
  };
  return new CfApi({ accountId: 'acct', token: 'tok', fetchImpl });
}

describe('the Unfiled board cannot be shared', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let folder: string;

  /** The default hub board — where a bind that names no board lands. */
  let unfiledBoardId: string;
  /** A real, named board — the positive control. */
  let boardId: string;

  const local = (path: string, body: unknown, method = 'POST') =>
    fetch(`http://localhost:${handle.port}${path}`, {
      method,
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'unfiled-share-data-'));
    folder = mkdtempSync(join(tmpdir(), 'unfiled-share-folder-'));
    writeFileSync(join(folder, 'README.md'), '# Entry\n\nThe bind entry.\n');

    handle = createServer({
      port: 0,
      dataDir,
      share: {
        config: { publicHostname: PUBLIC_HOST, baseHostname: BASE_HOST, cfAccountId: 'acct' },
        cfApi: makeMockCfApi({ apps: [], policies: [] }),
        cfApiToken: 'tok',
      },
    });

    // A real board, made the way create_workspace makes one.
    const board = await local('/api/workspaces', { name: 'Partner review' });
    expect(board.status).toBe(200);
    boardId = ((await board.json()) as { workspace: { id: string } }).workspace.id;
    expect(boardId).toBeTruthy();

    // A bind that names NO board — exactly the stray this refusal protects.
    // The response says where it landed: the Unfiled board.
    const bind = await local('/api/workspaces', { folderPath: folder });
    expect(bind.status).toBe(200);
    unfiledBoardId = ((await bind.json()) as { hubWorkspaceId: string }).hubWorkspaceId;
    expect(unfiledBoardId).toBeTruthy();
    expect(unfiledBoardId).not.toBe(boardId);
  });

  afterEach(async () => {
    await handle.stop();
    for (const d of [dataDir, folder]) rmSync(d, { recursive: true, force: true });
  });

  it('refuses share_link for the Unfiled board, while a named board mints', async () => {
    const refused = await local('/api/share/link', {
      workspaceId: unfiledBoardId,
      label: 'everything anyone ever bound',
    });
    expect(refused.status).toBe(403);
    const body = (await refused.json()) as { error: string; hint: string };
    expect(body.error).toBe('unfiled_board_not_shareable');
    // The refusal has to name the fix, or it reads as a broken server.
    expect(body.hint).toContain('file the review on a real board first');
    expect(body.hint).toContain('share that board');
    expect(body.hint).toContain('hubWorkspaceId');

    // Positive control, same server, same route: the named board mints.
    const minted = await local('/api/share/link', { workspaceId: boardId });
    expect(minted.status).toBe(200);
    expect(((await minted.json()) as { share: Share }).share.workspaceId).toBe(boardId);
  });

  it('refuses share_workspace (Access mode) the same way — the modes differ only in visitor auth', async () => {
    const refused = await local('/api/share/workspace', {
      workspaceId: unfiledBoardId,
      allowDomains: ['@partner.example'],
    });
    expect(refused.status).toBe(403);
    const body = (await refused.json()) as { error: string; hint: string };
    expect(body.error).toBe('unfiled_board_not_shareable');
    expect(body.hint).toContain('file the review on a real board first');

    // Positive control: the named board, through the same Cloudflare path.
    const minted = await local('/api/share/workspace', {
      workspaceId: boardId,
      allowDomains: ['@partner.example'],
    });
    expect(minted.status).toBe(200);
    expect(((await minted.json()) as { share: Share }).share.workspaceId).toBe(boardId);
  });

  it('refuses by NAME, so a fresh restart cannot mint a share of a re-created Unfiled', async () => {
    // The server finds the default board by name on every call — the id is
    // never cached, so the refusal must key on the same thing the lookup
    // does. A board a user deliberately names "Unfiled" answers that lookup
    // too (strays would land on it), so it is refused as well.
    const named = await local('/api/workspaces', { name: 'Unfiled' });
    // Whatever the create route thinks of a duplicate name, the share must
    // refuse any id whose board answers to the Unfiled lookup.
    if (named.status === 200) {
      const id = ((await named.json()) as { workspace: { id: string } }).workspace.id;
      const res = await local('/api/share/link', { workspaceId: id });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe('unfiled_board_not_shareable');
    }

    // And an id that exists as nothing still 404s — the refusal is for the
    // Unfiled board, not a new answer for every unrecognised id.
    const unknown = await local('/api/share/link', { workspaceId: 'no-such-workspace' });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: string }).error).toBe('workspace not found');
  });
});
