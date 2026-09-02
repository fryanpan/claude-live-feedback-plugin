/**
 * An UN-IGNORED credential file inside a repo must not be listed or served.
 *
 * `context-file-listed.test.ts` covers the guarantee the doc leaned on: a
 * GITIGNORED `.env` never appears in `git ls-files --cached --others
 * --exclude-standard`, so a share visitor can never open it. That is precisely
 * true and precisely the limit. `--others` lists UNTRACKED files, so an `.env`
 * that is merely absent from `.gitignore` — a fresh checkout, a repo whose
 * ignore rules never covered it, a file an agent just wrote — IS listed, and
 * `isListedFile` then admits it. The name floor existed only on the readdir
 * fallback, which meant the safer of the two modes was the one without one.
 *
 * Both halves matter, so both are asserted: the credential names disappear,
 * and the repo's ordinary dotfiles do NOT. The fallback's rule is "every
 * dotfile", and applying that inside a repo would hide `.github/workflows`
 * and `.gitignore` itself from a diff review — a false refusal on the files
 * a reviewer most often came for.
 *
 * Fixtures are synthetic: every "secret" here is a marker string.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearListingCache, isListedFile, scanFolderPaths } from '../src/fs-scan.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

const MARKER = 'FIXTURE_MARKER=not-a-real-secret';

describe('the credential floor applies to the git listing, not just the fallback', () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'credfloor-repo-'));
    git(repo, 'init', '-q');
    // Ordinary tracked content, including the dotfiles a reviewer needs.
    writeFileSync(join(repo, 'README.md'), '# repo\n');
    writeFileSync(join(repo, '.gitignore'), 'ignored-only.txt\n');
    mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');

    // UNTRACKED and UN-IGNORED — the hole. `--others` lists all of these.
    writeFileSync(join(repo, '.env'), `${MARKER}\n`);
    writeFileSync(join(repo, '.env.production'), `${MARKER}\n`);
    writeFileSync(join(repo, '.npmrc'), '//registry:_authToken=FIXTURE\n');
    writeFileSync(join(repo, 'id_rsa'), 'FIXTURE PRIVATE KEY\n');
    writeFileSync(join(repo, 'server.key'), 'FIXTURE PRIVATE KEY\n');
    mkdirSync(join(repo, 'conf'), { recursive: true });
    writeFileSync(join(repo, 'conf', '.env'), `${MARKER}\n`);
    // An untracked ordinary file, so "the listing is not simply empty".
    writeFileSync(join(repo, 'draft.md'), '# draft\n');
    clearListingCache();
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('CONTROL: git really does list the un-ignored credential files', () => {
    // Without this the assertions below could pass because git listed
    // nothing at all — the exact vacuous pass this floor must not hide.
    const raw = git(repo, 'ls-files', '--cached', '--others', '--exclude-standard').split('\n');
    expect(raw).toContain('.env');
    expect(raw).toContain('id_rsa');
    expect(raw).toContain('conf/.env');
  });

  it('the scan omits every credential-shaped name, at the root and nested', () => {
    const paths = scanFolderPaths(repo);
    for (const gone of ['.env', '.env.production', '.npmrc', 'id_rsa', 'server.key', 'conf/.env']) {
      expect(paths, gone).not.toContain(gone);
    }
  });

  it('CONTROL: ordinary content — including tracked dotfiles — still lists', () => {
    const paths = scanFolderPaths(repo);
    expect(paths).toContain('README.md');
    expect(paths).toContain('draft.md');
    // The half a blanket dot-prefix rule would have broken. A reviewer opens
    // these constantly; they are tracked content, not a forgotten credential.
    expect(paths).toContain('.gitignore');
    expect(paths).toContain('.github/workflows/ci.yml');
  });

  it('isListedFile — the rule a share visitor is checked against — agrees', () => {
    clearListingCache();
    expect(isListedFile(repo, '.env')).toBe(false);
    expect(isListedFile(repo, 'conf/.env')).toBe(false);
    expect(isListedFile(repo, 'id_rsa')).toBe(false);
    // Control: the same call on the same root admits ordinary files, so a
    // `false` above is the floor and not a broken listing.
    expect(isListedFile(repo, 'README.md')).toBe(true);
    expect(isListedFile(repo, '.github/workflows/ci.yml')).toBe(true);
  });
});

describe('over the real routes: context-file refuses the un-ignored .env', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let repo: string;
  let reviewId: string;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`http://localhost:${handle.port}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        'content-type': 'application/json',
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  const open = (relPath: string) =>
    local(`/api/workspaces/${reviewId}/context-file`, {
      method: 'POST',
      body: JSON.stringify({ relPath }),
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'credfloor-data-'));
    repo = mkdtempSync(join(tmpdir(), 'credfloor-http-'));
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'note.md'), '# note\n');
    writeFileSync(join(repo, '.gitignore'), 'nothing-here\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    // No ignore rule covers it — this is the file the git listing showed.
    writeFileSync(join(repo, '.env'), `${MARKER}\n`);
    clearListingCache();

    handle = createServer({ port: 0, dataDir });
    const bound = (await local('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ folderPath: repo }),
    }).then((r) => r.json())) as { workspaceId: string };
    reviewId = bound.workspaceId;
    expect(reviewId).toBeTruthy();
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it('CONTROL: a listed file opens, so a 404 below is the floor', async () => {
    const r = await open('note.md');
    expect(r.status).toBe(200);
  });

  it('the un-ignored .env is refused, and its contents never appear', async () => {
    const r = await open('.env');
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain(MARKER);
  });

  it('nor does it appear in the tree the visitor browses', async () => {
    const raw = await local(`/api/workspaces/${reviewId}/files`).then((r) => r.text());
    expect(raw).toContain('note.md'); // control: the tree is not empty
    expect(raw).not.toContain('.env');
  });
});
