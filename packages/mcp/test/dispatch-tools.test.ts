/**
 * `register_dispatch` / `close_dispatch` reach peers, and reach the right
 * routes.
 *
 * A tool declared in `mcp.ts` but never built into
 * `packages/plugin/mcp/index.js` is invisible to every peer, and a handler
 * pointed at the wrong verb or path fails only in a peer's session. The routes
 * themselves are covered end to end in
 * packages/server/test/dispatch-routes.test.ts.
 *
 * This file used to read the built bundle and assert the two tool names appear
 * in its text. A name in the bundle is not a reachable tool: it survives a
 * handler that was deleted and a route that was renamed under it. The harness
 * runs the committed bundle as a real MCP server against a recording stub, so
 * the declaration is what a client is handed and the verb and path are the
 * request the handler made.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BundleHarness, startBundle } from './harness/mcp-bundle.ts';

let mcp: BundleHarness;

beforeAll(async () => {
  mcp = await startBundle(() => ({ dispatch: { taskId: 't-1', worktreePath: '/w/one' } }));
}, 60_000);
afterAll(async () => {
  await mcp?.stop();
});

describe('dispatch tools', () => {
  // Positive control for every assertion below: a tool that has shipped for
  // months is reachable, so a harness listing nothing would fail here first.
  it('POSITIVE CONTROL: the running bundle serves a known tool', () => {
    expect(mcp.tool('list_agents')).toBeDefined();
    expect(mcp.tool('register_dispatch_that_never_existed')).toBeUndefined();
  });

  it('register_dispatch requires the task and the worktree path', () => {
    const decl = mcp.tool('register_dispatch');
    expect(decl).toBeDefined();
    expect(decl?.inputSchema?.required).toEqual(['workspaceId', 'taskId', 'worktreePath']);
    expect(Object.keys(decl?.inputSchema?.properties ?? {}).sort()).toEqual([
      'taskId',
      'workspaceId',
      'worktreePath',
    ]);
  });

  it('register_dispatch POSTs the route the server serves, carrying both fields', async () => {
    const res = await mcp.call('register_dispatch', {
      workspaceId: 'w-1',
      taskId: 't-K69wx',
      worktreePath: '/tmp/worktrees/builder-3',
    });
    expect(res.isError).toBe(false);
    expect(res.sent.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /workspaces/w-1/dispatches',
    ]);
    expect(res.sent[0]?.body).toEqual({
      taskId: 't-K69wx',
      worktreePath: '/tmp/worktrees/builder-3',
    });
  });

  it('close_dispatch DELETEs the per-task route, with the id escaped into the path', async () => {
    const res = await mcp.call('close_dispatch', {
      workspaceId: 'w-1',
      taskId: 't-K69wx/../other',
    });
    expect(res.isError).toBe(false);
    expect(res.sent).toHaveLength(1);
    expect(res.sent[0]?.method).toBe('DELETE');
    // Escaped, not interpolated raw: a task id carrying a slash must not be
    // able to walk out of the collection it addresses.
    expect(res.sent[0]?.url).toBe('/workspaces/w-1/dispatches/t-K69wx%2F..%2Fother');
  });

  it('both tools are declared to a client, not merely present in the file', () => {
    expect(mcp.tool('register_dispatch')).toBeDefined();
    expect(mcp.tool('close_dispatch')).toBeDefined();
  });
});
