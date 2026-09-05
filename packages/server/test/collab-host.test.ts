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
 *   E. …and does an admitted email reach only the boards it was GIVEN?
 *
 * E is the newest and the one the others depend on. Passing Access proves an
 * email is one the owner admitted to the hostname; it says nothing about which
 * boards behind it that person was given, and until this suite existed every
 * admitted email could open every workspace on the server by id. Membership is
 * the allow lists of a board's LIVE shares plus the owner allowlist, so these
 * fixtures mint real shares rather than only filing docs.
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
import { emailIdentityId } from '@feedback/core';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'collab-host-kid';
/** The Access application over the collaboration hostname has its own AUD. */
const COLLAB_AUD = 'aud-for-the-collab-app';
const TUNNEL_HOST = 'workspaces.example.com';
/** Link-mode sharing, configured alongside — see the note in `beforeAll`. */
const LINK_HOST = 'links.example.com';
/** Cloudflare stamps this on everything it proxies; its presence IS the hop. */
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };

/**
 * Four admitted emails. Every one of them holds a VALID token for the
 * hostname's Access application — that is the point. What separates them is
 * only what they were given.
 */
/** Given `board`, by a DOMAIN entry on its share. */
const MEMBER_EMAIL = 'collaborator@partner.example';
/** Given `exactBoard`, by an entry naming this address and no other. */
const NAMED_EMAIL = 'named@other.example';
/** Given nothing — and deliberately at the same domain as NAMED_EMAIL, so an
 *  exact entry read as a domain would admit them. */
const NEIGHBOUR_EMAIL = 'neighbour@other.example';
/** The deployment's own operator: a member of every board, named in no share. */
const OWNER_EMAIL = 'owner@example.com';

let jwks: JSONWebKeySet;
let signJwt: (aud: string, email?: string) => Promise<string>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  publicJwk.kid = KID;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  jwks = { keys: [publicJwk] };
  signJwt = (aud: string, email: string = MEMBER_EMAIL) =>
    new SignJWT({ email })
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
  /** A third, shared with ONE named address rather than a domain. */
  let exactBoard: string;

  /**
   * A board with one file-backed doc filed on it; answers the board id and
   * the id the server minted for the doc. Assigned in `beforeAll` and used by
   * the tests too, which is why it is declared out here.
   */
  let boardWith: (
    name: string,
    requestedDocId: string,
  ) => Promise<{ boardId: string; mintedDocId: string }>;
  /** Write an allow list down against a board — which is what a share IS, and
   *  therefore the only way anybody becomes a member of one. */
  let shareBoard: (boardId: string, allowDomains: string[]) => Promise<void>;
  /** The readable names the caller asks for… */
  const DOC = 'design-doc';
  const OTHER_DOC = 'private-doc';
  /**
   * …and the ids the server MINTS for them, which is what a board's
   * membership holds and therefore what every scope answer is about. The
   * names stay aliases that resolve; the addresses are these.
   */
  let docId: string;
  let otherDocId: string;

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

  /** The same, as whoever you like — every one of them Access-admitted. */
  const asEmail = async (email: string, path: string, init: RequestInit = {}) =>
    req(path, TUNNEL_HOST, {
      ...init,
      headers: {
        ...CF_RAY,
        'cf-access-jwt-assertion': await signJwt(COLLAB_AUD, email),
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'collab-host-'));
    handle = createServer({
      port: 0,
      dataDir,
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: COLLAB_AUD, jwks },
      // Share hosting configured TOO, deliberately, because that is what prod
      // looks like and it is where the wiring can go wrong: with `shares`
      // present the main verifier resolves its AUD per share hostname and
      // answers `null` for anything that is not one. A collaboration host is
      // never a share hostname, so a shared verifier would refuse every
      // request here with `no_share_for_host`. The collab host gets its own
      // verifier built from the static AUD, and this fixture is what proves it.
      //
      // It is also what makes membership testable at all: a share is where a
      // board's allow list is written down, and the mock Cloudflare client is
      // what lets one be minted without leaving the process.
      share: {
        config: { ...ACCESS_SHARE_CONFIG, publicHostname: LINK_HOST },
        cfApi: mockCfApi(),
      },
      // The owner half of the membership set — the same list the operator
      // hostname checks. No `proxiedTrustedHosts`, so nothing is classified
      // differently; only who counts as this deployment's own people.
      proxiedTrustedEmails: [OWNER_EMAIL],
      accessTunnelHosts: [TUNNEL_HOST],
    });
    base = `http://localhost:${handle.port}`;
    jwt = await signJwt(COLLAB_AUD);

    boardWith = async (
      name: string,
      requestedDocId: string,
    ): Promise<{ boardId: string; mintedDocId: string }> => {
      const created = await asOwner('/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      expect(created.status).toBe(200);
      const id = ((await created.json()) as { workspace: { id: string } }).workspace.id;
      const path = join(dataDir, `${requestedDocId}.md`);
      writeFileSync(path, `# ${requestedDocId}\n\nBody.\n`);
      const doc = await asOwner('/api/docs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: requestedDocId, type: 'markdown', sourceUrl: path }),
      });
      expect(doc.status).toBe(200);
      const mintedDocId = ((await doc.json()) as { docId: string }).docId;
      // Filed by the readable name; the membership the board records is the
      // minted id, which is what the scope checks below are measured against.
      const filed = await asOwner(`/workspaces/${encodeURIComponent(id)}/docs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: requestedDocId }),
      });
      expect(filed.status).toBe(200);
      return { boardId: id, mintedDocId };
    };
    shareBoard = async (boardId: string, allowDomains: string[]): Promise<void> => {
      const res = await asOwner('/api/share/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: boardId, allowDomains }),
      });
      expect(res.status, await res.clone().text()).toBe(200);
    };

    ({ boardId: board, mintedDocId: docId } = await boardWith('Shared work', DOC));
    ({ boardId: otherBoard, mintedDocId: otherDocId } = await boardWith('Not shared', OTHER_DOC));
    ({ boardId: exactBoard } = await boardWith('Named guest', 'exact-doc'));
    expect(docId).toBeTruthy();
    expect(otherDocId).toBeTruthy();
    // `board` by domain, `exactBoard` by one address, `otherBoard` not at all.
    await shareBoard(board, ['@partner.example']);
    await shareBoard(exactBoard, [NAMED_EMAIL]);
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
      const r = await req(`/api/docs/${docId}`, TUNNEL_HOST, {
        headers: { ...CF_RAY, 'cf-access-jwt-assertion': wrong },
      });
      expect(r.status).toBe(401);
    });

    it('refuses the same hostname when the request did NOT come through the edge', async () => {
      // A LAN client can send any Host it likes. Without the proxy hop there
      // is no Access application in front of the request, so the opt-in list
      // must not recognise it — even holding a valid token.
      const r = await req(`/api/docs/${docId}`, TUNNEL_HOST, {
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
      // Not asserting 200 on the page routes — the workspaces-app dist is not
      // built in tests. What is under test is the gate.
      expect(
        (await asCollaborator(`/workspaces/${encodeURIComponent(board)}?format=json`)).status,
      ).not.toBe(403);
      expect(
        (await asCollaborator(`/workspaces/${encodeURIComponent(board)}?format=json`)).status,
      ).toBe(200);
      const doc = await asCollaborator(`/api/docs/${docId}`);
      expect(doc.status).toBe(200);
      expect(((await doc.json()) as { meta: { docId: string } }).meta.docId).toBe(docId);
      expect((await asCollaborator(`/api/docs/${docId}/threads`)).status).toBe(200);
      expect((await asCollaborator(`/review/${docId}`)).status).not.toBe(403);
    });

    it('loads the app shell, which belongs to no workspace', async () => {
      expect((await asCollaborator('/app/app.js')).status).not.toBe(403);
    });

    it('can comment — reviewing is the point of the surface', async () => {
      const r = await asCollaborator(`/api/docs/${docId}/threads/by_find`, {
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
      const listed = await asOwner(`/api/docs/${docId}/threads`);
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
      const raw = await (await asCollaborator(`/api/docs/${docId}`)).text();
      expect(raw).not.toContain(dataDir);
      expect(raw).not.toContain('.ts.net');
      const { meta } = JSON.parse(raw) as { meta: Record<string, unknown> };
      expect(meta.sourceUrl).toBeUndefined();
      expect(meta.docId).toBe(docId);
    });
  });

  describe('C. what stays privileged', () => {
    it('CANNOT enumerate the server — the doc list or the workspace list', async () => {
      for (const p of ['/api/docs', '/workspaces']) {
        const r = await asCollaborator(p);
        expect(r.status, p).toBe(403);
        expect(await r.json(), p).toEqual({ error: 'out_of_share_scope' });
      }
      // POSITIVE CONTROL: the owner over loopback still gets both, so the
      // refusals above are about the host and not about a server that has
      // stopped answering.
      expect((await asOwner('/api/docs')).status).toBe(200);
      expect((await asOwner('/workspaces')).status).toBe(200);
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
      const bind = await asCollaborator('/workspaces', {
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

    it('CANNOT deploy, push a plugin refresh at the fleet, or merge agent ids', async () => {
      expect((await asCollaborator('/api/deploy', { method: 'POST' })).status).toBe(403);
      expect((await asCollaborator('/api/deploy')).status).toBe(403);
      expect((await asCollaborator('/api/plugin/refresh', { method: 'POST' })).status).toBe(403);
      expect((await asCollaborator('/api/agents/agent-one/merge', { method: 'POST' })).status).toBe(
        403,
      );
    });

    it('CANNOT delete a doc it can read, or rewrite it wholesale', async () => {
      expect((await asCollaborator(`/api/docs/${docId}`, { method: 'DELETE' })).status).toBe(403);
      const rewrite = await asCollaborator(`/api/docs/${docId}/content`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ markdown: '# Wiped\n' }),
      });
      expect(rewrite.status).toBe(403);
      expect(
        (await asCollaborator(`/api/docs/${docId}/reparse_from_disk`, { method: 'POST' })).status,
      ).toBe(403);
      // …and the doc really is intact.
      expect((await asOwner(`/api/docs/${docId}`)).status).toBe(200);
    });

    it('CANNOT delete a board or reshape one', async () => {
      expect(
        (await asCollaborator(`/workspaces/${encodeURIComponent(board)}`, { method: 'DELETE' }))
          .status,
      ).toBe(403);
      const regroup = await asCollaborator(`/api/reviews/${encodeURIComponent(board)}/groups`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ groups: [] }),
      });
      expect(regroup.status).toBe(403);
      expect((await asOwner('/workspaces')).status).toBe(200);
    });

    it('CANNOT reach a doc through a board it does not belong to', async () => {
      // Two conditions, not one: naming a board you can reach in front of
      // someone else's doc must not carry the doc in with it.
      const crossed = `/workspaces/${encodeURIComponent(board)}/docs/${otherDocId}`;
      expect((await asCollaborator(crossed)).status).toBe(403);
      // POSITIVE CONTROL: the same shape with the doc that IS on that board.
      const own = `/workspaces/${encodeURIComponent(board)}/docs/${docId}`;
      expect((await asCollaborator(own)).status).not.toBe(403);
    });

    it('CANNOT reach a board it was not given, even holding a valid token', async () => {
      // This test used to assert the opposite, and the assertion was right
      // about the code: an Access-admitted collaborator could open ANY board
      // they had the id for. Access admits an email to the HOSTNAME; the
      // board's own allow list is what says who was given the board.
      const r = await asCollaborator(`/workspaces/${encodeURIComponent(otherBoard)}?format=json`);
      expect(r.status).toBe(403);
      // POSITIVE CONTROL: the same request shape, the same token, on the board
      // this collaborator WAS given — so the 403 above is membership and not
      // a route that stopped answering.
      expect(
        (await asCollaborator(`/workspaces/${encodeURIComponent(board)}?format=json`)).status,
      ).toBe(200);
    });
  });

  /**
   * E. Membership: which boards an admitted email actually reaches.
   *
   * Every request below carries a VALID token for this hostname's Access
   * application. What separates a 200 from a 403 is only whether the board's
   * live share names that person.
   */
  describe('E. one admitted email, one board', () => {
    const boardPath = (id: string) => `/workspaces/${encodeURIComponent(id)}?format=json`;
    // The board's own path with a collection under it. Separate from
    // `boardPath` because that one carries `?format=json` — the board record
    // and the board PAGE are one address now, and the query string is what
    // tells them apart — so appending a segment to it would put the
    // collection inside the query.
    const boardSub = (id: string, sub: string) => `/workspaces/${encodeURIComponent(id)}/${sub}`;

    it('a DOMAIN entry admits every address at that domain', async () => {
      // `board` was shared with `@partner.example`, and the collaborator is
      // at it. A second, never-named address at the same domain gets in too —
      // that is what a domain entry means, and it must not be read as an
      // exact address.
      expect((await asCollaborator(boardPath(board))).status).toBe(200);
      expect((await asEmail('someone-else@partner.example', boardPath(board))).status).toBe(200);
    });

    it('an EXACT entry admits that address and not its neighbour', async () => {
      // The pairing is the whole test: both emails are at `other.example`,
      // and only one is written in the share. An entry read as a domain would
      // pass them both.
      expect((await asEmail(NAMED_EMAIL, boardPath(exactBoard))).status).toBe(200);
      expect((await asEmail(NEIGHBOUR_EMAIL, boardPath(exactBoard))).status).toBe(403);
    });

    it('a second admitted email is refused the board it was not given', async () => {
      // The weakness, stated as a test. `named@other.example` is admitted to
      // the hostname and holds a board of their own; that buys them nothing
      // on somebody else's.
      const crossed = await asEmail(NAMED_EMAIL, boardPath(board));
      expect(crossed.status).toBe(403);
      expect(await crossed.json()).toEqual({ error: 'out_of_share_scope' });
      // POSITIVE CONTROL: the given email on the same path.
      expect((await asCollaborator(boardPath(board))).status).toBe(200);
      // …and the refusal is not "this email reaches nothing": their own board
      // still opens.
      expect((await asEmail(NAMED_EMAIL, boardPath(exactBoard))).status).toBe(200);
    });

    it('a member works their own board’s rows, and never another board’s', async () => {
      // The row routes name no workspace in their path — `/api/tasks/<id>/…`
      // resolves through the task's own board — so the membership question
      // and the scope question have to land on the same board. This is that,
      // end to end, on the collaboration hostname.
      const json = { 'content-type': 'application/json' };
      const mine = await asCollaborator(boardSub(board, 'tasks'), {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ title: 'Filed by a collaborator', assignee: 'human' }),
      });
      expect(mine.status, await mine.clone().text()).toBe(200);
      const taskId = ((await mine.json()) as { task: { id: string } }).task.id;
      const moved = await asCollaborator(`/api/tasks/${taskId}/transition`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ to: 'in-progress' }),
      });
      expect(moved.status, await moved.clone().text()).toBe(200);

      // `named@other.example` holds a board of their own and not this one.
      const crossed = await asEmail(NAMED_EMAIL, `/api/tasks/${taskId}/transition`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ to: 'done' }),
      });
      expect(crossed.status).toBe(403);
      expect(await crossed.json()).toEqual({ error: 'out_of_share_scope' });
      // POSITIVE CONTROL: the same address files on the board it DOES hold.
      const theirs = await asEmail(NAMED_EMAIL, boardSub(exactBoard, 'tasks'), {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ title: 'On their own board', assignee: 'human' }),
      });
      expect(theirs.status, await theirs.clone().text()).toBe(200);
    });

    it('a board with no live share admits nobody', async () => {
      for (const email of [MEMBER_EMAIL, NAMED_EMAIL, NEIGHBOUR_EMAIL]) {
        const r = await asEmail(email, boardPath(otherBoard));
        expect(r.status, email).toBe(403);
      }
      // POSITIVE CONTROL: the board exists and answers — to the owner over
      // loopback, and to the owner's own email through the tunnel.
      expect((await asOwner(boardPath(otherBoard))).status).toBe(200);
      expect((await asEmail(OWNER_EMAIL, boardPath(otherBoard))).status).toBe(200);
    });

    it('the owner allowlist is a member of every board, naming no share', async () => {
      for (const id of [board, otherBoard, exactBoard]) {
        expect((await asEmail(OWNER_EMAIL, boardPath(id))).status, id).toBe(200);
      }
    });

    it('refuses the DOCS of a board it was not given, over REST and the socket', async () => {
      // The board id is the cheap probe; the doc and its Yjs room are what
      // the probe would have been worth. `/y/<id>` is gated before the
      // upgrade, so a 403 here is the gate rather than a failed handshake.
      for (const path of [
        `/api/docs/${otherDocId}`,
        `/api/docs/${otherDocId}/threads`,
        `/review/${otherDocId}`,
        `/y/${otherDocId}`,
        `/y/ws:${encodeURIComponent(otherBoard)}`,
        `/workspaces/${encodeURIComponent(otherBoard)}/events:stream`,
      ]) {
        expect((await asCollaborator(path)).status, path).toBe(403);
      }
      // POSITIVE CONTROL: the matching paths on the board they WERE given.
      expect((await asCollaborator(`/api/docs/${docId}`)).status).toBe(200);
      expect((await asCollaborator(`/api/docs/${docId}/threads`)).status).toBe(200);
      expect((await asCollaborator(`/y/${docId}`)).status).not.toBe(403);
    });

    it('cannot comment on a doc it was not given', async () => {
      // The one write a collaborator has. Refused by the gate, and the doc is
      // untouched afterwards.
      const r = await asCollaborator(`/api/docs/${otherDocId}/threads/by_find`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          author: { id: 'x', name: 'x', kind: 'known', color: '#2e7dd7' },
          text: 'should never land',
          find: 'Body',
        }),
      });
      expect(r.status).toBe(403);
      const listed = await asOwner(`/api/docs/${otherDocId}/threads`);
      const { threads } = (await listed.json()) as { threads: unknown[] };
      expect(threads).toHaveLength(0);
    });

    it('reaches a doc filed on TWO boards through EITHER board it holds', async () => {
      // A doc belongs to every board it is filed on. Asking membership about
      // only the first — whichever the store iterates first — refused a
      // visitor the doc their own board shows them, while that board's own
      // share hostname served it. Both orders are asserted, because the bug
      // was invisible in one of them.
      const first = await boardWith('Filed first', 'two-board-doc');
      const second = await asOwner('/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Filed second' }),
      });
      expect(second.status).toBe(200);
      const secondId = ((await second.json()) as { workspace: { id: string } }).workspace.id;
      const filed = await asOwner(`/workspaces/${encodeURIComponent(secondId)}/docs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: 'two-board-doc' }),
      });
      expect(filed.status).toBe(200);

      // Shared on the SECOND board only — the one that is not first in the
      // store's order.
      await shareBoard(secondId, [NAMED_EMAIL]);
      expect((await asEmail(NAMED_EMAIL, `/api/docs/${first.mintedDocId}`)).status).toBe(200);

      // POSITIVE CONTROL, the reverse: share the FIRST board with a different
      // address, and that address reaches the same doc too.
      await shareBoard(first.boardId, ['@partner.example']);
      expect((await asCollaborator(`/api/docs/${first.mintedDocId}`)).status).toBe(200);

      // …and a member of NEITHER board is still refused it, so the two 200s
      // above are membership rather than a doc that answers anybody.
      expect((await asEmail(NEIGHBOUR_EMAIL, `/api/docs/${first.mintedDocId}`)).status).toBe(403);
    });

    it('still loads the app shell — an admitted non-member sees the page', async () => {
      // Membership is asked about a workspace, and these paths name none.
      // Refusing them would leave a collaborator on the wrong board staring
      // at a blank tab instead of a page that can say so.
      for (const p of ['/app/app.js', '/favicon.ico']) {
        expect((await asEmail(NEIGHBOUR_EMAIL, p)).status, p).not.toBe(403);
      }
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

    it('leaves the retired link hostname reaching nothing', async () => {
      // The opt-in list is consulted last, so nothing it contains takes a
      // meaning away from a hostname that already had one. `links.example.com`
      // is not on the list at all. Link mode is retired, so it no longer
      // answers 401 for a missing session — the name resolves to no share and
      // is refused like any other unknown host.
      const r = await req('/api/docs/design-doc', LINK_HOST, { headers: CF_RAY });
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: 'unknown_host' });
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

/**
 * Identity on the collaboration surface.
 *
 * A collaborator arrives with an Access-verified email and, until now, wrote
 * as `guest-<hash>` regardless — the surface knew exactly who they were and
 * threw it away. With email identity in effect the claim becomes the author.
 *
 * The half that matters more is the ABSENCE, and membership sharpened what it
 * means. A token with no email claim used to be admitted and written down as a
 * guest; now it names nobody, and nobody is a member of anything, so it reaches
 * the app shell and stops there. Guest attribution itself is still exercised on
 * the share surfaces (visitor-identity.test.ts and the share-scope suites) —
 * what this file pins is that the collaboration hostname does not admit an
 * unnamed visitor in the first place.
 */
describe('the collaboration hostname, with email identity in effect', () => {
  const dirs: string[] = [];
  const handles: ServerHandle[] = [];

  afterAll(async () => {
    for (const h of handles) await h.stop();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  interface Surface {
    port: number;
    docId: string;
    sign: (email?: string) => Promise<string>;
  }

  /** A collab-reachable server with one doc filed on a board, plus a signer
   *  whose email claim the caller chooses. */
  async function surface(): Promise<Surface> {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = (await exportJWK(publicKey)) as JWK;
    jwk.kid = 'collab-identity-kid';
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    const dataDir = mkdtempSync(join(tmpdir(), 'collab-identity-'));
    dirs.push(dataDir);
    const h = createServer({
      port: 0,
      dataDir,
      requireEmailAuth: true,
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: COLLAB_AUD, jwks: { keys: [jwk] } },
      // Share hosting configured too, for the reason spelled out in the first
      // fixture: without it the whole server falls into legacy Access mode
      // and even the local setup calls need a token. It is also what mints
      // the board's allow list below.
      share: {
        config: { ...ACCESS_SHARE_CONFIG, publicHostname: LINK_HOST },
        cfApi: mockCfApi(),
      },
      accessTunnelHosts: [TUNNEL_HOST],
    });
    handles.push(h);

    const sign = async (email?: string) =>
      await new SignJWT(email ? { email } : {})
        .setProtectedHeader({ alg: 'RS256', kid: 'collab-identity-kid' })
        .setIssuer(`https://${TEAM_DOMAIN}`)
        .setAudience(COLLAB_AUD)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
        .setSubject('cf-access-collab-identity')
        .sign(privateKey);

    const local = (path: string, init: RequestInit = {}) =>
      fetch(`http://localhost:${h.port}${path}`, {
        ...init,
        headers: {
          host: `localhost:${h.port}`,
          ...((init.headers as Record<string, string>) ?? {}),
        },
      });
    const board = await local('/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Collab identity' }),
    });
    expect(board.status, await board.clone().text()).toBe(200);
    const boardId = ((await board.json()) as { workspace: { id: string } }).workspace.id;
    const name = 'collab-identity-doc';
    const path = join(dataDir, `${name}.md`);
    writeFileSync(path, '# Doc\n\nBody to comment on.\n');
    const doc = await local('/api/docs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: name, type: 'markdown', sourceUrl: path }),
    });
    expect(doc.status).toBe(200);
    const docId = ((await doc.json()) as { docId: string }).docId;
    const filed = await local(`/workspaces/${encodeURIComponent(boardId)}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: name }),
    });
    expect(filed.status).toBe(200);
    // Who was GIVEN this board. Without it nobody reaches the doc at all and
    // these tests would be measuring the membership gate instead of identity.
    const shared = await local('/api/share/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: boardId, allowDomains: ['@example.com'] }),
    });
    expect(shared.status, await shared.clone().text()).toBe(200);
    return { port: h.port, docId, sign };
  }

  /** Comment as a collaborator claiming to be the owner; answer with the
   *  author the server actually recorded. */
  async function authorOfWrite(s: Surface, jwt: string): Promise<{ id: string; name: string }> {
    const res = await fetch(`http://localhost:${s.port}/api/docs/${s.docId}/threads/by_find`, {
      method: 'POST',
      headers: {
        host: TUNNEL_HOST,
        ...CF_RAY,
        'cf-access-jwt-assertion': jwt,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        author: { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' },
        text: 'a collaborator note',
        find: 'Body',
      }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const listed = await fetch(`http://localhost:${s.port}/api/docs/${s.docId}/threads`, {
      headers: { host: `localhost:${s.port}` },
    });
    const { threads } = (await listed.json()) as {
      threads: Array<{ comments: Array<{ author: { id: string; name: string } }> }>;
    };
    const authors = threads.flatMap((t) => t.comments.map((c) => c.author));
    expect(authors.length).toBeGreaterThan(0);
    return authors[0] as { id: string; name: string };
  }

  it('a verified email claim becomes the author, outranking the claimed body', async () => {
    const s = await surface();
    const author = await authorOfWrite(s, await s.sign('collaborator@example.com'));
    expect(author.id).toBe(emailIdentityId('collaborator@example.com'));
    expect(author.id).not.toBe('known-bryan');
  });

  it('a token with NO email claim is nobody, and nobody is a member', async () => {
    // The board's allow list is a set of addresses. A token that carries no
    // address cannot be in it, whatever the entry says — a domain entry least
    // of all, since there is no domain to compare. So the write is refused
    // before attribution is ever reached.
    const s = await surface();
    const res = await fetch(`http://localhost:${s.port}/api/docs/${s.docId}/threads/by_find`, {
      method: 'POST',
      headers: {
        host: TUNNEL_HOST,
        ...CF_RAY,
        'cf-access-jwt-assertion': await s.sign(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        author: { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' },
        text: 'a nameless note',
        find: 'Body',
      }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'out_of_share_scope' });
    // POSITIVE CONTROL: the same request with an email the board admits.
    const named = await authorOfWrite(s, await s.sign('collaborator@example.com'));
    expect(named.id).toBe(emailIdentityId('collaborator@example.com'));
    // …and the nameless one really did land nothing.
    const listed = await fetch(`http://localhost:${s.port}/api/docs/${s.docId}/threads`, {
      headers: { host: `localhost:${s.port}` },
    });
    const { threads } = (await listed.json()) as { threads: Array<{ comments: unknown[] }> };
    expect(threads).toHaveLength(1);
  });
});
