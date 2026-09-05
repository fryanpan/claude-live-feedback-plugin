/**
 * A review root is a whole repository, and `context-file` / `editable-file`
 * open any path under it on demand — for a share visitor as much as for the
 * owner. The all-files tree is built from `git ls-files --cached --others
 * --exclude-standard`, so an ignored file (`.env`, a credentials dump) never
 * APPEARS in the tree; but until the Urgent-fixes ticket (2026-09-02) nothing
 * stopped a caller who knew the path from opening it anyway. This suite pins
 * the rule "you can open what the tree shows, and nothing else", over the
 * real routes.
 *
 * Every refusal here is paired with a positive control on the same server —
 * a listed file opens — so a 404 cannot be a review that never bound.
 *
 * Fixtures are synthetic: the "secret" is a marker string, not a credential.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** A repo with one tracked doc, one ignored env file, and a working-tree change. */
function makeRepo(): { repo: string; base: string } {
  const repo = mkdtempSync(join(tmpdir(), 'ctx-listed-'));
  git(repo, 'init', '-q');
  writeFileSync(join(repo, '.gitignore'), '.env\nsecrets/\n');
  writeFileSync(join(repo, 'note.md'), '# a tracked note\n');
  writeFileSync(join(repo, 'src.ts'), 'export const a = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  // The ignored material — present on disk, absent from ls-files.
  writeFileSync(join(repo, '.env'), 'FIXTURE_MARKER=not-a-real-secret\n');
  mkdirSync(join(repo, 'secrets'));
  writeFileSync(join(repo, 'secrets', 'dump.txt'), 'FIXTURE_MARKER_2\n');
  // A working-tree change, so the diff review has a member.
  writeFileSync(join(repo, 'src.ts'), 'export const a = 2;\n');
  return { repo, base };
}

describe('context-file opens only what git ls-files shows', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let repo: string;
  let base: string;
  let reviewId: string;

  const post = (path: string, body: unknown) =>
    fetch(`http://localhost:${handle.port}${path}`, {
      method: 'POST',
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'ctx-listed-data-'));
    handle = createServer({ port: 0, dataDir });
    ({ repo, base } = makeRepo());
    const bind = await post('/api/diffs', { repo, base });
    expect(bind.status).toBe(200);
    reviewId = ((await bind.json()) as { reviewId: string }).reviewId;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  const open = (relPath: string, verb: 'context-file' | 'editable-file' = 'context-file') =>
    post(`/api/reviews/${encodeURIComponent(reviewId)}/${verb}`, { relPath });

  it('positive control: a tracked, unchanged file opens', async () => {
    const r = await open('note.md');
    expect(r.status).toBe(200);
  });

  it('refuses an ignored .env by path, as not found', async () => {
    const r = await open('.env');
    expect(r.status).toBe(404);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('not-listed');
  });

  it('refuses a file under an ignored directory', async () => {
    const r = await open('secrets/dump.txt');
    expect(r.status).toBe(404);
  });

  it('refuses anything under .git outright', async () => {
    // `.git/config` exists in every repo and is never listed; `.git/HEAD`
    // likewise. Both must be refused without the tree being consulted.
    for (const p of ['.git/config', '.git/HEAD', './.git/config']) {
      const r = await open(p);
      expect(r.status).toBe(404);
      expect(((await r.json()) as { error: string }).error).toBe('not-listed');
    }
  });

  it('the editable-file verb is bound by the same rule', async () => {
    // An ignored `.md` would otherwise be reachable through the companion
    // editor, which delegates to context-file for non-members.
    writeFileSync(join(repo, 'secrets', 'plan.md'), '# ignored plan\n');
    const r = await open('secrets/plan.md', 'editable-file');
    expect(r.status).toBe(404);
    // And the positive control on the same verb.
    const ok = await open('note.md', 'editable-file');
    expect(ok.status).toBe(200);
  });

  it('an untracked but not ignored file still opens (ls-files --others)', async () => {
    writeFileSync(join(repo, 'scratch.md'), '# new, untracked\n');
    const r = await open('scratch.md');
    expect(r.status).toBe(200);
  });

  it('a file created after the listing was cached is found on a miss', async () => {
    // Warm the cache with a hit, then create a new file and ask for it. A
    // cache that only ever served hits would refuse it for the TTL — the
    // miss path must rescan rather than answer stale.
    expect((await open('note.md')).status).toBe(200);
    writeFileSync(join(repo, 'later.ts'), 'export const later = true;\n');
    // Past the miss-rescan window (250ms), well inside the hit TTL (5s): a
    // hit-only cache would still be serving the warm listing here.
    await new Promise((r) => setTimeout(r, 400));
    const r = await open('later.ts');
    expect(r.status).toBe(200);
  });
});

/**
 * The other half of the rule: what the listing shows when there is no git.
 *
 * `scanFolder` falls back to a recursive readdir whenever `git ls-files` exits
 * non-zero — a bound folder in no checkout at all — and the fallback used to
 * apply its dot-prefix test to DIRECTORIES only. So a `bind_folder` on a
 * non-repo directory put `.env` in the tree AND satisfied `isListedFile`, and
 * `context-file` served it. There is no `.gitignore` to honour out here, so
 * the fallback carries its own floor.
 *
 * Fixtures are synthetic: the "secret" is a marker string, not a credential.
 */
describe('the non-git listing carries its own floor', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let folder: string;
  let workspaceId: string;

  const post = (path: string, body: unknown) =>
    fetch(`http://localhost:${handle.port}${path}`, {
      method: 'POST',
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nogit-listed-data-'));
    handle = createServer({ port: 0, dataDir });
    // Deliberately NOT a git repo — `git ls-files` exits non-zero here, which
    // is the whole point of this block.
    folder = mkdtempSync(join(tmpdir(), 'nogit-listed-'));
    writeFileSync(join(folder, 'note.md'), '# a note\n');
    writeFileSync(join(folder, '.env'), 'FIXTURE_MARKER=not-a-real-secret\n');
    writeFileSync(join(folder, '.npmrc'), '//registry.example/:_authToken=FIXTURE_MARKER\n');
    writeFileSync(join(folder, 'server.key'), 'FIXTURE_MARKER_KEY\n');
    writeFileSync(join(folder, 'id_ed25519'), 'FIXTURE_MARKER_SSH\n');
    const bind = await post('/api/workspaces', { folderPath: folder });
    expect(bind.status, await bind.clone().text()).toBe(200);
    // The GROUPING workspace id the bind returns — the id `context-file`
    // and `/files` are addressed by, not the board it is also filed under.
    workspaceId = ((await bind.json()) as { workspaceId: string }).workspaceId;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  const open = (relPath: string) =>
    post(`/api/workspaces/${encodeURIComponent(workspaceId)}/context-file`, { relPath });

  it('positive control: an ordinary file in the same folder opens', async () => {
    // Without this, every refusal below could be a bind that never happened.
    expect((await open('note.md')).status).toBe(200);
  });

  it('refuses the dotfiles and key-shaped names the readdir used to list', async () => {
    for (const p of ['.env', '.npmrc', 'server.key', 'id_ed25519']) {
      const r = await open(p);
      expect(r.status, `expected ${p} to be refused`).toBe(404);
      expect(((await r.json()) as { error: string }).error).toBe('not-listed');
    }
  });

  it('and the tree itself does not name them', async () => {
    // The refusal above and the listing are the same rule; a tree that still
    // advertised `.env` would be telling a visitor a path worth guessing.
    const res = await fetch(
      `http://localhost:${handle.port}/api/workspaces/${encodeURIComponent(workspaceId)}/files`,
      { headers: { host: `localhost:${handle.port}` } },
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('note.md');
    expect(text).not.toContain('.env');
    expect(text).not.toContain('.npmrc');
    expect(text).not.toContain('id_ed25519');
  });
});
