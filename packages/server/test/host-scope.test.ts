/**
 * HTTP-level coverage for the two authorization fixes (2026-08-05 review):
 *
 *   A. Default-deny by host — an unknown hostname arriving over the tunnel
 *      must be refused, not waved past the Access gate.
 *   B. Share scoping — passing Access for ONE shared doc must not grant the
 *      rest of the server.
 *
 * host-guard.test.ts covers the predicates. These tests drive the real route
 * table, because the route layer is the part nothing type-checks — a gate
 * that returns the right decision but is wired in the wrong place, or after
 * a route that already answered, would still pass the unit tests.
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

    // Two file-backed docs; only one of them gets shared.
    for (const id of [SHARED, OTHER]) {
      const path = join(dataDir, `${id}.md`);
      writeFileSync(path, `# ${id}\n\nBody.\n`);
      const r = await fetch(`${base}/api/docs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: id, type: 'markdown', sourceUrl: path }),
      });
      expect(r.status).toBe(200);
    }

    const sr = await fetch(`${base}/api/share/doc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: SHARED, allowDomains: ['partner.example'] }),
    });
    expect(sr.status).toBe(200);
    const shareBody = (await sr.json()) as { share: { hostname: string; audience: string } };
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
      expect((await asVisitor(`/review/${SHARED}`)).status).not.toBe(403);
      expect((await asVisitor(`/api/docs/${SHARED}/threads`)).status).not.toBe(403);
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
      const mint = await asVisitor('/api/share/doc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: OTHER, allowDomains: ['attacker.example'] }),
      });
      expect(mint.status).toBe(403);
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

    it('CANNOT list a workspace tree — a DOC share stays one doc', async () => {
      // Sharing one doc never widens to its workspace. share_workspace
      // (below) is the way to let a reviewer browse the whole set.
      expect((await asVisitor('/api/workspaces/ws-1/tree')).status).toBe(403);
      expect((await asVisitor('/api/workspaces/ws-1/grouped')).status).toBe(403);
      expect((await asVisitor('/api/workspaces/ws-1/files')).status).toBe(403);
    });

    it('can load the app shell it needs to render the review', async () => {
      expect((await asVisitor('/app/app.js')).status).not.toBe(403);
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
 * Workspace shares: the reviewer gets the whole folder — tree, every member,
 * lazy opens — and nothing outside it.
 */
describe('workspace share over HTTP', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let folder: string;
  let base: string;
  let shareHost: string;
  let shareJwt: string;
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

    const bind = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderPath: folder }),
    });
    expect(bind.status).toBe(200);
    const bound = (await bind.json()) as {
      workspaceId: string;
      files: Array<{ docId: string; relPath: string }>;
    };
    workspaceId = bound.workspaceId;
    entryDocId = bound.files[0]?.docId ?? '';
    expect(entryDocId).not.toBe('');

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
      body: JSON.stringify({ workspaceId, allowDomains: ['partner.example'] }),
    });
    expect(sr.status).toBe(200);
    const shareBody = (await sr.json()) as {
      share: { hostname: string; audience: string; url: string; workspaceId?: string };
    };
    shareHost = shareBody.share.hostname;
    expect(shareBody.share.workspaceId).toBe(workspaceId);
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

  it('repairs a share URL whose entry doc is gone', async () => {
    // An Access share hands out /review/<entryDocId> directly and is never
    // redeemed, so there is no other moment to re-resolve it. Renaming the
    // entry file used to leave that emailed URL pointing at nothing.
    // Give the workspace a survivor, then drop the entry doc — the same
    // "entry is gone" state a renamed entry file produces, reachable here
    // without the folder (setup deletes it).
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
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe(`/review/${encodeURIComponent(survivor)}`);
  });

  it('does not turn the repair into an oracle for docs outside the share', async () => {
    // A docId that EXISTS elsewhere must stay a 403, not a redirect —
    // otherwise the repair would confirm which ids are real.
    const r = await asVisitor(`/review/${encodeURIComponent(outsideDocId)}`, {
      redirect: 'manual',
    });
    expect(r.status).toBe(403);
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

  it('rejects an entryDocId that belongs to another workspace', async () => {
    const r = await fetch(`${base}/api/share/workspace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId,
        entryDocId: outsideDocId,
        allowDomains: ['partner.example'],
      }),
    });
    expect(r.status).toBe(400);
  });

  it('404s on an unknown workspace', async () => {
    const r = await fetch(`${base}/api/share/workspace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'no-such-ws', allowDomains: ['partner.example'] }),
    });
    expect(r.status).toBe(404);
  });
});
