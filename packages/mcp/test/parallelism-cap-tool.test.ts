/**
 * `set_parallelism_cap` — the tool the lead skill has named since 2026-08-31.
 *
 * The skill told leads to call `set_parallelism_cap(workspaceId, cap)` while
 * no such tool existed: the cap moved only through the REST route and the
 * settings panel, so a lead following the skill got "unknown tool" and a
 * board whose cap nobody could lower from a session. Two layers here:
 *
 *  - The argument check is a real unit (`parseCapArg`), because a refusal
 *    that reaches the server as a 400 arrives as a thrown route error, and
 *    the point of validating in the tool is a message that says what to send.
 *  - The tool itself is driven through the committed bundle. This file used to
 *    slice `mcp.ts` for the handler and then assert the string
 *    `set_parallelism_cap` appears in the built file — a check that passes on a
 *    tool nobody can call. The harness asks the running bundle for its
 *    declarations and records the request the handler makes, so "PUTs the
 *    route carrying this agent as author" is the actual wire body. The route
 *    itself is covered end to end in
 *    packages/server/test/parallelism-cap.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCapArg } from '../src/parallelism-cap.ts';
import { type BundleHarness, startBundle } from './harness/mcp-bundle.ts';

const CAP_VIEW = {
  cap: 3,
  isDefault: false,
  default: 4,
  inUse: 2,
  free: 1,
  holders: [{ taskId: 't-1', title: 'Ship the search revamp', agentName: 'Builder One' }],
  lastChange: { actor: { name: 'Harness Agent' }, ts: 1_700_000_000_000, from: 4, to: 3 },
};

let mcp: BundleHarness;

beforeAll(async () => {
  mcp = await startBundle(() => CAP_VIEW);
}, 60_000);
afterAll(async () => {
  await mcp?.stop();
});

describe('parseCapArg', () => {
  it('accepts a positive integer as-is', () => {
    expect(parseCapArg(1)).toEqual({ ok: true, cap: 1 });
    expect(parseCapArg(4)).toEqual({ ok: true, cap: 4 });
    expect(parseCapArg(50)).toEqual({ ok: true, cap: 50 });
  });

  it.each([
    ['zero', 0],
    ['a negative', -2],
    ['a fraction', 2.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a numeric string', '3'],
    ['a boolean', true],
    ['null', null],
    ['undefined', undefined],
    ['an object', { cap: 3 }],
  ])('refuses %s with a message that says what to send', (_label, raw) => {
    const res = parseCapArg(raw);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/positive integer/);
    // The message names what arrived, so the caller can see its own mistake
    // rather than re-reading the schema.
    expect(res.error).toMatch(/got /);
  });
});

describe('set_parallelism_cap tool', () => {
  // Positive control: a tool that has shipped for months is reachable, so a
  // harness that listed nothing would fail here rather than pass the rest
  // vacuously.
  it('POSITIVE CONTROL: the running bundle serves a known tool', () => {
    expect(mcp.tool('list_attachments')).toBeDefined();
    expect(mcp.tool('set_parallelism_ceiling')).toBeUndefined();
  });

  it('is declared to a client with the two arguments the skill names, both required', () => {
    const decl = mcp.tool('set_parallelism_cap');
    expect(decl).toBeDefined();
    expect(decl?.inputSchema?.required).toEqual(['workspaceId', 'cap']);
    expect(decl?.inputSchema?.properties?.workspaceId?.type).toBe('string');
    expect(decl?.inputSchema?.properties?.cap?.type).toBe('integer');
    // It tells the lead what a change does and does not do — the sentence the
    // skill already makes, so the two never disagree.
    expect(decl?.description).toContain('next dispatch');
  });

  it('refuses a cap that is not a positive integer without sending anything', async () => {
    const res = await mcp.call('set_parallelism_cap', { workspaceId: 'w-1', cap: 0 });
    expect(res.isError).toBe(true);
    // The refusal is the point: nothing reached the server, and the message
    // says what to send instead of relaying a 400 as a thrown route error.
    expect(res.sent).toEqual([]);
    expect(res.text.toLowerCase()).toContain('positive');
  });

  it('PUTs the route the board uses, carrying this agent as author', async () => {
    const res = await mcp.call('set_parallelism_cap', { workspaceId: 'w DRa7/Bg', cap: 3 });
    expect(res.isError).toBe(false);
    expect(res.sent).toHaveLength(1);
    expect(res.sent[0]?.method).toBe('PUT');
    expect(res.sent[0]?.url).toBe('/api/workspaces/w%20DRa7%2FBg/parallelism-cap');
    const body = res.sent[0]?.body as { cap: number; author?: { name?: string } };
    expect(body.cap).toBe(3);
    // Without an author the change lands as `unknown` instead of this agent.
    expect(body.author?.name).toBe('Harness Agent');
  });

  it('returns the cap and the recorded last change, not just an ack', async () => {
    const res = await mcp.call('set_parallelism_cap', { workspaceId: 'w-1', cap: 3 });
    const out = res.json as typeof CAP_VIEW & { workspaceId: string };
    expect(out.workspaceId).toBe('w-1');
    expect(out.cap).toBe(3);
    expect(out.free).toBe(1);
    expect(out.holders).toEqual(CAP_VIEW.holders);
    expect(out.lastChange).toEqual(CAP_VIEW.lastChange);
  });
});
