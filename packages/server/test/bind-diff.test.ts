import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { diffFiles, isSafeRef, resolveCommit, showFile } from '../src/git-diff.ts';
import { Rooms } from '../src/rooms.ts';
import { SseHub } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

function makeRooms(dataDir: string): Rooms {
  return new Rooms({
    dataDir,
    sse: new SseHub(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
    decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
  });
}

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

/**
 * Build a two-commit fixture repo:
 *   base:   src/kept.ts, src/gone.ts, src/moved.ts, note.md
 *   target: src/kept.ts (modified), src/gone.ts deleted, src/moved.ts →
 *           src/renamed.ts (content preserved), src/new.ts added,
 *           bin.dat added (binary), note.md untouched
 */
function makeFixtureRepo(): { repo: string; base: string; target: string } {
  const repo = mkdtempSync(join(tmpdir(), 'bd-repo-'));
  git(repo, 'init', '-q');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'kept.ts'), 'line1\nline2\nline3\n');
  writeFileSync(join(repo, 'src', 'gone.ts'), 'to be removed\n');
  writeFileSync(
    join(repo, 'src', 'moved.ts'),
    'stable content that survives a rename unchanged\n'.repeat(4),
  );
  writeFileSync(join(repo, 'note.md'), '# unchanged\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');

  writeFileSync(join(repo, 'src', 'kept.ts'), 'line1\nline2 CHANGED\nline3\nline4 added\n');
  rmSync(join(repo, 'src', 'gone.ts'));
  git(repo, 'mv', join('src', 'moved.ts'), join('src', 'renamed.ts'));
  writeFileSync(join(repo, 'src', 'new.ts'), 'brand new\n');
  writeFileSync(join(repo, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'target');
  const target = git(repo, 'rev-parse', 'HEAD');

  return { repo, base, target };
}

describe('git-diff helpers', () => {
  let fixture: { repo: string; base: string; target: string };

  beforeEach(() => {
    fixture = makeFixtureRepo();
  });
  afterEach(() => {
    rmSync(fixture.repo, { recursive: true, force: true });
  });

  it('rejects unsafe refs', () => {
    expect(isSafeRef('--upload-pack=/bin/sh')).toBe(false);
    expect(isSafeRef('HEAD~1')).toBe(true);
    expect(isSafeRef('feature/x')).toBe(true);
    expect(isSafeRef('a b')).toBe(false);
    expect(isSafeRef('')).toBe(false);
  });

  it('resolveCommit resolves refs and rejects garbage', () => {
    expect(resolveCommit(fixture.repo, 'HEAD')).toBe(fixture.target);
    expect(resolveCommit(fixture.repo, fixture.base.slice(0, 8))).toBe(fixture.base);
    expect(resolveCommit(fixture.repo, 'no-such-ref')).toBeNull();
    expect(resolveCommit(fixture.repo, '-x')).toBeNull();
  });

  it('diffFiles reports status, rename, and line counts', () => {
    const res = diffFiles(fixture.repo, fixture.base, fixture.target);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const byPath = new Map(res.files.map((f) => [f.relPath, f]));
    expect(byPath.get('src/kept.ts')?.status).toBe('modified');
    expect(byPath.get('src/kept.ts')?.additions).toBe(2);
    expect(byPath.get('src/kept.ts')?.deletions).toBe(1);
    expect(byPath.get('src/gone.ts')?.status).toBe('deleted');
    expect(byPath.get('src/renamed.ts')?.status).toBe('renamed');
    expect(byPath.get('src/renamed.ts')?.oldPath).toBe('src/moved.ts');
    expect(byPath.get('src/new.ts')?.status).toBe('added');
    expect(byPath.get('bin.dat')?.binary).toBe(true);
    expect(byPath.has('note.md')).toBe(false);
  });

  it('showFile reads a path at a commit and nulls on a missing path', () => {
    expect(showFile(fixture.repo, fixture.base, 'src/gone.ts')).toBe('to be removed\n');
    expect(showFile(fixture.repo, fixture.target, 'src/gone.ts')).toBeNull();
  });
});

describe('Rooms.bindDiff', () => {
  let dataDir: string;
  let rooms: Rooms;
  let fixture: { repo: string; base: string; target: string };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'bd-data-'));
    rooms = makeRooms(dataDir);
    fixture = makeFixtureRepo();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fixture.repo, { recursive: true, force: true });
  });

  it('errors on a missing repo and on bad refs', () => {
    const miss = rooms.bindDiff({ repoPath: join(fixture.repo, 'nope'), base: 'a', target: 'b' });
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.error).toBe('not-found');

    const badRef = rooms.bindDiff({ repoPath: fixture.repo, base: 'nope', target: 'HEAD' });
    expect(badRef.ok).toBe(false);
    if (!badRef.ok) expect(badRef.error).toBe('bad-ref');
  });

  it('creates one diff doc per changed text file, seeded with target content', () => {
    const res = rooms.bindDiff({
      repoPath: fixture.repo,
      base: fixture.base,
      target: fixture.target,
      owner: '/cwd',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.base).toBe(fixture.base);
    expect(res.target).toBe(fixture.target);
    const byRel = new Map(res.files.map((f) => [f.relPath, f]));
    expect([...byRel.keys()].sort()).toEqual([
      'src/gone.ts',
      'src/kept.ts',
      'src/new.ts',
      'src/renamed.ts',
    ]);
    // Binary files are skipped, not bound.
    expect(res.skipped.some((s) => s.path === 'bin.dat' && s.reason === 'binary')).toBe(true);

    const kept = byRel.get('src/kept.ts');
    expect(kept?.status).toBe('modified');
    const keptRoom = rooms.get(kept?.docId ?? '');
    expect(keptRoom?.meta.type).toBe('diff');
    expect(keptRoom?.meta.diffBase).toBe(fixture.base);
    expect(keptRoom?.meta.diffTarget).toBe(fixture.target);
    expect(keptRoom?.ydoc.getText('content').toString()).toBe(
      'line1\nline2 CHANGED\nline3\nline4 added\n',
    );

    // Renames carry the base-side path for baseText lookups.
    const renamed = byRel.get('src/renamed.ts');
    const renamedRoom = rooms.get(renamed?.docId ?? '');
    expect(renamedRoom?.meta.diffStatus).toBe('renamed');
    expect(renamedRoom?.meta.diffOldPath).toBe('src/moved.ts');

    // Deleted files exist in the tree but hold no target content.
    const gone = byRel.get('src/gone.ts');
    const goneRoom = rooms.get(gone?.docId ?? '');
    expect(goneRoom?.meta.diffStatus).toBe('deleted');
    expect(goneRoom?.ydoc.getText('content').toString()).toBe('');
  });

  it('is idempotent for the same range and rejects a different range', () => {
    const a = rooms.bindDiff({
      repoPath: fixture.repo,
      base: fixture.base,
      target: fixture.target,
    });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const b = rooms.bindDiff({
      repoPath: fixture.repo,
      base: fixture.base,
      target: fixture.target,
    });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.reviewId).toBe(a.reviewId);
    expect(b.files.map((f) => f.docId).sort()).toEqual(a.files.map((f) => f.docId).sort());

    const conflict = rooms.bindDiff({
      repoPath: fixture.repo,
      base: fixture.target, // swapped — different range, same derived id? no:
      target: fixture.base, // derived id differs, so pin it explicitly:
      reviewId: a.reviewId,
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error).toBe('review-exists-different-range');
  });

  it('threads survive a re-bind (deterministic docIds)', async () => {
    const a = rooms.bindDiff({
      repoPath: fixture.repo,
      base: fixture.base,
      target: fixture.target,
    });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const docId = a.files.find((f) => f.relPath === 'src/kept.ts')?.docId ?? '';
    const room = rooms.get(docId);
    if (!room) throw new Error('room missing');
    // Anchor to the second line ("line2 CHANGED\n"), like the code surface's
    // snap-to-lines selection does.
    const content = room.ydoc.getText('content');
    const from = content.toString().indexOf('line2');
    const to = content.toString().indexOf('\n', from) + 1;
    const anchor = {
      kind: 'text-range' as const,
      startRel: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(content, from)),
      endRel: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(content, to)),
      snippet: { text: 'line2 CHANGED\n' },
    };
    await rooms.postComment(
      docId,
      null,
      { id: 'u1', name: 'T', kind: 'known', color: '#000' },
      'hello',
      anchor,
    );
    expect(rooms.listThreads(docId)).toHaveLength(1);

    const b = rooms.bindDiff({
      repoPath: fixture.repo,
      base: fixture.base,
      target: fixture.target,
    });
    expect(b.ok).toBe(true);
    expect(rooms.listThreads(docId)).toHaveLength(1);
  });

  it('create_thread by_find works on diff docs (flat content, line-snapped)', async () => {
    const res = rooms.bindDiff({
      repoPath: fixture.repo,
      base: fixture.base,
      target: fixture.target,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const docId = res.files.find((f) => f.relPath === 'src/kept.ts')?.docId ?? '';
    const created = await rooms.createThreadByFind(
      docId,
      { find: 'line2 CHANGED' },
      { id: 'u1', name: 'T', kind: 'known', color: '#000' },
      'why changed?',
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const anchor = created.thread.anchor;
    expect(anchor.kind).toBe('text-range');
    if (anchor.kind !== 'text-range') return;
    // Snapped to the whole line.
    expect(anchor.snippet.text).toBe('line2 CHANGED\n');

    // Ambiguous finds surface candidates instead of guessing.
    const ambiguous = await rooms.createThreadByFind(
      docId,
      { find: 'line' },
      { id: 'u1', name: 'T', kind: 'known', color: '#000' },
      'x',
    );
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) {
      expect(ambiguous.error).toBe('ambiguous');
      expect((ambiguous.candidates ?? []).length).toBeGreaterThan(1);
    }

    // Missing text → no-match.
    const miss = await rooms.createThreadByFind(
      docId,
      { find: 'does-not-exist' },
      { id: 'u1', name: 'T', kind: 'known', color: '#000' },
      'x',
    );
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.error).toBe('no-match');
  });

  it('applies exclude path prefixes', () => {
    const res = rooms.bindDiff({
      repoPath: fixture.repo,
      base: fixture.base,
      target: fixture.target,
      exclude: ['src'],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.files).toHaveLength(0 + 0); // all changed files live under src/
    expect(res.skipped.filter((s) => s.reason === 'excluded')).toHaveLength(4);
  });

  it('enforces maxFiles', () => {
    const res = rooms.bindDiff({
      repoPath: fixture.repo,
      base: fixture.base,
      target: fixture.target,
      maxFiles: 2,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('too-many-files');
      expect(res.fileCount).toBe(4);
    }
  });

  it('rejects an empty diff', () => {
    const res = rooms.bindDiff({
      repoPath: fixture.repo,
      base: fixture.target,
      target: fixture.target,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('empty-diff');
  });

  it('working-tree mode: binds live files incl. uncommitted + untracked', async () => {
    // Uncommitted edit on top of target, plus a brand-new untracked file.
    writeFileSync(join(fixture.repo, 'src', 'kept.ts'), 'line1\nline2 WORKTREE\nline3\n');
    writeFileSync(join(fixture.repo, 'src', 'untracked.ts'), 'not yet added\n');

    const res = rooms.bindDiff({ repoPath: fixture.repo, base: fixture.base });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.target).toBeNull();
    expect(res.reviewId.endsWith('-live')).toBe(true);

    const byRel = new Map(res.files.map((f) => [f.relPath, f]));
    // Untracked file shows up as an addition.
    expect(byRel.get('src/untracked.ts')?.status).toBe('added');
    // Content is the WORKING TREE bytes, not the last commit.
    const keptDocId = byRel.get('src/kept.ts')?.docId ?? '';
    const keptRoom = rooms.get(keptDocId);
    expect(keptRoom?.ydoc.getText('content').toString()).toBe('line1\nline2 WORKTREE\nline3\n');
    expect(keptRoom?.meta.diffTarget).toBeUndefined();
    // Live binding: sourceUrl set (poll armed), unlike pinned docs.
    expect(keptRoom?.meta.sourceUrl).toBe(join(fixture.repo, 'src', 'kept.ts'));

    // Agent edits the file → reparse (poll shortcut) → live doc updates and
    // the thread stack re-anchors by snippet.
    const anchorLine = 'line2 WORKTREE\n';
    const created = await rooms.createThreadByFind(
      keptDocId,
      { find: anchorLine.trim() },
      { id: 'u1', name: 'T', kind: 'known', color: '#000' },
      'watch this line',
    );
    expect(created.ok).toBe(true);
    writeFileSync(
      join(fixture.repo, 'src', 'kept.ts'),
      'line0 new\nline1\nline2 WORKTREE\nline3\n',
    );
    expect(rooms.reparseFromDisk(keptDocId).ok).toBe(true);
    expect(keptRoom?.ydoc.getText('content').toString()).toContain('line0 new');
    // Thread still resolves to the (moved) line — snippet re-anchor keeps it.
    const threads = rooms.listThreads(keptDocId);
    expect(threads).toHaveLength(1);

    // Re-bind refreshes derived counts idempotently.
    const again = rooms.bindDiff({ repoPath: fixture.repo, base: fixture.base });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.reviewId).toBe(res.reviewId);
    expect(rooms.listThreads(keptDocId)).toHaveLength(1);
    const keptAgain = again.files.find((f) => f.relPath === 'src/kept.ts');
    // +2 now: "line2 WORKTREE" replaced line2 and "line0 new" was added.
    expect(keptAgain?.additions).toBe(2);
  });

  it('working-tree and pinned reviews of the same repo coexist under different ids', () => {
    const live = rooms.bindDiff({ repoPath: fixture.repo, base: fixture.base });
    const pinned = rooms.bindDiff({
      repoPath: fixture.repo,
      base: fixture.base,
      target: fixture.target,
    });
    expect(live.ok).toBe(true);
    expect(pinned.ok).toBe(true);
    if (!live.ok || !pinned.ok) return;
    expect(live.reviewId).not.toBe(pinned.reviewId);
  });

  it('listWorkspaceThreads aggregates threads across a review with doc context', async () => {
    const res = rooms.bindDiff({
      repoPath: fixture.repo,
      base: fixture.base,
      target: fixture.target,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const keptId = res.files.find((f) => f.relPath === 'src/kept.ts')?.docId ?? '';
    const newId = res.files.find((f) => f.relPath === 'src/new.ts')?.docId ?? '';
    await rooms.createThreadByFind(
      keptId,
      { find: 'line2 CHANGED' },
      { id: 'u1', name: 'T', kind: 'known', color: '#000' },
      'a',
    );
    await rooms.createThreadByFind(
      newId,
      { find: 'brand new' },
      { id: 'u1', name: 'T', kind: 'known', color: '#000' },
      'b',
    );
    const all = rooms.listWorkspaceThreads(res.reviewId);
    expect(all).toHaveLength(2);
    expect(all.map((t) => t.relPath).sort()).toEqual(['src/kept.ts', 'src/new.ts']);
    expect(all.every((t) => t.docId.length > 0)).toBe(true);

    const one = rooms.listWorkspaceThreads(res.reviewId, { status: 'open' });
    expect(one).toHaveLength(2);
    const kept = all.find((t) => t.relPath === 'src/kept.ts');
    if (kept) rooms.resolve(kept.docId, kept.id);
    expect(rooms.listWorkspaceThreads(res.reviewId, { status: 'open' })).toHaveLength(1);
  });

  it('builds a workspace tree with diff badges', () => {
    const res = rooms.bindDiff({
      repoPath: fixture.repo,
      base: fixture.base,
      target: fixture.target,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const tree = rooms.buildWorkspaceTree(res.reviewId);
    expect(tree.totalOpen).toBe(0);
    const srcDir = tree.tree.children.find((c) => c.type === 'dir' && c.name === 'src');
    expect(srcDir).toBeDefined();
    if (!srcDir || srcDir.type !== 'dir') return;
    const kept = srcDir.children.find((c) => c.type === 'file' && c.relPath === 'src/kept.ts');
    if (!kept || kept.type !== 'file') throw new Error('kept.ts missing from tree');
    expect(kept.diffStatus).toBe('modified');
    expect(kept.diffAdditions).toBe(2);
    expect(kept.diffDeletions).toBe(1);
  });

  it('reparseFromDisk re-seeds diff content from the pinned commit', () => {
    const res = rooms.bindDiff({
      repoPath: fixture.repo,
      base: fixture.base,
      target: fixture.target,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const docId = res.files.find((f) => f.relPath === 'src/kept.ts')?.docId ?? '';
    const room = rooms.get(docId);
    if (!room) throw new Error('room missing');
    // Simulate content corruption/loss.
    const content = room.ydoc.getText('content');
    room.ydoc.transact(() => content.delete(0, content.length));
    expect(content.toString()).toBe('');
    const rep = rooms.reparseFromDisk(docId);
    expect(rep.ok).toBe(true);
    expect(content.toString()).toBe('line1\nline2 CHANGED\nline3\nline4 added\n');
  });
});
