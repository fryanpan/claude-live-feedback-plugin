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
 *  - The handler is source-read, like dispatch-tools.test.ts and for its
 *    reasons: mcp.ts is a bundle entry point and exports nothing, and a
 *    handler pointed at the wrong route — or one that forgets `author`, so
 *    the change is recorded against `unknown` instead of this agent — fails
 *    only in a peer's session. The route itself is covered end to end in
 *    packages/server/test/parallelism-cap.test.ts.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCapArg } from '../src/parallelism-cap.ts';

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
  it('is declared with the two arguments the skill names, both required', () => {
    const decl = declarationFor('set_parallelism_cap');
    expect(decl).toMatch(/workspaceId: \{ type: 'string'/);
    expect(decl).toMatch(/cap: \{\s*type: 'integer'/);
    expect(decl).toMatch(/required: \['workspaceId', 'cap'\]/);
    // It tells the lead what a change does and does not do — the sentence
    // the skill already makes, so the two never disagree.
    expect(decl).toMatch(/next dispatch/);
  });

  it('refuses before any request when the cap is not a positive integer', () => {
    const h = handlerFor('set_parallelism_cap');
    const check = h.indexOf('parseCapArg(');
    const call = h.indexOf('http(');
    expect(check).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(-1);
    expect(check).toBeLessThan(call);
    expect(h).toMatch(/return err\(/);
  });

  it('PUTs the route the board uses, carrying this agent as author', () => {
    const h = handlerFor('set_parallelism_cap');
    expect(h).toMatch(
      /http\(\s*'PUT',\s*`\/api\/workspaces\/\$\{encodeURIComponent\(workspaceId\)\}\/parallelism-cap`/,
    );
    // `author: AUTHOR` is how every write tool identifies the agent (see
    // rename_goal); the route records the actor from it. Without it the
    // change lands as `unknown`.
    expect(h).toMatch(/author: AUTHOR/);
    // Positive control for the pattern: the neighbour it copies sends it too.
    expect(handlerFor('rename_goal')).toMatch(/author: AUTHOR/);
  });

  it('returns the cap and the recorded last change, not just an ack', () => {
    const h = handlerFor('set_parallelism_cap');
    expect(h).toMatch(/cap: res\.cap/);
    expect(h).toMatch(/lastChange: res\.lastChange/);
  });

  it('is in the committed bundle peers actually load', () => {
    // Positive control: a tool that has shipped for months is present too,
    // so a bundle read returning nothing useful fails rather than passes.
    expect(BUNDLE).toContain('list_attachments');
    expect(BUNDLE).toContain('set_parallelism_cap');
    expect(BUNDLE).toContain('/parallelism-cap');
  });
});
