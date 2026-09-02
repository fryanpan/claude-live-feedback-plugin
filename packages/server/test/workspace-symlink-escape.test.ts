/**
 * A symlink inside a shared workspace must not become an arbitrary-file read.
 *
 * `openContextFile` / `openEditableFile` guard traversal LEXICALLY: they
 * reject a `..` segment and require `join(root, relPath)` to start with the
 * root. Both checks are string operations, so a symlink that lives inside the
 * root and points outside it passes them — `join` never touches the
 * filesystem. `serveStaticUnder` learned this lesson already ("realpath, not
 * resolve: a symlink inside the root pointing anywhere on disk sails straight
 * through a string-prefix check"); these two callers did not.
 *
 * It matters here more than it does for static files, because both endpoints
 * are reachable by a SHARE VISITOR on a workspace/diff share
 * (`POST /api/workspaces/<id>/{context-file,editable-file}` are on the
 * allowlist in middleware/host-guard.ts), and a diff review's workspace root
 * is the whole repository. `git ls-files` lists tracked symlinks, so on a real
 * repo the escaping path is also advertised in the visitor's own file list.
 *
 * Driven through the real route table with a real share session: the route
 * layer is the part nothing type-checks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SHARE_COOKIE } from '../src/share/link-session.ts';

const PUBLIC_HOST = 'feedback.example.com';
const SECRET = 'SECRET-PRIVATE-KEY-MATERIAL';

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

describe('symlink escape from a shared workspace', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let repo: string;
  let outside: string;
  let base: string;
  let workspaceId: string;
  let cookie: string;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        'content-type': 'application/json',
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  /** A share visitor: public host + a redeemed session cookie. */
  const visitor = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      ...init,
      headers: {
        host: PUBLIC_HOST,
        cookie: `${SHARE_COOKIE}=${cookie}`,
        'content-type': 'application/json',
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  const openContext = (relPath: string) =>
    visitor(`/api/workspaces/${workspaceId}/context-file`, {
      method: 'POST',
      body: JSON.stringify({ relPath }),
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'symesc-data-'));
    repo = mkdtempSync(join(tmpdir(), 'symesc-repo-'));
    outside = mkdtempSync(join(tmpdir(), 'symesc-secret-'));

    writeFileSync(join(repo, 'README.md'), '# Entry\n\nbody\n');
    writeFileSync(join(repo, 'in-root.txt'), 'ordinary in-root content\n');
    mkdirSync(join(repo, 'sub'), { recursive: true });
    writeFileSync(join(repo, 'sub', 'nested.txt'), 'nested in-root content\n');

    writeFileSync(join(outside, 'id_rsa'), `${SECRET}\n`);
    // The two shapes that occur in real repos.
    symlinkSync(join(outside, 'id_rsa'), join(repo, 'notes.txt')); // symlinked file
    symlinkSync(outside, join(repo, 'linkdir')); // symlinked directory
    // A git repo with the symlinks COMMITTED. Since the tree gate (a path
    // opens only if `git ls-files` lists it) the symlink guard sits behind
    // it, and in a bare directory the readdir fallback never lists a
    // symlink at all — every escape below would then be refused as
    // `not-listed` without the symlink guard ever running, and this suite
    // would stop proving what it exists to prove. Git tracks symlinks as
    // entries, so a committed one IS listed and reaches the guard.
    git(repo, 'init', '-q');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'fixture with symlinks');

    handle = createServer({
      port: 0,
      dataDir,
      share: { config: { publicHostname: PUBLIC_HOST } },
    });
    base = `http://localhost:${handle.port}`;

    // The bind is a GROUPING and is not shareable on its own; file it on a
    // board and share that. The escape this file guards is unchanged — a
    // board visitor reaches the grouping's files through the same routes.
    const board = await local('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'Escape board' }),
    }).then((r) => r.json());
    const boardId = board.workspace.id as string;
    expect(boardId).toBeTruthy();

    const bound = await local('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ folderPath: repo, hubWorkspaceId: boardId }),
    }).then((r) => r.json());
    workspaceId = bound.workspaceId;
    expect(workspaceId).toBeTruthy();

    const share = await local('/api/share/link', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: boardId }),
    }).then((r) => r.json());
    const shareUrl = new URL(share.share.url);
    const redeemed = await fetch(`${base}${shareUrl.pathname}${shareUrl.search}`, {
      redirect: 'manual',
      headers: { host: PUBLIC_HOST },
    });
    expect(redeemed.status).toBe(302);
    cookie = (redeemed.headers.get('set-cookie') ?? '').match(
      new RegExp(`${SHARE_COOKIE}=([^;]+)`),
    )?.[1] as string;
    expect(cookie).toBeTruthy();
  });

  afterAll(async () => {
    await handle.stop();
    for (const d of [dataDir, repo, outside]) rmSync(d, { recursive: true, force: true });
  });

  /**
   * POSITIVE CONTROL. Every assertion below is an ABSENCE — that the escape is
   * refused. Absence proves nothing until the same probe is shown to succeed
   * on a legitimate path, so: the visitor really can open in-root files, and
   * the content channel really does carry file bytes.
   */
  it('opens an ordinary in-root file (control)', async () => {
    const res = await openContext('in-root.txt');
    expect(res.status).toBe(200);
    const { docId } = await res.json();
    expect(docId).toBeTruthy();

    // `plainText`, not `content` — getDoc's shape. Naming it wrong is how the
    // leak assertion below silently passes on `undefined`.
    const doc = await visitor(`/api/docs/${docId}/content`).then((r) => r.json());
    expect(typeof doc.plainText).toBe('string');
    expect(doc.plainText).toContain('ordinary in-root content');
  });

  it('opens a nested in-root file (control)', async () => {
    const res = await openContext('sub/nested.txt');
    expect(res.status).toBe(200);
  });

  it('refuses lexical traversal (already guarded)', async () => {
    const res = await openContext('../../etc/passwd');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bad-path');
  });

  it('refuses a symlinked FILE that points outside the root', async () => {
    const res = await openContext('notes.txt');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bad-path');
  });

  it('refuses a path THROUGH a symlinked directory', async () => {
    // Git lists `linkdir` as one entry and never anything beneath it, so
    // this is refused by the tree gate as not-listed (404) — one layer
    // before the symlink guard, which would have said bad-path. Either
    // refusal keeps the bytes in; the byte-level assertion below is the one
    // that holds whichever layer answers.
    const res = await openContext('linkdir/id_rsa');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('not-listed');
  });

  it('never lets the outside file’s bytes reach the visitor', async () => {
    // Belt and braces: whatever the status code, the secret must not be
    // readable through any doc the visitor can now reach.
    for (const rel of ['notes.txt', 'linkdir/id_rsa']) {
      const res = await openContext(rel);
      if (res.status !== 200) continue;
      const { docId } = await res.json();
      const doc = await visitor(`/api/docs/${docId}/content`).then((r) => r.json());
      // Assert on a real string, not `undefined` — a wrong field name here
      // makes this pass whether or not the secret leaked.
      expect(typeof doc.plainText).toBe('string');
      expect(doc.plainText).not.toContain(SECRET);
    }
  });

  it('refuses the same escape through editable-file', async () => {
    // .md so it gets past the not-markdown check and reaches the path guard.
    // Untracked is fine: `ls-files --others` lists an untracked symlink, so
    // it is listed and the symlink guard is the layer that refuses. Created
    // after the listing was cached by the tests above, so wait out the
    // miss-rescan window (250ms) or the tree gate answers not-listed first.
    symlinkSync(join(outside, 'id_rsa'), join(repo, 'escape.md'));
    await new Promise((r) => setTimeout(r, 400));
    const res = await visitor(`/api/workspaces/${workspaceId}/editable-file`, {
      method: 'POST',
      body: JSON.stringify({ relPath: 'escape.md' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bad-path');
  });
});
