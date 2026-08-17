import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyExternalContent } from '../src/git-provenance.ts';
import { Rooms } from '../src/rooms.ts';
import { SseHub } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

/**
 * What a git operation does to a bound doc (task: "A git operation on a bound
 * file is a live edit the reconcile path cannot tell apart").
 *
 * The disk→doc poll detects change by mtime, so `git checkout`, `git stash`,
 * a branch switch and `git pull` are indistinguishable from a person saving in
 * an editor. These tests MEASURE both resulting directions rather than assert
 * a fix, because the policy is deliberate and stays:
 *
 *   live doc idle          → 'apply': the git content lands in the doc.
 *   live doc has un-flushed
 *   edits                  → 'conflict': the live doc wins, its content is
 *                            reasserted onto the working tree, and the git
 *                            operation is partly undone while git exits 0.
 *
 * What this file pins is (a) that both directions are real, so a later change
 * that alters either one is caught, and (b) that the conflict's `syncError`
 * NAMES git as the cause — the only part an operator can act on.
 *
 * Every fixture repo is synthetic and lives in a temp dir. `git` exports
 * GIT_DIR into subprocesses and a `git init` carrying an inherited
 * linked-worktree GIT_DIR rewrites the PRIMARY checkout's config, so the
 * environment is stripped of every GIT_* key and identity is passed per call.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One poll tick (500ms) + read debounce (150ms) + write debounce (800ms). */
const SETTLE_MS = 1600;

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_')) env[k] = v;
  }
  return env;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture', ...args],
    { cwd, env: cleanEnv(), encoding: 'utf8' },
  );
}

const MAIN_DOC = `# Design note

Intro paragraph on main.

## Section

Keep this sentence intact.
`;

const OTHER_DOC = `# Design note

Intro paragraph on the other branch.

## Section

Keep this sentence intact.
`;

describe('git operations against a bound doc', () => {
  let root: string;
  let dataDir: string;
  let repo: string;
  let path: string;
  let rooms: Rooms;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lf-gitops-'));
    dataDir = mkdtempSync(join(tmpdir(), 'lf-gitops-data-'));
    repo = join(root, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    path = join(repo, 'doc.md');
    writeFileSync(path, MAIN_DOC);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'main version');
    git(repo, 'checkout', '-q', '-b', 'other');
    writeFileSync(path, OTHER_DOC);
    git(repo, 'commit', '-q', '-am', 'other version');
    git(repo, 'checkout', '-q', 'main');

    rooms = new Rooms({
      dataDir,
      sse: new SseHub(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
      decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
    });
    rooms.getOrCreate('d1', { type: 'markdown', sourceUrl: path });
    expect(rooms.attachFile('d1', path).ok).toBe(true);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  const liveText = () => rooms.getDoc('d1')?.plainText ?? '';
  const diskText = () => readFileSync(path, 'utf8');
  const dirty = () => git(repo, 'status', '--porcelain').trim();

  /**
   * POSITIVE CONTROL. Every "the git operation did X" result below is only
   * meaningful if the poll fires at all in this harness — a suite where
   * nothing can ever reach the doc would report the same silence.
   */
  it('positive control: an ordinary editor save reaches the live doc', async () => {
    const before = statSync(path).mtimeMs;
    writeFileSync(path, MAIN_DOC.replace('Intro paragraph on main.', 'Intro from an editor save.'));
    expect(statSync(path).mtimeMs).not.toBe(before);

    await sleep(SETTLE_MS);
    expect(liveText()).toContain('Intro from an editor save.');
    expect(rooms.getSyncError('d1')).toBeUndefined();
  });

  describe('live doc IDLE — the git content is applied into the doc', () => {
    it('git checkout -- <file> reverts the doc under whoever is reading it', async () => {
      // A working-tree edit first, so the checkout has something to revert.
      writeFileSync(path, MAIN_DOC.replace('Intro paragraph on main.', 'Working-tree scratch.'));
      await sleep(SETTLE_MS);
      expect(liveText()).toContain('Working-tree scratch.');

      const before = statSync(path).mtimeMs;
      git(repo, 'checkout', '--', 'doc.md');
      // Assert the SHAPE before the behaviour: git really did rewrite the file.
      expect(statSync(path).mtimeMs).not.toBe(before);
      expect(dirty()).toBe('');

      await sleep(SETTLE_MS);
      // The reader's doc silently loses the scratch text. No syncError: as far
      // as the reconcile knows this was an ordinary external save.
      expect(liveText()).not.toContain('Working-tree scratch.');
      expect(liveText()).toContain('Intro paragraph on main.');
      expect(rooms.getSyncError('d1')).toBeUndefined();
    });

    it('a branch switch pulls the other branch content into the doc', async () => {
      expect(liveText()).toContain('Intro paragraph on main.');

      const before = statSync(path).mtimeMs;
      git(repo, 'checkout', '-q', 'other');
      expect(statSync(path).mtimeMs).not.toBe(before);

      await sleep(SETTLE_MS);
      expect(liveText()).toContain('Intro paragraph on the other branch.');
      expect(rooms.getSyncError('d1')).toBeUndefined();
      // Disk is untouched by us — the checkout stands.
      expect(dirty()).toBe('');
    });

    it('git pull fast-forwards the doc along with the working tree', async () => {
      // A second clone acting as the remote's consumer.
      const upstream = join(root, 'upstream');
      git(root, 'clone', '-q', repo, upstream);
      // Advance `repo`'s main, then pull it into a doc bound in `upstream`.
      writeFileSync(path, MAIN_DOC.replace('Intro paragraph on main.', 'Pulled from upstream.'));
      git(repo, 'commit', '-q', '-am', 'upstream advance');

      const clonePath = join(upstream, 'doc.md');
      rooms.getOrCreate('d2', { type: 'markdown', sourceUrl: clonePath });
      expect(rooms.attachFile('d2', clonePath).ok).toBe(true);
      expect(rooms.getDoc('d2')?.plainText).toContain('Intro paragraph on main.');

      git(upstream, 'pull', '-q', '--ff-only', 'origin', 'main');
      await sleep(SETTLE_MS);
      expect(rooms.getDoc('d2')?.plainText).toContain('Pulled from upstream.');
      expect(rooms.getSyncError('d2')).toBeUndefined();
    });
  });

  describe('live doc has UN-FLUSHED edits — the git operation is partly undone', () => {
    /** Make a live edit that has not yet reached disk (800ms write debounce). */
    function liveEdit(find: string): void {
      expect(rooms.findAndReplace('d1', { find, replace: 'Live edit, not yet flushed.' }).ok).toBe(
        true,
      );
    }

    it('a branch switch is reasserted away: git exits 0 and the tree goes dirty', async () => {
      liveEdit('Intro paragraph on main.');
      git(repo, 'checkout', '-q', 'other');
      // git did its job — at this instant the file holds the other branch.
      expect(diskText()).toContain('Intro paragraph on the other branch.');
      expect(dirty()).toBe('');

      await sleep(SETTLE_MS);

      // ...and a second later the server has put the live doc back over it.
      expect(diskText()).toContain('Live edit, not yet flushed.');
      expect(diskText()).not.toContain('Intro paragraph on the other branch.');
      // The operator's only visible trace, and only if they look:
      expect(dirty()).toContain('doc.md');
    });

    it('git stash leaves the tree dirty with content that is neither HEAD nor the stash', async () => {
      writeFileSync(path, MAIN_DOC.replace('Intro paragraph on main.', 'Working-tree scratch.'));
      await sleep(SETTLE_MS);
      liveEdit('Working-tree scratch.');

      git(repo, 'stash');
      // The stash consumed the change and restored HEAD.
      expect(git(repo, 'stash', 'list')).toContain('stash@{0}');
      expect(diskText()).toContain('Intro paragraph on main.');

      await sleep(SETTLE_MS);

      // The reassert re-dirties the tree the stash just cleaned — with content
      // that is in neither HEAD nor the stash, so a later `git stash pop` has
      // an unexpected working-tree change to contend with.
      expect(diskText()).toContain('Live edit, not yet flushed.');
      expect(dirty()).not.toBe('');
    });

    it('git checkout -- <file> is undone the same way', async () => {
      writeFileSync(path, MAIN_DOC.replace('Intro paragraph on main.', 'Working-tree scratch.'));
      await sleep(SETTLE_MS);
      liveEdit('Working-tree scratch.');

      git(repo, 'checkout', '--', 'doc.md');
      expect(dirty()).toBe('');

      await sleep(SETTLE_MS);
      expect(diskText()).toContain('Live edit, not yet flushed.');
      expect(dirty()).not.toBe('');
    });

    it('the syncError names git as the cause and points at the backup', async () => {
      liveEdit('Intro paragraph on main.');
      git(repo, 'checkout', '-q', 'other');
      await sleep(SETTLE_MS);

      const err = rooms.getSyncError('d1');
      expect(err).toBeDefined();
      // Pre-existing half: what happened and where the overwritten bytes went.
      expect(err?.message).toContain('clobber-backups');
      // The half this task adds: WHY the file changed, which is the only
      // thing that tells an operator their checkout came undone.
      expect(err?.message).toContain('git command');
      expect(err?.message).toContain('identical to HEAD:doc.md');
      expect(err?.message).toContain('git status');
    });

    it('an ordinary editor save conflicting the same way does NOT blame git', async () => {
      // Same conflict, different cause. Without this the git sentence could be
      // unconditional and every assertion above would still pass.
      liveEdit('Intro paragraph on main.');
      writeFileSync(path, MAIN_DOC.replace('Intro paragraph on main.', 'A person typed this.'));
      await sleep(SETTLE_MS);

      const err = rooms.getSyncError('d1');
      expect(err).toBeDefined();
      expect(err?.message).toContain('clobber-backups');
      expect(err?.message).not.toContain('git command');
    });
  });
});

describe('classifyExternalContent', () => {
  let root: string;
  let repo: string;
  let path: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lf-prov-'));
    repo = join(root, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    path = join(repo, 'doc.md');
    writeFileSync(path, MAIN_DOC);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'main version');
    git(repo, 'checkout', '-q', '-b', 'other');
    writeFileSync(path, OTHER_DOC);
    git(repo, 'commit', '-q', '-am', 'other version');
    git(repo, 'checkout', '-q', 'main');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('recognises the content git checked out as HEAD', () => {
    const v = classifyExternalContent(path, readFileSync(path, 'utf8'));
    expect(v.source).toBe('git');
    expect(v.detail).toContain('HEAD:doc.md');
  });

  it('recognises a blob from another ref (a pull or a rebase step)', () => {
    const v = classifyExternalContent(path, OTHER_DOC);
    expect(v.source).toBe('git');
    expect(v.detail).toContain('already contains');
  });

  it('does not claim git for content a person typed', () => {
    expect(
      classifyExternalContent(path, `${MAIN_DOC}\nA sentence nobody committed.\n`).source,
    ).toBe('unknown');
  });

  it('answers unknown outside a git repository instead of throwing', () => {
    const bare = mkdtempSync(join(tmpdir(), 'lf-nogit-'));
    const outside = join(bare, 'doc.md');
    writeFileSync(outside, MAIN_DOC);
    expect(classifyExternalContent(outside, MAIN_DOC).source).toBe('unknown');
    rmSync(bare, { recursive: true, force: true });
  });

  it('answers unknown for a path whose directory does not exist', () => {
    expect(classifyExternalContent(join(root, 'gone', 'doc.md'), MAIN_DOC).source).toBe('unknown');
  });
});
