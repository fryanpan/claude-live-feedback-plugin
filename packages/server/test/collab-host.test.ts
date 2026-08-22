/**
 * HTTP-level coverage for the collaboration hostname — the deliberate
 * narrowing of the `cf-ray` veto (ticket: "Collaborators can reach Workspaces
 * at workspaces.fryanpan.com from outside the tailnet").
 *
 * The veto itself stays. cloudflared forwards the visitor's Host verbatim, so
 * a gate that believed the header would be spoofable by exactly the callers it
 * exists to exclude, and `isTrustedLocalHost` still refuses every proxied
 * request. What is new is a SECOND, opt-in list: a hostname on it classifies
 * `collab` — Cloudflare Access must authenticate the visitor, and what they
 * then reach is the share surface, scoped per request to whichever workspace
 * the path names.
 *
 * Bryan set the boundary (2026-08-18): *"workspaces.fryanpan.com is meant to
 * be the Cloudflare tunnel for collaboration that's reachable outside tailnet.
 * But not used for the privileged access that inside-tailnet traffic gets."*
 * So the suites below are three questions, in the order they matter:
 *
 *   A. Without the opt-in — or without Access in front of it — is behaviour
 *      exactly what it was? (Refusal, not exposure.)
 *   B. With both, does a collaborator actually reach the board and its docs?
 *   C. …and do the privileged routes still refuse them?
 *
 * The predicates are unit-tested in host-guard.test.ts. These drive the real
 * route table, because the route layer is the part nothing type-checks — a
 * gate wired in after a route that already answered would still pass a unit
 * test (see docs/process/learnings.md).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { type ServerHandle, createServer } from '../src/server.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'collab-host-kid';
/** The Access application over the collaboration hostname has its own AUD. */
const COLLAB_AUD = 'aud-for-the-collab-app';
const TUNNEL_HOST = 'workspaces.example.com';
/** Link-mode sharing, configured alongside — see the note in `beforeAll`. */
const LINK_HOST = 'links.example.com';
/** Cloudflare stamps this on everything it proxies; its presence IS the hop. */
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };

let jwks: JSONWebKeySet;
let signJwt: (aud: string) => Promise<string>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  publicJwk.kid = KID;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  jwks = { keys: [publicJwk] };
  signJwt = (aud: string) =>
    new SignJWT({ email: 'collaborator@partner.example' })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(`https://${TEAM_DOMAIN}`)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .setSubject('cf-access-collaborator-1')
      .sign(privateKey);
});

describe('the collaboration hostname over HTTP', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let jwt: string;

  /** A board the collaborator is meant to reach, and one they are not. */
  let board: string;
  let otherBoard: string;
  const DOC = 'design-doc';
  const OTHER_DOC = 'private-doc';

  const req = (path: string, host: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { host, ...((init.headers as Record<string, string>) ?? {}) },
    });

  /** As the machine's owner — loopback, no proxy hop, no token. */
  const asOwner = (path: string, init: RequestInit = {}) =>
    req(path, `localhost:${handle.port}`, init);

  /** As an Access-authenticated collaborator arriving through the tunnel. */
  const asCollaborator = (path: string, init: RequestInit = {}) =>
    req(path, TUNNEL_HOST, {
      ...init,
      headers: {
        ...CF_RAY,
        'cf-access-jwt-assertion': jwt,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'collab-host-'));
    handle = createServer({
      port: 0,
      dataDir,
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: COLLAB_AUD, jwks },
      // Link sharing configured TOO, deliberately, because that is what prod
      // looks like and it is where the wiring can go wrong: with `shares`
      // present the main verifier resolves its AUD per share hostname and
      // answers `null` for anything that is not one. A collaboration host is
      // never a share hostname, so a shared verifier would refuse every
      // request here with `no_share_for_host`. The collab host gets its own
      // verifier built from the static AUD, and this fixture is what proves it.
      share: { config: { publicHostname: LINK_HOST } },
      accessTunnelHosts: [TUNNEL_HOST],
    });
    base = `http://localhost:${handle.port}`;
    jwt = await signJwt(COLLAB_AUD);

    /** A board with one file-backed doc filed on it. */
    const boardWith = async (name: string, docId: string): Promise<string> => {
      const created = await asOwner('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      expect(created.status).toBe(200);
      const id = ((await created.json()) as { workspace: { id: string } }).workspace.id;
      const path = join(dataDir, `${docId}.md`);
      writeFileSync(path, `# ${docId}\n\nBody.\n`);
      const doc = await asOwner('/api/docs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId, type: 'markdown', sourceUrl: path }),
      });
      expect(doc.status).toBe(200);
      const filed = await asOwner(`/api/workspaces/${encodeURIComponent(id)}/docs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId }),
      });
      expect(filed.status).toBe(200);
      return id;
    };
    board = await boardWith('Shared work', DOC);
    otherBoard = await boardWith('Not shared', OTHER_DOC);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('A. authentication at the door', () => {
    it('demands a token — reaching the hostname is not reaching the product', () => {
      // Access normally challenges before the request ever arrives. This is
      // the server's own answer if it does not, which is the case that
      // matters: a misconfigured Access application must not mean an open one.
      return req('/api/docs/design-doc', TUNNEL_HOST, { headers: CF_RAY }).then(async (r) => {
        expect(r.status).toBe(401);
        expect(await r.json()).toEqual({ error: 'missing_jwt' });
      });
    });

    it('rejects a token minted for a different Access application', async () => {
      const wrong = await signJwt('aud-for-some-other-app');
      const r = await req(`/api/docs/${DOC}`, TUNNEL_HOST, {
        headers: { ...CF_RAY, 'cf-access-jwt-assertion': wrong },
      });
      expect(r.status).toBe(401);
    });

    it('refuses the same hostname when the request did NOT come through the edge', async () => {
      // A LAN client can send any Host it likes. Without the proxy hop there
      // is no Access application in front of the request, so the opt-in list
      // must not recognise it — even holding a valid token.
      const r = await req(`/api/docs/${DOC}`, TUNNEL_HOST, {
        headers: { 'cf-access-jwt-assertion': jwt },
      });
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: 'unknown_host' });
    });

    it('still refuses a proxied request that CLAIMS a local Host', async () => {
      // The veto this feature narrows is still doing its job for every
      // hostname that is not on the list.
      for (const host of ['localhost', '127.0.0.1', `attacker.${TUNNEL_HOST}`]) {
        const r = await req('/api/docs', host, { headers: CF_RAY });
        expect(r.status, host).toBe(403);
        expect(await r.json(), host).toEqual({ error: 'unknown_host' });
      }
    });
  });

  describe('B. what a collaborator reaches', () => {
    it('opens the board it was linked to, and the docs filed on it', async () => {
      // Not asserting 200 on the page routes — the markdown-app dist is not
      // built in tests. What is under test is the gate.
      expect((await asCollaborator(`/workspaces/${encodeURIComponent(board)}`)).status).not.toBe(
        403,
      );
      expect((await asCollaborator(`/api/workspaces/${encodeURIComponent(board)}`)).status).toBe(
        200,
      );
      const doc = await asCollaborator(`/api/docs/${DOC}`);
      expect(doc.status).toBe(200);
      expect(((await doc.json()) as { meta: { docId: string } }).meta.docId).toBe(DOC);
      expect((await asCollaborator(`/api/docs/${DOC}/threads`)).status).toBe(200);
      expect((await asCollaborator(`/review/${DOC}`)).status).not.toBe(403);
    });

    it('loads the app shell, which belongs to no workspace', async () => {
      expect((await asCollaborator('/app/app.js')).status).not.toBe(403);
    });

    it('can comment — reviewing is the point of the surface', async () => {
      const r = await asCollaborator(`/api/docs/${DOC}/threads/by_find`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          author: { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' },
          text: 'a note from outside the tailnet',
          find: 'Body',
        }),
      });
      expect(r.status).toBe(200);
      // …as a guest, not as whoever they claimed to be. Same rewrite a share
      // visitor gets: the collaboration host is an outsider surface.
      const listed = await asOwner(`/api/docs/${DOC}/threads`);
      const { threads } = (await listed.json()) as {
        threads: Array<{ comments: Array<{ author: { id: string; name: string } }> }>;
      };
      const authors = threads.flatMap((t) => t.comments.map((c) => c.author));
      expect(authors.length).toBeGreaterThan(0);
      for (const a of authors) {
        expect(a.id).not.toBe('known-bryan');
        expect(a.name).not.toBe('Bryan');
      }
    });

    it('is not shown the absolute paths or the tailnet host', async () => {
      const raw = await (await asCollaborator(`/api/docs/${DOC}`)).text();
      expect(raw).not.toContain(dataDir);
      expect(raw).not.toContain('.ts.net');
      const { meta } = JSON.parse(raw) as { meta: Record<string, unknown> };
      expect(meta.sourceUrl).toBeUndefined();
      expect(meta.docId).toBe(DOC);
    });
  });

  describe('C. what stays privileged', () => {
    it('CANNOT enumerate the server — the doc list or the workspace list', async () => {
      for (const p of ['/api/docs', '/api/workspaces']) {
        const r = await asCollaborator(p);
        expect(r.status, p).toBe(403);
        expect(await r.json(), p).toEqual({ error: 'out_of_share_scope' });
      }
      // POSITIVE CONTROL: the owner over loopback still gets both, so the
      // refusals above are about the host and not about a server that has
      // stopped answering.
      expect((await asOwner('/api/docs')).status).toBe(200);
      expect((await asOwner('/api/workspaces')).status).toBe(200);
    });

    it('CANNOT open the landing page — this is not the product at a nicer name', async () => {
      expect((await asCollaborator('/')).status).toBe(403);
      // …while the owner's own browser is untouched.
      expect((await asOwner('/')).status).not.toBe(403);
    });

    it('CANNOT list, mint, or revoke shares', async () => {
      expect((await asCollaborator('/api/share')).status).toBe(403);
      const mint = await asCollaborator('/api/share/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: board }),
      });
      expect(mint.status).toBe(403);
      expect((await asCollaborator('/api/share/any-id', { method: 'DELETE' })).status).toBe(403);
    });

    it('CANNOT bind a folder or create a diff review (arbitrary filesystem read)', async () => {
      const bind = await asCollaborator('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ folderPath: '/etc' }),
      });
      expect(bind.status).toBe(403);
      const diff = await asCollaborator('/api/diffs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo: '/', base: 'HEAD' }),
      });
      expect(diff.status).toBe(403);
    });

    it('CANNOT deploy, or push a plugin refresh at the fleet', async () => {
      expect((await asCollaborator('/api/deploy', { method: 'POST' })).status).toBe(403);
      expect((await asCollaborator('/api/deploy')).status).toBe(403);
      expect((await asCollaborator('/api/plugin/refresh', { method: 'POST' })).status).toBe(403);
    });

    it('CANNOT delete a doc it can read, or rewrite it wholesale', async () => {
      expect((await asCollaborator(`/api/docs/${DOC}`, { method: 'DELETE' })).status).toBe(403);
      const rewrite = await asCollaborator(`/api/docs/${DOC}/content`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ markdown: '# Wiped\n' }),
      });
      expect(rewrite.status).toBe(403);
      expect(
        (await asCollaborator(`/api/docs/${DOC}/reparse_from_disk`, { method: 'POST' })).status,
      ).toBe(403);
      // …and the doc really is intact.
      expect((await asOwner(`/api/docs/${DOC}`)).status).toBe(200);
    });

    it('CANNOT delete a board or reshape one', async () => {
      expect(
        (await asCollaborator(`/api/workspaces/${encodeURIComponent(board)}`, { method: 'DELETE' }))
          .status,
      ).toBe(403);
      const regroup = await asCollaborator(`/api/workspaces/${encodeURIComponent(board)}/groups`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ groups: [] }),
      });
      expect(regroup.status).toBe(403);
      expect((await asOwner('/api/workspaces')).status).toBe(200);
    });

    it('CANNOT reach a doc through a board it does not belong to', async () => {
      // Two conditions, not one: naming a board you can reach in front of
      // someone else's doc must not carry the doc in with it.
      const crossed = `/workspaces/${encodeURIComponent(board)}/docs/${OTHER_DOC}`;
      expect((await asCollaborator(crossed)).status).toBe(403);
      // POSITIVE CONTROL: the same shape with the doc that IS on that board.
      const own = `/workspaces/${encodeURIComponent(board)}/docs/${DOC}`;
      expect((await asCollaborator(own)).status).not.toBe(403);
    });

    it('reaches the OTHER board too — the surface is scoped per path, not per host', async () => {
      // Stated as its own test rather than left implicit, because it is the
      // widest thing this hostname grants and it should be visible in the
      // test names. An Access-admitted collaborator can open any BOARD they
      // have the id for; what they cannot do is enumerate the ids (the two
      // list routes above), or touch anything an operator touches.
      expect(
        (await asCollaborator(`/api/workspaces/${encodeURIComponent(otherBoard)}`)).status,
      ).toBe(200);
    });
  });

  describe('D. the local surface is unchanged', () => {
    it('still serves loopback unauthenticated, share administration included', async () => {
      expect((await asOwner('/api/docs')).status).toBe(200);
      expect((await asOwner('/api/share')).status).toBe(200);
    });

    it('still refuses an unrelated public hostname outright', async () => {
      const r = await req('/api/docs', 'attacker.example.com', { headers: CF_RAY });
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: 'unknown_host' });
    });

    it('leaves the link hostname a link hostname', async () => {
      // The opt-in list is consulted last, so nothing it contains takes a
      // meaning away from a hostname that already had one. `links.example.com`
      // is not on the list at all, and it must still be link mode: 401 for a
      // missing session, not 403 for an unknown host.
      const r = await req('/api/docs/design-doc', LINK_HOST, { headers: CF_RAY });
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: 'no_share_session' });
    });
  });
});

/**
 * The two ways the opt-in fails closed. Each gets its own server, because
 * what is under test is the CONFIGURATION rather than a request.
 */
describe('the opt-in fails closed', () => {
  const dirs: string[] = [];
  const handles: ServerHandle[] = [];
  const spinUp = (opts: Parameters<typeof createServer>[0]): ServerHandle => {
    const dataDir = mkdtempSync(join(tmpdir(), 'collab-closed-'));
    dirs.push(dataDir);
    const h = createServer({ port: 0, dataDir, ...opts });
    handles.push(h);
    return h;
  };

  afterAll(async () => {
    for (const h of handles) await h.stop();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('WITHOUT the opt-in, the hostname answers exactly what it always did', async () => {
    // The (c) case from the brief, at the HTTP layer: a deployment that has
    // not opted in is bit-for-bit unchanged, Access configured or not.
    const h = spinUp({ cfAccess: { teamDomain: TEAM_DOMAIN, audience: COLLAB_AUD, jwks } });
    const jwt = await signJwt(COLLAB_AUD);
    const r = await fetch(`http://localhost:${h.port}/api/docs`, {
      headers: { host: TUNNEL_HOST, ...CF_RAY, 'cf-access-jwt-assertion': jwt },
    });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'unknown_host' });
  });

  it('WITH the opt-in but NO Access, the list is ignored rather than honoured', async () => {
    // The refusal the whole design turns on. Honouring the list here would
    // hand the share surface to anyone who can reach the tunnel and type the
    // hostname — the exact hole the cf-ray veto was added to close.
    const h = spinUp({ accessTunnelHosts: [TUNNEL_HOST] });
    const r = await fetch(`http://localhost:${h.port}/api/docs`, {
      headers: { host: TUNNEL_HOST, ...CF_RAY },
    });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'unknown_host' });
    // POSITIVE CONTROL: that server is alive and serving its local caller, so
    // the 403 is the gate rather than a server that answers nothing.
    const local = await fetch(`http://localhost:${h.port}/api/docs`, {
      headers: { host: `localhost:${h.port}` },
    });
    expect(local.status).toBe(200);
  });
});
