/**
 * The MCP server's source, as one string, the way it used to be one file.
 *
 * A dozen tests in this package read `mcp.ts` and assert on its text — that a
 * handler forwards a parameter rather than dropping it, that a description
 * names the trap its parameter exists for, that a `case` arm exists at all.
 * They read source rather than the module because `mcp.ts` is a bundle entry
 * point with top-level side effects and exports nothing importable.
 *
 * The split into `tool-schemas.ts` and `tools/` moved that text into four
 * more files without changing a line of it. Concatenating them here is what
 * keeps those assertions asking their original question — "does the server
 * do this?" — rather than the narrower one their `readFileSync` would now be
 * asking by accident, which is "does this ONE file do this?". A test that
 * silently narrows its subject is the failure the split is most likely to
 * cause and the least likely to announce.
 *
 * Order matters for the two tests that walk forward from a match to the next
 * `case`: files appear here in the order their code appeared in `mcp.ts`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Not `import.meta.dir` — that is Bun-only, and these files are collected by
// vitest as well as by `bun test`.
const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../src');

/** Every file the dispatch and the registry live in, in source order. */
export const MCP_SOURCE_FILES = [
  'tool-schemas.ts',
  'mcp.ts',
  'tools/docs.ts',
  'tools/tasks.ts',
  'tools/workspace.ts',
] as const;

/** All of it, joined — the subject the source-shape tests are written about. */
export function readMcpSource(): string {
  return MCP_SOURCE_FILES.map((f) => readFileSync(join(SRC_DIR, f), 'utf8')).join('\n');
}
