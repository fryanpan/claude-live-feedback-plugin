/**
 * `create_tasks` carries `sourceDoc` to the batch route, and carries the
 * gate's verdict back.
 *
 * The server routes are covered end to end; what was uncovered is the layer
 * between — an MCP handler that accepts a field and drops it before the wire,
 * or reads a response field and never returns it. Both fail only in a peer's
 * session, and both look like success everywhere else.
 *
 * This used to slice `mcp.ts` for `sourceDoc !== undefined ? { sourceDoc }` and
 * then check the built bundle contains the word `sourceDoc`. Neither is
 * evidence: the source pattern is a shape a refactor breaks while the feature
 * works, and the bundle string is present whether or not anything sends it.
 * The harness runs the committed bundle against a recording stub, so the
 * forward is the body the server received.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BundleHarness, type Recorded, startBundle } from './harness/mcp-bundle.ts';

const SOURCE_DOC = { docId: 'plan-doc-1', mode: 'plan' as const };

/** The batch route's answer: one row, and the gate's verdict on the doc. */
const batchReply = {
  tasks: [{ id: 't-1', title: 'Ship the search revamp', status: 'triage' }],
  failures: [],
  sourceDoc: { docId: 'plan-doc-1', mode: 'plan', held: true },
};

let mcp: BundleHarness;

beforeAll(async () => {
  mcp = await startBundle((req: Recorded) =>
    req.path.endsWith('/tasks/batch') ? batchReply : {},
  );
}, 60_000);
afterAll(async () => {
  await mcp?.stop();
});

const batchOf = (sent: Recorded[]) => sent.find((r) => r.path.endsWith('/tasks/batch'));

describe('create_tasks declares sourceDoc', () => {
  it('POSITIVE CONTROL: the running bundle serves a known tool', () => {
    expect(mcp.tool('list_attachments')).toBeDefined();
    expect(mcp.tool('create_tasks_from_doc')).toBeUndefined();
  });

  it('the schema names the field, both modes, and what the plan gate does', () => {
    const decl = mcp.tool('create_tasks');
    expect(decl).toBeDefined();
    const schema = JSON.stringify(decl?.inputSchema ?? {});
    expect(schema).toContain('sourceDoc');
    expect(schema).toContain("'plan'");
    expect(schema).toContain("'discussion'");
    // The consequence is the contract: an agent must learn from the schema
    // that plan rows are held drafts, not silently-queued work.
    expect(schema).toContain('held in triage until a person approves');
    expect(schema).toContain('structured origin ref');
  });
});

describe('the handler forwards sourceDoc both ways', () => {
  it('sends it to the batch route', async () => {
    const res = await mcp.call('create_tasks', {
      workspaceId: 'w-1',
      tasks: [{ title: 'Ship the search revamp' }],
      sourceDoc: SOURCE_DOC,
    });
    expect(res.isError).toBe(false);
    const batch = batchOf(res.sent);
    expect(batch?.method).toBe('POST');
    expect((batch?.body as { sourceDoc?: unknown })?.sourceDoc).toEqual(SOURCE_DOC);
  });

  it('returns the gate verdict rather than swallowing it', async () => {
    const res = await mcp.call('create_tasks', {
      workspaceId: 'w-1',
      tasks: [{ title: 'Ship the search revamp' }],
      sourceDoc: SOURCE_DOC,
    });
    expect((res.json as { sourceDoc?: unknown }).sourceDoc).toEqual({
      docId: 'plan-doc-1',
      mode: 'plan',
      held: true,
    });
  });

  // CONTROL: the field is optional, and a batch without it must not invent
  // one — a phantom sourceDoc would hold rows the gate never looked at.
  it('sends no sourceDoc key when the caller passed none', async () => {
    const res = await mcp.call('create_tasks', {
      workspaceId: 'w-1',
      tasks: [{ title: 'Ship the search revamp' }],
    });
    expect(Object.keys(batchOf(res.sent)?.body as object)).not.toContain('sourceDoc');
  });
});
