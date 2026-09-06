/**
 * The version a session reports on attach is the version it is RUNNING.
 *
 * The server can only tell Bryan that a peer is eleven releases behind if the
 * peer says which bundle it is. There is exactly one honest source for that
 * inside the MCP child — the literal the initialize handshake already uses —
 * and what has to hold is that attach sends the SAME value rather than a
 * second literal that can drift on its own. A fourth version site is exactly
 * the failure this whole area keeps repeating.
 *
 * Driven through the committed bundle rather than read out of `mcp.ts`. The
 * old form matched `const PLUGIN_VERSION = '…';` and `pluginVersion:
 * PLUGIN_VERSION,` in the source, which proves nothing about the artifact a
 * peer loads: a source edit that was never rebuilt passes it, and so does a
 * `pluginVersion` the handler assembles and then drops. What a client is
 * handed at initialize, and what the server receives on the attach POST, are
 * both observable — so assert those.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BundleHarness, startBundle } from './harness/mcp-bundle.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(
  readFileSync(join(HERE, '../../plugin/.claude-plugin/plugin.json'), 'utf8'),
) as { version: string };

let h: BundleHarness;

beforeAll(async () => {
  h = await startBundle();
}, 60_000);

afterAll(async () => {
  await h?.stop();
});

describe('the MCP reports its own bundle version', () => {
  it('hands the manifest version to a client at initialize', () => {
    // Not "a version": THE version, so the number a session reports and the
    // number the marketplace ships cannot drift apart unnoticed.
    expect(h.serverVersion).toBe(MANIFEST.version);
  });

  it('sends the same value in the attach_agent body', async () => {
    // The whole point. A version the server never receives cannot be
    // compared against anything.
    const res = await h.call('attach_agent', { workspaceId: 'w-stub' });
    const post = res.sent.find((r) => r.method === 'POST' && r.path.endsWith('/agents'));
    expect(post, `no attach POST; sent ${JSON.stringify(res.sent)}`).toBeDefined();
    expect((post?.body as { pluginVersion?: unknown }).pluginVersion).toBe(h.serverVersion);
  });

  it('CONTROL: the attach body is not simply echoing every string it is given', async () => {
    // Without this, "pluginVersion equals serverVersion" would also pass on a
    // handler that copied some unrelated field into it.
    const res = await h.call('attach_agent', { workspaceId: 'w-stub' });
    const post = res.sent.find((r) => r.method === 'POST' && r.path.endsWith('/agents'));
    expect((post?.body as { pluginVersion?: unknown }).pluginVersion).not.toBe('w-stub');
    expect((post?.body as { pluginVersion?: unknown }).pluginVersion).toMatch(/^\d+\.\d+\.\d+/);
  });
});
