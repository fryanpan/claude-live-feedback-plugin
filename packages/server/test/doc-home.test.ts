import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalRepoRoot,
  checkoutBranch,
  findWorktreeRoot,
  gitCommonDir,
  normalizeDocHome,
  resolveHomeCheckout,
  verifyPathInHome,
} from '../src/doc-home.ts';

/**
 * The doc-home resolvers read git's plumbing files directly (no subprocess),
 * so these tests build REAL repos and worktrees with the git CLI and assert
 * the pure readers agree with what git set up. All fixtures are synthetic.
 */

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

describe('doc-home git plumbing readers', () => {
  let tmp: string;
  let main: string;
  let wt: string;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lf-home-')));
    main = join(tmp, 'repo');
    mkdirSync(main);
    git(main, 'init', '-b', 'main');
    writeFileSync(join(main, 'README.md'), '# hello\n');
    git(main, 'add', '.');
    git(main, 'commit', '-m', 'init');
    wt = join(tmp, 'wt-feature');
    git(main, 'worktree', 'add', wt, '-b', 'feature');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('checkoutBranch reads the branch of main and linked worktrees', () => {
    expect(checkoutBranch(main)).toBe('main');
    expect(checkoutBranch(wt)).toBe('feature');
  });

  it('checkoutBranch is null for detached HEAD and non-repos', () => {
    git(wt, 'checkout', '--detach');
    expect(checkoutBranch(wt)).toBeNull();
    expect(checkoutBranch(tmp)).toBeNull();
  });

  it('gitCommonDir gives one identity for every worktree of the repo', () => {
    const a = gitCommonDir(main);
    const b = gitCommonDir(wt);
    expect(a).not.toBeNull();
    expect(a).toBe(b as string);
  });

  it('canonicalRepoRoot names the main checkout from ANY worktree of the repo', () => {
    // A home stored with a linked worktree's path dies with that worktree —
    // the resolvers start at the stored path. The canonical spelling is the
    // main checkout, which outlives worktree churn.
    expect(canonicalRepoRoot(main)).toBe(main);
    expect(canonicalRepoRoot(wt)).toBe(main);
    expect(canonicalRepoRoot(tmp)).toBeNull();
  });

  it('a relPath through a symlinked parent that leaves the checkout is refused, not written', () => {
    // `docs` inside the worktree is a symlink to a directory OUTSIDE the
    // repo: the lexical spelling looks contained, the bytes would not be.
    const outside = join(tmp, 'outside-the-repo');
    mkdirSync(outside);
    symlinkSync(outside, join(wt, 'docs'));
    const home = { repoRoot: main, branch: 'feature', relPath: 'docs/plans/triage.md' };
    expect(resolveHomeCheckout(home)).toEqual({
      placed: false,
      reason: 'path-escapes-checkout',
    });
    expect(verifyPathInHome(join(wt, 'docs/plans/triage.md'), home)).toBe('outside-repo');
    // A symlink that stays INSIDE the checkout is a normal repo layout.
    mkdirSync(join(wt, 'real-docs'));
    symlinkSync(join(wt, 'real-docs'), join(wt, 'docs-in'));
    expect(
      resolveHomeCheckout({ repoRoot: main, branch: 'feature', relPath: 'docs-in/triage.md' })
        .placed,
    ).toBe(true);
  });

  it('findWorktreeRoot walks up from a (possibly missing) file path', () => {
    expect(findWorktreeRoot(join(wt, 'docs', 'plans', 'not-yet-created.md'))).toBe(wt);
    expect(findWorktreeRoot(join(tmp, 'nowhere', 'x.md'))).toBeNull();
  });

  it('resolveHomeCheckout finds the worktree holding the branch, from any checkout', () => {
    for (const repoRoot of [main, wt]) {
      const placed = resolveHomeCheckout({ repoRoot, branch: 'feature', relPath: 'docs/plan.md' });
      expect(placed).toEqual({
        placed: true,
        worktreeRoot: wt,
        absPath: join(wt, 'docs/plan.md'),
      });
      const onMain = resolveHomeCheckout({ repoRoot, branch: 'main', relPath: 'docs/plan.md' });
      expect(onMain.placed && onMain.worktreeRoot).toBe(main);
    }
  });

  it('resolveHomeCheckout: no checkout on the branch / missing repo are named refusals', () => {
    expect(resolveHomeCheckout({ repoRoot: main, branch: 'ghost', relPath: 'a.md' })).toEqual({
      placed: false,
      reason: 'no-checkout-on-branch',
    });
    expect(
      resolveHomeCheckout({ repoRoot: join(tmp, 'gone'), branch: 'main', relPath: 'a.md' }),
    ).toEqual({ placed: false, reason: 'repo-missing' });
  });

  it('resolveHomeCheckout skips a removed worktree registration', () => {
    rmSync(wt, { recursive: true, force: true });
    expect(resolveHomeCheckout({ repoRoot: main, branch: 'feature', relPath: 'a.md' })).toEqual({
      placed: false,
      reason: 'no-checkout-on-branch',
    });
  });

  it('verifyPathInHome: the full verdict set', () => {
    const home = { repoRoot: main, branch: 'feature', relPath: 'docs/plan.md' };
    const good = join(wt, 'docs/plan.md');
    expect(verifyPathInHome(good, home)).toBe('ok');
    // Same worktree, different file.
    expect(verifyPathInHome(join(wt, 'docs/other.md'), home)).toBe('wrong-path');
    // A path in a checkout of a DIFFERENT repo, and one outside any repo.
    const other = join(tmp, 'other-repo');
    mkdirSync(other);
    git(other, 'init', '-b', 'feature');
    expect(verifyPathInHome(join(other, 'docs/plan.md'), home)).toBe('outside-repo');
    expect(verifyPathInHome(join(tmp, 'docs/plan.md'), home)).toBe('outside-repo');
    // The checkout under the path switches away from the home branch — the
    // exact incident the guard exists for.
    git(wt, 'checkout', '-b', 'someone-elses-feature');
    expect(verifyPathInHome(good, home)).toBe('wrong-branch');
  });

  it('normalizeDocHome accepts the canonical shape and refuses traversal', () => {
    const ok = normalizeDocHome({ repoRoot: main, branch: 'main', relPath: 'docs/a.md' });
    expect(ok.ok).toBe(true);
    for (const bad of [
      null,
      { repoRoot: 'relative/path', branch: 'main', relPath: 'a.md' },
      { repoRoot: main, branch: '', relPath: 'a.md' },
      { repoRoot: main, branch: '-rf', relPath: 'a.md' },
      { repoRoot: main, branch: 'main', relPath: '/abs.md' },
      { repoRoot: main, branch: 'main', relPath: '../escape.md' },
      { repoRoot: main, branch: 'main', relPath: 'docs/../../escape.md' },
      { repoRoot: main, branch: 'main', relPath: '.git/hooks/pre-commit' },
      { repoRoot: main, branch: 'main', relPath: '' },
    ]) {
      expect(normalizeDocHome(bad).ok).toBe(false);
    }
  });
});
