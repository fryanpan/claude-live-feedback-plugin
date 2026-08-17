/**
 * `-dirty` on a client release must mean "built from uncommitted code", and it
 * had stopped meaning that: prod's deploy source hosts bound review documents,
 * so a tracked markdown file under `docs/` sits modified for as long as a
 * review is open and every release published in that window was stamped
 * `-dirty` for a reason that had nothing to do with the build. Observed both
 * directions on 2026-08-17 — `0ef5d92-dirty` mid-edit, `a822618` once the same
 * checkout went clean.
 *
 * Every "does not mark" case here is paired with a "does mark" case built the
 * same way, in the same repo, in the same pass. An absence assertion on its own
 * would pass just as happily against a function that never marks anything,
 * which is precisely the regression that must not ship.
 *
 * Fixtures are synthetic.
 */
import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type GitRunner,
  MAX_DIRTY_PATHS,
  affectsDeployedArtifacts,
  describeDeploySource,
  parseStatusPorcelainZ,
  readDeploySource,
} from '../src/deploy-source.ts';

/**
 * git exports GIT_DIR (and friends) into every hook it runs, and a `git init`
 * carrying that inherited env re-initializes the repo GIT_DIR names instead of
 * its own cwd — which has set `core.bare = true` on this very checkout before.
 * Strip them; that also removes GIT_AUTHOR_* / GIT_COMMITTER_*, so identity is
 * passed per-commit (a CI runner has no global one).
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_')) env[k] = v;
  }
  return env;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    encoding: 'utf8',
    env: gitEnv(),
  }).trim();
}

function write(repo: string, rel: string, body: string): void {
  const p = join(repo, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}

/** A checkout shaped like this repo's deploy source: a doc tree, a served
 *  demos tree, and package sources — all committed, so it starts clean. */
function fixtureRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'lf-deploy-src-'));
  git(repo, 'init', '-q');
  write(repo, 'README.md', '# fixture\n');
  write(repo, 'docs/product/plans/some-plan.md', '# plan\n\nfirst draft\n');
  write(repo, 'demos/mockup.html', '<!doctype html><title>m</title>\n');
  write(repo, 'packages/markdown-app/src/app.ts', 'export const a = 1;\n');
  write(repo, 'packages/plugin/skills/thing/SKILL.md', '# skill\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  return repo;
}

describe('what a modified path means for a release', () => {
  it('marks anything the deploy builds or serves, and exempts only documentation', () => {
    // The marking half comes FIRST deliberately: it is the property that must
    // not regress, and the exemptions below are only meaningful next to it.
    for (const p of [
      'packages/markdown-app/src/app.ts',
      'packages/server/src/server.ts',
      'packages/widget/src/widget.ts',
      // Served live out of the deploy source (`bin.ts` → join(repoRoot,
      // 'demos'), `/demos/*`), so an uncommitted demo really is a changed
      // artifact — even though demos hold bound review docs too.
      'demos/mockup.html',
      'scripts/serve.ts',
      'package.json',
      'packages/plugin/.claude-plugin/plugin.json',
      // Deep markdown ships to peers inside the plugin bundle.
      'packages/plugin/skills/thing/SKILL.md',
      'docsite/index.html', // `docs`-prefixed but not the `docs/` tree
    ]) {
      expect(affectsDeployedArtifacts(p)).toBe(true);
    }

    for (const p of [
      'docs/product/plans/some-plan.md',
      'docs/process/learnings.md',
      'README.md',
      'CLAUDE.md',
    ]) {
      expect(affectsDeployedArtifacts(p)).toBe(false);
    }
  });
});

describe('the marker a release carries', () => {
  it('stays clean for a documentation edit but still records it', () => {
    const d = describeDeploySource({
      describe: 'a822618',
      modifiedPaths: ['docs/product/plans/some-plan.md'],
    });
    expect(d.sourceRef).toBe('a822618');
    // Not silence: the tree was not pristine, and the release says so, so the
    // absent suffix reads as a decision rather than an oversight.
    expect(d.dirtyPaths).toEqual(['docs/product/plans/some-plan.md']);
    expect(d.dirtyPathCount).toBe(1);
  });

  it('marks a build-affecting edit and names the file that earned it', () => {
    const d = describeDeploySource({
      describe: 'a822618',
      modifiedPaths: ['packages/markdown-app/src/app.ts'],
    });
    expect(d.sourceRef).toBe('a822618-dirty');
    expect(d.dirtyPaths).toEqual(['packages/markdown-app/src/app.ts']);
  });

  it('marks when a doc edit and a code edit are both outstanding', () => {
    // One exempt path must never launder the ones beside it.
    const d = describeDeploySource({
      describe: 'a822618',
      modifiedPaths: ['docs/x.md', 'packages/server/src/rooms.ts'],
    });
    expect(d.sourceRef).toBe('a822618-dirty');
    expect(d.dirtyPathCount).toBe(2);
  });

  it('leaves a genuinely clean tree with no marker and no path list', () => {
    const d = describeDeploySource({ describe: 'a822618', modifiedPaths: [] });
    expect(d.sourceRef).toBe('a822618');
    expect(d.dirtyPaths).toBeUndefined();
    expect(d.dirtyPathCount).toBeUndefined();
  });

  it('treats an unknowable tree as dirty rather than claiming committed provenance', () => {
    const d = describeDeploySource({ describe: 'a822618', modifiedPaths: null });
    expect(d.sourceRef).toBe('a822618-dirty');
    expect(d.dirtyPaths).toBeUndefined();
  });

  it('caps the recorded paths but never the count', () => {
    const many = Array.from(
      { length: MAX_DIRTY_PATHS + 5 },
      (_, i) => `docs/f${String(i).padStart(3, '0')}.md`,
    );
    const d = describeDeploySource({ describe: 'a822618', modifiedPaths: many });
    expect(d.dirtyPaths).toHaveLength(MAX_DIRTY_PATHS);
    expect(d.dirtyPathCount).toBe(many.length);
    expect(d.sourceRef).toBe('a822618');
  });
});

describe('reading the porcelain', () => {
  it('takes both sides of a rename', () => {
    const out = 'R  docs/new.md\0packages/old.ts\0 M packages/server/src/a.ts\0';
    expect(parseStatusPorcelainZ(out)).toEqual([
      'docs/new.md',
      'packages/old.ts',
      'packages/server/src/a.ts',
    ]);
  });

  it('reads a path with a space, which porcelain v1 would have C-quoted', () => {
    expect(parseStatusPorcelainZ(' M docs/a plan.md\0')).toEqual(['docs/a plan.md']);
  });

  it('reads nothing out of a clean tree', () => {
    expect(parseStatusPorcelainZ('')).toEqual([]);
  });
});

describe('against a real checkout', () => {
  // The pure decision above proves nothing about whether the git invocations
  // that feed it produce the shape it expects — the porcelain format and the
  // path convention are exactly the kind of thing a unit test invents.
  it('reports clean, doc-dirty, and code-dirty from the same repo', () => {
    const repo = fixtureRepo();
    try {
      const clean = readDeploySource(repo);
      expect(clean).not.toBeNull();
      expect(clean?.sourceRef).not.toContain('-dirty');
      expect(clean?.dirtyPaths).toBeUndefined();
      const head = clean?.sourceRef ?? '';
      expect(head.length).toBeGreaterThan(0);

      // A bound review doc's ~1s flush, in effect.
      write(repo, 'docs/product/plans/some-plan.md', '# plan\n\nsecond draft\n');
      const docDirty = readDeploySource(repo);
      expect(docDirty?.sourceRef).toBe(head);
      expect(docDirty?.dirtyPaths).toEqual(['docs/product/plans/some-plan.md']);

      // The positive control, in the same repo, with the doc edit still
      // outstanding: this is the case the marker exists for.
      write(repo, 'packages/markdown-app/src/app.ts', 'export const a = 2;\n');
      const codeDirty = readDeploySource(repo);
      expect(codeDirty?.sourceRef).toBe(`${head}-dirty`);
      expect(codeDirty?.dirtyPaths).toContain('packages/markdown-app/src/app.ts');
      expect(codeDirty?.dirtyPathCount).toBe(2);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does not mark an untracked scratch file, matching what --dirty always did', () => {
    const repo = fixtureRepo();
    try {
      write(repo, 'packages/markdown-app/src/scratch.ts', 'export const s = 1;\n');
      expect(readDeploySource(repo)?.sourceRef).not.toContain('-dirty');
      // Positive control: the same path, tracked and modified, does mark.
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'track scratch');
      write(repo, 'packages/markdown-app/src/scratch.ts', 'export const s = 2;\n');
      expect(readDeploySource(repo)?.sourceRef).toContain('-dirty');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('answers null where git cannot describe at all, and dirty where it cannot look', () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'lf-not-a-repo-'));
    try {
      expect(readDeploySource(notARepo)).toBeNull();
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }

    // describe answers, status does not — the tree is unknown, not clean.
    const halfBlind: GitRunner = (args) =>
      args[0] === 'describe' ? { ok: true, stdout: 'a822618\n' } : { ok: false, stdout: '' };
    expect(readDeploySource('/nonexistent', halfBlind)?.sourceRef).toBe('a822618-dirty');
  });
});
