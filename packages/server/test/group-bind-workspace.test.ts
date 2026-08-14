/**
 * A group bind lands on a board too — as ONE unit.
 *
 * PR #127 made every STANDALONE doc land in a hub workspace and deliberately
 * left group binds alone, so a diff review or folder bind was reachable only
 * by its URL: nothing on any board pointed at it. This closes that path.
 *
 * The modelling decision these tests encode, because it is the whole reason
 * this is separate work — two different things wear the word "workspace":
 *
 *   - a GROUPING id (`meta.workspaceId`, a.k.a. `reviewId`) bundles the member
 *     docs of one folder bind or diff review. It has no doc room of its own.
 *   - a HUB workspace is the board: goals, tasks, and a list of attached ids.
 *
 * A board's `docIds` is a list of ATTACHMENT ids, and an attachment is either
 * a doc room or a grouping — `POST /api/workspaces/:id/docs` has accepted both
 * since it was written, and the hub sidebar already resolves a grouping id
 * through the workspace endpoints. So the unit that goes on the board is the
 * grouping, and its members stay off: a hundred-file review is one row, not a
 * hundred.
 *
 * Route-level on purpose. Every REST handler here hand-copies body fields into
 * the rooms call and nothing type-checks that layer.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
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

/** `hubWorkspaceId` is the BOARD. `reviewId` / `workspaceId` in these payloads
 *  is the GROUPING. Same word in English, kept apart on the wire. */
interface DiffResponse {
  reviewId: string;
  hubWorkspaceId?: string;
  files: Array<{ docId: string; relPath: string }>;
}
interface FolderResponse {
  workspaceId: string;
  hubWorkspaceId?: string;
}

describe('a group bind lands on a board, as one unit', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let repo: string;
  let repoBase: string;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  const post = (path: string, body: unknown) =>
    local(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const newBoard = async (name: string): Promise<string> => {
    const r = await post('/api/workspaces', { name, goal: 'Ship.' });
    return ((await r.json()) as { workspace: { id: string } }).workspace.id;
  };

  /** A fresh folder with two files — a folder bind's whole input. */
  const newFolder = (label: string): string => {
    const dir = mkdtempSync(join(tmpdir(), `gbw-${label}-`));
    writeFileSync(join(dir, 'README.md'), '# Entry\n\nRead me.\n');
    writeFileSync(join(dir, 'notes.md'), '# Notes\n\nThoughts.\n');
    return dir;
  };

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'gbw-data-'));
    repo = mkdtempSync(join(tmpdir(), 'gbw-repo-'));
    git(repo, 'init', '-q');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'a.ts'), 'const a = 1;\n');
    writeFileSync(join(repo, 'src', 'b.ts'), 'const b = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    repoBase = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'src', 'a.ts'), 'const a = 2;\n');
    writeFileSync(join(repo, 'src', 'b.ts'), 'const b = 2;\n');

    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(() => {
    handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it('honours the board a diff review names', async () => {
    // Positive control for every "it got a board" assertion below: when a
    // board IS supplied, that specific one comes back and holds the link — so
    // a non-empty hubWorkspaceId elsewhere means something.
    const boardId = await newBoard('named-diff-board');
    const r = await post('/api/diffs', {
      repo,
      base: repoBase,
      reviewId: 'rev-named',
      hubWorkspaceId: boardId,
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as DiffResponse;
    expect(body.hubWorkspaceId).toBe(boardId);
    expect(handle.tasks.getWorkspace(boardId)?.docIds).toContain('rev-named');
  });

  it('files a diff review with no board named, and says where it went', async () => {
    const r = await post('/api/diffs', { repo, base: repoBase, reviewId: 'rev-unfiled' });
    expect(r.status).toBe(200);
    const body = (await r.json()) as DiffResponse;
    expect(body.hubWorkspaceId).toBeTruthy();

    // A real board holding a real link, not a label on nothing.
    const boardId = body.hubWorkspaceId as string;
    expect(handle.tasks.getWorkspace(boardId)?.docIds).toContain('rev-unfiled');

    // And findable without the URL — the point of the task. A board the
    // server materialized was never named to anyone, so the list is the only
    // way in.
    const list = await local('/api/workspaces');
    const ids = ((await list.json()) as { hubWorkspaces: { id: string }[] }).hubWorkspaces.map(
      (w) => w.id,
    );
    expect(ids).toContain(boardId);
  });

  it('links the GROUPING, never its member docs', async () => {
    // The whole modelling decision in one assertion. Attaching each member
    // would put one row per changed file on a board nobody asked for.
    const r = await post('/api/diffs', { repo, base: repoBase, reviewId: 'rev-members' });
    const body = (await r.json()) as DiffResponse;
    const boardId = body.hubWorkspaceId as string;
    // Positive control: the members exist and the grouping IS linked, so the
    // absences below are claims about a choice rather than about an empty
    // review or an empty board.
    expect(body.files.length).toBeGreaterThan(1);
    expect(handle.tasks.getWorkspace(boardId)?.docIds).toContain('rev-members');
    for (const f of body.files) {
      expect(handle.rooms.get(f.docId)).toBeTruthy();
      expect(handle.tasks.workspaceOfDoc(f.docId)).toBeNull();
    }
  });

  it('files a folder bind the same way', async () => {
    // bind_folder is a second route into the same shape (POST /api/workspaces
    // with folderPath), and it is the one a reader forgets exists.
    const folder = newFolder('bound');
    try {
      const r = await post('/api/workspaces', { folderPath: folder });
      expect(r.status).toBe(200);
      const body = (await r.json()) as FolderResponse;
      expect(body.hubWorkspaceId).toBeTruthy();
      expect(handle.tasks.getWorkspace(body.hubWorkspaceId as string)?.docIds).toContain(
        body.workspaceId,
      );
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('honours the board a folder bind names', async () => {
    const folder = newFolder('named');
    try {
      const boardId = await newBoard('named-folder-board');
      const r = await post('/api/workspaces', { folderPath: folder, hubWorkspaceId: boardId });
      const body = (await r.json()) as FolderResponse;
      expect(body.hubWorkspaceId).toBe(boardId);
      expect(handle.tasks.getWorkspace(boardId)?.docIds).toContain(body.workspaceId);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('re-binding an existing review does not move it off its board', async () => {
    // Re-running create_diff_review is documented as idempotent, and an agent
    // that re-runs it without repeating hubWorkspaceId must not have the
    // review swept back into the holding pen behind the reviewer's back.
    const boardId = await newBoard('sticky-board');
    await post('/api/diffs', {
      repo,
      base: repoBase,
      reviewId: 'rev-sticky',
      hubWorkspaceId: boardId,
    });
    const again = await post('/api/diffs', { repo, base: repoBase, reviewId: 'rev-sticky' });
    expect(((await again.json()) as DiffResponse).hubWorkspaceId).toBe(boardId);
    expect(handle.tasks.getWorkspace(boardId)?.docIds).toContain('rev-sticky');
  });

  it('moving a review to a real board takes it out of the holding pen', async () => {
    // The ordinary flow: the review is filed before anyone names a board for
    // it, then attach_doc moves it. Left in both, `workspaceOfDoc` answers
    // with whichever the store iterates first — and that is what share
    // scoping resolves against.
    const r = await post('/api/diffs', { repo, base: repoBase, reviewId: 'rev-moved' });
    const holdingId = ((await r.json()) as DiffResponse).hubWorkspaceId as string;
    expect(handle.tasks.getWorkspace(holdingId)?.docIds).toContain('rev-moved');

    const realId = await newBoard('real-home-for-review');
    expect((await post(`/api/workspaces/${realId}/docs`, { docId: 'rev-moved' })).status).toBe(200);

    expect(handle.tasks.getWorkspace(realId)?.docIds).toContain('rev-moved');
    expect(handle.tasks.getWorkspace(holdingId)?.docIds).not.toContain('rev-moved');
    expect(handle.tasks.workspaceOfDoc('rev-moved')).toBe(realId);
  });

  it('deleting a review leaves no tombstone on the board', async () => {
    // Filing every review means a board would otherwise collect one dangling
    // id per finished review — invisible in the UI and permanent in the store.
    // This is the group-bind twin of the doc-delete unlink in PR #127.
    const r = await post('/api/diffs', { repo, base: repoBase, reviewId: 'rev-deleted' });
    const boardId = ((await r.json()) as DiffResponse).hubWorkspaceId as string;
    expect(handle.tasks.getWorkspace(boardId)?.docIds).toContain('rev-deleted');

    const del = await local('/api/workspaces/rev-deleted?force=true', { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(handle.tasks.getWorkspace(boardId)?.docIds).not.toContain('rev-deleted');
  });
});
