import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rooms } from '../src/rooms.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SseHub } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

/**
 * Flat (code / working-tree diff) docs gain doc→disk write-back so the File
 * view can be a live editor. The contract mirrors the prose side:
 * debounced atomic write, stat-before-write guard, echo-loop suppression via
 * lastWritten, and a conflict arm that backs up the losing external version
 * instead of silently nuking either side. Pinned diffs and plain read-only
 * attaches must stay write-free.
 */

function makeRooms(dataDir: string): Rooms {
  return new Rooms({
    dataDir,
    sse: new SseHub(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
    decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let mtimeBump = 0;
function writeExternal(path: string, content: string): void {
  writeFileSync(path, content);
  mtimeBump += 2;
  const t = new Date(Date.now() + mtimeBump * 1000);
  require('node:fs').utimesSync(path, t, t);
}

const SRC = 'fun main() {\n    println("one")\n    println("two")\n}\n';

describe('flat write-back', () => {
  let dataDir: string;
  let path: string;
  let rooms: Rooms;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'lf-flat-'));
    path = join(dataDir, 'Main.kt');
    writeFileSync(path, SRC);
    rooms = makeRooms(dataDir);
    rooms.getOrCreate('c1', { type: 'code', sourceUrl: path });
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('writeBack: an edit to the content Y.Text lands in the file', async () => {
    expect(rooms.attachFlatFile('c1', path, { writeBack: true }).ok).toBe(true);
    const content = rooms.get('c1')?.ydoc.getText('content');
    expect(content?.toString()).toBe(SRC);
    content?.insert(SRC.indexOf('one'), 'edited-');
    await sleep(1100);
    expect(readFileSync(path, 'utf8')).toContain('edited-one');
  });

  it('read-only attach: an edit to the content Y.Text never touches the file', async () => {
    expect(rooms.attachReadonlyFile('c1', path).ok).toBe(true);
    rooms.get('c1')?.ydoc.getText('content').insert(0, 'INJECTED ');
    await sleep(1100);
    expect(readFileSync(path, 'utf8')).toBe(SRC);
  });

  it('external edits still flow in, and the write-back does not echo them back out', async () => {
    expect(rooms.attachFlatFile('c1', path, { writeBack: true }).ok).toBe(true);
    const changed = SRC.replace('two', 'three');
    writeExternal(path, changed);
    await sleep(1400); // poll (500ms) + read debounce (150ms)
    expect(rooms.get('c1')?.ydoc.getText('content').toString()).toBe(changed);
    // The apply came in under a file-watch origin — no write-back echo, so
    // the file keeps the external bytes and mtime-driven loops don't spin.
    await sleep(1000);
    expect(readFileSync(path, 'utf8')).toBe(changed);
  });

  it('conflict: un-flushed live edit + external write keeps live, backs up external, sets syncError', async () => {
    expect(rooms.attachFlatFile('c1', path, { writeBack: true }).ok).toBe(true);
    rooms.get('c1')?.ydoc.getText('content').insert(0, '// live edit\n');
    writeExternal(path, SRC.replace('two', 'external'));
    expect(rooms.reconcileNow('c1')).toBe('conflict');
    await sleep(1100);
    // Live wins on disk...
    expect(readFileSync(path, 'utf8')).toContain('// live edit');
    // ...and the external version survives in clobber-backups.
    const backupDir = join(dataDir, 'clobber-backups');
    expect(existsSync(backupDir)).toBe(true);
    const backups = readdirSync(backupDir).map((f) => readFileSync(join(backupDir, f), 'utf8'));
    expect(backups.some((c) => c.includes('external'))).toBe(true);
    expect(rooms.getSyncError('c1')?.message).toContain('clobber-backups');
  });

  it('re-attach does not stack duplicate content observers', async () => {
    expect(rooms.attachFlatFile('c1', path, { writeBack: true }).ok).toBe(true);
    expect(rooms.attachFlatFile('c1', path, { writeBack: true }).ok).toBe(true);
    expect(rooms.attachFlatFile('c1', path, { writeBack: true }).ok).toBe(true);
    // One observer means one write per change: mutate once, then confirm the
    // file settles to exactly the doc's content (duplicates with stale
    // bindings would race and can resurrect old bytes).
    const content = rooms.get('c1')?.ydoc.getText('content');
    content?.insert(0, '// once\n');
    await sleep(1100);
    expect(readFileSync(path, 'utf8')).toBe(content?.toString() ?? '');
  });
});

describe('flat write-back through bindDiff', () => {
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

  let repo: string;
  let dataDir: string;
  let rooms: Rooms;
  let base: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'lf-flatrepo-'));
    dataDir = mkdtempSync(join(tmpdir(), 'lf-flatdata-'));
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'Main.kt'), SRC);
    writeFileSync(join(repo, 'README.md'), '# Title\n\nBody.\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    base = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'Main.kt'), SRC.replace('two', 'changed'));
    writeFileSync(join(repo, 'README.md'), '# Title\n\nBody changed.\n');
    rooms = makeRooms(dataDir);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('working-tree members get write-back for code but NOT for markdown', async () => {
    const res = rooms.bindDiff({ repoPath: repo, base });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ktId = res.files.find((f) => f.relPath === 'Main.kt')?.docId ?? '';
    const mdId = res.files.find((f) => f.relPath === 'README.md')?.docId ?? '';
    rooms.get(ktId)?.ydoc.getText('content').insert(0, '// from the File view\n');
    // .md members flow through the (future) companion prose doc — writing
    // their flat surface back would double-write the same file.
    rooms.get(mdId)?.ydoc.getText('content').insert(0, 'INJECTED ');
    await sleep(1100);
    expect(readFileSync(join(repo, 'Main.kt'), 'utf8')).toContain('// from the File view');
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# Title\n\nBody changed.\n');
  });

  it('write-back survives a server restart (hydrate re-arms it)', async () => {
    // Learnings: state hydration ≠ binding hydration. hydrateFromDisk
    // re-attached flat docs read-only, so after a restart the File view
    // LOOKED editable but edits silently never reached the working tree.
    const res = rooms.bindDiff({ repoPath: repo, base });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ktId = res.files.find((f) => f.relPath === 'Main.kt')?.docId ?? '';
    await sleep(350); // let the .ydoc persist
    const rooms2 = makeRooms(dataDir);
    rooms2.get(ktId)?.ydoc.getText('content').insert(0, '// post-restart edit\n');
    await sleep(1100);
    expect(readFileSync(join(repo, 'Main.kt'), 'utf8')).toContain('// post-restart edit');
  });

  it('openEditableFile: companion markdown doc whose edits reach the working tree and the member', async () => {
    const res = rooms.bindDiff({ repoPath: repo, base });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const opened = rooms.openEditableFile(res.reviewId, 'README.md');
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.meta.type).toBe('markdown');
    expect(rooms.getDoc(opened.docId)?.plainText).toContain('Body changed.');
    // Edits made in the full markdown editor flow to the working tree...
    expect(
      rooms.findAndReplace(opened.docId, {
        find: 'Body changed.',
        replace: 'Body edited in File view.',
      }).ok,
    ).toBe(true);
    await sleep(1100);
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toContain('Body edited in File view.');
    // ...and from there into the diff member's flat content (redline/diff
    // re-render), closing the loop.
    const mdId = res.files.find((f) => f.relPath === 'README.md')?.docId ?? '';
    rooms.reconcileNow(mdId);
    expect(rooms.get(mdId)?.ydoc.getText('content').toString()).toContain(
      'Body edited in File view.',
    );
    // Idempotent: repeat opens reuse the doc (threads survive).
    const again = rooms.openEditableFile(res.reviewId, 'README.md');
    expect(again.ok && again.docId === opened.docId).toBe(true);
  });

  it('openEditableFile refuses pinned reviews and non-markdown members', () => {
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'target');
    const target = git(repo, 'rev-parse', 'HEAD');
    const pinned = rooms.bindDiff({ repoPath: repo, base, target });
    expect(pinned.ok).toBe(true);
    if (!pinned.ok) return;
    const refused = rooms.openEditableFile(pinned.reviewId, 'README.md');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toBe('pinned');

    const live = rooms.bindDiff({ repoPath: repo, base });
    expect(live.ok).toBe(true);
    if (!live.ok) return;
    const notMd = rooms.openEditableFile(live.reviewId, 'Main.kt');
    expect(notMd.ok).toBe(false);
    if (!notMd.ok) expect(notMd.error).toBe('not-markdown');
    const traversal = rooms.openEditableFile(live.reviewId, '../evil.md');
    expect(traversal.ok).toBe(false);
    if (!traversal.ok) expect(traversal.error).toBe('bad-path');
  });

  it('pinned members never write back', async () => {
    const target = (() => {
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'target');
      return git(repo, 'rev-parse', 'HEAD');
    })();
    const res = rooms.bindDiff({ repoPath: repo, base, target });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ktId = res.files.find((f) => f.relPath === 'Main.kt')?.docId ?? '';
    rooms.get(ktId)?.ydoc.getText('content').insert(0, '// pinned edit\n');
    await sleep(1100);
    expect(readFileSync(join(repo, 'Main.kt'), 'utf8')).not.toContain('// pinned edit');
  });

  it('workspace tree lists an opened editable .md once, under the diff member, badges merged', async () => {
    const res = rooms.bindDiff({ repoPath: repo, base });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const mdId = res.files.find((f) => f.relPath === 'README.md')?.docId ?? '';
    const opened = rooms.openEditableFile(res.reviewId, 'README.md');
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    // One thread on the diff member, one on the companion editor doc — the
    // tree must show ONE README.md row carrying BOTH.
    const author = { id: 'u1', name: 'T', kind: 'known', color: '#000' } as const;
    expect(
      (await rooms.createThreadByFind(mdId, { find: 'Body changed.' }, author, 'on member')).ok,
    ).toBe(true);
    expect(
      (
        await rooms.createThreadByFind(
          opened.docId,
          { find: 'Body changed.' },
          author,
          'on companion',
        )
      ).ok,
    ).toBe(true);
    const tree = rooms.buildWorkspaceTree(res.reviewId);
    const readmes = tree.tree.children.filter(
      (c): c is Extract<typeof c, { type: 'file' }> =>
        c.type === 'file' && c.relPath === 'README.md',
    );
    expect(readmes.length).toBe(1);
    // The diff member stays the tree's face for the file (nav ids, diff
    // badges); the companion's threads still count toward its badge.
    expect(readmes[0]?.docId).toBe(mdId);
    expect(readmes[0]?.openCount).toBe(2);
    expect(readmes[0]?.threadCount).toBe(2);
    expect(tree.totalOpen).toBe(2);
  });

  it('restart in the flush window: newer doc state wins, stale disk is backed up then reasserted', async () => {
    // The crash ordering: File-view edit → .ydoc persisted → server dies
    // BEFORE the ~800ms file write fires. On restart the file holds STALE
    // bytes; blindly seeding from disk (the read-only-era behavior) would
    // silently destroy the persisted edit. Arbitrate by mtime: the .ydoc is
    // newer, so the doc wins, disk is backed up, and the writer reasserts.
    const file = join(repo, 'Main.kt');
    const staleDisk = readFileSync(file, 'utf8');
    const docText = `// survived the crash\n${staleDisk}`;
    // Build the persisted state WITHOUT a file binding (no poll, no writer —
    // nothing races the setup): getOrCreate + a content edit is exactly what
    // hydration will find after a crash mid-flush.
    const setup = makeRooms(dataDir);
    const room = setup.getOrCreate('crash1', {
      type: 'diff',
      sourceUrl: file,
      relPath: 'Main.kt',
      workspaceId: 'wcrash',
      workspaceRoot: repo,
    });
    room.ydoc.getText('content').insert(0, docText);
    await sleep(400); // .ydoc persist debounce
    // Stamp the file OLDER than the .ydoc — the on-disk truth of "the write
    // never happened".
    const past = new Date(Date.now() - 60_000);
    require('node:fs').utimesSync(file, past, past);

    const restarted = makeRooms(dataDir);
    expect(restarted.get('crash1')?.ydoc.getText('content').toString()).toBe(docText);
    await sleep(1100);
    expect(readFileSync(file, 'utf8')).toBe(docText);
    const backupDir = join(dataDir, 'clobber-backups');
    expect(existsSync(backupDir)).toBe(true);
    const backups = readdirSync(backupDir).map((f) => readFileSync(join(backupDir, f), 'utf8'));
    expect(backups).toContain(staleDisk);
  });

  it('restart after downtime edits: newer file wins over stale doc state (deploy-window safety)', async () => {
    // The opposite ordering: server down, agent edits the working tree, then
    // restart. Here DISK is the newer side — "doc always wins" would resurrect
    // pre-deploy bytes into the view and then REASSERT them over the agent's
    // work. The file's newer mtime must make disk authoritative, and no
    // write-back of the stale doc may fire.
    const file = join(repo, 'Main.kt');
    const setup = makeRooms(dataDir);
    const room = setup.getOrCreate('crash2', {
      type: 'diff',
      sourceUrl: file,
      relPath: 'Main.kt',
      workspaceId: 'wcrash',
      workspaceRoot: repo,
    });
    room.ydoc.getText('content').insert(0, readFileSync(file, 'utf8'));
    await sleep(400); // .ydoc persisted
    const downtimeEdit = '// written while the server was down\n';
    writeExternal(file, downtimeEdit); // future mtime > .ydoc mtime

    const restarted = makeRooms(dataDir);
    expect(restarted.get('crash2')?.ydoc.getText('content').toString()).toBe(downtimeEdit);
    await sleep(1100);
    expect(readFileSync(file, 'utf8')).toBe(downtimeEdit);
  });

  it('POST /api/workspaces/:id/editable-file routes the whole flow (route-layer test per learnings)', async () => {
    const handle: ServerHandle = createServer({ port: 0, dataDir });
    try {
      const httpBase = `http://localhost:${handle.port}`;
      const bind = await fetch(`${httpBase}/api/diffs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo, base }),
      });
      expect(bind.ok).toBe(true);
      const bound = (await bind.json()) as { reviewId: string };
      const open = await fetch(
        `${httpBase}/api/workspaces/${encodeURIComponent(bound.reviewId)}/editable-file`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ relPath: 'README.md' }),
        },
      );
      expect(open.status).toBe(200);
      const opened = (await open.json()) as { docId: string; meta: { type: string } };
      expect(opened.meta.type).toBe('markdown');
      // Verify the server-side EFFECT, not just the 200: the doc serves the
      // parsed markdown.
      const read = await fetch(`${httpBase}/api/docs/${encodeURIComponent(opened.docId)}/content`);
      expect(await read.text()).toContain('Body changed.');
    } finally {
      await handle.stop();
    }
  });
});
