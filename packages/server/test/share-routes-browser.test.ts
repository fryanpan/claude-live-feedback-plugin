/**
 * The share MUTATION routes are for agents, not pages.
 *
 * `POST /api/share/link` and `/api/share/workspace` publish a whole board to
 * the internet; `POST /api/share/enabled` is the external-access master
 * switch and can RE-OPEN it after the operator closed it; the TTL and revoke
 * routes move a live credential's lifetime. Nothing in the browser apps calls
 * any of them — every real caller is the MCP tool layer or a script from the
 * box.
 *
 * Until this suite none of them could tell a page from an agent, which is the
 * same page-on-this-machine class `/api/deploy` closed with
 * `browser_cannot_operate`: the cross-origin write gate admits any
 * machine-local hostname on ANY port, and a local dev origin is same-site
 * with this server, so the operator's own session cookie rides along. The
 * routes' own "local-only" comments describe the HOST class, which is a
 * different question.
 *
 * Every refusal below is paired with the agent request that must still
 * succeed on the same route with the same body, and each one also asserts
 * that the refused call CHANGED NOTHING — a 403 on a route that was going to
 * fail anyway would prove nothing.
 *
 * Fixtures are synthetic. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type AccessHarness, accessHarness } from './access-share.ts';

interface ShareList {
  shares: Array<{ shareId: string }>;
  sharing: { enabled: boolean };
}

describe('share mutation routes refuse browser callers', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let folder: string;
  let base: string;
  let boardId: string;

  /** An agent: no Origin, no Sec-Fetch-* — nothing a page cannot suppress. */
  const agent = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        'content-type': 'application/json',
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  /** A page on another local port. The origin policy admits it. */
  const devServerPage = (): Record<string, string> => ({
    origin: 'http://localhost:5173',
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'cors',
  });
  /** The app's own origin — same-origin, the widest trust the policy has. */
  const samePage = (): Record<string, string> => ({
    origin: base,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
  });

  const page = (path: string, init: RequestInit = {}, headers = devServerPage()) =>
    agent(path, { ...init, headers: { ...headers, ...((init.headers as object) ?? {}) } });

  const post = (path: string, body: unknown) =>
    agent(path, { method: 'POST', body: JSON.stringify(body) });

  const state = async (): Promise<ShareList> =>
    (await agent('/api/share').then((r) => r.json())) as ShareList;

  const expectRefused = async (r: Response) => {
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toBe('browser_cannot_operate');
  };

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'share-browser-data-'));
    folder = mkdtempSync(join(tmpdir(), 'share-browser-src-'));
    writeFileSync(join(folder, 'note.md'), '# Note\n\nbody\n');

    const access: AccessHarness = await accessHarness();
    handle = createServer({
      port: 0,
      dataDir,
      ...access.serverOptions,
      // The sign-in gate would refuse these browser POSTs FIRST, with a 401 —
      // which is not the state the hole has. The hole is a page running while
      // the operator IS signed in, and a session cookie is same-site with a
      // local origin. Off here, so what refuses is the operator gate alone.
      requireSignInToWrite: false,
    });
    base = `http://localhost:${handle.port}`;

    boardId = (
      (await post('/workspaces', { name: 'Share board' }).then((r) => r.json())) as {
        workspace: { id: string };
      }
    ).workspace.id;
    expect(boardId).toBeTruthy();
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  describe('POST /api/share/link — minting a public link', () => {
    it('positive control: an agent mints one', async () => {
      const r = await post('/api/share/link', {
        allowDomains: ['@partner.example'],
        workspaceId: boardId,
      });
      expect(r.status).toBe(200);
      expect((await state()).shares).toHaveLength(1);
    });

    it('a page on another local port cannot mint, and mints nothing', async () => {
      await expectRefused(
        await page('/api/share/link', {
          method: 'POST',
          body: JSON.stringify({ workspaceId: boardId }),
        }),
      );
      expect((await state()).shares).toHaveLength(0);
    });

    it('nor can a same-origin page — the board never publishes itself', async () => {
      await expectRefused(
        await page(
          '/api/share/link',
          { method: 'POST', body: JSON.stringify({ workspaceId: boardId }) },
          samePage(),
        ),
      );
      expect((await state()).shares).toHaveLength(0);
    });
  });

  describe('POST /api/share/workspace — minting an Access share', () => {
    /**
     * This route provisions a Cloudflare Access application, so an agent
     * cannot reach 200 in a test without a real Cloudflare token — it fails
     * at the edge call with a 502. That still makes it a control for what is
     * under test: the agent's request gets PAST the gate and into the
     * handler, where the page's never arrives. Asserting 200 here would test
     * the vendor, not the refusal.
     */
    it('positive control: an agent gets past the gate and into provisioning', async () => {
      const r = await post('/api/share/workspace', {
        workspaceId: boardId,
        allowDomains: ['example.com'],
      });
      expect(r.status).not.toBe(403);
      expect(await r.text()).not.toContain('browser_cannot_operate');
    });

    it('a page cannot, and mints nothing', async () => {
      await expectRefused(
        await page('/api/share/workspace', {
          method: 'POST',
          body: JSON.stringify({ workspaceId: boardId, allowDomains: ['example.com'] }),
        }),
      );
      expect((await state()).shares).toHaveLength(0);
    });
  });

  describe('POST /api/share/enabled — the external-access master switch', () => {
    it('positive control: an agent flips it off and back on', async () => {
      expect((await post('/api/share/enabled', { enabled: false })).status).toBe(200);
      expect((await state()).sharing.enabled).toBe(false);
      expect((await post('/api/share/enabled', { enabled: true })).status).toBe(200);
      expect((await state()).sharing.enabled).toBe(true);
    });

    it('a page cannot RE-OPEN external access the operator closed', async () => {
      expect((await post('/api/share/enabled', { enabled: false })).status).toBe(200);
      await expectRefused(
        await page('/api/share/enabled', {
          method: 'POST',
          body: JSON.stringify({ enabled: true }),
        }),
      );
      // The switch is the assertion: still closed.
      expect((await state()).sharing.enabled).toBe(false);
    });

    it('nor close it — a page must not reach the switch in either direction', async () => {
      await expectRefused(
        await page('/api/share/enabled', {
          method: 'POST',
          body: JSON.stringify({ enabled: false }),
        }),
      );
      expect((await state()).sharing.enabled).toBe(true);
    });
  });

  describe('the lifetime routes on an existing share', () => {
    const mint = async (): Promise<string> => {
      const r = await post('/api/share/link', {
        allowDomains: ['@partner.example'],
        workspaceId: boardId,
      });
      expect(r.status).toBe(200);
      return ((await r.json()) as { share: { shareId: string } }).share.shareId;
    };

    it('positive control: an agent changes a TTL and then revokes', async () => {
      const id = await mint();
      expect((await post(`/api/share/${id}/ttl`, { ttl: '1h' })).status).toBe(200);
      expect((await agent(`/api/share/${id}`, { method: 'DELETE' })).status).toBe(200);
      expect((await state()).shares).toHaveLength(0);
    });

    it('a page cannot extend a live share', async () => {
      const id = await mint();
      await expectRefused(
        await page(`/api/share/${id}/ttl`, { method: 'POST', body: JSON.stringify({ ttl: '1h' }) }),
      );
    });

    it('a page cannot revoke one either — the share survives', async () => {
      const id = await mint();
      await expectRefused(await page(`/api/share/${id}`, { method: 'DELETE' }));
      expect((await state()).shares).toHaveLength(1);
    });
  });

  describe('the guard is keyed on the ROUTE, so the read is refused too', () => {
    it('a page cannot read GET /api/share, and the agent still can', async () => {
      // This read used to be exempt, for a settings pane that does not exist:
      // nothing in the browser bundles fetches this route. What the exemption
      // handed a page on another local port was every link id — which is the
      // whole secret of a share URL — and every member's email address.
      await post('/api/share/link', { allowDomains: ['@partner.example'], workspaceId: boardId });
      await expectRefused(await page('/api/share', {}));
      // Positive control on the same route and the same body: the agent, who
      // is the only real caller, still reads it.
      const r = await agent('/api/share');
      expect(r.status).toBe(200);
      expect(((await r.json()) as ShareList).shares).toHaveLength(1);
    });
  });
});
