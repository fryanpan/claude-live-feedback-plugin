/**
 * The plugin's Stop and PermissionDenied hooks post one-line notes to
 * `POST /api/agent-notes` so a per-agent activity pane can say what each
 * agent did lately. Everything that decides WHAT to post is a pure function
 * in `hooks/lib/agent-notes.ts`; the two scripts are thin mains. These tests
 * drive the pure module end to end (`runHook`) with a fake fetch, so the
 * exit-0 contract is asserted without spawning a process.
 *
 * Fixtures are synthetic. Any secret-looking value below is invented to
 * prove it NEVER reaches the payload — the repo is public.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BASE_URL,
  NOTE_TEXT_CAP,
  POST_TIMEOUT_MS,
  commandShape,
  decideDenialNote,
  decideTurnNote,
  oneLine,
  payloadKeys,
  postNote,
  readAgentName,
  resolveBaseUrl,
  runHook,
} from '../hooks/lib/agent-notes.ts';

const NOW = 1_700_000_000_000;
const STOP = {
  session_id: 'sess-abc1',
  transcript_path: '/tmp/x.jsonl',
  cwd: '/work/repo',
  permission_mode: 'auto',
  hook_event_name: 'Stop',
  stop_hook_active: false,
};
const DENIED = {
  session_id: 'sess-abc1',
  transcript_path: '/tmp/x.jsonl',
  cwd: '/work/repo',
  permission_mode: 'auto',
  hook_event_name: 'PermissionDenied',
};
const ENV = { CW_AGENT_NAME: 'Cartographer', CW_BASE_URL: 'http://localhost:1' };

type Call = { url: string; init: RequestInit };
function fakeFetch(calls: Call[], impl?: () => Promise<Response>): typeof fetch {
  return ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return impl ? impl() : Promise.resolve(new Response('{"ok":true}', { status: 202 }));
  }) as unknown as typeof fetch;
}
const sentBody = (c: Call) => JSON.parse(String(c.init.body)) as Record<string, unknown>;

describe('oneLine — a closing message reduced to one safe line', () => {
  it('strips markdown and keeps the first prose line, preferring a sentence over a heading', () => {
    const msg =
      '\n\n## Done\n\nShipped the **fix** in `server.ts` — see [PR](https://x.example/1).\nSecond line.';
    expect(oneLine(msg)).toBe('Shipped the fix in server.ts — see PR.');
    expect(oneLine('## Only a heading')).toBe('Only a heading');
    expect(oneLine('# H1\n## H2\nprose')).toBe('prose');
  });
  it('unwraps bold, code, links, images and list markers on the first prose line', () => {
    expect(
      oneLine(
        '- Shipped the **fix** in `server.ts`, see [the PR](https://x.example/1) ![i](a.png)',
      ),
    ).toBe('Shipped the fix in server.ts, see the PR i');
    expect(oneLine('> quoted *emph* and __strong__ and ~~gone~~')).toBe(
      'quoted emph and strong and gone',
    );
    expect(oneLine('1. first item')).toBe('first item');
    expect(oneLine('- [ ] unchecked task')).toBe('unchecked task');
  });
  it('skips a leading code fence and horizontal rules to find prose', () => {
    expect(oneLine('```ts\nconst x = 1;\n```\n---\nAll green.')).toBe('All green.');
  });
  it('falls back to the first fenced line when the message is only code', () => {
    expect(oneLine('```\nbun test\n```')).toBe('bun test');
  });
  it('caps at the note cap and marks the cut with an ellipsis', () => {
    const long = 'a'.repeat(500);
    const out = oneLine(long);
    expect(out.length).toBe(NOTE_TEXT_CAP);
    expect(out.endsWith('…')).toBe(true);
    expect(oneLine('x'.repeat(NOTE_TEXT_CAP))).toBe('x'.repeat(NOTE_TEXT_CAP));
  });
  it('is empty for whitespace, non-strings and pure markup', () => {
    expect(oneLine('   \n\n  ')).toBe('');
    expect(oneLine(undefined)).toBe('');
    expect(oneLine('---\n***\n')).toBe('');
  });
  it('collapses inner whitespace and leaves snake_case alone', () => {
    expect(oneLine('kept   my_var   intact\ttoo')).toBe('kept my_var intact too');
  });
});

describe('commandShape — a Bash command reduced to its shape', () => {
  it('keeps the first two tokens', () => {
    expect(commandShape('git rm -rf foo')).toBe('git rm');
    expect(commandShape('  bun   test packages/server')).toBe('bun test');
    expect(commandShape('ls')).toBe('ls');
  });
  it('drops a second token that looks like a path, URL, assignment or token', () => {
    expect(commandShape('cat /etc/hosts')).toBe('cat');
    expect(commandShape('curl https://example.test/x')).toBe('curl');
    expect(commandShape('export API_KEY=sk-test-FAKE00000000000000000000')).toBe('export');
    expect(commandShape('echo ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKE1234 | pbcopy')).toBe('echo');
    expect(commandShape('ssh user@host.example')).toBe('ssh');
    expect(commandShape('cd ~/projects && ls')).toBe('cd');
    expect(commandShape('open ./README.md')).toBe('open');
  });
  it('reduces a command that starts with a path to that one token, without the directory', () => {
    const shape = commandShape('./scripts/launchd/install.sh --force /Users/someone/x');
    expect(shape).toBe('install.sh');
    expect(shape).not.toMatch(/\s/);
    expect(commandShape('/usr/local/bin/tool run')).toBe('tool');
  });
  it('is empty for blank or non-string input', () => {
    expect(commandShape('')).toBe('');
    expect(commandShape('   ')).toBe('');
    expect(commandShape(undefined)).toBe('');
  });
});

describe('env resolution', () => {
  it('reads the agent name from CW_AGENT_NAME, falling back to FEEDBACK_AGENT_NAME', () => {
    expect(readAgentName({ CW_AGENT_NAME: ' Cartographer ' })).toBe('Cartographer');
    expect(readAgentName({ FEEDBACK_AGENT_NAME: 'Legacy' })).toBe('Legacy');
    expect(readAgentName({ CW_AGENT_NAME: '  ', FEEDBACK_AGENT_NAME: 'Legacy' })).toBe('Legacy');
    expect(readAgentName({})).toBeUndefined();
  });
  it('resolves the base URL: CW_BASE_URL, FEEDBACK_BASE_URL, discovery file, then the default', () => {
    expect(resolveBaseUrl({ CW_BASE_URL: 'http://a:1/' })).toBe('http://a:1');
    expect(resolveBaseUrl({ FEEDBACK_BASE_URL: 'http://b:2' })).toBe('http://b:2');
    expect(resolveBaseUrl({ CW_BASE_URL: 'http://a:1', FEEDBACK_BASE_URL: 'http://b:2' })).toBe(
      'http://a:1',
    );
    expect(resolveBaseUrl({}, () => 4321)).toBe('http://localhost:4321');
    expect(resolveBaseUrl({}, () => undefined)).toBe(DEFAULT_BASE_URL);
    expect(resolveBaseUrl({})).toBe(DEFAULT_BASE_URL);
    expect(
      resolveBaseUrl({}, () => {
        throw new Error('boom');
      }),
    ).toBe(DEFAULT_BASE_URL);
  });
});

describe('decideTurnNote — the Stop hook', () => {
  const ctx = { agent: 'Cartographer', now: NOW };
  it('builds the payload the server route accepts', () => {
    const d = decideTurnNote(
      { ...STOP, last_assistant_message: '## Done\n\nShipped the fix.' },
      ctx,
    );
    expect(d).toEqual({
      post: {
        agent: 'Cartographer',
        kind: 'turn',
        text: 'Shipped the fix.',
        cwd: '/work/repo',
        sessionId: 'sess-abc1',
        at: NOW,
      },
    });
  });
  it('is a no-op without an agent name', () => {
    expect(decideTurnNote({ ...STOP, last_assistant_message: 'hi' }, { now: NOW })).toEqual({
      skip: 'no agent name',
    });
  });
  it('is a no-op when the message is empty or missing', () => {
    expect(decideTurnNote({ ...STOP, last_assistant_message: '' }, ctx)).toEqual({
      skip: 'empty message',
    });
    expect(decideTurnNote({ ...STOP, last_assistant_message: '\n```\n```\n' }, ctx)).toEqual({
      skip: 'empty message',
    });
    expect(decideTurnNote({ ...STOP }, ctx)).toEqual({ skip: 'empty message' });
  });
  it('is a no-op while a stop hook is already active', () => {
    expect(
      decideTurnNote({ ...STOP, stop_hook_active: true, last_assistant_message: 'hi' }, ctx),
    ).toEqual({ skip: 'stop hook active' });
  });
  it('is a no-op on a malformed payload', () => {
    expect(decideTurnNote(null, ctx)).toEqual({ skip: 'malformed payload' });
    expect(decideTurnNote('nope', ctx)).toEqual({ skip: 'malformed payload' });
  });
  it('omits cwd and sessionId when they are not short strings', () => {
    const d = decideTurnNote(
      { last_assistant_message: 'hi', session_id: 'x'.repeat(300), cwd: 7 },
      ctx,
    );
    expect(d).toEqual({ post: { agent: 'Cartographer', kind: 'turn', text: 'hi', at: NOW } });
  });
});

describe('decideDenialNote — the PermissionDenied hook', () => {
  const ctx = { agent: 'Cartographer', now: NOW };
  it('posts the command shape for Bash, never the command', () => {
    const d = decideDenialNote(
      { ...DENIED, tool_name: 'Bash', tool_input: { command: 'git rm -rf foo' } },
      ctx,
    );
    expect(d).toEqual({
      post: {
        agent: 'Cartographer',
        kind: 'denial',
        text: 'git rm',
        cwd: '/work/repo',
        sessionId: 'sess-abc1',
        at: NOW,
      },
    });
  });
  it('posts just the tool name for other tools', () => {
    const d = decideDenialNote(
      {
        ...DENIED,
        tool_name: 'Write',
        tool_input: { file_path: '/work/repo/secret.env', content: 'x' },
      },
      ctx,
    );
    expect(d).toEqual(
      expect.objectContaining({ post: expect.objectContaining({ text: 'Write' }) }),
    );
    expect(JSON.stringify(d)).not.toContain('secret.env');
  });
  it('falls back to the tool name when a Bash command is blank', () => {
    const d = decideDenialNote(
      { ...DENIED, tool_name: 'Bash', tool_input: { command: '  ' } },
      ctx,
    );
    expect(d).toEqual(expect.objectContaining({ post: expect.objectContaining({ text: 'Bash' }) }));
  });
  it('never lets a token-looking string reach the payload', () => {
    const token = 'sk-test-FAKE00000000000000000000';
    const d = decideDenialNote(
      {
        ...DENIED,
        tool_name: 'Bash',
        tool_input: { command: `curl -H "Authorization: Bearer ${token}" https://api.example/v1` },
      },
      ctx,
    );
    expect(JSON.stringify(d)).not.toContain(token);
    expect(JSON.stringify(d)).not.toContain('api.example');
    expect(d).toEqual(
      expect.objectContaining({ post: expect.objectContaining({ text: 'curl -H' }) }),
    );
  });
  it('is a no-op without an agent, without a tool name, or on a malformed payload', () => {
    expect(decideDenialNote({ ...DENIED, tool_name: 'Bash' }, { now: NOW })).toEqual({
      skip: 'no agent name',
    });
    expect(decideDenialNote({ ...DENIED }, ctx)).toEqual({ skip: 'no tool name' });
    expect(decideDenialNote([], ctx)).toEqual({ skip: 'malformed payload' });
  });
});

describe('payloadKeys — the live shape, names only', () => {
  it('lists top-level key names and nothing else', () => {
    expect(payloadKeys({ b: 'secret', a: { nested: 1 } })).toEqual(['a', 'b']);
    expect(payloadKeys('nope')).toEqual([]);
    expect(payloadKeys(null)).toEqual([]);
  });
});

describe('postNote — fail-open transport', () => {
  const note = { agent: 'Cartographer', kind: 'turn' as const, text: 'hi', at: NOW };
  it('POSTs JSON to /api/agent-notes with a timeout signal', async () => {
    const calls: Call[] = [];
    expect(await postNote('http://localhost:1', note, fakeFetch(calls))).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://localhost:1/api/agent-notes');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>)['content-type']).toBe(
      'application/json',
    );
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(sentBody(calls[0])).toEqual(note);
    expect(POST_TIMEOUT_MS).toBe(1500);
  });
  it('resolves false — never throws — when fetch throws or the server refuses', async () => {
    const throwing = fakeFetch([], () => Promise.reject(new Error('ECONNREFUSED')));
    await expect(postNote('http://localhost:1', note, throwing)).resolves.toBe(false);
    const refusing = fakeFetch([], () =>
      Promise.resolve(new Response('{"error":"bad-kind"}', { status: 400 })),
    );
    await expect(postNote('http://localhost:1', note, refusing)).resolves.toBe(false);
    const syncThrow = (() => {
      throw new TypeError('not a function');
    }) as unknown as typeof fetch;
    await expect(postNote('http://localhost:1', note, syncThrow)).resolves.toBe(false);
  });
});

describe('runHook — the thin main, end to end', () => {
  it('posts a turn note and exits 0', async () => {
    const calls: Call[] = [];
    const code = await runHook(
      'turn',
      JSON.stringify({ ...STOP, last_assistant_message: 'Shipped it.' }),
      {
        env: ENV,
        fetch: fakeFetch(calls),
        now: () => NOW,
      },
    );
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(sentBody(calls[0])).toEqual({
      agent: 'Cartographer',
      kind: 'turn',
      text: 'Shipped it.',
      cwd: '/work/repo',
      sessionId: 'sess-abc1',
      at: NOW,
    });
  });
  it('exits 0 with no fetch for every no-op condition', async () => {
    const cases: Array<[string, Record<string, string | undefined>, string]> = [
      [
        'no agent',
        { CW_BASE_URL: 'http://localhost:1' },
        JSON.stringify({ ...STOP, last_assistant_message: 'x' }),
      ],
      ['empty message', ENV, JSON.stringify({ ...STOP, last_assistant_message: '' })],
      [
        'stop hook active',
        ENV,
        JSON.stringify({ ...STOP, stop_hook_active: true, last_assistant_message: 'x' }),
      ],
      ['bad json', ENV, '{not json'],
      ['empty stdin', ENV, ''],
    ];
    for (const [label, env, stdin] of cases) {
      const calls: Call[] = [];
      const code = await runHook('turn', stdin, { env, fetch: fakeFetch(calls), now: () => NOW });
      expect(code, label).toBe(0);
      expect(calls, label).toHaveLength(0);
    }
  });
  it('exits 0 with no fetch when no base URL resolves', async () => {
    const calls: Call[] = [];
    const code = await runHook('turn', JSON.stringify({ ...STOP, last_assistant_message: 'x' }), {
      env: { CW_AGENT_NAME: 'Cartographer' },
      fetch: fakeFetch(calls),
      now: () => NOW,
      baseUrl: () => undefined,
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
  });
  it('exits 0 when fetch throws', async () => {
    const throwing = fakeFetch([], () => Promise.reject(new Error('ECONNREFUSED')));
    await expect(
      runHook('turn', JSON.stringify({ ...STOP, last_assistant_message: 'x' }), {
        env: ENV,
        fetch: throwing,
        now: () => NOW,
      }),
    ).resolves.toBe(0);
  });
  it('posts a denial note with the shape, and logs key names once', async () => {
    const calls: Call[] = [];
    const logged: string[] = [];
    let seen = false;
    const deps = {
      env: ENV,
      fetch: fakeFetch(calls),
      now: () => NOW,
      log: (line: string) => logged.push(line),
      shapeSeen: () => {
        const was = seen;
        seen = true;
        return was;
      },
    };
    const stdin = JSON.stringify({
      ...DENIED,
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /work/repo/node_modules' },
    });
    expect(await runHook('denial', stdin, deps)).toBe(0);
    expect(await runHook('denial', stdin, deps)).toBe(0);
    expect(calls).toHaveLength(2);
    expect(sentBody(calls[0])).toEqual(expect.objectContaining({ kind: 'denial', text: 'rm -rf' }));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('tool_name');
    expect(logged[0]).toContain('tool_input');
    expect(logged[0]).not.toContain('node_modules');
    expect(logged[0]).not.toContain('sess-abc1');
  });
});
