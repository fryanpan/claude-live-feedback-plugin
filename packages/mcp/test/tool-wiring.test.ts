/**
 * Every tool the server ADVERTISES has a handler, and vice versa.
 *
 * mcp.ts declares tools in one array and dispatches them in a switch a
 * thousand lines away, both by hand. Declaring without dispatching ships a
 * tool that is visible, callable, and answers "unknown tool" — and nothing
 * type-checks the pair, so it can only be found in the field, by a peer, on
 * a version that already shipped. This reads the source rather than the
 * module because mcp.ts is a bundle entry point and exports nothing.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Not `import.meta.dir` — that is Bun-only, and this file is collected by
// vitest as well as by `bun test`.
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '../src/mcp.ts'), 'utf8');

/** Tool names from the `name: 'x',` lines inside the tools array — each is
 *  followed by a description on the next line, which is what distinguishes
 *  them from every other `name:` in the file. */
const declared = new Set(
  [...SRC.matchAll(/\n {6}name: '([a-z0-9_]+)',\n {6}description:/g)].map((m) => m[1] as string),
);
const dispatched = new Set(
  [...SRC.matchAll(/\n {6}case '([a-z0-9_]+)': \{/g)].map((m) => m[1] as string),
);

describe('MCP tool wiring', () => {
  it('found both lists (the assertions below are otherwise vacuous)', () => {
    expect(declared.size).toBeGreaterThan(20);
    expect(dispatched.size).toBeGreaterThan(20);
    expect(declared.has('create_tasks')).toBe(true);
    expect(dispatched.has('create_tasks')).toBe(true);
  });

  it('advertises nothing it cannot answer', () => {
    expect([...declared].filter((n) => !dispatched.has(n))).toEqual([]);
  });

  it('answers nothing it does not advertise', () => {
    // The other direction is a tool nobody can discover: reachable by name
    // for whoever wrote it, invisible to every other agent.
    expect([...dispatched].filter((n) => !declared.has(n))).toEqual([]);
  });

  /**
   * A RENAMED tool keeps answering to its old name, and that is not the bug
   * the two assertions above look for. An alias is a fallthrough label with
   * no brace, so it is invisible to the `dispatched` regex — which is why it
   * is asserted here by name instead. Listing it makes the alias a decision
   * somebody wrote down, rather than a line that reads like a typo.
   */
  it('still answers the names these tools had before the rename', () => {
    for (const [alias, now] of [
      ['refresh_workspace', 'refresh_review'],
      ['set_workspace_groups', 'set_review_groups'],
    ] as const) {
      expect(SRC, alias).toContain(`case '${alias}':\n      case '${now}': {`);
      // …and the old name is NOT advertised: an agent reading the tool list
      // should find one name for one thing.
      expect(declared.has(alias), alias).toBe(false);
      expect(declared.has(now), now).toBe(true);
    }
  });
});

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

describe('find_and_replace forwards replaceAll', () => {
  // Positive control: the extractor really is reading that handler.
  it('found the handler, and it is the one that calls the find_and_replace route', () => {
    expect(handlerFor('find_and_replace')).toContain('/find_and_replace');
  });

  it('the handler puts replaceAll into the POST body instead of dropping it', () => {
    const handler = handlerFor('find_and_replace');
    const bodyStart = handler.indexOf("await http('POST'");
    expect(bodyStart, 'handler does not POST').toBeGreaterThan(-1);
    // The forward, not just the `as { … }` type annotation naming the field.
    expect(handler.slice(bodyStart)).toMatch(/replaceAll === true \? \{ replaceAll: true \}/);
  });

  it('the tool declares replaceAll and its description names the bulk-sweep use', () => {
    const decl = declarationFor('find_and_replace');
    expect(decl).toContain('replaceAll: {');
    expect(decl.toLowerCase()).toContain('every occurrence');
  });

  it('the committed bundle carries the forward too (peers load the bundle, not the source)', () => {
    const bundle = readFileSync(join(HERE, '../../plugin/mcp/index.js'), 'utf8');
    expect(bundle).toContain('replaceAll');
  });
});

describe('insert_blocks tools forward placement', () => {
  for (const tool of ['insert_blocks_at_anchor', 'insert_blocks_after_thread'] as const) {
    it(`${tool} declares placement, and the description names the list-item nesting trap`, () => {
      const decl = declarationFor(tool);
      expect(decl).toContain('placement: {');
      expect(decl).toContain("'after-block'");
      expect(decl).toContain("'top-level'");
      // The failure mode the param exists for must be discoverable from the
      // schema alone — an agent picks placement at the moment its anchor
      // sits inside a list item, not after re-reading the docs.
      expect(decl.toLowerCase()).toContain('list item');
    });

    it(`${tool} handler puts placement into the POST body instead of dropping it`, () => {
      // These handlers' http() calls are line-wrapped, so match the pieces
      // separately: a POST happens, and the body carries the forward (not
      // just the `as { … }` type annotation naming the field).
      const handler = handlerFor(tool);
      const bodyStart = handler.indexOf('await http(');
      expect(bodyStart, 'handler does not call http').toBeGreaterThan(-1);
      const call = handler.slice(bodyStart);
      expect(call).toContain("'POST'");
      expect(call).toMatch(/placement !== undefined \? \{ placement \}/);
    });
  }

  it('the committed bundle carries the forward too (peers load the bundle, not the source)', () => {
    const bundle = readFileSync(join(HERE, '../../plugin/mcp/index.js'), 'utf8');
    expect(bundle).toContain("'after-block'");
  });
});
