/**
 * `set_workspace_goal` is gone from the tool surface peers actually load.
 *
 * The workspace-level TEXT goal was removed; a board's goals are the ordered
 * goal LIST. Source alone is not the deliverable here: peers run the committed
 * `packages/plugin/mcp/index.js`, and a tool that survives only in the bundle
 * is a tool agents keep calling — against a route that now refuses it.
 *
 * This was a text search over `mcp.ts` and the built file for the absent
 * string. What the removal is FOR is that no session can reach the verb, and a
 * string search cannot tell a live handler from a comment mentioning one. So
 * the running bundle is asked: the tool is off the list a client receives, the
 * call is refused, and the surviving goal verbs still work. Every absence is
 * still paired with a presence, or a harness that listed nothing would satisfy
 * the file by being empty.
 *
 * The REST route is deliberately NOT removed and is not asserted absent
 * anywhere: an old bundle still calls it, and it answers 410 with the
 * replacement named. That half is pinned in
 * `packages/server/test/text-goal-removed.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BundleHarness, startBundle } from './harness/mcp-bundle.ts';

let mcp: BundleHarness;

beforeAll(async () => {
  mcp = await startBundle(() => ({ changed: true, created: [] }));
}, 60_000);
afterAll(async () => {
  await mcp?.stop();
});

describe('the text-goal tool is off the surface', () => {
  it('is not among the tools a client is offered, while the goal verbs that replaced it are', () => {
    // Positive controls first: the surviving verbs are reachable, so the
    // absence below is a removal rather than a harness that saw nothing.
    expect(mcp.tool('set_goal_list')).toBeDefined();
    expect(mcp.tool('set_task_goal')).toBeDefined();
    expect(mcp.tool('set_workspace_goal')).toBeUndefined();
  });

  it('refuses the call, and sends nothing to the server on its way to failing', async () => {
    const res = await mcp.call('set_workspace_goal', { workspaceId: 'w-1', goal: 'Ship faster' });
    expect(res.isError).toBe(true);
    expect(res.sent).toEqual([]);
    // POSITIVE CONTROL for the refusal: the replacement verb does reach the
    // server through this same path, so "no request" above means removed and
    // not "the harness cannot make a request".
    const ok = await mcp.call('set_goal_list', { workspaceId: 'w-1', goals: [{ title: 'Speed' }] });
    expect(ok.isError).toBe(false);
    expect(ok.sent.map((r) => r.path)).toEqual(['/api/workspaces/w-1/goals']);
  });

  it('no tool still teaches the north star or its re-triage', () => {
    // The declarations are what an agent reads before it acts, so a leftover
    // sentence about re-triage sends it after a gesture the board no longer
    // makes. What DID survive the removal — the backlog counts a lead is
    // handed on attach — is asserted where it is produced, in
    // attach-backlog.test.ts and declare-lead-handler.test.ts, rather than by
    // grepping for the field name here.
    const surface = JSON.stringify(mcp.tools);
    // Positive control: the surface really is in view and non-trivial.
    expect(mcp.tools.length).toBeGreaterThan(20);
    expect(surface).toContain('set_goal_list');
    expect(surface).not.toContain('workspace.goal_updated');
    expect(surface).not.toContain('workspace.retriaged');
    expect(surface).not.toContain('pendingRetriage');
    expect(surface).not.toContain('goal-retriage');
  });

  it('create_workspace no longer takes a goal', () => {
    const schema = mcp.tool('create_workspace')?.inputSchema;
    // Positive control: the schema really is in view.
    expect(schema?.required).toEqual(['name']);
    // The SCHEMA is what an old caller's payload is matched against — the
    // description still says the word "goal", and has to: it names where a
    // board's aims live now.
    expect(JSON.stringify(schema)).not.toMatch(/goal/);
  });
});
