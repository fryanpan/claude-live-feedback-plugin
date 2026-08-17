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
 *    not the source, and a tool description IS the deliverable when the
 *    change is "here is the new way to say this" — there is no behaviour to
 *    notice, so nothing else reports the miss.
 *
 * Source-reading, like create-tasks-tool.test.ts: mcp.ts is a bundle entry
 * point and exports nothing.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '../src/mcp.ts'), 'utf8');
const BUNDLE = readFileSync(join(HERE, '../../plugin/mcp/index.js'), 'utf8');

function handlerFor(tool: string): string {
  const start = SRC.indexOf(`case '${tool}': {`);
  expect(start, `no handler for ${tool}`).toBeGreaterThan(-1);
  const rest = SRC.slice(start + 1);
  return rest.slice(0, rest.indexOf('case '));
}

function declarationFor(tool: string): string {
  const start = SRC.indexOf(`name: '${tool}',\n      description:`);
  expect(start, `no declaration for ${tool}`).toBeGreaterThan(-1);
  const rest = SRC.slice(start);
  return rest.slice(0, rest.indexOf('},\n    {'));
}

describe('set_goal_list declares the generated-id contract', () => {
  it('does not require an id, at either level', () => {
    const decl = declarationFor('set_goal_list');
    // Positive control: the schema is really in view — `title` is required at
    // both levels, so a decl slice that captured nothing fails here first.
    expect(decl.match(/required: \['title'\]/g) ?? []).toHaveLength(2);
    expect(decl).not.toMatch(/required: \['id', 'title'\]/);
  });

  it('says how to create, how to keep, and what happens to an id the board lacks', () => {
    const decl = declarationFor('set_goal_list');
    expect(decl).toMatch(/GOAL IDS ARE GENERATED AND PERMANENT/);
    expect(decl).toMatch(/NO `id` at all/);
    expect(decl).toMatch(/unknown-goal-id/);
    expect(decl).toMatch(/created/);
  });

  it('the sibling verbs stop describing the re-key as something that lands', () => {
    // rename_goal used to explain that renaming through set_goal_list "is a
    // removal plus an addition" — true then, wrong now, and a description that
    // describes a gesture the server refuses sends the agent to do it anyway.
    expect(declarationFor('rename_goal')).toMatch(/generated and permanent/);
  });
});

describe('the handler forwards `created` rather than dropping it', () => {
  it('reads it off the response and returns it', () => {
    const h = handlerFor('set_goal_list');
    expect(h).toMatch(/created: Array<\{ id: string; title: string; parent\?: string \}>/);
    expect(h).toMatch(/created: res\.created/);
  });
});

describe('the committed bundle peers load carries all of it', () => {
  it('has the contract text and the forwarding', () => {
    // Positive control first: a tool that has shipped for months is present,
    // so a bundle read that returned something useless fails here rather than
    // passing the assertions below vacuously.
    expect(BUNDLE).toContain('list_attachments');
    expect(BUNDLE).toContain('GOAL IDS ARE GENERATED AND PERMANENT');
    expect(BUNDLE).toContain('unknown-goal-id');
    expect(BUNDLE).toContain('created: res.created');
  });
});
