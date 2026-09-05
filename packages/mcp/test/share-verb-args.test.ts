/**
 * The share verbs on the wire: what `share_workspace` sends, and the fact
 * that `share_link` is no longer a tool at all.
 *
 * Two properties, and the first is why this file exists. A handler that
 * destructures named keys and forwards those is how `share_link(docId, ttl:
 * '15m')` once reached the server as a bare board share and came back 200 —
 * the whole board, for two weeks, to a caller who asked for one doc for
 * fifteen minutes. The SDK does not reject an argument the schema does not
 * name; it just never makes the wire, so the server's refuse-by-name checks
 * only work if every key gets there. `share_workspace` is the verb that
 * carries that property now.
 *
 * The second is the retirement. `share_link` minted a per-share Cloudflare
 * Access application — its own hostname, audience and policy — which is the
 * machinery the 2026-09-03 flow replaced with one Access application and a
 * membership record. Two mints for one question is how the two answers to
 * "who may open this board" drift apart, so there is one verb.
 *
 * These are wire facts, so this file reads the wire: the harness runs the
 * COMMITTED bundle against a recording stub and asserts on the body the
 * server was actually sent. Slicing the source or grepping the bundle for a
 * call expression would pass on a minifier rename and, worse, would keep
 * passing over a deleted handler.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BundleHarness, startBundle } from './harness/mcp-bundle.ts';

let mcp: BundleHarness;

beforeAll(async () => {
  mcp = await startBundle(() => ({ url: 'https://example.invalid/s/abc', ttlSeconds: 900 }));
}, 60_000);
afterAll(async () => {
  await mcp?.stop();
});

describe('share_workspace', () => {
  it('POSITIVE CONTROL: the running bundle serves a known tool', () => {
    expect(mcp.tool('list_agents')).toBeDefined();
    expect(mcp.tool('share_hyperlink')).toBeUndefined();
  });

  it('POSTs the workspace route', async () => {
    const res = await mcp.call('share_workspace', { workspaceId: 'w-1' });
    expect(res.isError).toBe(false);
    expect(res.sent.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /api/share/workspace']);
  });

  it('forwards the arguments object itself, not a hand-picked subset', async () => {
    // `docId` is the key the old shape dropped, and `ttl` the one it turned
    // into the default. Both have to reach the server for it to refuse them
    // by name rather than silently widen the share.
    const res = await mcp.call('share_workspace', {
      workspaceId: 'w-1',
      docId: 'doc-42',
      ttl: '15m',
      label: 'Design partner',
    });
    // A docId in the arguments also arms the auto-watch, so pick the share
    // request rather than assuming it is the only one.
    const share = res.sent.find((r) => r.path === '/api/share/workspace');
    expect(share?.body).toMatchObject({
      workspaceId: 'w-1',
      docId: 'doc-42',
      ttl: '15m',
      label: 'Design partner',
    });
  });

  it('returns the server answer to the caller unchanged', async () => {
    const res = await mcp.call('share_workspace', { workspaceId: 'w-1' });
    expect(res.json).toEqual({ url: 'https://example.invalid/s/abc', ttlSeconds: 900 });
  });
});

describe('share_link is retired', () => {
  it('is not a tool the bundle declares', () => {
    // Paired with the POSITIVE CONTROL above, which proves this harness can
    // see a tool that IS declared — otherwise `toBeUndefined` passes on a
    // bundle that failed to load anything at all.
    expect(mcp.tool('share_link')).toBeUndefined();
    // The verb that replaced it is there, in the same listing.
    expect(mcp.tool('share_workspace')).toBeDefined();
  });

  it('leaves the verbs that MANAGE existing shares alone', () => {
    // Retiring the mint is not retiring the records. A share already out
    // there is still listed, still shortenable and still revocable, and the
    // people who came through one are still ejectable.
    for (const name of ['list_shares', 'set_share_ttl', 'unshare', 'remove_share_member']) {
      expect(mcp.tool(name), name).toBeDefined();
    }
  });
});
