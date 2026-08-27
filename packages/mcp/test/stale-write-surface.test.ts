/**
 * The stale-write guard is a server behavior; this pins the MCP surface that
 * makes it usable. Same source-reading style as tool-wiring.test.ts (mcp.ts
 * is a bundle entry point and exports nothing):
 *
 *  - get_doc must send its caller's identity as `reader`, or no session ever
 *    gets read-tracking and every rewrite is judged by the blunt time window;
 *  - set_doc_content must advertise AND forward confirmOverwriteHumanEdits,
 *    or the refusal's own instructions name a field the tool rejects;
 *  - the tool description and server instructions must carry the carve-out —
 *    never rewrite a doc a human is editing from a stale copy — because the
 *    2026-08-26 incident's agent did exactly what the old text suggested.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '../src/mcp.ts'), 'utf8');

/** The `case 'x': {` block for one tool, up to the next case. */
function handlerFor(tool: string): string {
  const start = SRC.indexOf(`case '${tool}': {`);
  expect(start, `no handler for ${tool}`).toBeGreaterThan(-1);
  const rest = SRC.slice(start + 1);
  return rest.slice(0, rest.indexOf('case '));
}

/** The declaration block for one tool, up to the next tool entry. */
function declarationFor(tool: string): string {
  const start = SRC.indexOf(`name: '${tool}',`);
  expect(start, `no declaration for ${tool}`).toBeGreaterThan(-1);
  const rest = SRC.slice(start + 1);
  const next = rest.indexOf("name: '");
  return next === -1 ? rest : rest.slice(0, next);
}

describe('stale-write guard MCP surface', () => {
  it('get_doc identifies its reader so the server can track staleness per session', () => {
    expect(handlerFor('get_doc')).toContain('reader=');
  });

  it('set_doc_content advertises confirmOverwriteHumanEdits and forwards it', () => {
    expect(declarationFor('set_doc_content')).toContain('confirmOverwriteHumanEdits');
    expect(handlerFor('set_doc_content')).toContain('confirmOverwriteHumanEdits');
  });

  it("set_doc_content's description warns against rewriting over live human edits", () => {
    const decl = declarationFor('set_doc_content');
    expect(decl).toContain('stale-write');
    expect(decl.toLowerCase()).toContain('scoped');
  });

  it('the server instructions carry the same carve-out next to the COMPREHENSIVE REWRITE pitch', () => {
    expect(SRC).toContain('COMPREHENSIVE REWRITE');
    // The carve-out must live in the instructions block, not only in the tool
    // description — the instructions are what a session reads at startup.
    const instrStart = SRC.indexOf('instructions: [');
    const instr = SRC.slice(instrStart, SRC.indexOf('DIFF REVIEW'));
    expect(instrStart).toBeGreaterThan(-1);
    expect(instr).toContain('stale-write');
  });

  it("find_and_replace's description says table rows match in pipe syntax", () => {
    expect(declarationFor('find_and_replace').toLowerCase()).toContain('table row');
  });
});
