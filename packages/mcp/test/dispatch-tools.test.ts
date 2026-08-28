/**
 * `register_dispatch` / `close_dispatch` reach peers, and reach the right
 * routes.
 *
 * Source-reading, like plugin-refresh-tool.test.ts and for its reasons: a
 * tool declared in `mcp.ts` but never built into
 * `packages/plugin/mcp/index.js` is invisible to every peer, and a handler
 * pointed at the wrong verb or path fails only in a peer's session. The
 * routes themselves are covered end to end in
 * packages/server/test/dispatch-routes.test.ts.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '../src/mcp.ts'), 'utf8');
const BUNDLE = readFileSync(join(HERE, '../../plugin/mcp/index.js'), 'utf8');

describe('dispatch tools', () => {
  it('register_dispatch requires the task and the worktree path', () => {
    const decl = SRC.slice(SRC.indexOf("name: 'register_dispatch',"));
    const schema = decl.slice(0, decl.indexOf('},\n    {'));
    expect(schema).toMatch(/required: \['taskId', 'worktreePath'\]/);
  });

  it('register_dispatch POSTs the route the server serves', () => {
    const start = SRC.indexOf("case 'register_dispatch': {");
    expect(start).toBeGreaterThan(-1);
    const body = SRC.slice(start + 1, SRC.indexOf('case ', start + 1));
    expect(body).toMatch(/http\('POST', '\/api\/dispatches'/);
  });

  it('close_dispatch DELETEs the per-task route', () => {
    const start = SRC.indexOf("case 'close_dispatch': {");
    expect(start).toBeGreaterThan(-1);
    const body = SRC.slice(start + 1, SRC.indexOf('case ', start + 1));
    expect(body).toMatch(/http\(\s*'DELETE',\s*`\/api\/dispatches\/\$\{encodeURIComponent\(/);
  });

  it('both are in the committed bundle peers actually load', () => {
    // Positive control: a tool that has shipped for months is present too,
    // so a bundle read returning nothing useful fails rather than passes.
    expect(BUNDLE).toContain('list_attachments');
    expect(BUNDLE).toContain('register_dispatch');
    expect(BUNDLE).toContain('close_dispatch');
    expect(BUNDLE).toContain('/api/dispatches');
  });
});
