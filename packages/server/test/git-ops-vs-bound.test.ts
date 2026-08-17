import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
const SETTLE_MS = 2400;

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

    it('git stash takes the doc back to HEAD and leaves the tree clean', async () => {
      writeFileSync(path, MAIN_DOC.replace('Intro paragraph on main.', 'Working-tree scratch.'));
      await sleep(SETTLE_MS);
      expect(liveText()).toContain('Working-tree scratch.');

      const before = statSync(path).mtimeMs;
      git(repo, 'stash');
      expect(statSync(path).mtimeMs).not.toBe(before);

      await sleep(SETTLE_MS);
      // The stash stands: no reassert re-dirties the tree, because the doc had
      // nothing un-flushed to defend.
      expect(liveText()).toContain('Intro paragraph on main.');
      expect(liveText()).not.toContain('Working-tree scratch.');
      expect(dirty()).toBe('');
      expect(rooms.getSyncError('d1')).toBeUndefined();
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

    it('git pull is reasserted away too — and the discarded content came from a remote', async () => {
      // The most consequential cell in the matrix: what the reassert overwrites
      // here arrived from a REMOTE, so the operator's "my tree is at
      // origin/main" is now false. In the checkout and stash cases what was
      // discarded was merely local.
      const upstream = join(root, 'upstream-unflushed');
      git(root, 'clone', '-q', repo, upstream);
      writeFileSync(path, MAIN_DOC.replace('Intro paragraph on main.', 'Arrived from the remote.'));
      git(repo, 'commit', '-q', '-am', 'remote advance');

      const clonePath = join(upstream, 'doc.md');
      rooms.getOrCreate('d3', { type: 'markdown', sourceUrl: clonePath });
      expect(rooms.attachFile('d3', clonePath).ok).toBe(true);
      expect(
        rooms.findAndReplace('d3', {
          find: 'Intro paragraph on main.',
          replace: 'Live edit, not yet flushed.',
        }).ok,
      ).toBe(true);

      git(upstream, 'pull', '-q', '--ff-only', 'origin', 'main');
      // git exits 0 and the tree is clean at this instant.
      expect(readFileSync(clonePath, 'utf8')).toContain('Arrived from the remote.');
      expect(git(upstream, 'status', '--porcelain').trim()).toBe('');

      await sleep(SETTLE_MS);

      // ...and the pulled content is gone from the working tree a second later.
      expect(readFileSync(clonePath, 'utf8')).toContain('Live edit, not yet flushed.');
      expect(readFileSync(clonePath, 'utf8')).not.toContain('Arrived from the remote.');
      expect(git(upstream, 'status', '--porcelain').trim()).toContain('doc.md');
      expect(rooms.getSyncError('d3')?.message).toContain('git command');
    });

    /**
     * The hint tells the operator how to recover, so the advice it gives has to
     * be advice that WORKS. The failure mode guarded here is a recovery step
     * that returns ok and changes nothing — which reads as success to the one
     * person who just lost something.
     */
    it('a bare reparse_from_disk does NOT bring the git version back; the backup does', async () => {
      liveEdit('Intro paragraph on main.');
      git(repo, 'checkout', '-q', 'other');
      await sleep(SETTLE_MS);

      // The reassert already landed, so disk holds the LIVE text, not git's.
      expect(diskText()).toContain('Live edit, not yet flushed.');
      const message = rooms.getSyncError('d1')?.message ?? '';

      expect(rooms.reparseFromDisk('d1').ok).toBe(true); // ...and yet:
      expect(liveText()).toContain('Live edit, not yet flushed.');
      expect(liveText()).not.toContain('Intro paragraph on the other branch.');
      // Worse than a no-op: the reparse clears the syncError, so following this
      // as advice also throws away the only pointer to the backup below.
      expect(rooms.getSyncError('d1')).toBeUndefined();

      // That backup is what actually holds the git version, which is why the
      // hint must send the operator there (or back to git) rather than to a
      // bare reparse.
      const backup = /\S*clobber-backups\S+/.exec(message)?.[0];
      expect(backup).toBeDefined();
      expect(readFileSync(backup as string, 'utf8')).toContain(
        'Intro paragraph on the other branch.',
      );
      expect(message).not.toContain('reparse_from_disk to let');
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
    // Commit an empty and a whitespace-only file, so those blobs really ARE in
    // this repo's object database. Without them the empty-content guard below
    // is untestable — `cat-file -e` would miss anyway and the assertion would
    // pass against a function that has no guard at all.
    writeFileSync(join(repo, 'empty.txt'), '');
    writeFileSync(join(repo, 'blank.txt'), '   \n\n');
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

  it('does not claim git for empty or whitespace-only content', () => {
    // Positive control for THIS assertion: the fixture committed both blobs,
    // so a guardless implementation really would answer 'git' here (a
    // truncated save would get blamed on a checkout). Verified by mutation —
    // deleting the guard turns this red.
    expect(
      classifyExternalContent(path, readFileSync(join(repo, 'empty.txt'), 'utf8')).source,
    ).toBe('unknown');
    expect(classifyExternalContent(path, '   \n\n').source).toBe('unknown');
  });

  it('treats a basename as a filename, not a glob', () => {
    // `ls-files -- 'a?.md'` matches BOTH of these, and the code takes [0]. The
    // decoy is named to SORT FIRST ('1' < '?'), because a decoy sorting after
    // the wildcard file lets [0] return the right one by accident — measured:
    writeFileSync(join(repo, 'a1.md'), 'decoy neighbour\n');
    const wild = join(repo, 'a?.md');
    writeFileSync(wild, OTHER_DOC);
    // --literal-pathspecs is a GLOBAL option: before the subcommand, not after.
    git(repo, '--literal-pathspecs', 'add', '--', 'a1.md', 'a?.md');
    git(repo, 'commit', '-q', '-m', 'wildcard-named file');

    const v = classifyExternalContent(wild, OTHER_DOC);
    expect(v.source).toBe('git');
    // The detail must name THIS file, not the decoy the glob also matched.

    expect(v.detail).toContain('a?.md');
    expect(v.detail).not.toContain('a1.md');
  });

  it('follows a symlinked bound path into the repo that actually holds it', () => {
    // `scheduleFileWrite` writes through realpathSync, so a doc bound by a
    // symlink from outside the repo has its bytes overwritten inside it. If
    // classify used the link's own directory it would find no repo and every
    // such conflict would silently answer `unknown`.
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    const link = join(outside, 'linked.md');
    symlinkSync(path, link);

    // Positive control: the link's own directory really is repo-less, so a
    // pass here is the symlink being followed and not the dir happening to work.
    expect(classifyExternalContent(join(outside, 'plain.md'), OTHER_DOC).source).toBe('unknown');
    expect(classifyExternalContent(link, readFileSync(path, 'utf8')).source).toBe('git');
  });

  it('gives up and answers unknown when its time budget is spent', () => {
    const head = readFileSync(path, 'utf8');
    // Positive control in the same assertion: this content DOES classify as
    // git with a normal budget, so a zero budget answering `unknown` is the
    // budget doing it and not the content being unrecognisable.
    expect(classifyExternalContent(path, head).source).toBe('git');
    expect(classifyExternalContent(path, head, 0).source).toBe('unknown');
  });

  /**
   * The budget above is measured with budget 0, which returns BEFORE spawning
   * anything — so it cannot see whether a slow call is actually cut off, and
   * it stays green with the timeout deleted entirely. This one spawns.
   *
   * It matters because `spawnSync`'s `timeout` sends `killSignal` and then
   * keeps waiting: under the default SIGTERM a child that ignores the signal
   * blocks this synchronous call, and the budget is advisory. That is not
   * hypothetical here — `hash-object --path` invokes the repository's
   * configured clean filter, i.e. arbitrary user-configured code.
   */
  it('cuts off a git that ignores SIGTERM instead of blocking the event loop', () => {
    const shimDir = join(root, 'shim');
    const ranMarker = join(root, 'shim-ran');
    mkdirSync(shimDir, { recursive: true });
    const shim = join(shimDir, 'git');
    // Touch a marker BEFORE hanging, so the assertion below can tell "the
    // hanging git was cut off" from "PATH didn't take and real git answered".
    writeFileSync(shim, `#!/bin/sh\ntrap '' TERM\n: > ${JSON.stringify(ranMarker)}\nsleep 30\n`);
    chmodSync(shim, 0o755);

    const realPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${realPath ?? ''}`;
    let elapsed: number;
    let verdict: string;
    try {
      const started = Date.now();
      verdict = classifyExternalContent(path, 'content that is not empty', 800).source;
      elapsed = Date.now() - started;
    } finally {
      process.env.PATH = realPath;
    }

    // Positive control: the hanging shim really is what we measured.
    expect(existsSync(ranMarker)).toBe(true);
    // Without `killSignal: 'SIGKILL'` this is ~30_000ms. Generous threshold so
    // the failure is the signal handling, never a slow machine.
    expect(elapsed).toBeLessThan(5_000);
    expect(verdict).toBe('unknown');
  }, 60_000);

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
