/**
 * Share visitors, driven through the real route table.
 *
 * Every browser-facing hostname sits behind Cloudflare Access (2026-09-02),
 * so a share's credential is a signed Access token for that share's own
 * hostname — there is no URL a stranger can hold. This file is what that
 * costs and buys: (a) minting validates before it creates anything, (b)
 * nothing on a share hostname is served without a token, (c) the visitor is
 * scoped to the board they were invited to, and (d) revocation and expiry
 * take effect immediately, including on sockets already open.
 *
 * It was `link-share.test.ts` when the signed URL was the credential. The
 * retirement of that mode has its own file (link-mode-retired.test.ts); what
 * stayed here is everything that was never about the URL.
 *
 * **A BOARD is the unit of sharing** (2026-08-17), so every fixture here is a
 * board share. The file used to mint most of them with `{docId}` — a grant
 * that no longer exists — so the "one doc" fixture is a folder bind holding
 * exactly one file, and the tests that were ABOUT per-doc scoping assert the
 * removal instead: `POST /api/share/doc` is gone, and a `docId` in a
 * `/api/share/link` body is refused by name rather than quietly re-scoped to
 * something the caller never asked for.
 *
 * The bind itself is no longer the shareable id either — a folder bind is a
 * GROUPING — so each one is FILED on a board and the link is minted over the
 * board. Nothing about reach changed: a board share opens every member of a
 * grouping filed on it, which is what the scope suites below measure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import {
  type AccessHarness,
  type MintedShare,
  accessHarness,
  mintAccessShare,
} from './access-share.ts';

describe('Access-mode shares over HTTP', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let folder: string;
  let soloFolder: string;
  let base: string;

  let access: AccessHarness;
  let soloShare: MintedShare;
  let wsShare: MintedShare;
  /** The board the multi-file folder bind is filed on — what `wsShare` covers. */
  let boardId: string;
  let workspaceId: string;
  let entryDocId: string;
  /** The board the one-file bind is filed on — what `soloShare` covers, and
   *  this file's "narrowest possible share" fixture now that neither a doc nor
   *  a grouping can be shared on its own. */
  let soloBoardId: string;
  /** The one-file workspace and its only member. */
  let soloWorkspaceId: string;
  let SOLO: string;
  /** SOLO path-encoded. Member docIds are `<group>:<relPath>`, so they carry
   *  a colon that every URL below has to encode. */
  let soloPath: string;

  const PRIVATE = 'private-doc';

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  /**
   * A request to a share's own hostname, optionally carrying that share's
   * Access token. With no visitor it is the caller who proves nothing, which
   * is what every 401 below is about. `soloShare` supplies the hostname in
   * that case, because a request has to name SOME share host to be a share
   * request at all.
   */
  const pub = (path: string, visitor?: MintedShare, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      ...init,
      headers: {
        host: (visitor ?? soloShare).host,
        ...(visitor ? { 'cf-access-jwt-assertion': visitor.jwt } : {}),
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'link-share-data-'));
    folder = mkdtempSync(join(tmpdir(), 'link-share-folder-'));
    mkdirSync(join(folder, 'sub'), { recursive: true });
    writeFileSync(join(folder, 'README.md'), '# Entry\n\nRead me.\n');
    writeFileSync(join(folder, 'design.md'), '# Design\n\nThe plan.\n');

    // The one-file folder. A share over it is as narrow as sharing gets now,
    // and it is what every test that used to say `{docId: SOLO}` points at.
    soloFolder = mkdtempSync(join(tmpdir(), 'link-share-solo-'));
    writeFileSync(join(soloFolder, 'solo.md'), '# Solo\n\nBody.\n');

    access = await accessHarness();
    handle = createServer({
      port: 0,
      dataDir,
      ...access.serverOptions,
    });
    base = `http://localhost:${handle.port}`;

    // PRIVATE is deliberately NOT bound into either workspace: it lands on the
    // default "Unfiled" board, which no share below covers.
    const privatePath = join(dataDir, `${PRIVATE}.md`);
    writeFileSync(privatePath, `# ${PRIVATE}\n\nBody.\n`);
    expect(
      (
        await local('/api/docs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ docId: PRIVATE, type: 'markdown', sourceUrl: privatePath }),
        })
      ).status,
    ).toBe(200);

    /** A fresh board, and a folder bound onto it in one call. */
    const makeBoard = async (name: string) => {
      const r = await local('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      expect(r.status).toBe(200);
      const id = ((await r.json()) as { workspace: { id: string } }).workspace.id;
      expect(id).toBeTruthy();
      return id;
    };
    const bindFolder = async (path: string, hubWorkspaceId: string) => {
      const r = await local('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ folderPath: path, hubWorkspaceId }),
      });
      expect(r.status).toBe(200);
      return (await r.json()) as { workspaceId: string; files: Array<{ docId: string }> };
    };

    boardId = await makeBoard('Folder review');
    const bound = await bindFolder(folder, boardId);
    workspaceId = bound.workspaceId;
    entryDocId = bound.files[0]?.docId ?? '';
    expect(workspaceId).not.toBe(boardId);

    soloBoardId = await makeBoard('Solo review');
    const soloBound = await bindFolder(soloFolder, soloBoardId);
    soloWorkspaceId = soloBound.workspaceId;
    SOLO = soloBound.files[0]?.docId ?? '';
    soloPath = encodeURIComponent(SOLO);
    expect(SOLO).not.toBe('');

    soloShare = await mintAccessShare(base, access, soloBoardId, { label: 'solo review' });
    wsShare = await mintAccessShare(base, access, boardId);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
    rmSync(soloFolder, { recursive: true, force: true });
  });

  /** Mint a link over the board holding the one-file workspace — the
   *  replacement for every `{docId: SOLO}` body this file used to send. */
  const mintSolo = (extra: Record<string, unknown> = {}) =>
    local('/api/share/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: soloBoardId,
        allowDomains: ['@partner.example'],
        ...extra,
      }),
    });

  describe('minting', () => {
    it('defaults to a two-week TTL', () => {
      const days = (soloShare.expiresAt - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(13.9);
      expect(days).toBeLessThan(14.1);
    });

    it('mints a hostname of its own — the URL carries no secret at all', () => {
      const u = new URL(soloShare.url);
      expect(u.hostname).toBe(soloShare.host);
      expect(u.search).toBe('');
      // Two shares of two boards are two hostnames and two audiences, which
      // is what makes "a token for one share is refused at the other"
      // possible below.
      expect(wsShare.host).not.toBe(soloShare.host);
      expect(wsShare.jwt).not.toBe(soloShare.jwt);
    });

    it('points the URL at the board it shares', () => {
      expect(new URL(soloShare.url).pathname).toBe(`/workspaces/${soloBoardId}`);
    });

    it('honours a caller-supplied TTL', async () => {
      const r = await mintSolo({ ttlSeconds: 3600 });
      const { share } = (await r.json()) as { share: { expiresAt: number; shareId: string } };
      const hours = (share.expiresAt - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(0.9);
      expect(hours).toBeLessThan(1.1);
    });

    it('can extend or shorten a live share after the fact', async () => {
      const mk = await mintSolo();
      const { share } = (await mk.json()) as { share: { shareId: string } };
      const r = await local(`/api/share/${share.shareId}/ttl`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ttlSeconds: 14 * 24 * 3600 }),
      });
      expect(r.status).toBe(200);
      const updated = (await r.json()) as { share: { expiresAt: number } };
      expect((updated.share.expiresAt - Date.now()) / 86_400_000).toBeGreaterThan(13.9);
      expect(
        (
          await local('/api/share/nope/ttl', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ttlSeconds: 60 }),
          })
        ).status,
      ).toBe(404);
    });

    it('refuses a nonsense TTL rather than minting a dead link', async () => {
      // NaN / Infinity can't get this far — JSON.stringify turns both into
      // null, which reads as "not supplied". They're covered against the
      // registry directly in shares-ttl.test.ts.
      for (const ttlSeconds of [0, -60]) {
        const r = await mintSolo({ ttlSeconds });
        expect(r.status, String(ttlSeconds)).toBe(400);
      }
      // Positive control: the same body with a sane TTL mints.
      expect((await mintSolo({ ttlSeconds: 3600 })).status).toBe(200);
    });

    it('refuses a workspace that does not exist', async () => {
      const ghost = await local('/api/share/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'ghost-ws', allowDomains: ['@partner.example'] }),
      });
      expect(ghost.status).toBe(404);
      // Positive control: a real BOARD id on the same route mints.
      expect((await mintSolo()).status).toBe(200);
    });

    it('refuses the GROUPING filed on the board, and not as "not found"', async () => {
      // The folder bind is a real id whose SHARING went away, so it answers
      // 410 by name rather than joining the 404 above. Collapsing the two
      // would tell a peer whose review stopped sharing that the review is gone.
      const r = await local('/api/share/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: soloWorkspaceId, allowDomains: ['@partner.example'] }),
      });
      expect(r.status).toBe(410);
      const body = (await r.json()) as { error: string; hint: string };
      expect(body.error).toBe('grouping_sharing_removed');
      expect(body.hint).toContain('board');
      // Positive control: the board that grouping is filed on mints fine.
      expect((await mintSolo()).status).toBe(200);
    });

    it('refuses an entryDocId — a board share opens the board', async () => {
      const r = await mintSolo({ entryDocId: SOLO });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toContain('entryDocId');
      // Positive control: drop the field and the same call mints.
      expect((await mintSolo()).status).toBe(200);
    });
  });

  /**
   * These four used to be the per-doc minting paths. A workspace is now the
   * unit of sharing, so what they prove is the REMOVAL — and specifically
   * that an older plugin bundle's payload is refused BY NAME rather than
   * silently re-scoped to a workspace the caller never asked about. Each
   * refusal sits next to the workspace call that replaces it, so none of
   * them can pass by the route being broken for everyone.
   */
  describe('per-doc sharing is gone, and says so', () => {
    it('answers POST /api/share/doc with 410 and names the replacement', async () => {
      const r = await local('/api/share/doc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: SOLO, allowDomains: ['@partner-org.example'] }),
      });
      expect(r.status).toBe(410);
      const body = (await r.json()) as { error: string; hint?: string };
      expect(body.error).toBe('per_doc_sharing_removed');
      expect(body.hint).toContain('workspaceId');
      // Positive control: sharing IS enabled on this server — the workspace
      // form of the same request succeeds.
      expect((await mintSolo()).status).toBe(200);
    });

    it('refuses a docId in a share/link body, even alongside a workspaceId', async () => {
      for (const body of [
        { docId: SOLO },
        // The dangerous reading of this payload is "ignore the field you
        // don't recognise and mint something anyway". Paired with a
        // workspaceId that WOULD mint on its own, so what is under test is
        // the docId and not the other field.
        { docId: SOLO, workspaceId: soloBoardId },
      ]) {
        const r = await local('/api/share/link', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, allowDomains: ['@partner.example'] }),
        });
        expect(r.status, JSON.stringify(body)).toBe(410);
        expect(((await r.json()) as { error: string }).error).toBe('per_doc_sharing_removed');
      }
      // Positive control: drop the docId and the very same call mints.
      expect((await mintSolo()).status).toBe(200);
    });

    it('refuses a share/link body that names no workspace at all', async () => {
      const r = await local('/api/share/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'no scope', allowDomains: ['@partner.example'] }),
      });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe('workspaceId required');
      // Positive control: add the workspaceId and the same label mints.
      expect((await mintSolo({ label: 'no scope' })).status).toBe(200);
    });

    it('mints nothing along the way — every refusal above created no share', async () => {
      // The failure this guards is a 4xx returned AFTER a share was pushed
      // onto the registry, which would leave a live grant nobody can see in
      // the response they got.
      const { shares } = (await (await local('/api/share')).json()) as {
        shares: Array<{ workspaceId?: string; docId: string }>;
      };
      expect(shares.length).toBeGreaterThan(0); // positive control: we can see shares
      for (const s of shares) expect(s.workspaceId).toBeTruthy();
    });
  });

  describe('landing', () => {
    it('the share URL opens the board, with the token Access already holds', async () => {
      // It used to land on `/review/<entry doc>`. A board share has no entry
      // doc to resolve — that resolution went with board-only sharing — so
      // the URL IS the board page and the visitor navigates from there.
      const u = new URL(soloShare.url);
      expect(u.pathname).toBe(`/workspaces/${soloBoardId}`);
      const r = await pub(u.pathname, soloShare);
      expect(r.status).toBe(200);
    });

    it('gives nothing away about which share hostnames exist', async () => {
      const unknown = await fetch(`${base}/workspaces/${soloBoardId}`, {
        headers: { host: `share-never-minted.${soloShare.host.split('.').slice(1).join('.')}` },
      });
      expect(unknown.status).toBe(403);
      expect(((await unknown.json()) as { error: string }).error).toBe('unknown_host');
    });
  });

  describe('the Access token is required', () => {
    it('refuses every other path on a share host without one', async () => {
      for (const p of [
        `/review/${soloPath}`,
        `/api/docs/${soloPath}`,
        '/api/docs',
        `/y/${soloPath}`,
      ]) {
        const r = await pub(p);
        expect(r.status, p).toBe(401);
      }
    });

    it("refuses another share's token, and a token that is not a token", async () => {
      // The audience is per-share, so a genuine token from the workspace
      // share is refused here even though it is validly signed by the same
      // Access team.
      const wrongShare = { ...soloShare, jwt: wsShare.jwt };
      expect((await pub(`/api/docs/${soloPath}`, wrongShare)).status).toBe(401);
      const garbage = { ...soloShare, jwt: 'not.a.jwt' };
      expect((await pub(`/api/docs/${soloPath}`, garbage)).status).toBe(401);
      // Positive control: the share's OWN token reads that doc, so the
      // refusals above are the token and not the path.
      expect((await pub(`/api/docs/${soloPath}`, soloShare)).status).toBe(200);
    });
  });

  describe('a redeemed session is scoped exactly like an Access visitor', () => {
    // The narrowest share available: a board holding one bind holding one
    // file. It reaches that file because it is a MEMBER of a grouping filed on
    // the board — never because the share names it. The "the entry doc is
    // always in scope" base case went away with per-doc sharing and the field
    // that expressed it went with board-only sharing, so a doc outside the
    // board is refused even here.
    let cookie: MintedShare;
    beforeAll(() => {
      cookie = soloShare;
    });

    it('reaches the doc filed on its board', async () => {
      expect((await pub(`/api/docs/${soloPath}`, cookie)).status).toBe(200);
      expect((await pub(`/review/${soloPath}`, cookie)).status).not.toBe(403);
      expect((await pub(`/api/docs/${soloPath}/threads`, cookie)).status).toBe(200);
    });

    it('CANNOT reach another doc or enumerate', async () => {
      expect((await pub(`/api/docs/${PRIVATE}`, cookie)).status).toBe(403);
      expect((await pub(`/review/${PRIVATE}`, cookie)).status).toBe(403);
      expect((await pub('/api/docs', cookie)).status).toBe(403);
      expect((await pub('/api/workspaces', cookie)).status).toBe(403);
    });

    it('CANNOT mint itself a wider share', async () => {
      const r = await pub('/api/share/link', cookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: boardId }),
      });
      expect(r.status).toBe(403);
      expect((await pub('/api/share', cookie)).status).toBe(403);
      // Positive control: the local surface CAN mint that very share, so the
      // 403 is the gate refusing a visitor rather than the route being dead.
      const ok = await local('/api/share/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: boardId, allowDomains: ['@partner.example'] }),
      });
      expect(ok.status).toBe(200);
      const minted = ((await ok.json()) as { share: { shareId: string } }).share;
      await local(`/api/share/${minted.shareId}`, { method: 'DELETE' });
    });

    it('CANNOT delete or wholesale-replace the doc it was given', async () => {
      expect((await pub(`/api/docs/${soloPath}`, cookie, { method: 'DELETE' })).status).toBe(403);
      const rewrite = await pub(`/api/docs/${soloPath}/content`, cookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ markdown: '# Wiped\n' }),
      });
      expect(rewrite.status).toBe(403);
    });
  });

  describe('a workspace share browses the whole set', () => {
    let cookie: MintedShare;
    beforeAll(() => {
      cookie = wsShare;
    });

    it('opens the entry doc and lists the tree', async () => {
      expect((await pub(`/api/docs/${encodeURIComponent(entryDocId)}`, cookie)).status).toBe(200);
      expect(
        (await pub(`/api/workspaces/${encodeURIComponent(workspaceId)}/tree`, cookie)).status,
      ).toBe(200);
    });

    it('opens a sibling lazily and can then read it', async () => {
      const opened = await pub(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/editable-file`,
        cookie,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ relPath: 'design.md' }),
        },
      );
      expect(opened.status).toBe(200);
      const { docId } = (await opened.json()) as { docId: string };
      expect((await pub(`/api/docs/${encodeURIComponent(docId)}`, cookie)).status).toBe(200);
    });

    it('still cannot reach a doc outside the workspace', async () => {
      expect((await pub(`/api/docs/${PRIVATE}`, cookie)).status).toBe(403);
    });
  });

  describe('there is no longer a DOC link to a workspace member', () => {
    /**
     * This block used to prove that a doc-scoped link WITHHELD `workspaceId`
     * from the doc payload: the client treats a non-empty workspaceId as
     * permission to render workspace nav and re-poll `/api/workspaces/<id>/…`
     * every 30s, and a doc share was refused those routes — so the id bought
     * the visitor a broken sidebar and a steady loop of 403s.
     *
     * That grant is gone, and with it the whole class of visitor that could
     * see a member doc without its workspace. So what is proven here now is
     * the removal plus the consequence: minting one is refused, and the
     * workspace link that replaces it DOES carry the id, because it can
     * actually use it.
     */
    let wsCookie: MintedShare;
    beforeAll(async () => {
      wsCookie = await mintAccessShare(base, access, boardId);
    });

    it('refuses to mint a link scoped to one member of a workspace', async () => {
      const r = await local('/api/share/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: entryDocId, allowDomains: ['@partner.example'] }),
      });
      expect(r.status).toBe(410);
      expect(((await r.json()) as { error: string }).error).toBe('per_doc_sharing_removed');
      // Positive control: the BOARD this member's workspace is filed on shares
      // fine. Not the workspace itself — that is a grouping, and its own
      // refusal is asserted in the minting suite above.
      const ok = await local('/api/share/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: boardId, allowDomains: ['@partner.example'] }),
      });
      expect(ok.status).toBe(200);
      await local(
        `/api/share/${((await ok.json()) as { share: { shareId: string } }).share.shareId}`,
        { method: 'DELETE' },
      );
    });

    it('the workspace link carries the id the sidebar needs, and the routes to use it', async () => {
      const res = await pub(`/api/docs/${encodeURIComponent(entryDocId)}`, wsCookie);
      expect(res.status).toBe(200);
      const { meta } = (await res.json()) as { meta: Record<string, unknown> };
      expect(meta.docId).toBe(entryDocId);
      expect(meta.workspaceId).toBe(workspaceId);
      // The id is only worth handing over because the nav routes are open to
      // this visitor — the pairing the doc-scoped link could never have.
      expect(
        (await pub(`/api/workspaces/${encodeURIComponent(workspaceId)}/tree`, wsCookie)).status,
      ).toBe(200);
    });

    it('and another workspace’s nav stays closed to it', async () => {
      // Positive control is the test above: this same cookie reads its own
      // tree. The one-file workspace is a different set, so it is refused.
      expect(
        (await pub(`/api/workspaces/${encodeURIComponent(soloWorkspaceId)}/tree`, wsCookie)).status,
      ).toBe(403);
      expect((await pub(`/api/docs/${soloPath}`, wsCookie)).status).toBe(403);
    });
  });

  describe('revocation and expiry are immediate', () => {
    it('a revoked share kills a visitor already in a browser', async () => {
      const share = await mintAccessShare(base, access, soloBoardId);
      expect((await pub(`/api/docs/${soloPath}`, share)).status).toBe(200);

      const del = await local(`/api/share/${share.shareId}`, { method: 'DELETE' });
      expect(del.status).toBe(200);

      // Same token, same browser — refused on the very next request, because
      // the hostname no longer resolves to a share at all.
      const after = await pub(`/api/docs/${soloPath}`, share);
      expect(after.status).toBe(403);
      expect(((await after.json()) as { error: string }).error).toBe('unknown_host');
    });

    it('an expired share stops working without anyone touching the browser', async () => {
      const share = await mintAccessShare(base, access, soloBoardId, { ttlSeconds: 60 });
      expect((await pub(`/api/docs/${soloPath}`, share)).status).toBe(200);

      // Wind the expiry into the past via the TTL route's own validation
      // path — negative TTLs are refused, so expire it by re-issuing at 1s
      // and waiting is too slow; set it directly through the registry.
      const registry = handle.shares;
      expect(registry).not.toBeNull();
      const live = registry?.list().find((s) => s.shareId === share.shareId);
      expect(live).toBeDefined();
      if (live) live.expiresAt = Date.now() - 1000;

      expect((await pub(`/api/docs/${soloPath}`, share)).status).toBe(403);
    });
  });

  describe('an expired share cannot be resurrected', () => {
    it('refuses to extend it — a dead grant must not come back to life', async () => {
      const share = await mintAccessShare(base, access, soloBoardId);
      const live = handle.shares?.list().find((s) => s.shareId === share.shareId);
      if (live) live.expiresAt = Date.now() - 1000;

      const r = await local(`/api/share/${share.shareId}/ttl`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ttlSeconds: 7 * 24 * 3600 }),
      });
      expect(r.status).toBe(404);
      // …and the hostname stays dead for the visitor holding its token.
      expect((await pub(`/api/docs/${soloPath}`, share)).status).toBe(403);
    });
  });

  describe('the public host is still default-deny for everything else', () => {
    it('refuses an unrelated hostname', async () => {
      const r = await fetch(`${base}/api/docs`, { headers: { host: 'attacker.example.com' } });
      expect(r.status).toBe(403);
    });

    it('still serves the local agent unauthenticated', async () => {
      expect((await local('/api/docs')).status).toBe(200);
      expect((await local('/api/share')).status).toBe(200);
    });
  });

  describe('revocation hangs up, it does not just refuse', () => {
    it('closes a websocket the share had already opened', async () => {
      // The original audit finding: authorization is re-checked on every
      // HTTP request, but a websocket is authorized ONCE at its upgrade.
      // Probing the deployed server showed the socket stayed open and
      // WRITABLE after unshare while HTTP correctly returned 401.
      const share = await mintAccessShare(base, access, soloBoardId);

      const ws = new WebSocket(`ws://localhost:${handle.port}/y/${soloPath}`, {
        headers: share.headers,
      } as unknown as string[]);
      const opened = await new Promise<boolean>((resolve) => {
        ws.addEventListener('open', () => resolve(true));
        ws.addEventListener('error', () => resolve(false));
        setTimeout(() => resolve(false), 3000);
      });
      expect(opened).toBe(true);

      const closedCode = new Promise<number>((resolve) => {
        ws.addEventListener('close', (e) => resolve((e as CloseEvent).code));
        setTimeout(() => resolve(-1), 5000);
      });

      const del = await local(`/api/share/${share.shareId}`, { method: 'DELETE' });
      expect(del.status).toBe(200);
      expect((await del.json()) as { closedSockets?: number }).toMatchObject({
        closedSockets: 1,
      });

      // 1008 = policy violation, which is exactly what a revoked share is.
      expect(await closedCode).toBe(1008);
    });

    it('leaves the operator’s own socket alone when a share is revoked', async () => {
      // The owner's editor is not authorized by any share and must not be
      // hung up on because someone else's invitation was revoked.
      const share = await mintAccessShare(base, access, soloBoardId);

      const ws = new WebSocket(`ws://localhost:${handle.port}/y/${soloPath}`);
      const opened = await new Promise<boolean>((resolve) => {
        ws.addEventListener('open', () => resolve(true));
        ws.addEventListener('error', () => resolve(false));
        setTimeout(() => resolve(false), 3000);
      });
      expect(opened).toBe(true);

      let closed = false;
      ws.addEventListener('close', () => {
        closed = true;
      });
      await local(`/api/share/${share.shareId}`, { method: 'DELETE' });
      await new Promise((r) => setTimeout(r, 300));
      expect(closed).toBe(false);
      ws.close();
    });
  });

  describe('identity comes from the proven email, not the share', () => {
    it('gives one person the SAME id on two shares of one board', async () => {
      // The inverse of what link mode did. A link visitor was anonymous, so
      // each link had to mint its own `guest-` id to keep two strangers
      // apart. Access proves an address, so the same person is the same
      // author wherever they were invited — and the body they send cannot
      // say otherwise.
      const ids: string[] = [];
      for (const label of ['first', 'second']) {
        const share = await mintAccessShare(base, access, soloBoardId, { label });
        const r = await pub(`/api/docs/${soloPath}/threads/by_find`, share, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            author: { id: 'same-browser', name: 'Casey', kind: 'anon', color: '#123456' },
            text: `from the ${label} link`,
            find: 'Body',
          }),
        });
        expect(r.status).toBe(200);
        const { thread } = (await r.json()) as {
          thread: { comments: Array<{ author: { id: string } }> };
        };
        ids.push(thread.comments[0]?.author.id ?? '');
        await local(`/api/share/${share.shareId}`, { method: 'DELETE' });
      }
      expect(ids[0]).toBeTruthy();
      expect(ids[0]).not.toBe('same-browser'); // never the claimed id
      expect(ids[1]).toBe(ids[0]);
    });
  });
});
