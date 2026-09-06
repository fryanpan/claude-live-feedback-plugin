/**
 * The stale-write guard is a server behavior; this pins the MCP surface that
 * makes it usable.
 *
 *  - get_doc must send its caller's identity as `reader`, or no session ever
 *    gets read-tracking and every rewrite is judged by the blunt time window;
 *  - set_doc_content must advertise AND forward confirmOverwriteHumanEdits,
 *    or the refusal's own instructions name a field the tool rejects;
 *  - the tool description and server instructions must carry the carve-out —
 *    never rewrite a doc a human is editing from a stale copy — because the
 *    2026-08-26 incident's agent did exactly what the old text suggested.
 *
 * Driven through the committed bundle rather than read out of `mcp.ts`. Every
 * claim here is about something a session RECEIVES: the `reader` on the wire,
 * the schema `tools/list` returns, the description a client is handed, and
 * the `instructions` string delivered at initialize. Grepping the source for
 * those proved only that a literal existed somewhere in a file — it passed on
 * a description no client is given and on a field the handler drops.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BundleHarness, type ToolDecl, startBundle } from './harness/mcp-bundle.ts';

let h: BundleHarness;

beforeAll(async () => {
  h = await startBundle();
}, 60_000);

afterAll(async () => {
  await h?.stop();
});

/** The declaration a real MCP client receives for one tool. */
function decl(tool: string): ToolDecl {
  const t = h.tool(tool);
  expect(t, `${tool} is not in tools/list (${h.tools.length} tools listed)`).toBeDefined();
  return t as ToolDecl;
}

describe('stale-write guard MCP surface', () => {
  it('found the running bundle (the assertions below are otherwise vacuous)', () => {
    expect(h.tools.length).toBeGreaterThan(20);
    expect(h.instructions.length).toBeGreaterThan(200);
  });

  it('get_doc identifies its reader so the server can track staleness per session', async () => {
    const res = await h.call('get_doc', { docId: 'doc-1' });
    const get = res.sent.find((r) => r.method === 'GET' && r.path.includes('/docs/doc-1'));
    expect(get, `no get_doc GET; sent ${JSON.stringify(res.sent)}`).toBeDefined();
    // A named reader, not the empty string a dropped identity would send.
    expect(get?.query.get('reader')).toBeTruthy();
  });

  it('set_doc_content advertises confirmOverwriteHumanEdits and forwards it', async () => {
    const props = decl('set_doc_content').inputSchema?.properties ?? {};
    expect(Object.keys(props)).toContain('confirmOverwriteHumanEdits');

    const res = await h.call('set_doc_content', {
      docId: 'doc-1',
      markdown: '# rewritten',
      confirmOverwriteHumanEdits: true,
    });
    const post = res.sent.find((r) => r.method === 'POST' && r.path.endsWith('/content'));
    expect(post, `no set_doc_content POST; sent ${JSON.stringify(res.sent)}`).toBeDefined();
    expect(
      (post?.body as { confirmOverwriteHumanEdits?: unknown }).confirmOverwriteHumanEdits,
    ).toBe(true);
  });

  it('CONTROL: the confirm flag is absent, not defaulted, when the caller omits it', async () => {
    // A handler that hard-coded it would pass the assertion above while
    // turning the guard off for every caller that never asked.
    const res = await h.call('set_doc_content', { docId: 'doc-1', markdown: '# rewritten' });
    const post = res.sent.find((r) => r.method === 'POST' && r.path.endsWith('/content'));
    expect(
      (post?.body as { confirmOverwriteHumanEdits?: unknown }).confirmOverwriteHumanEdits,
    ).toBeUndefined();
  });

  it("set_doc_content's description warns against rewriting over live human edits", () => {
    const description = decl('set_doc_content').description ?? '';
    expect(description).toContain('stale-write');
    expect(description.toLowerCase()).toContain('scoped');
  });

  it('the server instructions carry the same carve-out next to the COMPREHENSIVE REWRITE pitch', () => {
    // The instructions are what a session reads at startup, so the carve-out
    // has to be in THIS string and not only in the tool description.
    expect(h.instructions).toContain('COMPREHENSIVE REWRITE');
    const pitch = h.instructions.slice(0, h.instructions.indexOf('DIFF REVIEW'));
    expect(pitch.length, 'no DIFF REVIEW section in the instructions').toBeGreaterThan(0);
    expect(pitch).toContain('stale-write');
  });

  it("find_and_replace's description says table rows match in pipe syntax", () => {
    expect((decl('find_and_replace').description ?? '').toLowerCase()).toContain('table row');
  });
});
