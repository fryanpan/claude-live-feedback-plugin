import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

/**
 * The workspace notes-home setting and the doc-origin-repo routes, through the real
 * HTTP surface: a board declares where its planning notes get checked in,
 * `POST /api/docs` derives a pinned file from it, and `/api/docs/<id>/home`
 * pins/reads/unpins an explicit home. Docs bound the classic way (an
 * explicit path — the `<repo>/.claude/reviews/` convention) must be
 * untouched by all of it. All fixtures are synthetic.
 */

const OWNER = { id: 'known-casey', name: 'Casey', kind: 'person' };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });
}

describe('workspace notes home + doc origin repo routes', () => {
  let tmp: string;
  let dataDir: string;
  let repo: string;
  let wt: string;
  let handle: ServerHandle;
  let base: string;

  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };
  const post = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const put = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const get = (path: string) => fetch(`${base}${path}`);
  const del = (path: string) => fetch(`${base}${path}`, { method: 'DELETE' });

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cw-noteshome-')));
    dataDir = join(tmp, 'data');
    mkdirSync(dataDir);
    repo = join(tmp, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), '# repo\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'init');
    wt = join(tmp, 'wt-notes');
    git(repo, 'worktree', 'add', wt, '-b', 'notes');
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function board(): Promise<string> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name: 'planning-board' }),
    );
    return workspace.id;
  }

  it('settings PUT/GET round-trips notesHome, validates it, and null clears it', async () => {
    const ws = await board();
    const saved = await jj<{ notesHome?: unknown }>(
      await put(`/api/workspaces/${ws}/settings`, {
        author: OWNER,
        notesHome: { repoRoot: repo, branch: 'notes', dir: 'docs/notes' },
      }),
    );
    expect(saved.notesHome).toEqual({ repoRoot: repo, branch: 'notes', dir: 'docs/notes' });
    const read = await jj<{ notesHome?: unknown }>(await get(`/api/workspaces/${ws}/settings`));
    expect(read.notesHome).toEqual({ repoRoot: repo, branch: 'notes', dir: 'docs/notes' });

    const badDir = await put(`/api/workspaces/${ws}/settings`, {
      author: OWNER,
      notesHome: { repoRoot: repo, branch: 'notes', dir: '../outside' },
    });
    expect(badDir.status).toBe(400);
    const badRepo = await put(`/api/workspaces/${ws}/settings`, {
      author: OWNER,
      notesHome: { repoRoot: join(tmp, 'not-a-repo'), branch: 'notes', dir: 'docs' },
    });
    expect(badRepo.status).toBe(400);

    const cleared = await jj<{ notesHome?: unknown }>(
      await put(`/api/workspaces/${ws}/settings`, { author: OWNER, notesHome: null }),
    );
    expect(cleared.notesHome).toBeUndefined();
  });

  it('POST /api/docs derives a pinned, checked-in file from the workspace notes home', async () => {
    const ws = await board();
    await jj(
      await put(`/api/workspaces/${ws}/settings`, {
        author: OWNER,
        notesHome: { repoRoot: repo, branch: 'notes', dir: 'docs/notes' },
      }),
    );
    const created = await jj<{ docId: string }>(
      await post('/api/docs', { docId: 'sprint-plan', hubWorkspaceId: ws }),
    );
    const file = join(wt, 'docs/notes/sprint-plan.md');
    expect(existsSync(file)).toBe(true);
    const home = await jj<{
      home: { branch: string; relPath: string };
      placement: { placed: boolean; path?: string };
    }>(await get(`/api/docs/${created.docId}/home`));
    expect(home.home.branch).toBe('notes');
    expect(home.home.relPath).toBe('docs/notes/sprint-plan.md');
    expect(home.placement).toEqual({ placed: true, path: file });
  });

  it('a notes-home create with nobody on the branch is a 409 naming the fix', async () => {
    const ws = await board();
    await jj(
      await put(`/api/workspaces/${ws}/settings`, {
        author: OWNER,
        notesHome: { repoRoot: repo, branch: 'notes', dir: 'docs/notes' },
      }),
    );
    git(repo, 'worktree', 'remove', '--force', wt);
    const res = await post('/api/docs', { docId: 'orphan-plan', hubWorkspaceId: ws });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('notes_home_unplaced');
  });

  it('an explicit sourceUrl still works untouched — the .claude/reviews convention', async () => {
    const ws = await board();
    await jj(
      await put(`/api/workspaces/${ws}/settings`, {
        author: OWNER,
        notesHome: { repoRoot: repo, branch: 'notes', dir: 'docs/notes' },
      }),
    );
    const scratch = join(tmp, '.claude', 'reviews');
    mkdirSync(scratch, { recursive: true });
    const path = join(scratch, 'scratch-note.md');
    writeFileSync(path, '# Scratch\n\nnot checked in\n');
    const created = await jj<{ docId: string }>(
      await post('/api/docs', { docId: 'scratch-note', sourceUrl: path, hubWorkspaceId: ws }),
    );
    // No home was pinned, and the file stays where the caller put it.
    expect((await get(`/api/docs/${created.docId}/home`)).status).toBe(404);
    expect(readFileSync(path, 'utf8')).toContain('not checked in');
  });

  it('PUT/DELETE /api/docs/<id>/home pin and unpin an existing doc', async () => {
    const path = join(tmp, 'floating.md');
    writeFileSync(path, '# Floating\n\ncontent\n');
    const created = await jj<{ docId: string }>(
      await post('/api/docs', { docId: 'floating', sourceUrl: path }),
    );
    const pinned = await jj<{ placement: { placed: boolean; path?: string } }>(
      await put(`/api/docs/${created.docId}/home`, {
        home: { repoRoot: repo, branch: 'notes', relPath: 'docs/floating.md' },
      }),
    );
    expect(pinned.placement).toEqual({ placed: true, path: join(wt, 'docs/floating.md') });
    expect(readFileSync(join(wt, 'docs/floating.md'), 'utf8')).toContain('content');

    await jj(await del(`/api/docs/${created.docId}/home`));
    expect((await get(`/api/docs/${created.docId}/home`)).status).toBe(404);

    const bad = await put(`/api/docs/${created.docId}/home`, {
      home: { repoRoot: repo, branch: 'notes', relPath: '../escape.md' },
    });
    expect(bad.status).toBe(400);
  });
});
