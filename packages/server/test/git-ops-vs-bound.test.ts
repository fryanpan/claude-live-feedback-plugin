import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyExternalContent } from '../src/git-provenance.ts';
import { Rooms } from '../src/rooms.ts';
import { SseHub } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

/**
 * What an ordinary git command does to a doc that is bound live.
 *
 * Measured 2026-08-17 against a running server over synthetic git fixtures,
 * with an editor-save positive control in the same harness. Both directions of
 * the premise reproduced on `git checkout -- <file>`, a branch switch, `git
 * stash` and `git pull`:
 *
 *   - live doc IDLE            → `apply`. The git content lands in the doc
 *                                silently: no syncError, nothing on the page
 *                                saying why it changed under the reader.
 *   - live doc has un-flushed  → `conflict`. The live doc wins and is
 *     edits                      reasserted onto the working tree ~800ms after
 *                                git already exited 0, so `git status` was
 *                                clean and a second later the file is modified
 *                                again.
 *
 * The policy is right and stays — letting a git-sourced write win would
 * clobber a human's un-flushed edits, the exact incident class the conflict
 * arm exists to prevent. What was missing is that nobody was TOLD. These tests
 * pin the measured behaviour (so a later change to either direction goes red)
 * and pin the one thing that changed: the conflict `syncError` now names git.
 */

function makeRooms(dataDir: string): Rooms {
  return new Rooms({
    dataDir,
    sse: new SseHub(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
    decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
  });
}

/**
 * Run git with every `GIT_*` key stripped.
 *
 * A `git init` that inherits a linked worktree's `GIT_DIR` writes
 * `core.bare = true` into the SHARED config — i.e. the primary checkout's —
 * and breaks every subsequent command there (learnings.md: "git exports
 * GIT_DIR into hooks, and `git init` inherits it"). Stripping also removes
 * `GIT_AUTHOR_*` / `GIT_COMMITTER_*`, so commits need an explicit identity or
 * they exit 128 on a CI runner with no global config.
 */
function git(cwd: string, args: string[]): string {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_') && v !== undefined) env[k] = v;
  }
  const res = spawnSync(
    'git',
    ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture', ...args],
    { cwd, env, encoding: 'utf8' },
  );
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}:\n${res.stderr}${res.stdout}`);
  }
  return res.stdout;
}

const HEAD_TEXT = '# Fixture Note\n\nParagraph from the main branch.\n';
const OTHER_TEXT = '# Fixture Note\n\nParagraph from the other branch.\n';
const WIP_TEXT = '# Fixture Note\n\nUncommitted work in progress.\n';

/** A repo with note.md committed on `main` plus a branch `other` whose
 *  note.md differs.
 *
 *  It also commits an empty file and a whitespace-only one, so the object
 *  database CONTAINS those blobs — which is what makes the "don't claim git
 *  for empty content" guard load-bearing instead of vacuously true. Real
 *  repositories acquire an empty blob by accident; a fixture only does if you
 *  put one there. */
function makeRepo(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'note.md'), HEAD_TEXT);
  writeFileSync(join(dir, 'empty.md'), '');
  writeFileSync(join(dir, 'blank.md'), '   \n\n');
  git(dir, ['add', 'note.md', 'empty.md', 'blank.md']);
  git(dir, ['commit', '-q', '-m', 'seed']);
  git(dir, ['checkout', '-q', '-b', 'other']);
  writeFileSync(join(dir, 'note.md'), OTHER_TEXT);
  git(dir, ['commit', '-q', '-am', 'other branch text']);
  git(dir, ['checkout', '-q', 'main']);
  return dir;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Write + force a strictly newer mtime. Rapid writes can land in the same
 *  mtime tick on a coarse temp filesystem, which makes the second one
 *  invisible to the poll (learnings.md). */
let mtimeBump = 0;
function editorSave(path: string, content: string): void {
  writeFileSync(path, content);
  mtimeBump += 2;
  const t = new Date(Date.now() + mtimeBump * 1000);
  require('node:fs').utimesSync(path, t, t);
}

const mtime = (p: string) => statSync(p).mtimeMs;
const dirty = (repo: string) => git(repo, ['status', '--porcelain']).trim();

describe('git provenance — can it tell git-written bytes from typed text?', () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lf-gitprov-'));
    repo = makeRepo(root, 'r');
  });
  // Let the 200ms persist debounce land before the data dir disappears, or
  // every run is buried in ENOENT noise from timers firing after teardown.
  afterEach(async () => {
    await sleep(300);
    rmSync(root, { recursive: true, force: true });
  });

  it('classifies HEAD content as git', () => {
    const v = classifyExternalContent(join(repo, 'note.md'), HEAD_TEXT);
    expect(v.source).toBe('git');
    expect(v.detail).toContain('HEAD:note.md');
  });

  it("classifies another branch's blob as git, even though it is not HEAD", () => {
    const v = classifyExternalContent(join(repo, 'note.md'), OTHER_TEXT);
    expect(v.source).toBe('git');
    // Named differently on purpose: "not HEAD" is what tells a reader the
    // operation was a switch/pull rather than a plain restore.
    expect(v.detail).toContain('not HEAD:note.md');
  });

  it('classifies text a person typed as unknown', () => {
    // The discriminating half. Without this the check could return 'git'
    // unconditionally and every test above would still pass.
    expect(classifyExternalContent(join(repo, 'note.md'), WIP_TEXT).source).toBe('unknown');
  });

  it('does not claim git for empty or whitespace-only content', () => {
    // An empty blob is in nearly every real repository's object database by
    // accident, so a match on one says nothing about who wrote it. This
    // fixture commits both, so without the guard these WOULD classify as git
    // — assert that first, or the case proves nothing.
    expect(git(repo, ['cat-file', '-e', 'HEAD:empty.md']).length).toBe(0);
    expect(classifyExternalContent(join(repo, 'note.md'), '').source).toBe('unknown');
    expect(classifyExternalContent(join(repo, 'note.md'), '   \n\n').source).toBe('unknown');
  });

  it('answers unknown outside a repository, and for a path that is gone', () => {
    expect(classifyExternalContent(join(root, 'loose.md'), HEAD_TEXT).source).toBe('unknown');
    expect(classifyExternalContent(join(root, 'no', 'such', 'dir', 'f.md'), HEAD_TEXT).source).toBe(
      'unknown',
    );
  });
});

describe('a git operation on a bound doc', () => {
  let root: string;
  let dataDir: string;
  let repo: string;
  let file: string;
  let rooms: Rooms;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lf-gitops-'));
    dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });
    repo = makeRepo(root, 'repo');
    file = join(repo, 'note.md');
    rooms = makeRooms(dataDir);
    rooms.getOrCreate('g1', { type: 'markdown', sourceUrl: file });
    expect(rooms.attachFile('g1', file).ok).toBe(true);
  });
  // Let the 200ms persist debounce land before the data dir disappears, or
  // every run is buried in ENOENT noise from timers firing after teardown.
  afterEach(async () => {
    await sleep(300);
    rmSync(root, { recursive: true, force: true });
  });

  /** Give the doc un-flushed edits — the state every actively-typed-in doc is
   *  in for the 800ms write debounce, which re-arms on every keystroke. */
  function liveEdit(find: string, replace: string) {
    expect(rooms.findAndReplace('g1', { find, replace }).ok).toBe(true);
  }

  const syncError = () => rooms.getSyncError('g1')?.message ?? '';

  describe('with the live doc IDLE — the content lands, silently', () => {
    it('git checkout -- <file> reverts the doc to HEAD', () => {
      editorSave(file, WIP_TEXT);
      expect(rooms.reconcileNow('g1')).toBe('apply');
      expect(rooms.getDoc('g1')?.plainText).toContain('work in progress');

      const before = mtime(file);
      git(repo, ['checkout', '--', 'note.md']);
      // Shape before behaviour: a git command that left the bytes untouched
      // would produce a clean-looking "nothing happened" for the wrong reason.
      expect(mtime(file)).not.toBe(before);

      expect(rooms.reconcileNow('g1')).toBe('apply');
      expect(rooms.getDoc('g1')?.plainText).toContain('main branch');
      // Nothing tells the reader why the doc changed under them.
      expect(syncError()).toBe('');
    });

    it('a branch switch pulls the other branch into the doc', () => {
      const before = mtime(file);
      git(repo, ['checkout', '-q', 'other']);
      expect(mtime(file)).not.toBe(before);

      expect(rooms.reconcileNow('g1')).toBe('apply');
      expect(rooms.getDoc('g1')?.plainText).toContain('other branch');
      expect(syncError()).toBe('');
    });

    it('git stash pulls the stashed-away content out of the doc', () => {
      editorSave(file, WIP_TEXT);
      expect(rooms.reconcileNow('g1')).toBe('apply');

      const before = mtime(file);
      git(repo, ['stash']);
      expect(mtime(file)).not.toBe(before);

      expect(rooms.reconcileNow('g1')).toBe('apply');
      expect(rooms.getDoc('g1')?.plainText).toContain('main branch');
      expect(rooms.getDoc('g1')?.plainText).not.toContain('work in progress');
      expect(syncError()).toBe('');
    });
  });

  describe('with UN-FLUSHED live edits — the git operation is partly undone', () => {
    it('git checkout -- <file>: the doc wins and the tree goes dirty again', async () => {
      editorSave(file, WIP_TEXT);
      expect(rooms.reconcileNow('g1')).toBe('apply');
      liveEdit('Uncommitted work in progress.', 'LIVE EDIT typed just now.');

      const before = mtime(file);
      git(repo, ['checkout', '--', 'note.md']);
      expect(mtime(file)).not.toBe(before);
      expect(rooms.reconcileNow('g1')).toBe('conflict');

      expect(rooms.getDoc('g1')?.plainText).toContain('LIVE EDIT');
      expect(syncError()).toContain('a git command (checkout, stash, pull or rebase)');

      // ...and the reassert really lands on the working tree, after git had
      // already reported success.
      await sleep(1100);
      expect(readFileSync(file, 'utf8')).toContain('LIVE EDIT');
      expect(dirty(repo)).toBe('M note.md');
    });

    it('a branch switch: git exits 0 over a clean tree, then the tree is dirty', async () => {
      liveEdit('Paragraph from the main branch.', 'LIVE EDIT typed just now.');
      // The write debounce has not fired, so git sees a clean tree and allows
      // the switch. This is the sharp case: nothing about the git invocation
      // looks wrong.
      expect(dirty(repo)).toBe('');

      const before = mtime(file);
      git(repo, ['checkout', '-q', 'other']);
      expect(mtime(file)).not.toBe(before);
      expect(dirty(repo)).toBe('');

      expect(rooms.reconcileNow('g1')).toBe('conflict');
      expect(rooms.getDoc('g1')?.plainText).toContain('LIVE EDIT');
      expect(rooms.getDoc('g1')?.plainText).not.toContain('other branch');
      expect(syncError()).toContain('a git command (checkout, stash, pull or rebase)');

      await sleep(1100);
      // On branch `other`, holding main's paragraph plus a live edit.
      expect(readFileSync(file, 'utf8')).toContain('LIVE EDIT');
      expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('other');
      expect(dirty(repo)).toBe('M note.md');
    });

    it('git stash: the stash keeps the change AND the tree comes back dirty', async () => {
      editorSave(file, WIP_TEXT);
      expect(rooms.reconcileNow('g1')).toBe('apply');
      liveEdit('Uncommitted work in progress.', 'LIVE EDIT typed just now.');

      const before = mtime(file);
      git(repo, ['stash']);
      expect(mtime(file)).not.toBe(before);
      expect(dirty(repo)).toBe('');

      expect(rooms.reconcileNow('g1')).toBe('conflict');
      expect(syncError()).toContain('a git command (checkout, stash, pull or rebase)');

      await sleep(1100);
      // Worse than it sounds: the stash really consumed the change, and the
      // tree is dirty again holding content that is in neither HEAD nor the
      // stash — so a later `git stash pop` has an unexpected local change to
      // contend with.
      expect(git(repo, ['stash', 'list']).trim()).not.toBe('');
      expect(readFileSync(file, 'utf8')).toContain('LIVE EDIT');
      expect(dirty(repo)).toBe('M note.md');
    });

    it('an ordinary editor save still conflicts, and does NOT blame git', () => {
      // The control. Without it, a hint that fired unconditionally — or a
      // harness in which the conflict arm never ran at all — would look
      // identical to a working discriminator.
      liveEdit('Paragraph from the main branch.', 'LIVE EDIT typed just now.');
      editorSave(file, '# Fixture Note\n\nSomebody else typed this in an editor.\n');

      expect(rooms.reconcileNow('g1')).toBe('conflict');
      // The conflict arm ran (presence)...
      expect(syncError()).toContain('collided with un-flushed live edits');
      // ...and it did not name git (absence).
      expect(syncError()).not.toContain('a git command');
    });
  });
});
