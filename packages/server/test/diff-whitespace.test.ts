/**
 * Whitespace-only files in a diff review.
 *
 * A formatter run across a repo puts dozens of files in the sidebar that
 * have nothing to review. They are classified here so the sidebar can rank
 * them last instead of interleaving them with real work.
 *
 * The classification is `git diff --numstat` vs `git diff -w --numstat`:
 * a file the plain pass reports and the `-w` pass does not changed only in
 * whitespace. Deliberately NOT a drop — a file missing from a review is
 * worse than a file that is merely quiet, and a reviewer who wants to see
 * it still can.
 */
import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assignGroups } from '../src/diff-groups.ts';
import { diffFiles } from '../src/git-diff.ts';
import { Rooms } from '../src/rooms.ts';
import { SseHub } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

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
 * base → target where each file exercises one classification:
 *   src/reformatted.ts  reindented only          → whitespace-only
 *   src/blanks.ts       blank lines added only   → whitespace-only
 *   src/real.ts         one line rewritten       → not
 *   src/mixed.ts        reindented AND rewritten → not
 *   src/added.ts        new file                 → not
 */
function makeRepo(): { repo: string; base: string; target: string } {
  const repo = mkdtempSync(join(tmpdir(), 'ws-diff-'));
  git(repo, 'init', '-q');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'reformatted.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  writeFileSync(join(repo, 'src', 'blanks.ts'), 'const x = 1;\nconst y = 2;\n');
  writeFileSync(join(repo, 'src', 'real.ts'), 'const p = 1;\nconst q = 2;\n');
  writeFileSync(join(repo, 'src', 'mixed.ts'), 'const m = 1;\nconst n = 2;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');

  writeFileSync(
    join(repo, 'src', 'reformatted.ts'),
    '    const a = 1;\n    const b = 2;\n    const c = 3;\n',
  );
  writeFileSync(join(repo, 'src', 'blanks.ts'), 'const x = 1;\n\n\nconst y = 2;\n');
  writeFileSync(join(repo, 'src', 'real.ts'), 'const p = 1;\nconst q = 99;\n');
  writeFileSync(join(repo, 'src', 'mixed.ts'), '    const m = 1;\n    const n = 99;\n');
  writeFileSync(join(repo, 'src', 'added.ts'), 'const fresh = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'target');
  const target = git(repo, 'rev-parse', 'HEAD');
  return { repo, base, target };
}

describe('whitespace-only classification', () => {
  const { repo, base, target } = makeRepo();
  const listed = diffFiles(repo, base, target);
  if (!listed.ok) throw new Error(listed.error);
  const by = (p: string) => listed.files.find((f) => f.relPath === `src/${p}`);

  it('CONTROL: every fixture file is in the diff at all', () => {
    // Without this, "reformatted.ts is whitespace-only" could pass on a file
    // the diff never reported — the assertion below would read `undefined`.
    for (const name of ['reformatted.ts', 'blanks.ts', 'real.ts', 'mixed.ts', 'added.ts']) {
      expect(by(name), name).toBeTruthy();
    }
  });

  it('marks a reindented file whitespace-only', () => {
    expect(by('reformatted.ts')?.whitespaceOnly).toBe(true);
  });

  it('marks a blank-line-only change whitespace-only', () => {
    expect(by('blanks.ts')?.whitespaceOnly).toBe(true);
  });

  it('does NOT mark a file with a real edit', () => {
    expect(by('real.ts')?.whitespaceOnly).toBeFalsy();
  });

  it('does NOT mark a file that is reindented AND edited', () => {
    // The whole point: a formatter that also changed behaviour still gets read.
    expect(by('mixed.ts')?.whitespaceOnly).toBeFalsy();
  });

  it('does NOT mark an added file', () => {
    expect(by('added.ts')?.whitespaceOnly).toBeFalsy();
  });

  it('still reports real line counts for the whitespace-only file', () => {
    // It stays a normal, openable member — only its ranking changes.
    expect(by('reformatted.ts')?.additions).toBe(3);
    expect(by('reformatted.ts')?.deletions).toBe(3);
  });
});

describe('whitespace-only grouping', () => {
  const files = [
    { relPath: 'src/real.ts', additions: 1, deletions: 1 },
    { relPath: 'src/fmt.ts', additions: 40, deletions: 40, whitespaceOnly: true },
    { relPath: 'test/thing.test.ts', additions: 2, deletions: 0 },
  ];

  it('CONTROL: without the flag, churn alone would rank fmt.ts first', () => {
    const plain = assignGroups(files.map(({ whitespaceOnly, ...f }) => ({ ...f })));
    expect(plain.get('src/fmt.ts')?.rank).toBe(0);
    expect(plain.get('src/fmt.ts')?.group).toBe('src');
  });

  it('puts whitespace-only files in their own group, ranked last', () => {
    const got = assignGroups(files);
    const ws = got.get('src/fmt.ts');
    expect(ws?.group).toBe('Whitespace only');
    const ranks = [...got.values()].map((v) => v.rank);
    expect(ws?.rank).toBe(Math.max(...ranks));
  });

  it('ranks it below even the Tests bucket', () => {
    const got = assignGroups(files);
    const wsRank = got.get('src/fmt.ts')?.rank ?? -1;
    const testRank = got.get('test/thing.test.ts')?.rank ?? -1;
    expect(wsRank).toBeGreaterThan(testRank);
  });

  it('leaves ranks contiguous from 0', () => {
    const got = assignGroups(files);
    const ranks = [...new Set([...got.values()].map((v) => v.rank))].sort((a, b) => a - b);
    expect(ranks).toEqual([0, 1, 2]);
  });

  it('an explicit group still wins over the whitespace bucket', () => {
    // Agent-authored groups are caller intent; derived classification only
    // fills gaps (same precedence rule as refresh vs caller-supplied groups).
    const got = assignGroups(files, [{ title: 'The formatting pass', paths: ['src/fmt.ts'] }]);
    expect(got.get('src/fmt.ts')?.group).toBe('The formatting pass');
  });
});

/**
 * The classification is derived from a git repo, but `setWorkspaceGroups`
 * re-runs the grouping heuristic from STORED METADATA with no repo in hand.
 * If the flag didn't persist onto DocMeta, a file would climb back out of
 * the whitespace group the first time an agent touched groups — the same
 * "the fix lives one layer from where it's consumed" shape as the route
 * layer dropping params.
 */
describe('whitespace classification survives regrouping', () => {
  const { repo, base, target } = makeRepo();
  const rooms = new Rooms({
    dataDir: mkdtempSync(join(tmpdir(), 'ws-diff-data-')),
    sse: new SseHub(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
    decorateDocMeta: (m) => m,
  });
  const bound = rooms.bindDiff({ repoPath: repo, base, target, owner: '/cwd' });
  if (!bound.ok) throw new Error(bound.error);
  const groupOf = (rel: string) =>
    rooms.list().find((m) => m.relPath === rel && m.workspaceId === bound.reviewId)?.diffGroup;

  it('CONTROL: the review bound and the real file is in a source group', () => {
    expect(groupOf('src/real.ts')).toBe('src');
  });

  it('bindDiff files the reformatted one under Whitespace only', () => {
    expect(groupOf('src/reformatted.ts')).toBe('Whitespace only');
  });

  it('persists the flag on DocMeta', () => {
    const meta = rooms
      .list()
      .find((m) => m.relPath === 'src/reformatted.ts' && m.workspaceId === bound.reviewId);
    expect(meta?.diffWhitespaceOnly).toBe(true);
  });

  it('a groupless setWorkspaceGroups does not promote it back out', () => {
    const res = rooms.setWorkspaceGroups(bound.reviewId, []);
    expect(res.ok).toBe(true);
    expect(groupOf('src/reformatted.ts')).toBe('Whitespace only');
    expect(groupOf('src/real.ts')).toBe('src'); // control: others still regrouped
  });
});
