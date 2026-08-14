/**
 * The version a session reports on attach is the version it is RUNNING.
 *
 * The server can only tell Bryan that a peer is eleven releases behind if the
 * peer says which bundle it is. There is exactly one honest source for that
 * inside the MCP child — the literal that the initialize handshake already
 * uses — and `launcher.test.ts` pins that literal to
 * `packages/plugin/.claude-plugin/plugin.json` by driving the real bundle. So
 * what is left to prove here is that attach sends the SAME value, rather than
 * a second literal that can drift on its own. A fourth version site is
 * exactly the failure this whole area keeps repeating.
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
const MANIFEST = JSON.parse(
  readFileSync(join(HERE, '../../plugin/.claude-plugin/plugin.json'), 'utf8'),
) as { version: string };

describe('the MCP reports its own bundle version', () => {
  it('declares the version once, as a named constant', () => {
    const decl = SRC.match(/const PLUGIN_VERSION = '([^']+)';/);
    expect(decl?.[1]).toBe(MANIFEST.version);
  });

  it('uses that constant for the initialize handshake', () => {
    // Positive control for the assertion below: if the handshake stopped
    // using it, the constant would no longer be pinned to the manifest by
    // launcher.test.ts, and attach would be reporting an unverified string.
    expect(SRC).toMatch(/version: PLUGIN_VERSION,/);
  });

  it('sends it in the attach_agent body', () => {
    // The whole point. A version the server never receives cannot be
    // compared against anything.
    const attach = SRC.slice(SRC.indexOf("case 'attach_agent': {"));
    const body = attach.slice(0, attach.indexOf('watchWorkspace'));
    expect(body).toMatch(/pluginVersion: PLUGIN_VERSION,/);
  });
});
