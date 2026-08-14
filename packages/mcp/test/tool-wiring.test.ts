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
    expect(declared.has('create_task')).toBe(true);
    expect(dispatched.has('create_task')).toBe(true);
  });

  it('advertises nothing it cannot answer', () => {
    expect([...declared].filter((n) => !dispatched.has(n))).toEqual([]);
  });

  it('answers nothing it does not advertise', () => {
    // The other direction is a tool nobody can discover: reachable by name
    // for whoever wrote it, invisible to every other agent.
    expect([...dispatched].filter((n) => !declared.has(n))).toEqual([]);
  });
});
