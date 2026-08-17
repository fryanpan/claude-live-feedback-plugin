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

  it('marks create_task as not canonical, and points at the replacement', () => {
    // It stays REACHABLE on purpose — peers sit on different bundle versions
    // for days, so removing it in the release that promotes create_tasks
    // breaks every session that has not restarted. This assertion is the
    // record that it is deprecated rather than merely unloved.
    const decl = declarationFor('create_task');
    expect(decl).toMatch(/NOT the canonical create/);
    expect(decl).toMatch(/create_tasks/);
  });

  it('documents the batch-local dependency reference on the row schema', () => {
    const decl = declarationFor('create_tasks');
    expect(decl).toMatch(/key\?/); // the row field that makes a reference possible
    expect(decl).toMatch(/#seed/); // the spelling
    expect(decl).toMatch(/ABOVE it/); // and the direction rule
  });
});

describe('the create handlers forward placement rather than dropping it', () => {
  it('single create passes `placed` through and returns the goal bands', () => {
    const h = handlerFor('create_task');
    expect(h).toMatch(/res\.placement\?\.placed/);
    expect(h).toMatch(/res\.placement\?\.goals/);
  });

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
    expect(BUNDLE).toContain('NOT the canonical create');
    expect(BUNDLE).toContain('/tasks/batch');
    expect(BUNDLE).toContain('placement');
  });
});
