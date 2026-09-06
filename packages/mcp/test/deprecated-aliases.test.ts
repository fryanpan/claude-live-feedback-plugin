/**
 * A renamed tool answers to both names, once says so, and only the new name
 * is written down anywhere a person or an agent reads.
 *
 * Four verbs were named by the code rather than by the product —
 * `bind_folder`, `bind_mock`, `promote_to_task`, `retire_workspace` — while
 * the UI, the docs and the skills said attach, attach, spin off and archive.
 * Seven more said *review* for a set of docs, mockups, previews and diffs,
 * a word the rest of the product had already given to the review ITEM a
 * person answers; they took `attachment` instead.
 * Renaming them is cheap; the two ways it goes wrong are not. A peer running
 * last week's plugin bundle calls the old name and gets "unknown tool", which
 * costs somebody a turn to diagnose a rename they had no way to see — so the
 * old name has to keep landing on the same arm. And a doc left naming the old
 * verb teaches the next agent to call it, which is how an alias meant for one
 * release becomes permanent — so the prose has to move in the same commit.
 *
 * Both halves are asserted here, each with a control that fails if the check
 * has gone vacuous. All fixtures synthetic.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type CallToolDeps, type ToolContext, createCallToolHandler } from '../src/call-tool.ts';
import {
  DEPRECATED_TOOL_ALIASES,
  createAliasDeprecationWarner,
  deprecationLine,
} from '../src/deprecated-aliases.ts';
import { handleDocsTool } from '../src/tools/docs.ts';
import { handleTaskTool } from '../src/tools/tasks.ts';
import { handleWorkspaceTool } from '../src/tools/workspace.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '../../..');

const PAIRS = Object.entries(DEPRECATED_TOOL_ALIASES);

describe('the alias table is the one place the pairs are written down', () => {
  it('names the verbs this rename covers (the assertions below are otherwise vacuous)', () => {
    expect(DEPRECATED_TOOL_ALIASES).toEqual({
      bind_folder: 'attach_folder',
      bind_mock: 'attach_mockup',
      promote_to_task: 'spin_off_task',
      retire_workspace: 'archive_workspace',
      list_attachments: 'list_agents',
      create_review_doc: 'attach_markdown',
      delete_review: 'delete_attachment_set',
      archive_review: 'archive_attachment_set',
      unarchive_review: 'unarchive_attachment_set',
      list_archived_reviews: 'list_archived_attachments',
      refresh_review: 'refresh_attachment_set',
      set_review_groups: 'set_attachment_groups',
    });
  });

  // That each pair really is ONE fall-through `case` arm, and that only the
  // new name reaches `tools/list`, is asserted in `tool-wiring.test.ts` —
  // where the same four pairs are listed beside the two earlier renames. Both
  // of those read the MCP source text, and one copy of a source-shape read is
  // the most this rename should cost (see .claude/rules/testing-standards.md
  // §1). What lives here is the half that shape cannot show: that both names
  // reach the same REST call, and that the log says so once.
});

describe('the deprecation line is said once per session', () => {
  it('says it on the first call under the old name', () => {
    const said: string[] = [];
    const warn = createAliasDeprecationWarner((line) => said.push(line));
    warn('bind_folder');
    expect(said).toEqual([deprecationLine('bind_folder', 'attach_folder')]);
    // The line has to carry both names, or a reader cannot act on it.
    expect(said[0]).toContain('bind_folder');
    expect(said[0]).toContain('attach_folder');
  });

  it('says it once however many times the old name is called', () => {
    const said: string[] = [];
    const warn = createAliasDeprecationWarner((line) => said.push(line));
    for (let i = 0; i < 5; i += 1) warn('bind_folder');
    expect(said).toHaveLength(1);
  });

  it('says nothing for the new name, or for any other tool', () => {
    const said: string[] = [];
    const warn = createAliasDeprecationWarner((line) => said.push(line));
    warn('attach_folder');
    warn('get_doc');
    warn('create_tasks');
    expect(said).toEqual([]);
  });

  it('counts each alias separately — one is not a lid on the other three', () => {
    const said: string[] = [];
    const warn = createAliasDeprecationWarner((line) => said.push(line));
    for (const alias of Object.keys(DEPRECATED_TOOL_ALIASES)) {
      warn(alias);
      warn(alias);
    }
    expect(said).toHaveLength(PAIRS.length);
  });
});

/** A dispatcher wired to a spy warner and a handler that records the name. */
function dispatchHarness() {
  const said: string[] = [];
  const seen: string[] = [];
  const warn = createAliasDeprecationWarner((line) => said.push(line));
  const deps: CallToolDeps = {
    deferredEmits: { beginToolCall: () => () => {} },
    ensureWatchesRestored: async () => {},
    sendDueHeartbeats: async () => {},
    watchDoc: async () => true,
    toolContext: () => ({}) as ToolContext,
    handlers: [
      async (name) => {
        seen.push(name);
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    ],
    err: (message) => ({ isError: true, content: [{ type: 'text', text: message }] }),
    warnDeprecatedAlias: warn,
  };
  return { handle: createCallToolHandler(deps), said, seen };
}

describe('the dispatcher notes the old name without changing the call', () => {
  it('passes the name through to the handler untouched', async () => {
    const h = dispatchHarness();
    await h.handle({
      method: 'tools/call',
      params: { name: 'bind_mock', arguments: {} },
    } as Parameters<typeof h.handle>[0]);
    expect(h.seen).toEqual(['bind_mock']);
  });

  it('logs once across repeated calls, and not at all under the new name', async () => {
    const h = dispatchHarness();
    const call = (name: string) =>
      h.handle({ method: 'tools/call', params: { name, arguments: {} } } as Parameters<
        typeof h.handle
      >[0]);
    await call('bind_mock');
    await call('bind_mock');
    await call('attach_mockup');
    expect(h.said).toEqual([deprecationLine('bind_mock', 'attach_mockup')]);
  });
});

/** Records every REST call a domain handler makes, and answers `answer`. */
function recorder(answer: unknown) {
  const calls: Array<[string, string, unknown]> = [];
  const ctx = {
    http: async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      return answer;
    },
    ok: (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] }),
    err: (message: string) => ({ isError: true, content: [{ type: 'text', text: message }] }),
    AUTHOR: { id: 'a1', name: 'Tester', kind: 'agent' },
    watchWorkspace: async () => ({ open: true, persisted: true }),
    claimNoticeFor: async () => undefined,
  };
  return { calls, ctx };
}

/** The board every one of these calls is addressed under. */
const WS = 'w-board';

describe('both names reach the same code, not merely the same switch', () => {
  const sameUnderBothNames = async (
    handle: (name: string, a: Record<string, unknown>, ctx: never) => Promise<unknown>,
    alias: string,
    now: string,
    args: Record<string, unknown>,
    answer: unknown,
  ) => {
    const old = recorder(answer);
    const fresh = recorder(answer);
    const a = await handle(alias, args, old.ctx as never);
    const b = await handle(now, args, fresh.ctx as never);
    expect(a).not.toBeUndefined();
    expect(old.calls).toEqual(fresh.calls);
    expect(a).toEqual(b);
    return old.calls;
  };

  it('attach_folder / bind_folder post the same folder bind', async () => {
    const calls = await sameUnderBothNames(
      handleDocsTool as never,
      'bind_folder',
      'attach_folder',
      { folderPath: '/tmp/synthetic', workspaceId: WS, setId: 'grp-1', subscribe: false },
      { ok: true },
    );
    expect(calls[0]?.[1]).toBe('/workspaces');
  });

  it('attach_mockup / bind_mock post the same mockup doc', async () => {
    const calls = await sameUnderBothNames(
      handleDocsTool as never,
      'bind_mock',
      'attach_mockup',
      { workspaceId: WS, docId: 'mock-1', sourceHtmlPath: '/tmp/synthetic.html' },
      { docId: 'mock-1' },
    );
    expect(calls[0]?.[1]).toBe(`/workspaces/${WS}/docs`);
    expect(calls[0]?.[2]).toMatchObject({ type: 'mockup' });
  });

  it('spin_off_task / promote_to_task post the same thread promotion', async () => {
    const calls = await sameUnderBothNames(
      handleTaskTool as never,
      'promote_to_task',
      'spin_off_task',
      { docId: 'plan', threadId: 't1', workspaceId: WS },
      { task: { id: 'k1', title: 'A row', goal: 'g1', order: 1, status: 'todo', assignee: 'me' } },
    );
    expect(calls[0]?.[1]).toBe(`/workspaces/${WS}/docs/plan/threads/t1/promote`);
  });

  it('archive_workspace / retire_workspace put the same retired flag', async () => {
    const calls = await sameUnderBothNames(
      handleWorkspaceTool as never,
      'retire_workspace',
      'archive_workspace',
      { workspaceId: 'w1', reason: 'superseded' },
      { changed: true, workspace: { name: 'A board' } },
    );
    expect(calls[0]?.[1]).toBe('/workspaces/w1/retired');
    expect(calls[0]?.[2]).toMatchObject({ retired: true, reason: 'superseded' });
  });

  /**
   * The seven `review` → `attachment` verbs, each with the arguments it
   * actually takes and the route it actually reaches. Driven from a table
   * rather than written out seven times, and the table is checked against
   * the alias map below so a pair added to one and not the other is a
   * failure rather than a silence.
   */
  const REVIEW_WAVE: Array<{
    alias: string;
    now: string;
    args: Record<string, unknown>;
    answer: unknown;
    route: string;
  }> = [
    {
      alias: 'create_review_doc',
      now: 'attach_markdown',
      args: { workspaceId: WS, docId: 'plan', path: '/tmp/synthetic.md' },
      answer: { docId: 'plan' },
      route: `/workspaces/${WS}/docs`,
    },
    {
      alias: 'delete_review',
      now: 'delete_attachment_set',
      args: { workspaceId: WS, setId: 'set-1', force: true, purge: false },
      answer: { ok: true },
      route: `/workspaces/${WS}/reviews/set-1?force=true`,
    },
    {
      alias: 'archive_review',
      now: 'archive_attachment_set',
      args: { workspaceId: WS, setId: 'set-1', reason: 'merged in #301' },
      answer: { ok: true },
      route: `/workspaces/${WS}/reviews/set-1/archive`,
    },
    {
      alias: 'unarchive_review',
      now: 'unarchive_attachment_set',
      args: { workspaceId: WS, setId: 'set-1' },
      answer: { ok: true },
      route: `/workspaces/${WS}/reviews/set-1/unarchive`,
    },
    {
      alias: 'list_archived_reviews',
      now: 'list_archived_attachments',
      args: { workspaceId: WS },
      answer: { archived: [], docs: [] },
      route: `/workspaces/${WS}/reviews?archived=true`,
    },
    {
      alias: 'refresh_review',
      now: 'refresh_attachment_set',
      args: { workspaceId: WS, setId: 'set-1' },
      answer: { ok: true },
      route: `/workspaces/${WS}/reviews/set-1/refresh`,
    },
    {
      alias: 'set_review_groups',
      now: 'set_attachment_groups',
      args: {
        workspaceId: WS,
        setId: 'set-1',
        groups: [{ title: 'Server', paths: ['packages/server'] }],
      },
      answer: { ok: true },
      route: `/workspaces/${WS}/reviews/set-1/groups`,
    },
  ];

  it('the table below covers every verb of the review wave, and no other', () => {
    // Without this the `it.each` under it is only as complete as whoever
    // last edited it remembered to be: drop a row and seven assertions
    // quietly become six, with nothing red.
    // "review" is what the wave renamed away from, and no other alias key
    // contains it — bind_folder, bind_mock, promote_to_task,
    // retire_workspace and list_attachments are the earlier wave.
    const wave = Object.keys(DEPRECATED_TOOL_ALIASES)
      .filter((alias) => alias.includes('review'))
      .sort();
    expect(REVIEW_WAVE.map((r) => r.alias).sort()).toEqual(wave);
    expect(REVIEW_WAVE).toHaveLength(7);
    for (const row of REVIEW_WAVE) expect(DEPRECATED_TOOL_ALIASES[row.alias]).toBe(row.now);
  });

  it.each(REVIEW_WAVE)('$alias / $now make the same request', async (row) => {
    const calls = await sameUnderBothNames(
      handleDocsTool as never,
      row.alias,
      row.now,
      row.args,
      row.answer,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toBe(row.route);
  });
});

/** Every `.md` under a directory, recursively, as [repo-relative path, text]. */
function markdownUnder(dir: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = join(at, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.md')) out.push([relative(REPO, full), readFileSync(full, 'utf8')]);
    }
  };
  walk(dir);
  return out;
}

describe('the prose names the new verbs only', () => {
  const PROSE = [
    ...markdownUnder(join(REPO, 'docs')),
    ...markdownUnder(join(REPO, 'packages/plugin/skills')),
    ...markdownUnder(join(REPO, 'packages/plugin/commands')),
    ['CLAUDE.md', readFileSync(join(REPO, 'CLAUDE.md'), 'utf8')] as [string, string],
  ];

  it('is reading real files, and the matcher can see an old verb when one is there', () => {
    // Positive control. Without it a typo'd path or a broken matcher reports
    // a clean sweep over nothing, which is the failure this whole check is
    // most likely to have and least likely to announce.
    expect(PROSE.length).toBeGreaterThan(20);
    expect(PROSE.some(([, text]) => text.includes('attach_folder'))).toBe(true);
    // …and the matcher below can see an old verb: run it over a synthetic
    // page that contains every one of them, and it must report all four.
    const planted: Array<[string, string]> = [
      ['synthetic.md', Object.keys(DEPRECATED_TOOL_ALIASES).join(' and ')],
    ];
    for (const alias of Object.keys(DEPRECATED_TOOL_ALIASES)) {
      expect(
        planted.filter(([, text]) => text.includes(alias)).map(([path]) => path),
        `matcher blind to ${alias}`,
      ).toEqual(['synthetic.md']);
    }
  });

  it.each(Object.keys(DEPRECATED_TOOL_ALIASES))('no doc or skill still says %s', (alias) => {
    const offenders = PROSE.filter(([, text]) => text.includes(alias)).map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
