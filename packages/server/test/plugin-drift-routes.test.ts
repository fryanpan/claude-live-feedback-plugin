/**
 * The plugin-version drift signal, driven through the REAL routes.
 *
 * The unit tests in plugin-release.test.ts prove the comparison. They cannot
 * prove the version survives the trip, and that trip is where this class of
 * bug lives in this codebase: every REST handler hand-copies body fields into
 * the store call, so a new param needs the MCP tool, the route, AND the store
 * — and the route is the layer nothing type-checks. `groups` was accepted,
 * returned ok:true, and discarded exactly this way.
 *
 * Fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareSemver, readReleasedPluginVersion } from '../src/plugin-release.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

describe('plugin drift over the attachment routes', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        'content-type': 'application/json',
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  const post = (path: string, body: unknown) =>
    local(path, { method: 'POST', body: JSON.stringify(body) });

  const makeWorkspace = async (name: string): Promise<string> => {
    const r = await post('/api/workspaces', { name, goal: 'Ship it.' });
    return ((await r.json()) as { workspace: { id: string } }).workspace.id;
  };

  type ListBody = {
    attachments: Array<{ agentId: string; pluginVersion?: string }>;
    pluginRelease: {
      version: string | null;
      behind: Array<{ agentId: string; pluginVersion?: string }>;
      checked?: number;
    };
  };

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'plugin-drift-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('carries the reported version through attach and back out of the list', async () => {
    const wsId = await makeWorkspace('drift-hub');
    const r = await post(`/api/workspaces/${wsId}/attachments`, {
      agentId: 'agent-quill',
      runtime: 'claude-code-local',
      pluginVersion: '0.1.12',
    });
    expect(r.status).toBe(200);
    expect(
      ((await r.json()) as { attachment: { pluginVersion?: string } }).attachment.pluginVersion,
    ).toBe('0.1.12');

    const body = (await (await local(`/api/workspaces/${wsId}/attachments`)).json()) as ListBody;
    expect(body.attachments[0]?.pluginVersion).toBe('0.1.12');
  });

  it('reports what the deploy source would install, and who is behind it', async () => {
    const wsId = await makeWorkspace('drift-hub-2');
    // The released version is read from this checkout's own manifest, so the
    // test asserts a RELATIONSHIP against that manifest rather than a literal
    // — a literal would go red on every routine patch bump.
    const manifest = readReleasedPluginVersion(join(import.meta.dir, '../../..'));
    if (!manifest) throw new Error('this repo must have a plugin manifest to test against');

    await post(`/api/workspaces/${wsId}/attachments`, {
      agentId: 'agent-stale',
      runtime: 'claude-code-local',
      pluginVersion: '0.0.1',
    });
    await post(`/api/workspaces/${wsId}/attachments`, {
      agentId: 'agent-current',
      runtime: 'claude-code-local',
      pluginVersion: manifest,
    });

    const body = (await (await local(`/api/workspaces/${wsId}/attachments`)).json()) as ListBody;
    expect(body.pluginRelease.version).toBe(manifest);
    // Positive control beside the absence: the stale one IS named, which is
    // what makes the current one's absence mean anything.
    expect(body.pluginRelease.behind.map((b) => b.agentId)).toEqual(['agent-stale']);
    expect(compareSemver(body.pluginRelease.behind[0]?.pluginVersion ?? '', manifest)).toBe(-1);
  });

  it('counts a session that reports no version at all', async () => {
    // The version field ships in the release that reads it, so a peer on any
    // older bundle sends nothing. That silence is the fleet-wide drift.
    const wsId = await makeWorkspace('drift-hub-3');
    await post(`/api/workspaces/${wsId}/attachments`, {
      agentId: 'agent-silent',
      runtime: 'claude-code-local',
    });
    const body = (await (await local(`/api/workspaces/${wsId}/attachments`)).json()) as ListBody;
    expect(body.pluginRelease.behind.map((b) => b.agentId)).toEqual(['agent-silent']);
    expect(body.pluginRelease.behind[0]?.pluginVersion).toBeUndefined();
  });

  it('survives a restart — the version is on the persisted record', async () => {
    // Attachments live in a sidecar, not in a ydoc. A version that only
    // existed in memory would read as "everyone is behind" after every
    // server restart, i.e. after every deploy.
    const wsId = await makeWorkspace('drift-hub-4');
    await post(`/api/workspaces/${wsId}/attachments`, {
      agentId: 'agent-persisted',
      runtime: 'claude-code-local',
      pluginVersion: '0.9.9',
    });
    await handle.stop();
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    const body = (await (await local(`/api/workspaces/${wsId}/attachments`)).json()) as ListBody;
    expect(body.attachments.find((a) => a.agentId === 'agent-persisted')?.pluginVersion).toBe(
      '0.9.9',
    );
  });

  // ── The denominator (the defect measured 2026-08-17) ────────────────────
  //
  // `behind: []` was the whole answer, and it rendered as "no session is
  // behind" when it only ever meant "nothing that attached HERE is behind".
  // On this board that domain has normally held exactly one member: the
  // session reading the strip. The count has to survive the same trip the
  // list does — it is a new field on a hand-built payload, which is this
  // codebase's most reliable place to drop one.

  it('an empty behind list arrives with the count it was computed over', async () => {
    const wsId = await makeWorkspace('drift-domain-1');
    const manifest = readReleasedPluginVersion(join(import.meta.dir, '../../..'));
    if (!manifest) throw new Error('this repo must have a plugin manifest to test against');

    // Nobody attached yet: zero behind out of zero checked. Indistinguishable
    // from a real clearance without the second number.
    let body = (await (await local(`/api/workspaces/${wsId}/attachments`)).json()) as ListBody;
    expect(body.pluginRelease.behind).toEqual([]);
    expect(body.pluginRelease.checked).toBe(0);

    // One current session: still zero behind, but now out of one — which is
    // the exact reading that was mistaken for a fleet-wide all-clear.
    await post(`/api/workspaces/${wsId}/attachments`, {
      agentId: 'agent-current',
      runtime: 'claude-code-local',
      pluginVersion: manifest,
    });
    body = (await (await local(`/api/workspaces/${wsId}/attachments`)).json()) as ListBody;
    expect(body.pluginRelease.behind).toEqual([]);
    expect(body.pluginRelease.checked).toBe(1);
  });

  it('counts the population the check ran over, not every attachment', async () => {
    // A webhook cannot be behind, so it must not pad the denominator either —
    // otherwise "0 behind of 3 checked" claims two checks that never happened.
    const wsId = await makeWorkspace('drift-domain-2');
    await post(`/api/workspaces/${wsId}/attachments`, {
      agentId: 'agent-session',
      runtime: 'claude-code-local',
      pluginVersion: '0.0.1',
    });
    await post(`/api/workspaces/${wsId}/attachments`, {
      agentId: 'agent-hook',
      runtime: 'webhook',
    });
    await post(`/api/workspaces/${wsId}/attachments`, {
      agentId: 'agent-cloud',
      runtime: 'managed-agent',
    });

    const body = (await (await local(`/api/workspaces/${wsId}/attachments`)).json()) as ListBody;
    // Positive control beside the count: three attachments really did land.
    expect(body.attachments.length).toBe(3);
    expect(body.pluginRelease.checked).toBe(1);
    expect(body.pluginRelease.behind.map((b) => b.agentId)).toEqual(['agent-session']);
  });
});
