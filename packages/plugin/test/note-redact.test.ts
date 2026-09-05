/**
 * The reduction the plugin's hooks put every note through
 * (`hooks/lib/note-redact.ts`): a closing message reduced whole
 * (`fullNote`) or to one line (`oneLine`), and a denied Bash command
 * reduced to its shape (`commandShape`). `agent-notes.test.ts` drives the
 * hook plumbing that calls these; this file is the reduction itself, which
 * is where every leak the hooks can produce would come from.
 *
 * Fixtures are synthetic. Any secret-looking value below is invented to
 * prove it NEVER reaches the payload — the repo is public.
 */
import { describe, expect, it } from 'vitest';
import {
  FULL_NOTE_TEXT_CAP,
  NOTE_TEXT_CAP,
  commandShape,
  fullNote,
  oneLine,
} from '../hooks/lib/note-redact.ts';

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
  it('keeps blank lines inside a fence verbatim — code spacing is content, not a run to collapse', () => {
    // Verify-fix: the blank-line collapse ran inside fences too, so a pasted
    // diff or YAML block lost its double blank lines in the stored note.
    const msg =
      'Ran the tests:\n\n\n```\ndef a():\n    pass\n\n\ndef b():\n    pass\n```\n\n\nDone.';
    expect(fullNote(msg)).toBe(
      'Ran the tests:\n\n```\ndef a():\n    pass\n\n\ndef b():\n    pass\n```\n\nDone.',
    );
    // A fence holding only blank lines is still "nothing"
    expect(fullNote('```\n\n\n```')).toBe('');
  });
  it('redacts an opaque secret with no recognised prefix — a long alphanumeric run with digits', () => {
    // Security review: only five shapes were reduced; a bare hex key, a
    // JWT, a Twilio-style token or a base64 blob rode through whole.
    const hex = fullNote('Rotated key: 4f2b8c9e1a3d5f7b9c1e3a5d7f9b1c3e0a2d4f6b8c1e3a5d');
    expect(hex).toBe('Rotated key: [redacted]');
    const jwt = fullNote(
      'got eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c back',
    );
    expect(jwt).toBe('got [token] back');
    expect(fullNote('twilio is 0a1b2c3d4e5f60718293a4b5c6d7e8f9')).toBe('twilio is [redacted]');
    expect(fullNote('rk_live_FAKE0 and pk_test_FAKE0')).toBe('[token] and [token]');
    // a base64 blob with `/` or `+` in it, as an AWS secret or a PEM line is
    // (the canonical AWS example key, with its one digit)
    expect(fullNote('secret was wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY there')).toBe(
      'secret was [redacted] there',
    );
    // punctuation and inline code around it survive
    expect(fullNote('(`4f2b8c9e1a3d5f7b9c1e3a5d7f9b1c3e`).')).toBe('(`[redacted]`).');
  });
  it('leaves identifiers, short hashes, versions and long words alone (negative control)', () => {
    const kept =
      'renderCommentMarkdown at 910ffe6d, bumped 0.1.126, TASK_NOTES_STORE_CAP, internationalization, convertToBase64String, ran 1700000000000 ms';
    expect(fullNote(kept)).toBe(kept);
    expect(fullNote('see packages/workspaces-app/src/board/task-detail-island.tsx')).toBe(
      'see packages/workspaces-app/src/board/task-detail-island.tsx',
    );
    expect(fullNote('on feat/activity-feed-v2-2026-08-29')).toBe(
      'on feat/activity-feed-v2-2026-08-29',
    );
  });
  it('redacts the value of a secret-named assignment or key whatever the value looks like', () => {
    expect(
      fullNote(
        'DB_PASSWORD=Tr0ub4dor&3\naws_secret_access_key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n"api_key": "hunter2",\nauthToken=abc',
      ),
    ).toBe(
      'DB_PASSWORD=[redacted]\naws_secret_access_key: [redacted]\n"api_key": "[redacted]",\nauthToken=[redacted]',
    );
    expect(fullNote('Authorization: Basic dXNlcjpodW50ZXIy')).toBe('Authorization: [token]');
    // fenced code takes the same rule
    expect(fullNote('```\nexport PASSWORD=hunter2\npassword: hunter2\n```')).toBe(
      '```\nexport PASSWORD=[redacted]\npassword: [redacted]\n```',
    );
    // negative controls: a plural, an author, a plain flag, a count
    expect(fullNote('inputTokens: 1200, tokens: 3, author: sam, --base=main, MODE=dark')).toBe(
      'inputTokens: 1200, tokens: 3, author: sam, --base=main, MODE=dark',
    );
  });
  it('redacts a token continuation on the next line when a line ends in a bare token prefix', () => {
    // Security review: terminal-wrapped output splits a token; the prefix
    // half became [token] and the rest rode through as prose.
    expect(fullNote('Key is sk-\nabc12345 done')).toBe('Key is [token]\n[token] done');
    expect(fullNote('Key is sk-\nant-api03-abcdefghijklmnopqrstuvwxyz0123456789')).toBe(
      'Key is [token]\n[token]',
    );
    // negative control: an ordinary word after a whole token stays
    expect(fullNote('Key is sk-test-FAKEabc123\nhere')).toBe('Key is [token]\nhere');
  });
  it('reduces a Windows or UNC path to its file name like a POSIX one', () => {
    expect(fullNote('Key at C:\\Users\\someone\\.ssh\\id_rsa and \\\\box\\share\\x.txt')).toBe(
      'Key at id_rsa and x.txt',
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
