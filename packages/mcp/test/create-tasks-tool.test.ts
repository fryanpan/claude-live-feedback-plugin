/**
 * `create_tasks` is the canonical create, and what it learned reaches peers.
 *
 * Two things this guards, both of which have gone wrong here before:
 *
 *  - **The bundle.** `.mcp.json` loads the committed
 *    `packages/plugin/mcp/index.js`, not the source. A description edited in
 *    `mcp.ts` and never rebuilt is invisible to every peer — which is exactly
 *    how PR #69 shipped a schema change nobody received. A tool description IS
 *    the deliverable when the change is "steer the agent to the other verb":
 *    there is no behaviour to notice, so nothing else would report the miss.
 *  - **The forwarding.** The server routes are covered end to end
 *    (task-placement.test.ts), but nothing yet checked that the MCP handler
 *    passes `placement` on rather than dropping it — the same "one layer away
 *    from where it's consumed" failure as a route that accepts a param and
 *    discards it.
 *
 * Source-reading, like tool-wiring.test.ts: mcp.ts is a bundle entry point and
 * exports nothing.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '../src/mcp.ts'), 'utf8');
const BUNDLE = readFileSync(join(HERE, '../../plugin/mcp/index.js'), 'utf8');

/** The `case 'x': {` block for one tool, up to the next case. */
function handlerFor(tool: string): string {
  const start = SRC.indexOf(`case '${tool}': {`);
  expect(start, `no handler for ${tool}`).toBeGreaterThan(-1);
  const rest = SRC.slice(start + 1);
  return rest.slice(0, rest.indexOf('case '));
}

/** The declaration block for one tool, up to the next tool entry. */
function declarationFor(tool: string): string {
  const start = SRC.indexOf(`name: '${tool}',\n      description:`);
  expect(start, `no declaration for ${tool}`).toBeGreaterThan(-1);
  const rest = SRC.slice(start);
  return rest.slice(0, rest.indexOf('},\n    {'));
}

describe('create_tasks is the canonical create verb', () => {
  it('says so in its own description, and says a single task is a one-row list', () => {
    // The steering has to be in the description, because the description is
    // the only thing an agent reads at the moment it is about to file work.
    const decl = declarationFor('create_tasks');
    expect(decl).toMatch(/THE way to create tasks/);
    expect(decl).toMatch(/one-row list/);
  });

  it('carries the per-row field contract on its own schema', () => {
    // The single-row `create_task` declaration used to hold every field
    // description, and `tasks` merely pointed at it ("a create_task body
    // without workspaceId"). Deleting that tool without moving these would
    // have left a schema that still validates and documents nothing — the
    // kind of regression no assertion about the deleted tool can catch.
    const decl = declarationFor('create_tasks');
    expect(decl).toMatch(/<persona> can <do x> so that <goal y>/); // the body rule
    expect(decl).toMatch(/bare word 'agent'/); // the owner refusal
    expect(decl).toMatch(/decision-shaped `body`|REQUIRED and has a different shape/);
    expect(decl).toMatch(/MUST also appear in `after`/); // the afterEnforce subset rule
  });

  it('documents the batch-local dependency reference on the row schema', () => {
    const decl = declarationFor('create_tasks');
    expect(decl).toMatch(/key\?/); // the row field that makes a reference possible
    expect(decl).toMatch(/#seed/); // the spelling
    expect(decl).toMatch(/ABOVE it/); // and the direction rule
  });
});

describe('the create handler forwards placement rather than dropping it', () => {
  it('batch marks each row placed from the unplaced set, and returns the block once', () => {
    const h = handlerFor('create_tasks');
    expect(h).toMatch(/res\.placement\?\.unplaced/);
    expect(h).toMatch(/!unplaced\.has\(t\.id\)/);
    expect(h).toMatch(/placement: res\.placement/);
  });
});

describe('the committed bundle peers load carries all of it', () => {
  it('has the canonical steering and the placement forwarding', () => {
    // Positive control first: a tool that has shipped for months is present,
    // so a bundle read that returned something useless fails here rather than
    // passing the assertions below vacuously.
    expect(BUNDLE).toContain('list_attachments');
    expect(BUNDLE).toContain('THE way to create tasks');
    expect(BUNDLE).toContain('/tasks/batch');
    expect(BUNDLE).toContain('placement');
  });
});

/**
 * The single-row `create_task` is GONE, and gone from the artifact peers
 * actually load — `.mcp.json` runs `packages/plugin/mcp/index.js`, so a
 * source-only removal would leave every peer still seeing the tool on its
 * next restart. That is the exact shape of PR #69, which edited mcp.ts and
 * never rebuilt.
 *
 * The word boundary is the whole trick: `create_task` is a PREFIX of
 * `create_tasks`, so a plain `includes('create_task')` is true forever and
 * an absence test written that way can never fail.
 */
describe('create_task is removed, in the source and in the shipped bundle', () => {
  const SINGULAR = /create_task\b/; // \b does not match between `k` and `s`

  it('the naive check cannot see the difference (why the boundary is load-bearing)', () => {
    // Not a test of the product — a test of the assertion below. If this ever
    // goes false, `create_tasks` has been renamed and the guard is measuring
    // nothing.
    expect(BUNDLE.includes('create_task')).toBe(true);
    expect(SINGULAR.test('create_tasks')).toBe(false);
    expect(SINGULAR.test("case 'create_task': {")).toBe(true);
  });

  it('is absent from the bundle, which still contains the batch verb', () => {
    // Positive control in the SAME read: an empty or unreadable bundle would
    // satisfy the absence assertion and fail this one.
    expect(BUNDLE).toMatch(/create_tasks\b/);
    expect(BUNDLE).toContain('case "create_tasks":');

    expect(BUNDLE).not.toMatch(SINGULAR);
  });

  it('is absent from the source too — no declaration, no handler', () => {
    expect(SRC).toMatch(/create_tasks\b/);
    expect(SRC).not.toMatch(SINGULAR);
  });
});
