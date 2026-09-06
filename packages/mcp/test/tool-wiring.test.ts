/**
 * Every tool the server ADVERTISES has a handler, and vice versa.
 *
 * mcp.ts declares tools in one array and dispatches them in a switch a
 * thousand lines away, both by hand. Declaring without dispatching ships a
 * tool that is visible, callable, and answers "unknown tool" — and nothing
 * type-checks the pair, so it can only be found in the field, by a peer, on
 * a version that already shipped. This reads the source rather than the
 * module because mcp.ts is a bundle entry point and exports nothing.
 */
import { describe, expect, it } from 'vitest';
import { type BundleHarness, startBundle } from './harness/mcp-bundle.ts';
import { readMcpSource } from './harness/mcp-source.ts';

const SRC = readMcpSource();

/** Tool names from the `name: 'x',` lines inside the tools array — each is
 *  followed by a description on the next line, which is what distinguishes
 *  them from every other `name:` in the file. */
const declared = new Set(
  [...SRC.matchAll(/\n {6}name: '([a-z0-9_]+)',\n {6}description:/g)].map((m) => m[1] as string),
);
// Indentation is `{4,6}` rather than a fixed depth because the dispatch is
// mid-move: an arm still in `mcp.ts` sits inside the request handler at six,
// and one that has reached `tools/` sits inside its domain function at four.
// It stays a bounded range rather than ` +` so that a `case` nested deeper —
// inside a helper, inside another switch — cannot be counted as a tool.
const dispatched = new Set(
  [...SRC.matchAll(/\n {4,6}case '([a-z0-9_]+)': \{/g)].map((m) => m[1] as string),
);

describe('MCP tool wiring', () => {
  it('found both lists (the assertions below are otherwise vacuous)', () => {
    expect(declared.size).toBeGreaterThan(20);
    expect(dispatched.size).toBeGreaterThan(20);
    expect(declared.has('create_tasks')).toBe(true);
    expect(dispatched.has('create_tasks')).toBe(true);
  });

  it('advertises nothing it cannot answer', () => {
    expect([...declared].filter((n) => !dispatched.has(n))).toEqual([]);
  });

  it('answers nothing it does not advertise', () => {
    // The other direction is a tool nobody can discover: reachable by name
    // for whoever wrote it, invisible to every other agent.
    expect([...dispatched].filter((n) => !declared.has(n))).toEqual([]);
  });

  /**
   * A RENAMED tool keeps answering to its old name, and that is not the bug
   * the two assertions above look for. An alias is a fallthrough label with
   * no brace, so it is invisible to the `dispatched` regex — which is why it
   * is asserted here by name instead. Listing it makes the alias a decision
   * somebody wrote down, rather than a line that reads like a typo.
   */
  it('still answers the names these tools had before the rename', () => {
    for (const [alias, now] of [
      ['refresh_workspace', 'refresh_review'],
      ['set_workspace_groups', 'set_review_groups'],
      // The 2026-09 pass that made the verbs match the product's own words.
      // Their once-per-session deprecation line and the prose sweep that went
      // with them are asserted in deprecated-aliases.test.ts.
      ['bind_folder', 'attach_folder'],
      ['bind_mock', 'attach_mockup'],
      ['promote_to_task', 'spin_off_task'],
      ['retire_workspace', 'archive_workspace'],
      // The roster read followed its route off `attachments` when the agent
      // collection moved to /workspaces/<id>/agents.
      ['list_attachments', 'list_agents'],
    ] as const) {
      expect(SRC, alias).toMatch(new RegExp(`\\n( {4,6})case '${alias}':\\n\\1case '${now}': \\{`));
      // …and the old name is NOT advertised: an agent reading the tool list
      // should find one name for one thing.
      expect(declared.has(alias), alias).toBe(false);
      expect(declared.has(now), now).toBe(true);
    }
  });
});

/** The `case 'x': {` block for one tool, up to the next case. */
function handlerFor(tool: string): string {
  const start = SRC.indexOf(`case '${tool}': {`);
  expect(start, `no handler for ${tool}`).toBeGreaterThan(-1);
  const rest = SRC.slice(start + 1);
  return rest.slice(0, rest.indexOf('case '));
}

/** The declaration block for one tool, up to the next tool entry. */
function declarationFor(tool: string): string {
  const start = SRC.indexOf(`name: '${tool}',\n      description:`);
  expect(start, `no declaration for ${tool}`).toBeGreaterThan(-1);
  const rest = SRC.slice(start);
  return rest.slice(0, rest.indexOf('},\n    {'));
}

describe('find_and_replace forwards replaceAll', () => {
  // Positive control: the extractor really is reading that handler.
  it('found the handler, and it is the one that calls the find_and_replace route', () => {
    expect(handlerFor('find_and_replace')).toContain('/find_and_replace');
  });

  it('the handler puts replaceAll into the POST body instead of dropping it', () => {
    const handler = handlerFor('find_and_replace');
    const bodyStart = handler.indexOf("await http('POST'");
    expect(bodyStart, 'handler does not POST').toBeGreaterThan(-1);
    // The forward, not just the `as { … }` type annotation naming the field.
    expect(handler.slice(bodyStart)).toMatch(/replaceAll === true \? \{ replaceAll: true \}/);
  });

  it('the tool declares replaceAll and its description names the bulk-sweep use', () => {
    const decl = declarationFor('find_and_replace');
    expect(decl).toContain('replaceAll: {');
    expect(decl.toLowerCase()).toContain('every occurrence');
  });

  /**
   * Peers load the bundle, not the source — but `bundle.toContain('replaceAll')`
   * was satisfied by the SCHEMA naming the field, which is exactly the state
   * this describe exists to rule out: a declared parameter the handler drops.
   * So call it and read the body the bundle actually POSTs.
   */
  it('the committed bundle forwards it too, not just declares it', async () => {
    let h: BundleHarness | undefined;
    try {
      h = await startBundle();
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
  for (const tool of ['insert_blocks_at_anchor', 'insert_blocks_after_thread'] as const) {
    it(`${tool} declares placement, and the description names the list-item nesting trap`, () => {
      const decl = declarationFor(tool);
      expect(decl).toContain('placement: {');
      expect(decl).toContain("'after-block'");
      expect(decl).toContain("'top-level'");
      // The failure mode the param exists for must be discoverable from the
      // schema alone — an agent picks placement at the moment its anchor
      // sits inside a list item, not after re-reading the docs.
      expect(decl.toLowerCase()).toContain('list item');
    });

    it(`${tool} handler puts placement into the POST body instead of dropping it`, () => {
      // These handlers' http() calls are line-wrapped, so match the pieces
      // separately: a POST happens, and the body carries the forward (not
      // just the `as { … }` type annotation naming the field).
      const handler = handlerFor(tool);
      const bodyStart = handler.indexOf('await http(');
      expect(bodyStart, 'handler does not call http').toBeGreaterThan(-1);
      const call = handler.slice(bodyStart);
      expect(call).toContain("'POST'");
      expect(call).toMatch(/placement !== undefined \? \{ placement \}/);
    });
  }

  /** Same reasoning as above: the old `bundle.toContain("'after-block'")`
   *  could not tell a forwarded placement from the enum in the schema. */
  it('the committed bundle forwards placement too, not just declares it', async () => {
    let h: BundleHarness | undefined;
    try {
      h = await startBundle();
      const on = await h.call('insert_blocks_at_anchor', {
        docId: 'doc-1',
        anchorId: 'anc-1',
        markdown: '- a nested item',
        placement: 'after-block',
      });
      const post = on.sent.find((r) => r.method === 'POST' && r.path.endsWith('/insert_blocks'));
      expect(post, `no insert_blocks POST; sent ${JSON.stringify(on.sent)}`).toBeDefined();
      expect((post?.body as { placement?: unknown }).placement).toBe('after-block');

      // CONTROL: omitted stays omitted, so the server's own default still
      // decides for every caller that never passes one.
      const off = await h.call('insert_blocks_at_anchor', {
        docId: 'doc-1',
        anchorId: 'anc-1',
        markdown: '- a nested item',
      });
      const plain = off.sent.find((r) => r.method === 'POST' && r.path.endsWith('/insert_blocks'));
      expect((plain?.body as { placement?: unknown }).placement).toBeUndefined();
    } finally {
      await h?.stop();
    }
  }, 60_000);
});
