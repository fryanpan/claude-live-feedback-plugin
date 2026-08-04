import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { CfApi } from '../src/share/cf-api.ts';
import type { CfAccessApp, CfAccessPolicy } from '../src/share/cf-api.ts';

const SHARE_CONFIG = {
  cfAccountId: 'test-account',
  cfTeamDomain: 'test.cloudflareaccess.com',
  baseHostname: 'tunnel.fryanpan.com',
};

function makeMockCfApi(state: { apps: CfAccessApp[]; policies: CfAccessPolicy[] }) {
  // Use `any` for the fetch shape — Bun adds `preconnect` to the global
  // fetch which the structural type then requires; mock fetches don't
  // need it. The CfApi only ever calls the function form.
  // biome-ignore lint/suspicious/noExplicitAny: Bun fetch type compatibility
  const fetchImpl: any = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    if (method === 'POST' && url.endsWith('/access/apps')) {
      const body = JSON.parse(init!.body as string);
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
      const body = JSON.parse(init!.body as string);
      const policy: CfAccessPolicy = {
        id: `policy-${state.policies.length + 1}`,
        name: body.name,
        decision: body.decision,
      };
      state.policies.push(policy);
      return new Response(JSON.stringify({ success: true, result: policy }), { status: 200 });
    }
    const appMatch = url.match(/access\/apps\/([^/]+)$/);
    if (method === 'DELETE' && appMatch) {
      const appId = appMatch[1]!;
      const idx = state.apps.findIndex((a) => a.id === appId);
      if (idx >= 0) state.apps.splice(idx, 1);
      return new Response(JSON.stringify({ success: true, result: null }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'unhandled' }), { status: 404 });
  };
  return new CfApi({ accountId: 'test-account', token: 'test-token', fetchImpl });
}

describe('share REST endpoints', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let cfState: { apps: CfAccessApp[]; policies: CfAccessPolicy[] };

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'share-test-'));
    cfState = { apps: [], policies: [] };
    handle = createServer({
      port: 0,
      dataDir,
      share: { config: SHARE_CONFIG, cfApi: makeMockCfApi(cfState) },
    });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('rejects share creation when sharing is not enabled', async () => {
    // Spin up a second server *without* the share option
    const dd = mkdtempSync(join(tmpdir(), 'share-noshare-'));
    const h = createServer({ port: 0, dataDir: dd });
    const r = await fetch(`http://localhost:${h.port}/api/share/doc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'x', allowDomains: ['@x.com'] }),
    });
    expect(r.status).toBe(404);
    await h.stop();
    rmSync(dd, { recursive: true, force: true });
  });

  it('rejects share for a doc that does not exist', async () => {
    const r = await fetch(`${base}/api/share/doc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'no-such-doc', allowDomains: ['@partner-org.example'] }),
    });
    expect(r.status).toBe(404);
  });

  it('rejects share with empty allowDomains', async () => {
    // Create a doc first
    const md = join(dataDir, 'real.md');
    writeFileSync(md, '# real\n');
    const create = await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'real-1', type: 'markdown', sourceUrl: md }),
    });
    expect(create.status).toBe(200);

    const r = await fetch(`${base}/api/share/doc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'real-1', allowDomains: [] }),
    });
    expect(r.status).toBe(400);
  });

  it('creates a share for an existing markdown doc', async () => {
    const r = await fetch(`${base}/api/share/doc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        docId: 'real-1',
        allowDomains: ['@partner-org.example'],
        name: 'fixed-slug',
      }),
    });
    expect(r.status).toBe(200);
    const { share } = (await r.json()) as {
      share: { hostname: string; url: string; aud?: string };
    };
    expect(share.hostname).toBe('share-fixed-slug.tunnel.fryanpan.com');
    expect(share.url).toBe('https://share-fixed-slug.tunnel.fryanpan.com/review/real-1');
    expect(cfState.apps).toHaveLength(1);
    expect(cfState.policies).toHaveLength(1);
  });

  it('lists active shares', async () => {
    const r = await fetch(`${base}/api/share`);
    const { shares } = (await r.json()) as { shares: { docId: string }[] };
    expect(shares.length).toBeGreaterThanOrEqual(1);
    expect(shares.some((s) => s.docId === 'real-1')).toBe(true);
  });

  it('revokes a share via DELETE', async () => {
    const list = await fetch(`${base}/api/share`).then(
      (r) => r.json() as Promise<{ shares: { shareId: string }[] }>,
    );
    const shareId = list.shares[0]!.shareId;
    const r = await fetch(`${base}/api/share/${shareId}`, { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect(cfState.apps).toHaveLength(0);
    const after = await fetch(`${base}/api/share`).then(
      (r) => r.json() as Promise<{ shares: unknown[] }>,
    );
    expect(after.shares).toHaveLength(0);
  });

  it('persists shares across server restart', async () => {
    // create a fresh share
    const md = join(dataDir, 'persist.md');
    writeFileSync(md, '# persist\n');
    await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'persist-1', type: 'markdown', sourceUrl: md }),
    });
    await fetch(`${base}/api/share/doc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'persist-1', allowDomains: ['@x.com'], name: 'p' }),
    });

    // restart with same dataDir
    await handle.stop();
    cfState = { apps: cfState.apps, policies: cfState.policies };
    handle = createServer({
      port: 0,
      dataDir,
      share: { config: SHARE_CONFIG, cfApi: makeMockCfApi(cfState) },
    });
    base = `http://localhost:${handle.port}`;

    const list = await fetch(`${base}/api/share`).then(
      (r) => r.json() as Promise<{ shares: { docId: string }[] }>,
    );
    expect(list.shares.some((s) => s.docId === 'persist-1')).toBe(true);
  });
});
