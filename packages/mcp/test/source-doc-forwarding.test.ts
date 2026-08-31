/**
 * `create_tasks`'s `sourceDoc` reaches the server and the peers.
 *
 * The doc→task tie only works if the MCP layer forwards it: a schema field
 * the handler drops files the rows with no origin and no plan gate, and
 * nothing else would report the miss (the batch still succeeds). Same
 * "one layer away from where it's consumed" hazard create-tasks-tool.test.ts
 * guards for `placement`, and the same bundle hazard: `.mcp.json` loads the
 * committed `packages/plugin/mcp/index.js`, so a source-only change reaches
 * nobody.
 *
 * Source-reading, like tool-wiring.test.ts: mcp.ts is a bundle entry point
 * and exports nothing.
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

describe('create_tasks declares sourceDoc', () => {
  it('the schema names the field, both modes, and what the plan gate does', () => {
    const decl = declarationFor('create_tasks');
    expect(decl).toContain('sourceDoc');
    expect(decl).toMatch(/'plan'/);
    expect(decl).toMatch(/'discussion'/);
    // The consequence is the contract: an agent must learn from the schema
    // that plan rows are held drafts, not silently-queued work.
    expect(decl).toMatch(/held in triage until a person approves/);
    expect(decl).toMatch(/structured origin ref/);
  });
});

describe('the handler forwards sourceDoc both ways', () => {
  it('sends it to the batch route and returns the gate verdict', () => {
    const h = handlerFor('create_tasks');
    expect(h).toMatch(/sourceDoc !== undefined \? \{ sourceDoc \}/); // request
    expect(h).toMatch(/sourceDoc: res\.sourceDoc/); // response
  });
});

describe('the committed bundle peers load carries it', () => {
  it('has the schema text and the forwarding', () => {
    // Positive control first: a long-shipped literal is present, so a bundle
    // read that returned something useless fails here rather than letting
    // the assertions below pass vacuously.
    expect(BUNDLE).toContain('the only create verb');
    expect(BUNDLE).toContain('held in triage until a person approves');
    expect(BUNDLE).toContain('sourceDoc');
  });
});
