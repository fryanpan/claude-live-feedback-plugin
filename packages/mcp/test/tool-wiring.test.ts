/**
 * Every tool the server ADVERTISES has a handler, and the renamed ones still
 * answer to the names they had before.
 *
 * The registry declares tools in one array and the dispatch answers them in
 * domain handlers a thousand lines away, both by hand. Declaring without
 * dispatching ships a tool that is visible, callable, and answers "unknown
 * tool" — and nothing type-checks the pair, so it can only be found in the
 * field, by a peer, on a version that already shipped.
 *
 * DRIVEN, NOT GREPPED. This file used to build two sets out of the
 * concatenated source with a `name: 'x',` regex and a `case 'x': {` regex and
 * compare them. That is a proxy for the thing: it cannot see a dispatch arm
 * the formatter re-indented out of its `{4,6}` window, it counts a `case`
 * inside an unrelated switch as a tool, and — the failure that matters most
 * here — it says nothing at all about `packages/plugin/mcp/index.js`, which
 * is the artifact `.mcp.json` loads and a peer runs. A tool wired in the
 * source and never rebuilt reaches nobody, and the old form was green for it.
 *
 * So: boot the committed bundle over stdio, take the advertised list from
 * `tools/list`, and CALL each name. "Has a handler" stops being a regex match
 * and becomes the server not answering `unknown tool`.
 *
 * WHAT THIS NO LONGER CHECKS, said plainly. The old file also asserted the
 * other direction — a `case` arm for a name nothing declares, a tool
 * reachable by whoever wrote it and invisible to everyone else. MCP has no
 * introspection for that: `tools/list` is the only enumeration a client gets,
 * so an undeclared arm cannot be observed from outside except by guessing its
 * name. What is checked instead is the bounded set that direction was really
 * protecting — the deprecated aliases, which ARE answered and deliberately
 * not advertised — plus a control proving an unknown name is refused.
 */
import { describe, expect, it } from 'vitest';
import { DEPRECATED_TOOL_ALIASES } from '../src/deprecated-aliases.ts';
import { type BundleHarness, type ToolDecl, startBundle } from './harness/mcp-bundle.ts';

/** Answering `unknown tool: x` is the shape of "declared and dispatched
 *  nowhere" — a normal result with `isError`, not a JSON-RPC error. */
const unknownTool = (text: string, name: string) => text.includes(`unknown tool: ${name}`);

describe('MCP tool wiring', () => {
  it('advertises nothing it cannot answer, and answers the old names too', async () => {
    let h: BundleHarness | undefined;
    try {
      h = await startBundle();
      const declared = h.tools.map((t) => t.name);

      // Positive control for everything below: the list is real and the probe
      // can tell a served name from an unserved one.
      expect(declared.length).toBeGreaterThan(20);
      expect(declared).toContain('create_tasks');
      const nonsense = await h.call('no_such_tool_at_all', {});
      expect(unknownTool(nonsense.text, 'no_such_tool_at_all')).toBe(true);

      // Every advertised name reaches an arm. Called with no arguments: a
      // handler that objects to its arguments has still ANSWERED, which is
      // the only thing in question here.
      const orphans: string[] = [];
      for (const name of declared) {
        const res = await h.call(name, {});
        if (unknownTool(res.text, name)) orphans.push(name);
      }
      expect(orphans).toEqual([]);

      // The other direction, on the set where it is observable. A renamed
      // tool keeps answering its old name for one release, and must NOT be
      // advertised — an agent reading the tool list should find one name for
      // one thing.
      for (const [alias, now] of Object.entries(DEPRECATED_TOOL_ALIASES)) {
        expect(declared, alias).not.toContain(alias);
        expect(declared, now).toContain(now);
        // Same arm, not merely a second arm that also answers: the same
        // arguments have to produce the same requests and the same reply.
        const viaAlias = await h.call(alias, {});
        const viaNow = await h.call(now, {});
        expect(unknownTool(viaAlias.text, alias), `${alias} is not answered`).toBe(false);
        expect(viaAlias.text, alias).toBe(viaNow.text);
        expect(
          viaAlias.sent.map((r) => `${r.method} ${r.url}`),
          alias,
        ).toEqual(viaNow.sent.map((r) => `${r.method} ${r.url}`));
      }
    } finally {
      await h?.stop();
    }
  }, 120_000);
});

describe('find_and_replace forwards replaceAll', () => {
  /**
   * The declaration half is read off `tools/list` rather than out of the
   * schema file: the description IS the product surface, and what has to be
   * true is that a client is handed it.
   *
   * The handler half was `handlerFor('find_and_replace')` over the source,
   * matching `replaceAll === true ? { replaceAll: true }`. It went red on any
   * respelling of the same forward and green on a bundle that was never
   * rebuilt. The call below reads the body the running bundle actually POSTs,
   * which is the question — and `bundle.toContain('replaceAll')` before it
   * was satisfied by the SCHEMA naming the field, which is exactly the state
   * this describe exists to rule out: a declared parameter the handler drops.
   */
  it('declares replaceAll, names the bulk-sweep use, and forwards it', async () => {
    let h: BundleHarness | undefined;
    try {
      h = await startBundle();
      const decl = h.tool('find_and_replace') as ToolDecl | undefined;
      expect(decl, 'the bundle declares no find_and_replace tool').toBeDefined();
      const replaceAll = decl?.inputSchema?.properties?.replaceAll as
        | { description?: string }
        | undefined;
      expect(replaceAll, 'find_and_replace declares no replaceAll').toBeDefined();
      expect(`${decl?.description ?? ''} ${replaceAll?.description ?? ''}`.toLowerCase()).toContain(
        'every occurrence',
      );

      const on = await h.call('find_and_replace', {
        docId: 'doc-1',
        find: 'alpha',
        replace: 'beta',
        replaceAll: true,
      });
      const post = on.sent.find((r) => r.method === 'POST' && r.path.endsWith('/find_and_replace'));
      expect(post, `no find_and_replace POST; sent ${JSON.stringify(on.sent)}`).toBeDefined();
      expect((post?.body as { replaceAll?: unknown }).replaceAll).toBe(true);

      // CONTROL: the field is absent, not defaulted, when the caller omits it.
      // A handler that hard-coded `replaceAll: true` would pass the assertion
      // above and change what every existing caller does.
      const off = await h.call('find_and_replace', {
        docId: 'doc-1',
        find: 'alpha',
        replace: 'beta',
      });
      const plain = off.sent.find(
        (r) => r.method === 'POST' && r.path.endsWith('/find_and_replace'),
      );
      expect((plain?.body as { replaceAll?: unknown }).replaceAll).toBeUndefined();
    } finally {
      await h?.stop();
    }
  }, 60_000);
});

describe('insert_blocks tools forward placement', () => {
  it('both tools declare placement, name the nesting trap, and forward it', async () => {
    let h: BundleHarness | undefined;
    try {
      h = await startBundle();
      for (const tool of ['insert_blocks_at_anchor', 'insert_blocks_after_thread'] as const) {
        const decl = h.tool(tool) as ToolDecl | undefined;
        expect(decl, `the bundle declares no ${tool} tool`).toBeDefined();
        const placement = decl?.inputSchema?.properties?.placement as
          | { enum?: string[]; description?: string }
          | undefined;
        expect(placement, `${tool} declares no placement`).toBeDefined();
        expect(placement?.enum).toEqual(expect.arrayContaining(['after-block', 'top-level']));
        // The failure mode the param exists for must be discoverable from the
        // schema alone — an agent picks placement at the moment its anchor
        // sits inside a list item, not after re-reading the docs.
        expect(
          `${decl?.description ?? ''} ${placement?.description ?? ''}`.toLowerCase(),
          tool,
        ).toContain('list item');
      }

      const anchored = {
        docId: 'doc-1',
        anchorId: 'anc-1',
        threadId: 'th-1',
        markdown: '- a nested item',
      };
      for (const tool of ['insert_blocks_at_anchor', 'insert_blocks_after_thread'] as const) {
        const on = await h.call(tool, { ...anchored, placement: 'after-block' });
        const post = on.sent.find((r) => r.method === 'POST' && r.path.includes('/insert_blocks'));
        expect(
          post,
          `no insert_blocks POST for ${tool}; sent ${JSON.stringify(on.sent)}`,
        ).toBeDefined();
        expect((post?.body as { placement?: unknown }).placement, tool).toBe('after-block');

        // CONTROL: omitted stays omitted, so the server's own default still
        // decides for every caller that never passes one.
        const off = await h.call(tool, anchored);
        const plain = off.sent.find(
          (r) => r.method === 'POST' && r.path.includes('/insert_blocks'),
        );
        expect((plain?.body as { placement?: unknown }).placement, tool).toBeUndefined();
      }
    } finally {
      await h?.stop();
    }
  }, 60_000);
});
