/**
 * HTTP-level coverage for the two authorization fixes (2026-08-05 review):
 *
 *   A. Default-deny by host — an unknown hostname arriving over the tunnel
 *      must be refused, not waved past the Access gate.
 *   B. Share scoping — passing Access for ONE shared workspace must not grant
 *      the rest of the server.
 *
 * host-guard.test.ts covers the predicates. These tests drive the real route
 * table, because the route layer is the part nothing type-checks — a gate
 * that returns the right decision but is wired in the wrong place, or after
 * a route that already answered, would still pass the unit tests.
 *
 * A BOARD is the unit of sharing (2026-08-17). The first suite used to mint a
 * doc-scoped share over `POST /api/share/doc`; that grant went first, and the
 * grouping-scoped share that replaced it went next. So its fixture is now two
 * one-doc grouping workspaces — `WS_SHARED` holds the doc the visitor was
 * invited to, `WS_OTHER` holds the one they must not reach — each FILED on a
 * board of its own, and the share is minted over the board. Every scope
 * assertion below is unchanged: what a share reaches, and what it must not, is
 * the same question it always was, and a board share reaches a filed
 * grouping's members through the grouping→board hop. The removals themselves
 * are asserted in their own tests ("per-doc sharing is gone", and
 * grouping-share-removed.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { type ServerHandle, createServer } from '../src/server.ts';
import { CfApi } from '../src/share/cf-api.ts';
import type { CfAccessApp, CfAccessPolicy } from '../src/share/cf-api.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const BASE_HOSTNAME = 'tunnel.example.com';
const KID = 'host-scope-kid';
const LOCAL_ALIAS = 'mac-mini-alias.example.test';

const SHARE_CONFIG = {
  cfAccountId: 'test-account',
  cfTeamDomain: TEAM_DOMAIN,
  baseHostname: BASE_HOSTNAME,
};

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
    return new Response(JSON.stringify({ error: 'unhandled' }), { status: 404 });
  };
  return new CfApi({ accountId: 'test-account', token: 'test-token', fetchImpl });
}

describe('host gate + share scoping over HTTP', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let shareHost: string;
  let shareJwt: string;
  let signJwt: (aud: string) => Promise<string>;

  const SHARED = 'shared-doc';
  const OTHER = 'other-doc';
  // Two grouping workspaces, one doc each. Docs sharing a `workspaceId` ARE a
  // grouping workspace (the same shape a diff review has), so this is the
  // smallest honest review: exactly the reach the old per-doc share had,
  // expressed in the unit that still exists.
  const WS_SHARED = 'ws-shared-doc';
  const WS_OTHER = 'ws-other-doc';
  // …and a BOARD for each, because a grouping cannot be shared on its own.
  // Board ids are server-assigned, so unlike the grouping tags above these
  // are filled in at setup.
  let boardShared: string;
  let boardOther: string;

  /** Request against the real server with an arbitrary Host header. */
  const req = (path: string, host: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { host, ...((init.headers as Record<string, string>) ?? {}) },
    });

  /** As an authenticated visitor on the share hostname. */
  const asVisitor = (path: string, init: RequestInit = {}) =>
    req(path, shareHost, {
      ...init,
      headers: {
        'cf-access-jwt-assertion': shareJwt,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const publicJwk = (await exportJWK(publicKey)) as JWK;
    publicJwk.kid = KID;
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';
    const jwks: JSONWebKeySet = { keys: [publicJwk] };

    signJwt = (aud: string) =>
      new SignJWT({ email: 'reviewer@partner.example' })
        .setProtectedHeader({ alg: 'RS256', kid: KID })
        .setIssuer(`https://${TEAM_DOMAIN}`)
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
        .setSubject('cf-access-user-1')
        .sign(privateKey);

    dataDir = mkdtempSync(join(tmpdir(), 'host-scope-'));
    handle = createServer({
      port: 0,
      dataDir,
      trustedHosts: [LOCAL_ALIAS],
      // audience is overridden by the shares registry's per-share AUD
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: 'unused', jwks },
      share: { config: SHARE_CONFIG, cfApi: makeMockCfApi({ apps: [], policies: [] }) },
    });
    base = `http://localhost:${handle.port}`;

    // Two file-backed docs in two separate workspaces; only one workspace
    // gets shared. Two workspaces rather than two loose docs because scope is
    // workspace membership now — a doc filed nowhere is reachable by nobody,
    // which would make "CANNOT read another doc" pass for the wrong reason.
    for (const [id, ws] of [
      [SHARED, WS_SHARED],
      [OTHER, WS_OTHER],
    ] as const) {
      const path = join(dataDir, `${id}.md`);
      writeFileSync(path, `# ${id}\n\nBody.\n`);
      const r = await fetch(`${base}/api/docs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: id, type: 'markdown', sourceUrl: path, workspaceId: ws }),
      });
      expect(r.status).toBe(200);
    }

    // File each grouping on a board of its own. `attach_doc` links a grouping
    // id as one row, which is how a review goes on a board; the board is then
    // the only thing the share routes will accept.
    const boardHolding = async (name: string, groupingId: string): Promise<string> => {
      const created = await fetch(`${base}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      expect(created.status).toBe(200);
      const id = ((await created.json()) as { workspace: { id: string } }).workspace.id;
      expect(id).toBeTruthy();
      const filed = await fetch(`${base}/api/workspaces/${encodeURIComponent(id)}/docs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: groupingId }),
      });
      expect(filed.status).toBe(200);
      return id;
    };
    boardShared = await boardHolding('Shared review', WS_SHARED);
    boardOther = await boardHolding('Other review', WS_OTHER);

    const sr = await fetch(`${base}/api/share/workspace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: boardShared, allowDomains: ['partner.example'] }),
    });
    expect(sr.status).toBe(200);
    const shareBody = (await sr.json()) as {
      share: { hostname: string; audience: string; docId: string; workspaceId: string };
    };
    // The URL opens the BOARD. There is no entry doc any more — `docId` is
    // empty on every record minted today — and the grant was never it: scope
    // is the board, which is what every assertion below measures.
    expect(shareBody.share.docId).toBe('');
    expect(shareBody.share.workspaceId).toBe(boardShared);
    shareHost = shareBody.share.hostname;
    shareJwt = await signJwt(shareBody.share.audience);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('A. default-deny by host', () => {
    it('refuses an unknown hostname under the share wildcard', async () => {
      // Before the fix this reached the API unauthenticated: no active
      // share owned the host, so the gate concluded "not a share → skip".
      const r = await req('/api/docs', `not-a-share.${BASE_HOSTNAME}`);
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: 'unknown_host' });
    });

    it('refuses an unrelated public hostname', async () => {
      const r = await req('/api/docs', 'attacker.example.com');
      expect(r.status).toBe(403);
    });

    it('refuses a lookalike of the share hostname', async () => {
      const r = await req('/api/docs', `${shareHost}.attacker.example.com`);
      expect(r.status).toBe(403);
      const r2 = await req('/api/docs', `evil-${shareHost}`);
      expect(r2.status).toBe(403);
    });

    it('does not leak the doc list to an unknown host even on a doc route', async () => {
      const r = await req(`/api/docs/${SHARED}`, 'attacker.example.com');
      expect(r.status).toBe(403);
      const r2 = await req(`/review/${SHARED}`, 'attacker.example.com');
      expect(r2.status).toBe(403);
    });

    it('still serves local callers unauthenticated (the agent over loopback)', async () => {
      const r = await req('/api/docs', `localhost:${handle.port}`);
      expect(r.status).toBe(200);
      const admin = await req('/api/share', `localhost:${handle.port}`);
      expect(admin.status).toBe(200);
    });

    it('honours an operator-declared trusted host', async () => {
      const r = await req('/api/docs', LOCAL_ALIAS);
      expect(r.status).toBe(200);
    });

    it('refuses a proxied request that claims a local Host', async () => {
      // The tunnel forwards the visitor's Host verbatim, so "Host: localhost"
      // from the outside must not read as loopback. cf-ray marks the hop.
      for (const host of ['localhost', '127.0.0.1', '192.168.50.227', LOCAL_ALIAS]) {
        const r = await req('/api/docs', host, { headers: { 'cf-ray': '8a1b2c3d4e5f-SJC' } });
        expect(r.status, host).toBe(403);
      }
    });

    it('a proxied request to a real share host is still gated, not denied', async () => {
      const r = await req(`/api/docs/${SHARED}`, shareHost, {
        headers: { 'cf-ray': '8a1b2c3d4e5f-SJC', 'cf-access-jwt-assertion': shareJwt },
      });
      expect(r.status).toBe(200);
    });

    it('lets OPTIONS preflight through from any host (CORS runs first)', async () => {
      const r = await req('/api/docs', 'attacker.example.com', { method: 'OPTIONS' });
      expect(r.status).toBe(204);
    });
  });

  describe('B. share host authentication', () => {
    it('demands a token on the share hostname', async () => {
      const r = await req(`/api/docs/${SHARED}`, shareHost);
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: 'missing_jwt' });
    });

    it('rejects a token minted for a different share', async () => {
      const wrong = await signJwt('aud-for-some-other-share');
      const r = await req(`/api/docs/${SHARED}`, shareHost, {
        headers: { 'cf-access-jwt-assertion': wrong },
      });
      expect(r.status).toBe(401);
    });
  });

  describe('B. share scoping (authenticated visitor)', () => {
    it('can read the doc it was shared', async () => {
      const r = await asVisitor(`/api/docs/${SHARED}`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { meta: { docId: string } };
      expect(body.meta.docId).toBe(SHARED);
    });

    it('can reach its own review page and event stream route', async () => {
      // Not asserting 200 — the markdown-app dist isn't built in tests.
      // What matters is that the scope check doesn't refuse them.
      //
      // No `redirect: 'manual'`, deliberately: `/review/<docId>` now
      // redirects to the workspace path, and following it is what a browser
      // does. That makes this assertion cover the redirect TARGET too, which
      // is where this broke — the target named whichever workspace held the
      // doc first, and the guard refused a visitor at the URL the product had
      // just handed them.
      expect((await asVisitor(`/review/${SHARED}`)).status).not.toBe(403);
      expect((await asVisitor(`/api/docs/${SHARED}/threads`)).status).not.toBe(403);
    });

    it('is redirected to the workspace it was shared, not to some other one', async () => {
      const r = await asVisitor(`/review/${SHARED}`, { redirect: 'manual' });
      expect(r.status).toBe(302);
      expect(r.headers.get('location')).toBe(
        `/workspaces/${boardShared}/docs/${encodeURIComponent(SHARED)}`,
      );
    });

    it('CANNOT enumerate every doc on the server', async () => {
      const r = await asVisitor('/api/docs');
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: 'out_of_share_scope' });
    });

    it('CANNOT read another doc', async () => {
      expect((await asVisitor(`/api/docs/${OTHER}`)).status).toBe(403);
      expect((await asVisitor(`/review/${OTHER}`)).status).toBe(403);
      expect((await asVisitor(`/api/docs/${OTHER}/threads`)).status).toBe(403);
    });

    it("CANNOT open another doc's websocket route", async () => {
      // Plain GET: the gate must answer before the upgrade handler.
      expect((await asVisitor(`/y/${OTHER}`)).status).toBe(403);
      expect((await asVisitor(`/events/${OTHER}`)).status).toBe(403);
    });

    it('CANNOT list, mint, or revoke shares', async () => {
      expect((await asVisitor('/api/share')).status).toBe(403);
      // Both live mint routes, and the retired one. `/api/share/doc` answers
      // 410 to a LOCAL caller — 403 here is the point: the gate is an
      // allowlist that runs before any route, so a visitor never learns which
      // share routes exist, let alone which were removed.
      const mintWs = await asVisitor('/api/share/workspace', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: WS_OTHER, allowDomains: ['attacker.example'] }),
      });
      expect(mintWs.status).toBe(403);
      const mintLink = await asVisitor('/api/share/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: WS_OTHER }),
      });
      expect(mintLink.status).toBe(403);
      const mintDoc = await asVisitor('/api/share/doc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: OTHER, allowDomains: ['attacker.example'] }),
      });
      expect(mintDoc.status).toBe(403);
      expect((await asVisitor('/api/share/some-id', { method: 'DELETE' })).status).toBe(403);
    });

    it('CANNOT bind a folder or create a diff review (arbitrary filesystem read)', async () => {
      const ws = await asVisitor('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ folderPath: '/etc' }),
      });
      expect(ws.status).toBe(403);
      const diff = await asVisitor('/api/diffs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo: '/', base: 'HEAD' }),
      });
      expect(diff.status).toBe(403);
    });

    it('CANNOT delete the shared doc or replace its content', async () => {
      expect((await asVisitor(`/api/docs/${SHARED}`, { method: 'DELETE' })).status).toBe(403);
      const rewrite = await asVisitor(`/api/docs/${SHARED}/content`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ markdown: '# Wiped\n' }),
      });
      expect(rewrite.status).toBe(403);
      expect(
        (await asVisitor(`/api/docs/${SHARED}/reparse_from_disk`, { method: 'POST' })).status,
      ).toBe(403);
    });

    it('CANNOT create a doc bound to an arbitrary path', async () => {
      const r = await asVisitor('/api/docs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: 'evil', type: 'markdown', sourceUrl: '/etc/hosts' }),
      });
      expect(r.status).toBe(403);
    });

    it('CANNOT list ANOTHER workspace’s tree — the share is one workspace', async () => {
      // This used to read "a DOC share stays one doc": sharing a doc never
      // widened to the workspace holding it. There is no doc share left to
      // widen, so what it now proves is the boundary that replaced it — a
      // workspace share reaches its OWN workspace and stops at the edge of it.
      // Positive control first, or the refusals below would pass on a visitor
      // who can reach no workspace at all.
      expect((await asVisitor(`/api/workspaces/${WS_SHARED}/tree`)).status).toBe(200);
      // `grouped` and `files` answer 404 on a one-doc grouping (no diff groups,
      // no repo root) — asserting 200 would be asserting the fixture. What is
      // under test is the GATE, so: past it for its own workspace, refused for
      // the other one.
      for (const sub of ['tree', 'grouped', 'files']) {
        expect((await asVisitor(`/api/workspaces/${WS_SHARED}/${sub}`)).status, sub).not.toBe(403);
        expect((await asVisitor(`/api/workspaces/${WS_OTHER}/${sub}`)).status, sub).toBe(403);
      }
    });

    it('can load the app shell it needs to render the review', async () => {
      expect((await asVisitor('/app/app.js')).status).not.toBe(403);
    });
  });

  describe('B. per-doc and per-grouping sharing are gone — a board is the unit', () => {
    // The suite above used to mint its share with `POST /api/share/doc`. That
    // grant is retired, and these are LOCAL calls (the visitor can reach
    // neither route — a sibling test proves that) so what they measure is the
    // mint path itself, not the host gate.
    it('refuses to mint a doc share, and names the replacement', async () => {
      const r = await req('/api/share/doc', `localhost:${handle.port}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: OTHER, allowDomains: ['partner.example'] }),
      });
      expect(r.status).toBe(410);
      const body = (await r.json()) as { error: string; hint?: string };
      expect(body.error).toBe('per_doc_sharing_removed');
      expect(body.hint).toContain('workspace');
    });

    it('refuses a share_link that still carries a docId', async () => {
      // An older plugin bundle keeps POSTing the payload ITS build sends. The
      // dangerous reading is "ignore the field you don't know and mint
      // something" — a link scoped to a workspace the caller never named.
      const list = async () => {
        const listed = await req('/api/share', `localhost:${handle.port}`);
        return ((await listed.json()) as { shares: Array<{ docId: string }> }).shares;
      };
      const before = await list();
      const r = await req('/api/share/link', `localhost:${handle.port}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: OTHER }),
      });
      expect(r.status).toBe(410);
      expect((await r.json()) as { error: string }).toMatchObject({
        error: 'per_doc_sharing_removed',
      });
      // …and nothing was created behind the refusal. Asserted as a COUNT, not
      // as "no share names OTHER": the refusal has to be that no share was
      // minted, whatever it would have been scoped to.
      expect(await list()).toHaveLength(before.length);
    });

    it('POSITIVE CONTROL: a BOARD share still mints', async () => {
      // Without this the two refusals above would pass on a server that has
      // stopped minting shares altogether. Access mode, because this fixture
      // configures no `publicHostname` — link mode's own mint is controlled
      // the same way in share-grouping-scope.test.ts.
      //
      // Over the BOARD, not the grouping `WS_OTHER` it holds: a grouping is no
      // longer shareable on its own, so passing one here would make the control
      // a 410 and the whole suite would pass on a dead share stack.
      const mint = await req('/api/share/workspace', `localhost:${handle.port}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: boardOther, allowDomains: ['partner.example'] }),
      });
      expect(mint.status).toBe(200);
      const { share } = (await mint.json()) as {
        share: { shareId: string; workspaceId: string; docId: string };
      };
      expect(share.workspaceId).toBe(boardOther);
      // A board share opens the board, so there is no entry doc on the record.
      expect(share.docId).toBe('');
      // Clean up so the expiry suite below still finds exactly one Access
      // share on `shareHost`.
      await req(`/api/share/${share.shareId}`, `localhost:${handle.port}`, { method: 'DELETE' });
    });

    it('refuses the GROUPING the board holds, and says so by name', async () => {
      // The grouping id is real and the caller is not wrong about it — the
      // capability is what went away — so it answers 410 rather than the 404 an
      // unrecognised id gets. Paired with the board control above, which runs
      // against the same server in the same suite.
      const r = await req('/api/share/workspace', `localhost:${handle.port}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: WS_OTHER, allowDomains: ['partner.example'] }),
      });
      expect(r.status).toBe(410);
      expect(((await r.json()) as { error: string }).error).toBe('grouping_sharing_removed');
    });

    it('refuses a share_link with no workspace at all', async () => {
      const r = await req('/api/share/link', `localhost:${handle.port}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'nothing in scope' }),
      });
      expect(r.status).toBe(400);
      expect((await r.json()) as { error: string }).toMatchObject({
        error: 'workspaceId required',
      });
    });
  });

  describe('C. an expired share host stops being a share host', () => {
    // Link mode re-checks liveness on every request (linkSessionTarget uses
    // findLive). Access mode resolved the host with findByHostname, which does
    // not look at expiresAt — so a share past its TTL still classified as a
    // share, still passed the Access gate, and served the doc. Closing its
    // websockets (the sweep) didn't help: the visitor just reconnected.
    it('serves the doc while the share is live', async () => {
      // POSITIVE CONTROL for the assertion below.
      expect((await asVisitor(`/api/docs/${SHARED}`)).status).toBe(200);
    });

    it('refuses every request on the hostname once the TTL has passed', async () => {
      const share = handle.shares?.list().find((s) => s.hostname === shareHost);
      expect(share).toBeTruthy();
      const restore = share?.expiresAt ?? 0;
      if (share) share.expiresAt = Date.now() - 1;
      try {
        const r = await asVisitor(`/api/docs/${SHARED}`);
        expect(r.status).toBe(403);
        expect(await r.json()).toEqual({ error: 'unknown_host' });
        // ...and it can't reconnect its websocket either.
        expect((await asVisitor(`/review/${SHARED}`)).status).toBe(403);
      } finally {
        if (share) share.expiresAt = restore;
      }
    });

    it('works again once the share is live — the host itself is not blacklisted', async () => {
      expect((await asVisitor(`/api/docs/${SHARED}`)).status).toBe(200);
    });
  });
});

/**
 * Board shares: the reviewer gets the whole folder filed on the board — tree,
 * every member, lazy opens — and nothing outside it.
 */
describe('workspace share over HTTP', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let folder: string;
  let base: string;
  let shareHost: string;
  let shareJwt: string;
  /** The board the share is minted over. */
  let boardId: string;
  /** The folder bind filed on it — a GROUPING, reached through the hop. */
  let workspaceId: string;
  let entryDocId: string;
  let outsideDocId: string;

  const req = (path: string, host: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { host, ...((init.headers as Record<string, string>) ?? {}) },
    });
  const asVisitor = (path: string, init: RequestInit = {}) =>
    req(path, shareHost, {
      ...init,
      headers: {
        'cf-access-jwt-assertion': shareJwt,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const publicJwk = (await exportJWK(publicKey)) as JWK;
    publicJwk.kid = KID;
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';
    const jwks: JSONWebKeySet = { keys: [publicJwk] };

    dataDir = mkdtempSync(join(tmpdir(), 'ws-share-data-'));
    folder = mkdtempSync(join(tmpdir(), 'ws-share-folder-'));
    mkdirSync(join(folder, 'sub'), { recursive: true });
    writeFileSync(join(folder, 'README.md'), '# Entry\n\nRead me.\n');
    writeFileSync(join(folder, 'design.md'), '# Design\n\nThe plan.\n');
    writeFileSync(join(folder, 'sub', 'notes.md'), '# Notes\n\nDetail.\n');

    handle = createServer({
      port: 0,
      dataDir,
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: 'unused', jwks },
      share: { config: SHARE_CONFIG, cfApi: makeMockCfApi({ apps: [], policies: [] }) },
    });
    base = `http://localhost:${handle.port}`;

    // The board first, then the bind FILED on it in the same call — that is
    // the whole prerequisite a board-only share adds to this flow.
    const board = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Folder review' }),
    });
    expect(board.status).toBe(200);
    boardId = ((await board.json()) as { workspace: { id: string } }).workspace.id;
    expect(boardId).toBeTruthy();

    const bind = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderPath: folder, hubWorkspaceId: boardId }),
    });
    expect(bind.status).toBe(200);
    const bound = (await bind.json()) as {
      workspaceId: string;
      files: Array<{ docId: string; relPath: string }>;
    };
    workspaceId = bound.workspaceId;
    entryDocId = bound.files[0]?.docId ?? '';
    expect(entryDocId).not.toBe('');
    expect(workspaceId).not.toBe(boardId);

    // A doc that is NOT part of the workspace — the thing scoping must hide.
    outsideDocId = 'private-doc';
    const outsidePath = join(dataDir, 'private.md');
    writeFileSync(outsidePath, '# Private\n\nNot shared.\n');
    await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: outsideDocId, type: 'markdown', sourceUrl: outsidePath }),
    });

    const sr = await fetch(`${base}/api/share/workspace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: boardId, allowDomains: ['partner.example'] }),
    });
    expect(sr.status).toBe(200);
    const shareBody = (await sr.json()) as {
      share: { hostname: string; audience: string; url: string; workspaceId?: string };
    };
    shareHost = shareBody.share.hostname;
    expect(shareBody.share.workspaceId).toBe(boardId);
    // The share opens the board; the folder is reached because it is filed on
    // it, which is what every assertion below actually exercises.
    expect(shareBody.share.url).toBe(
      `https://${shareHost}/workspaces/${encodeURIComponent(boardId)}`,
    );
    shareJwt = await new SignJWT({ email: 'reviewer@partner.example' })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(`https://${TEAM_DOMAIN}`)
      .setAudience(shareBody.share.audience)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .setSubject('cf-access-user-2')
      .sign(privateKey);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  it('still demands a token', async () => {
    expect((await req(`/api/docs/${entryDocId}`, shareHost)).status).toBe(401);
  });

  it('can read the entry doc and the workspace tree', async () => {
    expect((await asVisitor(`/api/docs/${encodeURIComponent(entryDocId)}`)).status).toBe(200);
    const tree = await asVisitor(`/api/workspaces/${encodeURIComponent(workspaceId)}/tree`);
    expect(tree.status).toBe(200);
  });

  it('can open a sibling lazily and then read it — the whole point', async () => {
    // bind_folder binds only the entry; this is how the rest come into being.
    const opened = await asVisitor(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/editable-file`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relPath: 'design.md' }),
      },
    );
    expect(opened.status).toBe(200);
    const { docId } = (await opened.json()) as { docId: string };
    expect(docId).not.toBe(entryDocId);
    // …and the newly-bound member is in scope for reading + commenting.
    expect((await asVisitor(`/api/docs/${encodeURIComponent(docId)}`)).status).toBe(200);
    expect((await asVisitor(`/review/${encodeURIComponent(docId)}`)).status).not.toBe(403);
    expect((await asVisitor(`/api/docs/${encodeURIComponent(docId)}/threads`)).status).toBe(200);
  });

  it('cannot escape the workspace root via relPath', async () => {
    const r = await asVisitor(`/api/workspaces/${encodeURIComponent(workspaceId)}/context-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ relPath: '../../etc/hosts' }),
    });
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: 'bad-path' });
  });

  it('CANNOT reach a doc outside the workspace', async () => {
    expect((await asVisitor(`/api/docs/${outsideDocId}`)).status).toBe(403);
    expect((await asVisitor(`/review/${outsideDocId}`)).status).toBe(403);
    expect((await asVisitor(`/y/${outsideDocId}`)).status).toBe(403);
  });

  it('CANNOT enumerate docs or workspaces, or manage shares', async () => {
    expect((await asVisitor('/api/docs')).status).toBe(403);
    expect((await asVisitor('/api/workspaces')).status).toBe(403);
    expect((await asVisitor('/api/share')).status).toBe(403);
  });

  it('CANNOT delete a member doc or rewrite it wholesale', async () => {
    expect(
      (await asVisitor(`/api/docs/${encodeURIComponent(entryDocId)}`, { method: 'DELETE' })).status,
    ).toBe(403);
    const rewrite = await asVisitor(`/api/docs/${encodeURIComponent(entryDocId)}/content`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ markdown: '# Wiped\n' }),
    });
    expect(rewrite.status).toBe(403);
    // …and the doc is intact.
    const still = await req(
      `/api/docs/${encodeURIComponent(entryDocId)}`,
      `localhost:${handle.port}`,
    );
    expect(still.status).toBe(200);
  });

  it('refuses a bookmarked /review/<gone doc> instead of repairing it', async () => {
    // This used to assert a REPAIR: an Access share handed out
    // /review/<entryDocId> directly and was never redeemed, so a renamed entry
    // file left that emailed URL pointing at nothing and the server redirected
    // it to whatever the workspace's current entry was.
    //
    // A board share has no entry doc — its URL is `/workspaces/<board>`, which
    // cannot go stale when a file is renamed — so there is nothing left to
    // repair and the whole resolution step is gone. What a stale
    // `/review/<docId>` gets now is the ordinary out-of-scope 403: the id names
    // no doc, so it is in no workspace, so the share does not cover it.
    //
    // Same setup as before — give the workspace a survivor, then drop the old
    // entry doc — because the survivor is the positive control: the share is
    // demonstrably still live and still reaching its members.
    const opened = await asVisitor(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/editable-file`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relPath: 'design.md' }),
      },
    );
    const survivor = ((await opened.json()) as { docId: string }).docId;
    await fetch(`${base}/api/docs/${encodeURIComponent(entryDocId)}?force=true`, {
      method: 'DELETE',
      headers: { host: `localhost:${handle.port}` },
    });

    const r = await asVisitor(`/review/${encodeURIComponent(entryDocId)}`, { redirect: 'manual' });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'out_of_share_scope' });
    // Positive control: the surviving member is still reachable, so the 403
    // above is about that one id and not about a share that stopped working.
    expect((await asVisitor(`/review/${encodeURIComponent(survivor)}`)).status).not.toBe(403);
  });

  it('gives a doc outside the share the SAME answer as one that is gone', async () => {
    // The pair is the point, and it survives the repair's removal intact: a
    // docId that exists elsewhere and a docId that exists nowhere must be
    // indistinguishable, or a visitor can enumerate which ids are real. The
    // sibling test above pins the gone half at 403; this pins the exists-
    // elsewhere half at the same 403, with the same body.
    const r = await asVisitor(`/review/${encodeURIComponent(outsideDocId)}`, {
      redirect: 'manual',
    });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'out_of_share_scope' });
    const never = await asVisitor('/review/no-such-doc-anywhere', { redirect: 'manual' });
    expect(never.status).toBe(403);
    expect(await never.json()).toEqual({ error: 'out_of_share_scope' });
  });

  it('is not shown the absolute paths or the tailnet host', async () => {
    // GET /api/docs/<id> is IN a visitor's scope — they need it to render —
    // but the full DocMeta describes Bryan's machine, not the document.
    const opened = await asVisitor(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/editable-file`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relPath: 'design.md' }),
      },
    );
    const target = ((await opened.json()) as { docId: string }).docId;
    const r = await asVisitor(`/api/docs/${encodeURIComponent(target)}`);
    expect(r.status).toBe(200);
    const raw = await r.text();
    expect(raw).not.toContain('/Volumes/');
    expect(raw).not.toContain('tailb53801');
    expect(raw).not.toContain('.ts.net');
    const { meta } = JSON.parse(raw) as { meta: Record<string, unknown> };
    expect(meta.sourceUrl).toBeUndefined();
    expect(meta.owner).toBeUndefined();
    expect(meta.workspaceRoot).toBeUndefined();
    // …while still carrying what the editor needs.
    expect(meta.docId).toBe(target);
    expect(meta.relPath).toBe('design.md');
  });

  it('still gives the OWNER the full metadata over the tailnet', async () => {
    const r = await req(`/api/docs/${encodeURIComponent(entryDocId)}`, `localhost:${handle.port}`);
    if (r.status === 200) {
      const { meta } = (await r.json()) as { meta: Record<string, unknown> };
      expect(meta.sourceUrl).toBeDefined();
    }
  });

  it('CANNOT post a comment signed as Bryan', async () => {
    // The write endpoints take `author` straight from the body. On the
    // tailnet that's fine; from a share link it means a stranger could sign
    // feedback as the person who asked for it.
    // Its own doc, not the shared entry — a sibling test deletes that one.
    const opened = await asVisitor(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/editable-file`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relPath: 'design.md' }),
      },
    );
    const target = ((await opened.json()) as { docId: string }).docId;
    const r = await asVisitor(`/api/docs/${encodeURIComponent(target)}/threads/by_find`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author: { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' },
        text: 'looks great, ship it',
        find: 'plan',
      }),
    });
    expect(r.status).toBe(200);
    const listed = await req(
      `/api/docs/${encodeURIComponent(target)}/threads`,
      `localhost:${handle.port}`,
    );
    const { threads } = (await listed.json()) as {
      threads: Array<{ comments: Array<{ author: { id: string; name: string } }> }>;
    };
    const authors = threads.flatMap((t) => t.comments.map((c) => c.author));
    expect(authors.length).toBeGreaterThan(0);
    for (const a of authors) {
      expect(a.id).not.toBe('known-bryan');
      expect(a.id).toStartWith('guest-');
      expect(a.name).not.toBe('Bryan');
    }
  });

  it('CANNOT record reading activity as Bryan by omitting the author', async () => {
    // /activity used to DEFAULT to Bryan when no author was sent.
    const opened = await asVisitor(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/editable-file`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relPath: 'design.md' }),
      },
    );
    const target = ((await opened.json()) as { docId: string }).docId;
    const r = await asVisitor(`/api/docs/${encodeURIComponent(target)}/activity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'doc_open', payload: {} }),
    });
    expect(r.status).toBe(200);
    const feed = await req('/api/activity', `localhost:${handle.port}`);
    if (feed.status === 200) {
      const body = (await feed.json()) as {
        events?: Array<{ actor?: { id?: string; name?: string } }>;
      };
      for (const e of body.events ?? []) {
        expect(e.actor?.id).not.toBe('known-bryan');
      }
    }
  });

  it("CANNOT reshape the workspace — refresh and regroup are the owner's calls", async () => {
    // A visitor reads and comments. Deciding which files are under review,
    // and how the sidebar organizes them, stays with whoever shared it.
    for (const sub of ['refresh', 'groups']) {
      const r = await asVisitor(`/api/workspaces/${encodeURIComponent(workspaceId)}/${sub}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ groups: [] }),
      });
      expect(r.status).toBe(403);
    }
  });

  it('CANNOT delete the workspace', async () => {
    const r = await asVisitor(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
      method: 'DELETE',
    });
    expect(r.status).toBe(403);
    // …and it really is still there.
    expect((await req('/api/workspaces', `localhost:${handle.port}`)).status).toBe(200);
  });

  it('rejects an entryDocId — any entryDocId, not just a foreign one', async () => {
    // This used to be "rejects an entryDocId that belongs to another
    // workspace", which was a scope check on a field that no longer exists: a
    // board share opens the board, so there is no entry doc to choose and the
    // key is refused outright. Widened rather than dropped, because the case
    // it used to cover is now a strict subset — and the assertion is on the
    // ERROR TEXT as well as the status, since a 400 alone would still be
    // satisfied by the old foreign-doc check and say nothing about the removal.
    for (const candidate of [outsideDocId, entryDocId]) {
      const r = await fetch(`${base}/api/share/workspace`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: boardId,
          entryDocId: candidate,
          allowDomains: ['partner.example'],
        }),
      });
      expect(r.status, candidate).toBe(400);
      expect(((await r.json()) as { error: string }).error).toContain('entryDocId');
    }
    // Positive control: drop the field and the same call mints.
    const ok = await fetch(`${base}/api/share/workspace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: boardId, allowDomains: ['partner.example'] }),
    });
    expect(ok.status).toBe(200);
    const { share } = (await ok.json()) as { share: { shareId: string } };
    await fetch(`${base}/api/share/${share.shareId}`, {
      method: 'DELETE',
      headers: { host: `localhost:${handle.port}` },
    });
  });

  it('404s on an unknown workspace, and 410s on the grouping the board holds', async () => {
    const r = await fetch(`${base}/api/share/workspace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'no-such-ws', allowDomains: ['partner.example'] }),
    });
    expect(r.status).toBe(404);
    // The two must not collapse: the folder bind is a real id whose SHARING
    // went away, and a peer whose review stopped sharing has to be able to tell
    // that from "your review vanished".
    const grouping = await fetch(`${base}/api/share/workspace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId, allowDomains: ['partner.example'] }),
    });
    expect(grouping.status).toBe(410);
    expect(((await grouping.json()) as { error: string }).error).toBe('grouping_sharing_removed');
  });
});
