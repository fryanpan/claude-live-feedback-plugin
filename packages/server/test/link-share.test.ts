/**
 * Link-mode sharing, driven through the real route table.
 *
 * The threat model is different from Access mode: the signed URL IS the
 * credential (its HMAC signature — see signed-link-share.test.ts for the
 * signature's own suite), so the tests below care about (a) the URL being
 * exchanged for a session exactly once, (b) everything else on the public
 * host requiring that session, (c) the session being scoped identically to
 * an Access visitor, and (d) revocation and expiry taking effect immediately
 * rather than when a browser cookie happens to lapse.
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
import { SHARE_COOKIE, signSession } from '../src/share/link-session.ts';

const PUBLIC_HOST = 'feedback.example.com';

describe('link shares over HTTP', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let folder: string;
  let soloFolder: string;
  let base: string;

  let soloShare: { shareId: string; url: string; expiresAt: number; slug?: string };
  let wsShare: { shareId: string; url: string; slug?: string };
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

  /** A request to the public share host, optionally carrying a session. */
  const pub = (path: string, cookie?: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      ...init,
      headers: {
        host: PUBLIC_HOST,
        ...(cookie ? { cookie: `${SHARE_COOKIE}=${cookie}` } : {}),
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  /** A share URL's path+query, as a visitor's browser sends it. */
  const signedPath = (shareUrl: string): string => {
    const u = new URL(shareUrl);
    return `${u.pathname}${u.search}`;
  };

  /** Redeem a signed share URL and return the session cookie value. */
  const redeem = async (shareUrl: string): Promise<string> => {
    const r = await pub(signedPath(shareUrl));
    expect(r.status).toBe(302);
    const setCookie = r.headers.get('set-cookie') ?? '';
    const m = setCookie.match(new RegExp(`${SHARE_COOKIE}=([^;]+)`));
    expect(m).not.toBeNull();
    return m?.[1] ?? '';
  };

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

    handle = createServer({
      dedicatedListener: true,
      port: 0,
      dataDir,
      // No cfAccess, no account id, no API token — link mode needs none.
      share: { config: { publicHostname: PUBLIC_HOST } },
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

    const dr = await local('/api/share/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: soloBoardId, label: 'solo review' }),
    });
    expect(dr.status).toBe(200);
    soloShare = ((await dr.json()) as { share: typeof soloShare }).share;

    const wr = await local('/api/share/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: boardId }),
    });
    expect(wr.status).toBe(200);
    wsShare = ((await wr.json()) as { share: typeof wsShare }).share;
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
      body: JSON.stringify({ workspaceId: soloBoardId, ...extra }),
    });

  describe('minting', () => {
    it('needs no Cloudflare credentials and defaults to a two-week TTL', () => {
      const days = (soloShare.expiresAt - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(13.9);
      expect(days).toBeLessThan(14.1);
    });

    it('mints a signed URL, not a slug — the signature is the credential', () => {
      expect(soloShare.slug).toBeUndefined();
      const u = new URL(soloShare.url);
      expect(u.searchParams.get('sig')).toMatch(/^[0-9a-f]{64}$/);
      expect(new URL(wsShare.url).searchParams.get('sig')).not.toBe(u.searchParams.get('sig'));
    });

    it('points the URL at the public host', () => {
      const u = new URL(soloShare.url);
      expect(u.hostname).toBe(PUBLIC_HOST);
      expect(u.pathname).toBe(`/share/${soloShare.shareId}`);
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
        body: JSON.stringify({ workspaceId: 'ghost-ws' }),
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
        body: JSON.stringify({ workspaceId: soloWorkspaceId }),
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
          body: JSON.stringify(body),
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
        body: JSON.stringify({ label: 'no scope' }),
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

  describe('redemption', () => {
    it('exchanges the signed URL for a session and lands ON THE BOARD', async () => {
      // It used to land on `/review/<entry doc>`. A board share has no entry
      // doc to resolve — that whole resolution step went with board-only
      // sharing — so redemption lands on the board and the visitor navigates
      // from there. The member doc is still reachable; the next suite opens it.
      const r = await pub(signedPath(soloShare.url));
      expect(r.status).toBe(302);
      expect(r.headers.get('location')).toBe(`/workspaces/${encodeURIComponent(soloBoardId)}`);
      const cookie = r.headers.get('set-cookie') ?? '';
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      // The signed URL must not ride out in a Referer to anything downstream.
      expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    });

    it('gives nothing away about which shares exist', async () => {
      const unknown = await pub(`/share/${'0'.repeat(16)}?exp=99999999999&sig=${'0'.repeat(64)}`);
      const malformed = await pub('/share/not-a-share');
      expect(unknown.status).toBe(404);
      expect(malformed.status).toBe(404);
      expect(await unknown.text()).toBe(await malformed.text());
    });
  });

  describe('the session is required', () => {
    it('refuses every other path on the public host without one', async () => {
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

    it('refuses a forged cookie', async () => {
      // Right shape, wrong key — the attacker doesn't have the HMAC secret.
      const forged = signSession(soloShare.shareId, 'f'.repeat(64));
      expect((await pub(`/api/docs/${soloPath}`, forged)).status).toBe(401);
      expect((await pub(`/api/docs/${soloPath}`, `${soloShare.shareId}.`)).status).toBe(401);
    });
  });

  describe('a redeemed session is scoped exactly like an Access visitor', () => {
    // The narrowest share available: a board holding one bind holding one
    // file. It reaches that file because it is a MEMBER of a grouping filed on
    // the board — never because the share names it. The "the entry doc is
    // always in scope" base case went away with per-doc sharing and the field
    // that expressed it went with board-only sharing, so a doc outside the
    // board is refused even here.
    let cookie: string;
    beforeAll(async () => {
      cookie = await redeem(soloShare.url);
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
        body: JSON.stringify({ workspaceId: boardId }),
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

  describe('a workspace link browses the whole set', () => {
    let cookie: string;
    beforeAll(async () => {
      cookie = await redeem(wsShare.url);
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
    let wsCookie: string;
    beforeAll(async () => {
      const r = await local('/api/share/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: boardId }),
      });
      expect(r.status).toBe(200);
      const { share } = (await r.json()) as { share: { url: string } };
      wsCookie = await redeem(share.url);
    });

    it('refuses to mint a link scoped to one member of a workspace', async () => {
      const r = await local('/api/share/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: entryDocId }),
      });
      expect(r.status).toBe(410);
      expect(((await r.json()) as { error: string }).error).toBe('per_doc_sharing_removed');
      // Positive control: the BOARD this member's workspace is filed on shares
      // fine. Not the workspace itself — that is a grouping, and its own
      // refusal is asserted in the minting suite above.
      const ok = await local('/api/share/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: boardId }),
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
    it('a revoked share kills a session already in a browser', async () => {
      const mk = await mintSolo();
      const { share } = (await mk.json()) as { share: { shareId: string; url: string } };
      const cookie = await redeem(share.url);
      expect((await pub(`/api/docs/${soloPath}`, cookie)).status).toBe(200);

      const del = await local(`/api/share/${share.shareId}`, { method: 'DELETE' });
      expect(del.status).toBe(200);

      // Same cookie, same browser — refused on the very next request.
      expect((await pub(`/api/docs/${soloPath}`, cookie)).status).toBe(401);
      // And the signed URL no longer redeems.
      expect((await pub(signedPath(share.url))).status).toBe(404);
    });

    it('an expired share stops working without anyone touching the browser', async () => {
      const mk = await mintSolo({ ttlSeconds: 60 });
      const { share } = (await mk.json()) as { share: { shareId: string; url: string } };
      const cookie = await redeem(share.url);
      expect((await pub(`/api/docs/${soloPath}`, cookie)).status).toBe(200);

      // Wind the expiry into the past via the TTL route's own validation
      // path — negative TTLs are refused, so expire it by re-issuing at 1s
      // and waiting is too slow; set it directly through the registry.
      const registry = handle.shares;
      expect(registry).not.toBeNull();
      const live = registry?.list().find((s) => s.shareId === share.shareId);
      expect(live).toBeDefined();
      if (live) live.expiresAt = Date.now() - 1000;

      expect((await pub(`/api/docs/${soloPath}`, cookie)).status).toBe(401);
      expect((await pub(signedPath(share.url))).status).toBe(404);
    });
  });

  describe('an expired share cannot be resurrected', () => {
    it('refuses to extend it — a leaked URL must not come back to life', async () => {
      const mk = await mintSolo();
      const { share } = (await mk.json()) as { share: { shareId: string; url: string } };
      const live = handle.shares?.list().find((s) => s.shareId === share.shareId);
      if (live) live.expiresAt = Date.now() - 1000;

      const r = await local(`/api/share/${share.shareId}/ttl`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ttlSeconds: 7 * 24 * 3600 }),
      });
      expect(r.status).toBe(404);
      // The old URL stays dead.
      expect((await pub(signedPath(share.url))).status).toBe(404);
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
      const mint = await mintSolo();
      const share = ((await mint.json()) as { share: { shareId: string; url: string } }).share;
      const cookie = await redeem(share.url);

      const ws = new WebSocket(`ws://localhost:${handle.port}/y/${soloPath}`, {
        headers: { host: PUBLIC_HOST, cookie: `${SHARE_COOKIE}=${cookie}` },
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

    it('leaves a tailnet socket alone when a share is revoked', async () => {
      // Bryan's own editor is not authorized by any share and must not be
      // hung up on because someone else's link was revoked.
      const mint = await mintSolo();
      const share = ((await mint.json()) as { share: { shareId: string } }).share;

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

  describe('guest identity is scoped to the SHARE', () => {
    it('gives the same browser different guest ids on two links to one workspace', async () => {
      // Two links to the same workspace are two audiences. Seeding the guest
      // id from the doc (or from the workspace) would attribute comments on a
      // freshly minted link to the previous link's visitor.
      const ids: string[] = [];
      for (const label of ['first', 'second']) {
        const mint = await mintSolo({ label });
        const share = ((await mint.json()) as { share: { shareId: string; url: string } }).share;
        const cookie = await redeem(share.url);
        const r = await pub(`/api/docs/${soloPath}/threads/by_find`, cookie, {
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
      expect(ids[0]).toStartWith('guest-');
      expect(ids[1]).toStartWith('guest-');
      expect(ids[0]).not.toBe(ids[1]);
    });
  });
});
