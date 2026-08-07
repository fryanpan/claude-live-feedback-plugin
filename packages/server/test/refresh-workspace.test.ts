import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rooms } from '../src/rooms.ts';
import { SseHub } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

/**
 * Keeping a review alive while its files move underneath it.
 *
 * The membership of a workspace used to be decided once, at bind time. A
 * file added afterwards was invisible to the grouped-diff sidebar until
 * someone remembered the original base ref and re-ran the bind by hand; a
 * file deleted afterwards stayed in the sidebar forever, pointing at
 * nothing. refreshWorkspace closes both gaps WITHOUT re-minting docIds, so
 * every existing comment thread survives the refresh.
 */

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

const USER = { id: 'u1', name: 'T', kind: 'known' as const, color: '#000' };

describe('Rooms.refreshWorkspace — browse workspace', () => {
  let dataDir: string;
  let folder: string;
  let rooms: Rooms;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rw-data-'));
    folder = mkdtempSync(join(tmpdir(), 'rw-src-'));
    rooms = makeRooms(dataDir);
    writeFileSync(join(folder, 'README.md'), '# Hello\n\nbody\n');
    writeFileSync(join(folder, 'guide.md'), 'guidance here\n');
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  it('errors not-found for an unknown workspace', () => {
    const res = rooms.refreshWorkspace('nope');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('not-found');
  });

  it('says how to recover a workspace bound from an empty folder', () => {
    // Binding an empty folder is a documented degenerate success that creates
    // NO docs — so there is nothing on the server to refresh, and the root
    // can't be recovered from the (hashed) workspaceId. re-running bind_folder
    // is the real fix, and it is safe: the id is derived from the absolute
    // path, so the workspace (and any share pointing at it) keeps its identity.
    const empty = mkdtempSync(join(tmpdir(), 'rw-empty-'));
    try {
      const first = rooms.bindFolder({ folderPath: empty });
      if (!first.ok) throw new Error('bind failed');
      expect(first.files).toEqual([]);

      const res = rooms.refreshWorkspace(first.workspaceId);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toBe('not-found');
        expect(res.detail).toContain('bind_folder');
      }

      writeFileSync(join(empty, 'now.md'), '# arrived late\n');
      const second = rooms.bindFolder({ folderPath: empty });
      if (!second.ok) throw new Error('rebind failed');
      expect(second.workspaceId).toBe(first.workspaceId);
      expect(rooms.refreshWorkspace(first.workspaceId).ok).toBe(true);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('errors root-missing when the folder itself is gone', () => {
    const bound = rooms.bindFolder({ folderPath: folder });
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    rmSync(folder, { recursive: true, force: true });
    const res = rooms.refreshWorkspace(bound.workspaceId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('root-missing');
  });

  it('is a no-op when nothing moved', () => {
    const bound = rooms.bindFolder({ folderPath: folder });
    if (!bound.ok) throw new Error('bind failed');
    const res = rooms.refreshWorkspace(bound.workspaceId);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.kind).toBe('browse');
    expect(res.added).toEqual([]);
    expect(res.stale).toEqual([]);
    expect(res.restored).toEqual([]);
  });

  it('marks a member stale when its file disappears, keeping its threads', async () => {
    const bound = rooms.bindFolder({ folderPath: folder });
    if (!bound.ok) throw new Error('bind failed');
    const opened = rooms.openContextFile(bound.workspaceId, 'guide.md');
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const docId = opened.docId;
    const created = await rooms.createThreadByFind(
      docId,
      { find: 'guidance' },
      USER,
      'is this ok?',
    );
    expect(created.ok).toBe(true);

    rmSync(join(folder, 'guide.md'));
    const res = rooms.refreshWorkspace(bound.workspaceId);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.stale.map((s) => s.relPath)).toEqual(['guide.md']);
    expect(res.stale[0]?.openThreads).toBe(1);

    // The doc — and the comment on it — is still there, just flagged.
    expect(rooms.get(docId)?.meta.stale).toBe(true);
    expect(rooms.listThreads(docId)).toHaveLength(1);
  });

  it('clears the flag when the file comes back', () => {
    const bound = rooms.bindFolder({ folderPath: folder });
    if (!bound.ok) throw new Error('bind failed');
    rooms.openContextFile(bound.workspaceId, 'guide.md');
    rmSync(join(folder, 'guide.md'));
    rooms.refreshWorkspace(bound.workspaceId);

    writeFileSync(join(folder, 'guide.md'), 'guidance here\n');
    const res = rooms.refreshWorkspace(bound.workspaceId);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.restored.map((r) => r.relPath)).toEqual(['guide.md']);
    expect(res.stale).toEqual([]);
    const docId = rooms.list().find((m) => m.relPath === 'guide.md')?.docId ?? '';
    expect(rooms.get(docId)?.meta.stale).toBeUndefined();
  });

  it('keeps excluded paths out of the all-files view AND out of lazy opens', () => {
    // exclude is a SCOPE, not a display filter — a path the caller kept out
    // must not be bindable on demand either, or a share visitor could pull it
    // into the workspace by clicking it in "Show All Files".
    mkdirSync(join(folder, 'vendor'));
    writeFileSync(join(folder, 'vendor', 'lib.md'), 'vendored\n');
    const bound = rooms.bindFolder({ folderPath: folder, exclude: ['vendor'] });
    if (!bound.ok) throw new Error('bind failed');

    const listed = rooms.listRepoFiles(bound.workspaceId);
    expect(listed.ok).toBe(true);
    expect(listed.files?.map((f) => f.relPath)).not.toContain('vendor/lib.md');

    const opened = rooms.openContextFile(bound.workspaceId, 'vendor/lib.md');
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error).toBe('bad-path');
    const editable = rooms.openEditableFile(bound.workspaceId, 'vendor/lib.md');
    expect(editable.ok).toBe(false);
  });

  it('reports the current scan count so a caller sees new files exist', () => {
    const bound = rooms.bindFolder({ folderPath: folder });
    if (!bound.ok) throw new Error('bind failed');
    writeFileSync(join(folder, 'extra.md'), 'new file\n');
    const res = rooms.refreshWorkspace(bound.workspaceId);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Browse members bind lazily, so a new file is browsable without being
    // bound — the count is what the sidebar will show.
    expect(res.fileCount).toBe(3);
    expect(res.added).toEqual([]);
  });
});

describe('Rooms.refreshWorkspace — diff review', () => {
  let dataDir: string;
  let repo: string;
  let base: string;
  let rooms: Rooms;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rw-data-'));
    repo = mkdtempSync(join(tmpdir(), 'rw-repo-'));
    rooms = makeRooms(dataDir);
    git(repo, 'init', '-q');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'a.ts'), 'const a = 1;\n');
    writeFileSync(join(repo, 'src', 'b.ts'), 'const b = 1;\n');
    // Unchanged in the working tree, so it stays OUT of the diff — it exists
    // so a test can change it and then revert it.
    writeFileSync(join(repo, 'notes.md'), '# notes\n\noriginal\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    base = git(repo, 'rev-parse', 'HEAD');
    // One working-tree change so the review has a member to start with.
    writeFileSync(join(repo, 'src', 'a.ts'), 'const a = 2;\n');
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it('picks up a file that changed AFTER the review was created', () => {
    const bound = rooms.bindDiff({ repoPath: repo, base });
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    expect(bound.files.map((f) => f.relPath)).toEqual(['src/a.ts']);

    writeFileSync(join(repo, 'src', 'b.ts'), 'const b = 2;\n');
    const res = rooms.refreshWorkspace(bound.reviewId);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.kind).toBe('diff');
    expect(res.added.map((a) => a.relPath)).toEqual(['src/b.ts']);
    expect(res.fileCount).toBe(2);
  });

  it('keeps honouring the exclude list the review was created with', () => {
    // Otherwise a refresh silently widens the review's scope: a vendored or
    // generated file the caller deliberately hid walks back in the moment it
    // starts differing from the base.
    const bound = rooms.bindDiff({ repoPath: repo, base, exclude: ['src/b.ts'] });
    if (!bound.ok) throw new Error('bind failed');
    writeFileSync(join(repo, 'src', 'b.ts'), 'const b = 2;\n');
    const res = rooms.refreshWorkspace(bound.reviewId);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.added).toEqual([]);
    expect(rooms.list().some((m) => m.relPath === 'src/b.ts')).toBe(false);
  });

  it('replays the NEWEST exclude, not one left on an untouched member', () => {
    // Narrowing a review leaves the newly-excluded member untouched, so if
    // config were written only to accepted files that member would still hold
    // the old exclude — and refresh, which reads config off whichever member
    // it finds first, could replay the obsolete scope and re-include it.
    writeFileSync(join(repo, 'src', 'b.ts'), 'const b = 2;\n');
    const first = rooms.bindDiff({ repoPath: repo, base, exclude: ['nothing'] });
    if (!first.ok) throw new Error('bind failed');
    expect(first.files).toHaveLength(2);

    // Narrow to drop src/a.ts — which is the FIRST member in insertion order,
    // so a config read that stops at the first match would find the member
    // this bind never touched, still holding exclude ['nothing'].
    rooms.bindDiff({ repoPath: repo, base, exclude: ['nothing', 'src/a.ts'] });
    const res = rooms.refreshWorkspace(first.reviewId);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.stale.map((x) => x.relPath)).toEqual(['src/a.ts']);
    expect(res.added).toEqual([]);
  });

  it("files a newly-added file into the caller's groups, not the heuristic", () => {
    const bound = rooms.bindDiff({
      repoPath: repo,
      base,
      groups: [{ title: 'Everything', paths: ['src'] }],
    });
    if (!bound.ok) throw new Error('bind failed');
    writeFileSync(join(repo, 'src', 'b.ts'), 'const b = 2;\n');
    rooms.refreshWorkspace(bound.reviewId);
    const grouped = rooms.listGroupedDiff(bound.reviewId);
    // One group, both files — not "Everything" plus a heuristic bucket.
    expect(grouped.groups.map((g) => g.title)).toEqual(['Everything']);
    expect(grouped.groups[0]?.files).toHaveLength(2);
  });

  it('keeps groups set AFTER the bind across a later refresh', () => {
    const bound = rooms.bindDiff({ repoPath: repo, base });
    if (!bound.ok) throw new Error('bind failed');
    rooms.setWorkspaceGroups(bound.reviewId, [{ title: 'Reviewed', paths: ['src'] }]);
    writeFileSync(join(repo, 'src', 'b.ts'), 'const b = 2;\n');
    rooms.refreshWorkspace(bound.reviewId);
    const grouped = rooms.listGroupedDiff(bound.reviewId);
    expect(grouped.groups.map((g) => g.title)).toEqual(['Reviewed']);
    expect(grouped.groups[0]?.files).toHaveLength(2);
  });

  it('keeps following the heuristic on later refreshes after a reset', () => {
    // Deleting the stored spec would make the reset a one-off: refresh
    // preserves existing diffGroup values (so a group-less refresh can't
    // clobber agent-set groups), so old members would keep the ranks from
    // the reset while new ones got freshly-computed ones. Storing the empty
    // array records "the heuristic IS the choice here" and re-applies it.
    const bound = rooms.bindDiff({
      repoPath: repo,
      base,
      groups: [{ title: 'Everything', paths: ['src'] }],
    });
    if (!bound.ok) throw new Error('bind failed');
    rooms.setWorkspaceGroups(bound.reviewId, []);
    writeFileSync(join(repo, 'src', 'b.ts'), 'const b = 2;\n');
    rooms.refreshWorkspace(bound.reviewId);
    const grouped = rooms.listGroupedDiff(bound.reviewId);
    // Both files land in the same heuristic bucket ("src"), not one in a
    // leftover "Everything" and one in a fresh bucket.
    expect(grouped.groups.map((g) => g.title)).not.toContain('Everything');
    expect(grouped.groups).toHaveLength(1);
    expect(grouped.groups[0]?.files).toHaveLength(2);
  });

  it('re-ranks heuristic groups by CURRENT churn after a reset', () => {
    // The sharp edge of the same problem: heuristic bucket membership is
    // per-file, but group ORDER is churn-ranked across the whole review. A
    // reset that didn't survive would leave old members frozen at the ranks
    // they had when it ran, so the sidebar ordering stops meaning anything.
    // Names chosen so a stale rank would WIN the alphabetical tiebreak:
    // 'alpha' is the low-churn incumbent, 'zeta' the high-churn newcomer.
    // With ranks frozen they tie at 0 and alpha sorts first — wrongly.
    for (const d of ['alpha', 'zeta']) {
      mkdirSync(join(repo, d));
      writeFileSync(join(repo, d, 'x.ts'), 'x\n');
    }
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'add dirs');
    const b2 = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'alpha', 'x.ts'), `${'x\n'.repeat(40)}`);
    const bound = rooms.bindDiff({ repoPath: repo, base: b2 });
    if (!bound.ok) throw new Error('bind failed');
    rooms.setWorkspaceGroups(bound.reviewId, []);
    expect(rooms.listGroupedDiff(bound.reviewId).groups[0]?.title).toBe('alpha');

    // zeta now churns 10x more — a live heuristic must put it first.
    writeFileSync(join(repo, 'zeta', 'x.ts'), `${'y\n'.repeat(400)}`);
    rooms.refreshWorkspace(bound.reviewId);
    expect(rooms.listGroupedDiff(bound.reviewId).groups[0]?.title).toBe('zeta');
  });

  it('stops re-applying a group spec once it is reset to the heuristic', () => {
    const bound = rooms.bindDiff({
      repoPath: repo,
      base,
      groups: [{ title: 'Everything', paths: ['src'] }],
    });
    if (!bound.ok) throw new Error('bind failed');
    rooms.setWorkspaceGroups(bound.reviewId, []);
    writeFileSync(join(repo, 'src', 'b.ts'), 'const b = 2;\n');
    rooms.refreshWorkspace(bound.reviewId);
    const grouped = rooms.listGroupedDiff(bound.reviewId);
    expect(grouped.groups.map((g) => g.title)).not.toContain('Everything');
  });

  it('keeps honouring a raised maxFiles across a refresh', () => {
    // Without the cap replayed, a review deliberately bound above the
    // default would start failing to refresh the moment it grew — the
    // original bind said this many files is fine.
    const bound = rooms.bindDiff({ repoPath: repo, base, maxFiles: 1 });
    if (!bound.ok) throw new Error('bind failed');
    writeFileSync(join(repo, 'src', 'b.ts'), 'const b = 2;\n');
    const res = rooms.refreshWorkspace(bound.reviewId);
    // The stored cap of 1 is what rejects this — proving it round-tripped.
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('too-many-files');
      expect(res.fileCount).toBe(2);
    }
  });

  it('keeps docIds and threads stable across a refresh', async () => {
    const bound = rooms.bindDiff({ repoPath: repo, base });
    if (!bound.ok) throw new Error('bind failed');
    const docId = bound.files[0]?.docId ?? '';
    const created = await rooms.createThreadByFind(docId, { find: 'const a' }, USER, 'why?');
    expect(created.ok).toBe(true);

    writeFileSync(join(repo, 'src', 'b.ts'), 'const b = 2;\n');
    rooms.refreshWorkspace(bound.reviewId);

    const still = rooms.list().find((m) => m.relPath === 'src/a.ts');
    expect(still?.docId).toBe(docId);
    expect(rooms.listThreads(docId)).toHaveLength(1);
  });

  it('marks a member stale once its change is reverted', () => {
    writeFileSync(join(repo, 'src', 'b.ts'), 'const b = 2;\n');
    const bound = rooms.bindDiff({ repoPath: repo, base });
    if (!bound.ok) throw new Error('bind failed');
    expect(bound.files).toHaveLength(2);

    // Put b.ts back the way the base has it — it is no longer part of the diff.
    writeFileSync(join(repo, 'src', 'b.ts'), 'const b = 1;\n');
    const res = rooms.refreshWorkspace(bound.reviewId);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.stale.map((s) => s.relPath)).toEqual(['src/b.ts']);
    const docId = res.stale[0]?.docId ?? '';
    expect(rooms.get(docId)?.meta.stale).toBe(true);

    // …and un-marks it when the change comes back.
    writeFileSync(join(repo, 'src', 'b.ts'), 'const b = 3;\n');
    const again = rooms.refreshWorkspace(bound.reviewId);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.restored.map((r) => r.relPath)).toEqual(['src/b.ts']);
    expect(rooms.get(docId)?.meta.stale).toBeUndefined();
  });

  it('clears stale on a plain re-bind too, not only on refresh', () => {
    // create_diff_review is documented as an idempotent refresh path, so a
    // file that is back in the diff must stop rendering as a ghost without
    // needing a separate refresh_workspace call.
    writeFileSync(join(repo, 'src', 'b.ts'), 'const b = 2;\n');
    const bound = rooms.bindDiff({ repoPath: repo, base });
    if (!bound.ok) throw new Error('bind failed');
    const docId = bound.files.find((f) => f.relPath === 'src/b.ts')?.docId ?? '';

    writeFileSync(join(repo, 'src', 'b.ts'), 'const b = 1;\n');
    rooms.refreshWorkspace(bound.reviewId);
    expect(rooms.get(docId)?.meta.stale).toBe(true);

    writeFileSync(join(repo, 'src', 'b.ts'), 'const b = 3;\n');
    rooms.bindDiff({ repoPath: repo, base });
    expect(rooms.get(docId)?.meta.stale).toBeUndefined();
  });

  it("takes a .md file's companion editor doc stale along with its member", () => {
    // A changed .md has TWO docs on one relPath: the diff member and the
    // editable companion. If only the member goes stale the workspace is
    // half-stale for that path — and because the companion isn't a diff
    // member, a share would start landing on the editor for a file that is
    // no longer under review.
    writeFileSync(join(repo, 'notes.md'), '# notes\n\nedited\n');
    const bound = rooms.bindDiff({ repoPath: repo, base });
    if (!bound.ok) throw new Error('bind failed');
    const companion = rooms.openEditableFile(bound.reviewId, 'notes.md');
    expect(companion.ok).toBe(true);
    if (!companion.ok) return;
    const memberDoc = rooms.list().find((m) => m.relPath === 'notes.md' && m.type === 'diff');
    expect(companion.docId).not.toBe(memberDoc?.docId); // really two docs

    // REVERT — the file still exists, it just no longer differs from base.
    // existsSync would call both of these live; only following the member
    // gets it right.
    writeFileSync(join(repo, 'notes.md'), '# notes\n\noriginal\n');
    rooms.refreshWorkspace(bound.reviewId);
    expect(rooms.get(memberDoc?.docId ?? '')?.meta.stale).toBe(true);
    expect(rooms.get(companion.docId)?.meta.stale).toBe(true);
  });

  it('leaves a CONTEXT file alone — it was never in the diff', () => {
    const bound = rooms.bindDiff({ repoPath: repo, base });
    if (!bound.ok) throw new Error('bind failed');
    // src/b.ts is unchanged, so it is context, not a review member.
    const ctx = rooms.openContextFile(bound.reviewId, 'src/b.ts');
    expect(ctx.ok).toBe(true);
    if (!ctx.ok) return;
    const res = rooms.refreshWorkspace(bound.reviewId);
    expect(res.ok).toBe(true);
    expect(rooms.get(ctx.docId)?.meta.stale).toBeUndefined();
  });

  it('does not mark a deleted-in-diff file stale — being gone IS the change', () => {
    rmSync(join(repo, 'src', 'b.ts'));
    const bound = rooms.bindDiff({ repoPath: repo, base });
    if (!bound.ok) throw new Error('bind failed');
    const res = rooms.refreshWorkspace(bound.reviewId);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.stale).toEqual([]);
  });

  it('refuses to refresh a PINNED review — its content is a commit, not a folder', () => {
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'target');
    const target = git(repo, 'rev-parse', 'HEAD');
    const bound = rooms.bindDiff({ repoPath: repo, base, target });
    if (!bound.ok) throw new Error('bind failed');
    const res = rooms.refreshWorkspace(bound.reviewId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('pinned');
  });
});

describe('Rooms.setWorkspaceGroups', () => {
  let dataDir: string;
  let repo: string;
  let base: string;
  let rooms: Rooms;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'sg-data-'));
    repo = mkdtempSync(join(tmpdir(), 'sg-repo-'));
    rooms = makeRooms(dataDir);
    git(repo, 'init', '-q');
    mkdirSync(join(repo, 'src'));
    mkdirSync(join(repo, 'test'));
    writeFileSync(join(repo, 'src', 'a.ts'), 'const a = 1;\n');
    writeFileSync(join(repo, 'test', 'a.test.ts'), 'test a\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    base = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'src', 'a.ts'), 'const a = 2;\n');
    writeFileSync(join(repo, 'test', 'a.test.ts'), 'test a changed\n');
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it('errors not-found for an unknown workspace', () => {
    const res = rooms.setWorkspaceGroups('nope', [{ title: 'X', paths: ['src'] }]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('not-found');
  });

  it('regroups an existing review in place', () => {
    const bound = rooms.bindDiff({ repoPath: repo, base });
    if (!bound.ok) throw new Error('bind failed');
    // Heuristic grouping put these in separate buckets; override it.
    const res = rooms.setWorkspaceGroups(bound.reviewId, [
      { title: 'The change', paths: ['src'], details: 'what actually moved' },
      { title: 'Coverage', paths: ['test'] },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.groups).toEqual([
      { title: 'The change', fileCount: 1 },
      { title: 'Coverage', fileCount: 1 },
    ]);

    const grouped = rooms.listGroupedDiff(bound.reviewId);
    expect(grouped.groups.map((g) => g.title)).toEqual(['The change', 'Coverage']);
    expect(grouped.groups[0]?.details).toBe('what actually moved');
  });

  it('drops a stale details string when the group is re-set without one', () => {
    const bound = rooms.bindDiff({ repoPath: repo, base });
    if (!bound.ok) throw new Error('bind failed');
    rooms.setWorkspaceGroups(bound.reviewId, [
      { title: 'All', paths: ['src', 'test'], details: 'first pass' },
    ]);
    rooms.setWorkspaceGroups(bound.reviewId, [{ title: 'All', paths: ['src', 'test'] }]);
    const grouped = rooms.listGroupedDiff(bound.reviewId);
    expect(grouped.groups[0]?.details).toBeUndefined();
  });

  it('puts unmatched files in Other and reports them', () => {
    const bound = rooms.bindDiff({ repoPath: repo, base });
    if (!bound.ok) throw new Error('bind failed');
    const res = rooms.setWorkspaceGroups(bound.reviewId, [{ title: 'Src only', paths: ['src'] }]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.ungrouped).toEqual(['test/a.test.ts']);
    expect(res.groups).toEqual([
      { title: 'Src only', fileCount: 1 },
      { title: 'Other', fileCount: 1 },
    ]);
  });

  it('rejects a group with no paths WITHOUT persisting it', () => {
    // A malformed spec used to be written to every member before the
    // assignment blew up on it — which left the workspace permanently
    // un-refreshable, because refresh reads that spec back and re-throws.
    const bound = rooms.bindDiff({ repoPath: repo, base });
    if (!bound.ok) throw new Error('bind failed');
    const res = rooms.setWorkspaceGroups(bound.reviewId, [{ title: 'X' } as never]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('bad-groups');
    expect(rooms.list().every((m) => m.workspaceGroups === undefined)).toBe(true);
    // …and the review is still usable.
    expect(rooms.refreshWorkspace(bound.reviewId).ok).toBe(true);
  });

  it('rejects a group with a blank title or non-string paths', () => {
    const bound = rooms.bindDiff({ repoPath: repo, base });
    if (!bound.ok) throw new Error('bind failed');
    for (const bad of [
      [{ title: '  ', paths: ['src'] }],
      [{ title: 'X', paths: 'src' }],
      [{ title: 'X', paths: [1] }],
      ['nope'],
    ]) {
      const res = rooms.setWorkspaceGroups(bound.reviewId, bad as never);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe('bad-groups');
    }
    expect(rooms.refreshWorkspace(bound.reviewId).ok).toBe(true);
  });

  it('rejects a malformed group spec at BIND time too', () => {
    const res = rooms.bindDiff({
      repoPath: repo,
      base,
      reviewId: 'bind-validate',
      groups: [{ title: 'X' } as never],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('bad-groups');
  });

  it('rejects an over-long details intro rather than truncating it', () => {
    const bound = rooms.bindDiff({ repoPath: repo, base });
    if (!bound.ok) throw new Error('bind failed');
    const res = rooms.setWorkspaceGroups(bound.reviewId, [
      { title: 'Long', paths: ['src'], details: 'x'.repeat(501) },
    ]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('group-details-too-long');
  });

  it('errors no-diff-members on a browse-only workspace', () => {
    const folder = mkdtempSync(join(tmpdir(), 'sg-folder-'));
    try {
      writeFileSync(join(folder, 'README.md'), '# hi\n');
      const bound = rooms.bindFolder({ folderPath: folder });
      if (!bound.ok) throw new Error('bind failed');
      const res = rooms.setWorkspaceGroups(bound.workspaceId, [
        { title: 'X', paths: ['README.md'] },
      ]);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe('no-diff-members');
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
