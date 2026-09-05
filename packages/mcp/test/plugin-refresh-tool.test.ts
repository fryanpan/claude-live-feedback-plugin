/**
 * `request_plugin_refresh` reaches peers, and reaches the right route.
 *
 * Two failures this covers, both of which have happened here before:
 *
 *  - A tool declared in `mcp.ts` and never built into
 *    `packages/plugin/mcp/index.js` is invisible to every peer, because
 *    `.mcp.json` loads the committed bundle, not the source. PR #69 shipped a
 *    schema change exactly that way and nobody got it.
 *  - The server route is covered end to end (plugin-refresh-routes.test.ts),
 *    and the pure refresher is covered by unit tests — but nothing yet checks
 *    that the MCP handler calls the path those tests serve. A tool pointed at
 *    the wrong verb or path fails only in a peer's session.
 *
 * This used to assert `BUNDLE.toContain('request_plugin_refresh')` over the
 * built file. That string survives a deleted handler, so it was never evidence
 * the tool worked. The harness runs the committed bundle as a real MCP server
 * against a recording stub instead: the declaration is what `tools/list`
 * returns, and the route is the request the handler actually made.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BundleHarness, startBundle } from './harness/mcp-bundle.ts';

let mcp: BundleHarness;

beforeAll(async () => {
  mcp = await startBundle(() => ({ refreshed: true, cacheDir: '/tmp/plugin-cache' }));
}, 60_000);
afterAll(async () => {
  await mcp?.stop();
});

describe('request_plugin_refresh', () => {
  // Positive control: a tool that has shipped for months is reachable too, so
  // a harness that somehow listed nothing would fail here rather than let the
  // assertions below pass vacuously.
  it('POSITIVE CONTROL: the running bundle serves a known tool', () => {
    expect(mcp.tool('list_agents')).toBeDefined();
    expect(mcp.tool('a_tool_that_was_never_declared')).toBeUndefined();
  });

  it('is declared to a client, with no inputs at all', () => {
    // The server spawns a process. Keeping the schema empty is what makes
    // "nothing a caller sends reaches a process" checkable rather than a
    // claim in a comment — the argv is fixed on the server side, and there is
    // no parameter here that could ever want to reach it.
    const decl = mcp.tool('request_plugin_refresh');
    expect(decl).toBeDefined();
    expect(decl?.inputSchema?.properties ?? {}).toEqual({});
    expect(decl?.inputSchema?.required).toBeUndefined();
  });

  it('POSTs the route the server actually serves, with no body', async () => {
    const res = await mcp.call('request_plugin_refresh', {});
    expect(res.isError).toBe(false);
    expect(res.sent.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /api/plugin/refresh']);
    expect(res.sent[0]?.body).toBeUndefined();
  });

  it("returns the server's answer to the caller rather than a bare ack", async () => {
    const res = await mcp.call('request_plugin_refresh', {});
    expect(res.json).toEqual({ refreshed: true, cacheDir: '/tmp/plugin-cache' });
  });
});
