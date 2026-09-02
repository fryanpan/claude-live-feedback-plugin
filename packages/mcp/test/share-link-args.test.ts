/**
 * `share_link` forwards what the caller sent, key for key.
 *
 * The handler used to destructure three named keys and forward those, so
 * `share_link(docId, ttl: '15m')` reached the server as a bare board share and
 * came back 200 — the whole board, for two weeks, to a caller who asked for
 * one doc for fifteen minutes. The server now refuses every key it does not
 * honour by name, and the only way that refusal reaches the caller is if every
 * key gets there.
 *
 * That is a wire fact, so this test now reads the wire. It used to slice
 * `mcp.ts` for the handler and grep the built bundle for
 * `http("POST", "/api/share/link", a)` — a regex that a minifier's variable
 * rename breaks while the feature works, and that a deleted handler leaves
 * intact. The harness runs the committed bundle against a recording stub and
 * asserts on the body the server was actually sent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BundleHarness, startBundle } from './harness/mcp-bundle.ts';

let mcp: BundleHarness;

beforeAll(async () => {
  mcp = await startBundle(() => ({ url: 'https://example.invalid/s/abc', ttlSeconds: 900 }));
}, 60_000);
afterAll(async () => {
  await mcp?.stop();
});

describe('share_link', () => {
  it('POSITIVE CONTROL: the running bundle serves a known tool', () => {
    expect(mcp.tool('list_attachments')).toBeDefined();
    expect(mcp.tool('share_hyperlink')).toBeUndefined();
  });

  it('POSTs the link route', async () => {
    const res = await mcp.call('share_link', { workspaceId: 'w-1' });
    expect(res.isError).toBe(false);
    expect(res.sent.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /api/share/link']);
  });

  it('forwards the arguments object itself, not a hand-picked subset', async () => {
    // `docId` is the key the old shape dropped, and `ttl` the one it turned
    // into the default. Both have to reach the server for it to refuse them
    // by name rather than silently widen the share.
    const res = await mcp.call('share_link', {
      workspaceId: 'w-1',
      docId: 'doc-42',
      ttl: '15m',
      label: 'Design partner',
    });
    // A docId in the arguments also arms the auto-watch, so pick the share
    // request rather than assuming it is the only one.
    const share = res.sent.find((r) => r.path === '/api/share/link');
    expect(share?.body).toEqual({
      workspaceId: 'w-1',
      docId: 'doc-42',
      ttl: '15m',
      label: 'Design partner',
    });
  });

  it('returns the server answer to the caller unchanged', async () => {
    const res = await mcp.call('share_link', { workspaceId: 'w-1' });
    expect(res.json).toEqual({ url: 'https://example.invalid/s/abc', ttlSeconds: 900 });
  });

  it('declares ttl as a duration string alongside ttlSeconds, and names the real default', () => {
    const decl = mcp.tool('share_link');
    expect(decl).toBeDefined();
    const props = decl?.inputSchema?.properties ?? {};
    expect(props.ttl?.type).toBe('string');
    expect(props.ttl?.description).toContain("'15m'");
    expect(props.ttlSeconds?.type).toBe('number');
    // The link-mode default is two weeks (DEFAULT_LINK_TTL_SECONDS); the
    // description used to promise one.
    expect(props.ttlSeconds?.description).not.toMatch(/one week/i);
    expect(props.ttlSeconds?.description).toMatch(/two weeks/i);
  });
});
