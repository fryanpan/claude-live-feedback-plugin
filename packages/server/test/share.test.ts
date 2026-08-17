/**
 * Access-mode sharing through the real route table.
 *
 * **A workspace is the unit of sharing** (2026-08-17), so every share minted
 * here goes through `POST /api/share/workspace` over a folder bind. This file
 * used to drive `POST /api/share/doc`, which is now a 410 that names the
 * replacement — asserted below rather than deleted, because an older plugin
 * bundle's `share_doc` still POSTs there and the useful behaviour is the
 * refusal, not a 404 that reads as "your server is broken".
 */
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
  let folder: string;
  let base: string;
  let cfState: { apps: CfAccessApp[]; policies: CfAccessPolicy[] };
  /** A folder bind — the unit of sharing, and the fixture every share below
   *  is minted over. `entryDocId` is its only member. */
  let workspaceId: string;
  let entryDocId: string;

  const shareWorkspace = (body: Record<string, unknown>) =>
    fetch(`${base}/api/share/workspace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'share-test-'));
    folder = mkdtempSync(join(tmpdir(), 'share-test-src-'));
    writeFileSync(join(folder, 'real.md'), '# real\n');
    cfState = { apps: [], policies: [] };
    handle = createServer({
      port: 0,
      dataDir,
      share: { config: SHARE_CONFIG, cfApi: makeMockCfApi(cfState) },
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
      files: Array<{ docId: string }>;
    };
    workspaceId = bound.workspaceId;
    entryDocId = bound.files[0]?.docId ?? '';
    expect(entryDocId).not.toBe('');
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  it('rejects share creation when sharing is not enabled', async () => {
    // Spin up a second server *without* the share option. Probed through
    // /api/share/workspace rather than /api/share/doc, which now answers 410
    // unconditionally and would say nothing about whether sharing is wired.
    const dd = mkdtempSync(join(tmpdir(), 'share-noshare-'));
    const h = createServer({ port: 0, dataDir: dd });
    const r = await fetch(`http://localhost:${h.port}/api/share/workspace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'x', allowDomains: ['@x.com'] }),
    });
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: string }).error).toBe('sharing not enabled');
    // Positive control: the SAME request shape on the share-enabled server
    // gets past that check (it fails on the unknown workspace instead).
    const enabled = await shareWorkspace({ workspaceId: 'x', allowDomains: ['@x.com'] });
    expect(((await enabled.json()) as { error: string }).error).toBe('workspace not found');
    await h.stop();
    rmSync(dd, { recursive: true, force: true });
  });

  /**
   * `POST /api/share/doc` is the per-doc mint, and it is gone. It answers by
   * name instead of falling through to a 404 because peers keep calling the
   * shared server with the payload THEIR bundle sends, long after this one
   * stopped sending it — so the reply has to name the replacement.
   */
  it('refuses to create a per-doc share, and names the replacement', async () => {
    // Counts are compared as DELTAS: the mock CF api never removes a policy
    // on delete, so absolute lengths drift with the tests that ran before.
    const apps = cfState.apps.length;
    const policies = cfState.policies.length;
    const r = await fetch(`${base}/api/share/doc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        docId: entryDocId,
        allowDomains: ['@partner-org.example'],
        name: 'doc-slug',
      }),
    });
    expect(r.status).toBe(410);
    const body = (await r.json()) as { error: string; hint?: string };
    expect(body.error).toBe('per_doc_sharing_removed');
    expect(body.hint).toContain('workspaceId');
    // It created NOTHING on the way out — no Access app, no policy…
    expect(cfState.apps).toHaveLength(apps);
    expect(cfState.policies).toHaveLength(policies);
    // …and no registry row. Positive control: the workspace form of the same
    // request does mint one, so this route is refusing rather than the whole
    // share stack being dead.
    const ok = await shareWorkspace({
      workspaceId,
      allowDomains: ['@partner-org.example'],
      name: 'control-slug',
    });
    expect(ok.status).toBe(200);
    const minted = ((await ok.json()) as { share: { shareId: string } }).share;
    const listed = (await (await fetch(`${base}/api/share`)).json()) as {
      shares: Array<{ shareId: string; docId: string }>;
    };
    expect(listed.shares.map((s) => s.shareId)).toEqual([minted.shareId]);
    await fetch(`${base}/api/share/${minted.shareId}`, { method: 'DELETE' });
  });

  it('rejects share for a workspace that does not exist', async () => {
    const r = await shareWorkspace({
      workspaceId: 'no-such-workspace',
      allowDomains: ['@partner-org.example'],
    });
    expect(r.status).toBe(404);
    // Positive control: the real workspace id on the same route mints.
    const ok = await shareWorkspace({ workspaceId, allowDomains: ['@partner-org.example'] });
    expect(ok.status).toBe(200);
    await fetch(
      `${base}/api/share/${((await ok.json()) as { share: { shareId: string } }).share.shareId}`,
      { method: 'DELETE' },
    );
  });

  it('rejects share with empty allowDomains', async () => {
    const r = await shareWorkspace({ workspaceId, allowDomains: [] });
    expect(r.status).toBe(400);
    // Positive control: one domain and the same call succeeds.
    const ok = await shareWorkspace({ workspaceId, allowDomains: ['@partner-org.example'] });
    expect(ok.status).toBe(200);
    await fetch(
      `${base}/api/share/${((await ok.json()) as { share: { shareId: string } }).share.shareId}`,
      { method: 'DELETE' },
    );
  });

  it('creates a share for a bound workspace, opening on its entry doc', async () => {
    const apps = cfState.apps.length;
    const policies = cfState.policies.length;
    const r = await shareWorkspace({
      workspaceId,
      allowDomains: ['@partner-org.example'],
      name: 'fixed-slug',
    });
    expect(r.status).toBe(200);
    const { share } = (await r.json()) as {
      share: { hostname: string; url: string; workspaceId: string; docId: string; aud?: string };
    };
    expect(share.hostname).toBe('share-fixed-slug.tunnel.fryanpan.com');
    expect(share.url).toBe(
      `https://share-fixed-slug.tunnel.fryanpan.com/review/${encodeURIComponent(entryDocId)}`,
    );
    // Scope comes from the workspace; the entry doc is only a landing address.
    expect(share.workspaceId).toBe(workspaceId);
    expect(share.docId).toBe(entryDocId);
    expect(cfState.apps).toHaveLength(apps + 1);
    expect(cfState.policies).toHaveLength(policies + 1);
  });

  it('lists active shares', async () => {
    const r = await fetch(`${base}/api/share`);
    const { shares } = (await r.json()) as { shares: { workspaceId: string }[] };
    expect(shares.length).toBeGreaterThanOrEqual(1);
    expect(shares.some((s) => s.workspaceId === workspaceId)).toBe(true);
  });

  it('revokes a share via DELETE', async () => {
    const list = await fetch(`${base}/api/share`).then(
      (r) => r.json() as Promise<{ shares: { shareId: string }[] }>,
    );
    expect(list.shares).toHaveLength(1); // positive control: there is one to revoke
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
    // A second folder bind, so the persisted record is a workspace share
    // distinguishable from the fixture one.
    const persistFolder = mkdtempSync(join(tmpdir(), 'share-test-persist-'));
    writeFileSync(join(persistFolder, 'persist.md'), '# persist\n');
    const bind = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderPath: persistFolder }),
    });
    const persistWorkspaceId = ((await bind.json()) as { workspaceId: string }).workspaceId;
    const mk = await shareWorkspace({
      workspaceId: persistWorkspaceId,
      allowDomains: ['@partner-org.example'],
      name: 'p',
    });
    expect(mk.status).toBe(200);

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
      (r) => r.json() as Promise<{ shares: { workspaceId: string }[] }>,
    );
    expect(list.shares.some((s) => s.workspaceId === persistWorkspaceId)).toBe(true);
    rmSync(persistFolder, { recursive: true, force: true });
  });
});
