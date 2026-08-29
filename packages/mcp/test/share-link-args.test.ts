/**
 * `share_link` forwards the call AS SENT, so the server can honour or refuse
 * every argument — the client never drops one.
 *
 * The field report: `share_link(workspaceId, docId: "…", ttl: "15m")` came
 * back 200 with the whole board shared for two weeks. The server already
 * refused `docId` by name (410) and would have honoured a TTL — neither
 * reached it, because the handler destructured `{ workspaceId, ttlSeconds,
 * label }` and forwarded only those. An argument the schema does not name
 * is not an error to the MCP SDK; it is simply absent from the wire, and
 * the caller reads the 200 as "done".
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

describe('share_link', () => {
  it('found the handler, and it is the one that POSTs the link route', () => {
    expect(handlerFor('share_link')).toContain("'/api/share/link'");
  });

  it('forwards the arguments object itself, not a hand-picked subset', () => {
    const handler = handlerFor('share_link');
    expect(handler).toMatch(/http\('POST', '\/api\/share\/link', a\)/);
    // The old shape — the one that dropped docId and ttl on the floor.
    expect(handler).not.toMatch(/const \{ workspaceId, ttlSeconds, label \}/);
  });

  it('declares ttl as a duration string alongside ttlSeconds, and names the real default', () => {
    const decl = declarationFor('share_link');
    expect(decl).toContain('ttl: {');
    expect(decl).toContain("'15m'");
    expect(decl).toContain('ttlSeconds: {');
    // The link-mode default is two weeks (DEFAULT_LINK_TTL_SECONDS); the
    // description used to promise one.
    expect(decl).not.toMatch(/one week/i);
    expect(decl).toMatch(/two weeks/i);
  });

  it('the committed bundle carries the forward too (peers load the bundle, not the source)', () => {
    // Positive control: a string that has been in the bundle for months.
    expect(BUNDLE).toContain('/api/share/link');
    expect(BUNDLE).toMatch(/http\("POST", "\/api\/share\/link", a\)/);
  });
});
