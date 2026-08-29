/**
 * The plugin's Stop and PermissionDenied hooks post notes to
 * `POST /api/agent-notes` so a task's Activity tab can say what each agent
 * did lately — the Stop hook the whole closing message (reduced, never
 * clipped to a line), the PermissionDenied hook the denied call's shape.
 * Everything that decides WHAT to post is a pure function
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
  FULL_NOTE_TEXT_CAP,
  NOTE_TEXT_CAP,
  POST_TIMEOUT_MS,
  commandShape,
  decideDenialNote,
  decideTurnNote,
  fullNote,
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
  it('reduces absolute and home paths to their file name and URLs to a marker', () => {
    // A closing sentence routinely names a host path or a hostname, and the
    // board projection is read by workspace-share visitors.
    const msg =
      'Done. The token is in /Users/someone/.config/app/token and the URL is https://u:p@host.example/x.';
    expect(oneLine(msg)).toBe('Done. The token is in token and the URL is [url].');
    expect(oneLine(msg)).not.toContain('host.example');
    expect(oneLine(msg)).not.toContain('/Users');
    expect(oneLine('Pushed feat/turn-notes to ~/dev/repo (see packages/server/src/x.ts)')).toBe(
      'Pushed feat/turn-notes to repo (see packages/server/src/x.ts)',
    );
    expect(oneLine('ran ./scripts/x.sh, then ../other/y.sh')).toBe('ran x.sh, then y.sh');
  });
  it('keeps only the command shape of a fenced-code fallback', () => {
    // Security review: the in-fence branch used to echo the line (first
    // only whitespace-collapsed, then prose-reduced) — and a prose reducer
    // cannot know that the bare word after `-u` is a password.
    const out = oneLine('```\ncurl -u admin:hunter2 https://host.example/x\n```');
    expect(out).toBe('curl -u');
    expect(oneLine('```sh\nAWS_SECRET_ACCESS_KEY=abcd1234 aws s3 ls\n```')).toBe('aws s3');
  });
  it('reduces scheme-less tailnet/local hosts, localhost, and bare IPv4 to [url]', () => {
    const out = oneLine(
      'Deployed to mac-mini.tailXXXXX.ts.net:8787/review/abc — see localhost:8787/w/x',
    );
    expect(out).not.toContain('ts.net');
    expect(out).not.toContain('localhost:8787');
    expect(out).toContain('[url]');

    const ips = oneLine('Host 192.168.1.44:8787 and 100.101.102.103');
    expect(ips).not.toContain('192.168.1.44');
    expect(ips).not.toContain('100.101.102.103');
  });
  it('leaves a version number and a plain dotted filename alone (negative control)', () => {
    expect(oneLine('bumped 0.1.124 and ran 3 tests')).toContain('0.1.124');
    expect(oneLine('touched server.ts today')).toContain('server.ts');
  });
  it('reduces common token prefixes and Bearer tokens to [token], and an email to [email]', () => {
    const msg = 'The key is sk-test-FAKEabc123 and Bearer eyJFAKE for user@example.com';
    const out = oneLine(msg);
    expect(out.match(/\[token\]/g)).toHaveLength(2);
    expect(out).toContain('[email]');
    expect(out).not.toContain('sk-test');
    expect(out).not.toContain('eyJFAKE');
    expect(out).not.toContain('example.com');
  });
  it('leaves an @-mention and a TLD-less address alone (negative control)', () => {
    expect(oneLine('@bryan asked about this')).toContain('@bryan');
    expect(oneLine('reachable at user@host on the LAN')).toContain('user@host');
  });
  it('reduces a token prefix inside inline code too, since the backticks are stripped', () => {
    const out = oneLine('key is `sk-test-FAKEXYZ00000000` here');
    expect(out).toContain('[token]');
    expect(out).not.toContain('sk-test-FAKEXYZ');
  });
});

describe('fullNote — the whole closing message, reduced line by line', () => {
  it('keeps line structure and markdown: headings, lists, emphasis, inline code', () => {
    const msg = '## Done\n\nShipped the **fix** in `server.ts`.\n\n- one\n  - nested\n1. first';
    expect(fullNote(msg)).toBe(msg);
  });
  it('collapses runs of blank lines to one and trims the ends', () => {
    expect(fullNote('\n\n\na\n\n\n\nb\n   \n\nc\n\n')).toBe('a\n\nb\n\nc');
  });
  it('reduces URLs on every line, and leaves versions, repo paths and branches alone', () => {
    const out = fullNote(
      'First https://u:p@host.example/x here.\nSecond line http://other.example/y too.',
    );
    expect(out).toBe('First [url] here.\nSecond line [url] too.');
    expect(out).not.toContain('host.example');
    // negative controls
    const kept = fullNote('bumped 0.1.124 in packages/server/src/x.ts on feat/turn-notes');
    expect(kept).toBe('bumped 0.1.124 in packages/server/src/x.ts on feat/turn-notes');
  });
  it('reduces host paths to their file name on every line', () => {
    const out = fullNote(
      'Token in /Users/someone/.config/app/token.\nRepo at ~/dev/repo, ran ./scripts/x.sh',
    );
    expect(out).toBe('Token in token.\nRepo at repo, ran x.sh');
    expect(out).not.toContain('/Users');
    expect(fullNote('see packages/server/src/x.ts')).toContain('packages/server/src/x.ts');
  });
  it('reduces scheme-less hosts, localhost and IPv4 to [url], not a dotted filename', () => {
    const out = fullNote(
      'Up at mac-mini.tailXXXXX.ts.net:8787/w/x\nand localhost:8787\nand 192.168.1.44:8787',
    );
    expect(out).toBe('Up at [url]\nand [url]\nand [url]');
    expect(fullNote('touched server.ts and 0.1.124')).toBe('touched server.ts and 0.1.124');
  });
  it('reduces token prefixes and Bearer tokens to [token], emails to [email], on every line', () => {
    const out = fullNote(
      'Key sk-test-FAKEabc123 here\nAuthorization: Bearer eyJFAKE\nMail user@example.com',
    );
    expect(out).toBe('Key [token] here\nAuthorization: [token]\nMail [email]');
    expect(out).not.toContain('sk-test');
    expect(out).not.toContain('eyJFAKE');
    expect(out).not.toContain('example.com');
    // negative controls: a mention and a TLD-less address
    expect(fullNote('@bryan asked; box is user@host')).toBe('@bryan asked; box is user@host');
  });
  it('reduces a markdown link or image TARGET and keeps its text', () => {
    expect(
      fullNote('See [the PR](https://x.example/1) and ![shot](https://x.example/a.png "t").'),
    ).toBe('See [the PR]([url]) and ![shot]([url] "t").');
    expect(fullNote('Mail [me](mailto:user@example.com)')).toBe('Mail [me]([email])');
    // negative control: a repo-relative target is the work, not the host
    expect(fullNote('See [x](packages/a.ts)')).toBe('See [x](packages/a.ts)');
  });
  it('reduces inside inline code, emphasis and angle brackets without dropping the markup', () => {
    expect(fullNote('key is `sk-test-FAKEXYZ00000000` in `/Users/x/secret`')).toBe(
      'key is `[token]` in `secret`',
    );
    expect(fullNote('**https://x.example/y** and <https://x.example/z>')).toBe(
      '**[url]** and <[url]>',
    );
    expect(fullNote('<b>bold</b> stays bold; a < b && c > d too')).toBe(
      'bold stays bold; a < b && c > d too',
    );
  });
  it('reduces a value riding an assignment or attribute, and a URL glued to a prefix', () => {
    expect(
      fullNote('ran with TOKEN=ghp_FAKEFAKEFAKEFAKEFAKEFAKE1234 and --url=https://x.example'),
    ).toBe('ran with TOKEN=[token] and --url=[url]');
    expect(fullNote('(see:https://x.example/y)')).toBe('(see:[url])');
    expect(fullNote('<a href="https://x.example/y">link</a>')).toBe('link');
  });
  it('keeps fenced code, fences included, reduced line by line rather than dropped', () => {
    const out = fullNote(
      '```sh\ncurl -u admin https://host.example/x\nexport K="sk-test-FAKE0000"\n  cat /Users/x/.env\n```\nAll green.',
    );
    expect(out).toBe('```sh\ncurl -u admin [url]\nexport K="[token]"\n  cat .env\n```\nAll green.');
    expect(out).not.toContain('host.example');
    expect(out).not.toContain('sk-test');
    // negative control: an ordinary command line survives whole
    expect(fullNote('```\nbun test packages/server\n```')).toBe(
      '```\nbun test packages/server\n```',
    );
  });
  it('caps at FULL_NOTE_TEXT_CAP with an ellipsis, and at a caller cap', () => {
    const out = fullNote('a'.repeat(5000));
    expect(out.length).toBe(FULL_NOTE_TEXT_CAP);
    expect(FULL_NOTE_TEXT_CAP).toBe(4000);
    expect(out.endsWith('…')).toBe(true);
    expect(fullNote('x'.repeat(FULL_NOTE_TEXT_CAP))).toBe('x'.repeat(FULL_NOTE_TEXT_CAP));
    expect(fullNote('hello world', 6)).toBe('hello…');
  });
  it('is empty for whitespace, non-strings, and bare fence markers', () => {
    expect(fullNote('   \n\n  ')).toBe('');
    expect(fullNote(undefined)).toBe('');
    expect(fullNote('\n```\n```\n')).toBe('');
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
  it('skips leading env assignments and never echoes their value', () => {
    // `VAR=value cmd` is how a secret rides a command line; the assignment
    // is not the shape, the command after it is.
    expect(commandShape('AWS_SECRET_ACCESS_KEY=abcd1234 aws s3 ls')).toBe('aws s3');
    expect(commandShape('SCRUB_SKIP=1 git push')).toBe('git push');
    expect(commandShape('A=1 B=two ./run.sh --now')).toBe('run.sh');
    expect(commandShape('X=1')).toBe('');
    expect(commandShape('TOKEN=ghp_FAKEFAKEFAKEFAKEFAKEFAKE1234 gh auth login')).toBe('gh auth');
  });
  it('drops an opaque first token entirely rather than echoing it', () => {
    expect(commandShape('user@host.example:cmd run')).toBe('');
    expect(commandShape('$CMD run')).toBe('');
  });
  it('keeps the second token only when it is a bare short flag, or a subcommand word after a known subcommand-taking tool', () => {
    expect(commandShape('mysql -phunter2 -u root')).toBe('mysql');
    expect(commandShape('sshpass -p hunter2')).toBe('sshpass -p');
    expect(commandShape('echo $SECRET')).toBe('echo');
    expect(commandShape('gh pr merge 12')).toBe('gh pr');
    expect(commandShape('bun run build:mcp')).toBe('bun run');
    expect(commandShape('curl -H "Authorization: x"')).toBe('curl -H');
    expect(commandShape(`echo ${'a'.repeat(30)}`)).toBe('echo');
    // A long double-dash flag is no longer kept, even after a known tool —
    // it doesn't match the bare-short-flag shape, and it isn't a subcommand
    // word either.
    expect(commandShape('git --no-pager log')).toBe('git');
    // "passwd" is subcommand-shaped, but openssl isn't a subcommand-taking
    // tool, so the second token no longer rides along on shape alone.
    expect(commandShape('openssl passwd Hunter2')).toBe('openssl');
  });
  it('is empty for blank or non-string input', () => {
    expect(commandShape('')).toBe('');
    expect(commandShape('   ')).toBe('');
    expect(commandShape(undefined)).toBe('');
  });
  it('drops a second token that is only allow-shaped by accident — the security-review cases', () => {
    // A bare word that happens to look like a subcommand (lowercase,
    // hyphenated) used to survive next to ANY first token; now it only
    // survives after a tool that's known to take subcommands.
    expect(commandShape('echo hunter2')).toBe('echo');
    expect(commandShape('printf hunter2')).toBe('printf');
    // A short single-dash flag glued to a value no longer passes as a bare
    // flag — only `^-[A-Za-z]{1,3}$` does.
    expect(commandShape('mysql -psecret db')).toBe('mysql');
    expect(commandShape('sshpass -phunter2 ssh x')).toBe('sshpass');
    // `-u` alone is a bare short flag regardless of the tool.
    expect(commandShape('curl -u admin:hunter2 https://h/x')).toBe('curl -u');
    // `aws` is a known subcommand-taking tool; `configure` is subcommand-shaped.
    expect(commandShape('aws configure set aws_secret_access_key X')).toBe('aws configure');
    // A heredoc marker is neither a bare flag nor a known-tool subcommand.
    expect(commandShape("cat <<'EOF'")).toBe('cat');
    expect(commandShape('TOKEN=abc gh auth login')).toBe('gh auth');
  });
  it('keeps -rf and -la (short bare flags) even for a tool outside the subcommand set', () => {
    expect(commandShape('rm -rf foo')).toBe('rm -rf');
    expect(commandShape('ls -la')).toBe('ls -la');
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
  it('builds the payload the server route accepts, carrying the WHOLE message reduced', () => {
    const d = decideTurnNote(
      { ...STOP, last_assistant_message: '## Done\n\n\nShipped the fix at https://x.example/1.' },
      ctx,
    );
    expect(d).toEqual({
      post: {
        agent: 'Cartographer',
        kind: 'turn',
        text: '## Done\n\nShipped the fix at [url].',
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
  it('falls back to the tool name when a Bash command is blank or only an assignment', () => {
    for (const command of ['  ', 'API_KEY=sk-test-FAKE0000']) {
      const d = decideDenialNote({ ...DENIED, tool_name: 'Bash', tool_input: { command } }, ctx);
      expect(d).toEqual(
        expect.objectContaining({ post: expect.objectContaining({ text: 'Bash' }) }),
      );
      expect(JSON.stringify(d)).not.toContain('FAKE0000');
    }
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
  it('posts the full turn note and exits 0', async () => {
    const calls: Call[] = [];
    const code = await runHook(
      'turn',
      JSON.stringify({ ...STOP, last_assistant_message: 'Shipped it.\n\nTests: 3 pass.' }),
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
      text: 'Shipped it.\n\nTests: 3 pass.',
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
