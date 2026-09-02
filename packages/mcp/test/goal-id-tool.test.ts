/**
 * `set_goal_list` teaches the generated-id contract, and hands back the id.
 *
 * Two failures this guards, both of which have happened in this repo:
 *
 *  - **The handler drops the new field.** `created` is the ONLY place a caller
 *    learns the id of a band it just created — it never chose one. The MCP
 *    handler hand-copies fields out of the route response, which is exactly
 *    the layer that silently dropped `groups` once already: every layer under
 *    it reports success while the caller gets nothing usable back.
 *  - **The bundle.** Peers load the committed `packages/plugin/mcp/index.js`,
 *    not the source, and a tool description IS the deliverable when the change
 *    is "here is the new way to say this" — there is no behaviour to notice,
 *    so nothing else reports the miss.
 *
 * Both used to be checked by reading text: a slice of `mcp.ts` for the
 * declaration, and `BUNDLE.toContain('created: res.created')` for the forward.
 * The second is the weaker — it passes on a handler no client can reach, and
 * breaks on a rename that changes nothing. The harness runs the committed
 * bundle as a real MCP server, so a declaration is what `tools/list` returns
 * and a forward is what the caller is actually handed back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BundleHarness, type Recorded, startBundle } from './harness/mcp-bundle.ts';

/** The goals route's answer: one band created, and the rest of the verdict. */
const goalsReply = {
  changed: true,
  created: [{ id: 'g-7Qa2', title: 'Ship the search revamp' }],
  movedToChores: ['t-9'],
  strandedDone: ['t-4'],
};

let mcp: BundleHarness;

beforeAll(async () => {
  mcp = await startBundle((req: Recorded) => (req.path.endsWith('/goals') ? goalsReply : {}));
}, 60_000);
afterAll(async () => {
  await mcp?.stop();
});

/** The whole declaration as a client receives it, description included. */
const declText = (tool: string) => JSON.stringify(mcp.tool(tool) ?? {});

describe('set_goal_list declares the generated-id contract', () => {
  it('POSITIVE CONTROL: the running bundle serves a known tool', () => {
    expect(mcp.tool('list_attachments')).toBeDefined();
    expect(mcp.tool('set_goal_tree')).toBeUndefined();
  });

  it('does not require an id', () => {
    const goals = mcp.tool('set_goal_list')?.inputSchema?.properties?.goals as
      | { items?: { required?: string[] } }
      | undefined;
    // Positive control: the schema is really in view — `title` is required, so
    // a lookup that captured nothing fails here first.
    expect(goals?.items?.required).toEqual(['title']);
  });

  // Subgoals were removed from the product (Bryan, 2026-08-30). The tool must
  // stop offering a shape the store will only flatten — an agent that submits
  // one gets bands it did not mean to create.
  it('offers no nesting', () => {
    expect(declText('set_goal_list')).not.toContain('subgoals');
    expect(declText('reorder_goals')).not.toContain('parent');
  });

  it('says how to create, how to keep, and what happens to an id the board lacks', () => {
    const decl = declText('set_goal_list');
    expect(decl).toContain('Goal ids are generated and permanent');
    expect(decl).toContain('no id to add a band');
    expect(decl).toContain('unknown-goal-id');
    expect(decl).toContain('created');
  });

  it('the sibling verbs stop describing the re-key as something that lands', () => {
    // rename_goal used to explain that renaming through set_goal_list "is a
    // removal plus an addition" — true then, wrong now, and a description that
    // describes a gesture the server refuses sends the agent to do it anyway.
    expect(declText('rename_goal')).toContain('The id never moves');
  });
});

describe('the handler forwards `created` rather than dropping it', () => {
  it('hands the caller the id of the band it just created', async () => {
    const res = await mcp.call('set_goal_list', {
      workspaceId: 'w-1',
      goals: [{ title: 'Ship the search revamp' }],
    });
    expect(res.isError).toBe(false);
    expect(res.sent.map((r) => `${r.method} ${r.path}`)).toEqual(['PUT /api/workspaces/w-1/goals']);
    const out = res.json as typeof goalsReply & { workspaceId: string };
    expect(out.created).toEqual([{ id: 'g-7Qa2', title: 'Ship the search revamp' }]);
    // The neighbours it is hand-copied beside, so a copy that lost one field
    // is not mistaken for a copy that lost this one.
    expect(out.changed).toBe(true);
    expect(out.movedToChores).toEqual(['t-9']);
    expect(out.strandedDone).toEqual(['t-4']);
    expect(out.workspaceId).toBe('w-1');
  });
});
