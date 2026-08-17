/**
 * `request_plugin_refresh` reaches peers, and reaches the right route.
 *
 * Two failures this covers, both of which have happened here before:
 *
 *  - A tool declared in `mcp.ts` and never built into
 *    `packages/plugin/mcp/index.js` is invisible to every peer, because
 *    `.mcp.json` loads the committed BUNDLE, not the source. PR #69 shipped a
 *    schema change exactly that way and nobody got it.
 *  - The server route is covered end to end (plugin-refresh-routes.test.ts),
 *    and the pure refresher is covered by unit tests — but nothing yet checks
 *    that the MCP handler calls the path those tests serve. A tool pointed at
 *    the wrong verb or path fails only in a peer's session.
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

describe('request_plugin_refresh', () => {
  it('is declared with no inputs at all', () => {
    // The server spawns a process. Keeping the schema empty is what makes
    // "nothing a caller sends reaches a process" checkable rather than a
    // claim in a comment — the argv is fixed on the server side, and there
    // is no parameter here that could ever want to reach it.
    const decl = SRC.slice(SRC.indexOf("name: 'request_plugin_refresh',"));
    const schema = decl.slice(0, decl.indexOf('},\n    {'));
    expect(schema).toMatch(/inputSchema: \{ type: 'object', properties: \{\} \}/);
    expect(schema).not.toMatch(/required:/);
  });

  it('POSTs the route the server actually serves', () => {
    const start = SRC.indexOf("case 'request_plugin_refresh': {");
    expect(start).toBeGreaterThan(-1); // the slice below is meaningless without this
    const handler = SRC.slice(start + 1);
    const body = handler.slice(0, handler.indexOf('case '));
    expect(body).toMatch(/http\('POST', '\/api\/plugin\/refresh'\)/);
  });

  it('is in the committed bundle peers actually load', () => {
    // Positive control alongside it: a tool that has shipped for months is
    // present too, so a bundle read that somehow returned nothing useful
    // would fail here rather than pass this test vacuously.
    expect(BUNDLE).toContain('list_attachments');
    expect(BUNDLE).toContain('request_plugin_refresh');
    expect(BUNDLE).toContain('/api/plugin/refresh');
  });
});
