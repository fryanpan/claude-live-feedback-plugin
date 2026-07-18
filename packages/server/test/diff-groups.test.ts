import { describe, expect, it } from 'bun:test';
import { type GroupableFile, assignGroups } from '../src/diff-groups.ts';

/**
 * assignGroups is the sidebar's "Show Grouped Diffs" logic. Agents pass
 * semantic groups (create_diff_review groups:[{title, paths}]); when they
 * don't, a heuristic buckets by Tests/Docs/Build + top-level module. This is
 * the behavior a by-commit review depends on, so both paths are pinned here.
 */

function f(relPath: string, additions = 1, deletions = 0): GroupableFile {
  return { relPath, additions, deletions };
}

describe('assignGroups — explicit groups', () => {
  it('matches a path exactly OR as a directory prefix', () => {
    const out = assignGroups(
      [f('src/a.ts'), f('src/sub/deep/b.ts'), f('README.md')],
      [
        { title: 'Core', paths: ['src'] }, // dir prefix claims everything under src/
        { title: 'Docs', paths: ['README.md'] }, // exact file
      ],
    );
    expect(out.get('src/a.ts')?.group).toBe('Core');
    expect(out.get('src/sub/deep/b.ts')?.group).toBe('Core');
    expect(out.get('README.md')?.group).toBe('Docs');
  });

  it('assigns rank by array order (first group = rank 0) so the sidebar reads top-down', () => {
    const out = assignGroups(
      [f('a/x.ts'), f('b/y.ts'), f('c/z.ts')],
      [
        { title: 'First', paths: ['a'] },
        { title: 'Second', paths: ['b'] },
        { title: 'Third', paths: ['c'] },
      ],
    );
    expect(out.get('a/x.ts')?.rank).toBe(0);
    expect(out.get('b/y.ts')?.rank).toBe(1);
    expect(out.get('c/z.ts')?.rank).toBe(2);
  });

  it('first group in order to claim a path wins (overlap resolves to lowest rank)', () => {
    const out = assignGroups(
      [f('src/shared.ts')],
      [
        { title: 'Early', paths: ['src'] },
        { title: 'Late', paths: ['src/shared.ts'] }, // also matches, but Early is earlier
      ],
    );
    expect(out.get('src/shared.ts')?.group).toBe('Early');
    expect(out.get('src/shared.ts')?.rank).toBe(0);
  });

  it('drops unmatched files into an "Other" group ranked last', () => {
    const out = assignGroups([f('src/a.ts'), f('stray.ts')], [{ title: 'Core', paths: ['src'] }]);
    expect(out.get('src/a.ts')?.group).toBe('Core');
    expect(out.get('stray.ts')?.group).toBe('Other');
    expect(out.get('stray.ts')?.rank).toBe(1); // norm.length (one explicit group)
  });

  it('tolerates leading/trailing slashes in supplied paths', () => {
    const out = assignGroups([f('src/a.ts')], [{ title: 'Core', paths: ['/src/'] }]);
    expect(out.get('src/a.ts')?.group).toBe('Core');
  });

  it('carries a group’s details onto every file it claims', () => {
    const out = assignGroups(
      [f('src/a.ts'), f('src/b.ts'), f('README.md')],
      [
        { title: 'Core', paths: ['src'], details: 'The routing rewrite.' },
        { title: 'Docs', paths: ['README.md'] }, // no details
      ],
    );
    expect(out.get('src/a.ts')?.details).toBe('The routing rewrite.');
    expect(out.get('src/b.ts')?.details).toBe('The routing rewrite.');
    expect(out.get('README.md')?.details).toBeUndefined();
  });

  it('truncates details to 500 chars and treats blank details as undefined', () => {
    const long = 'x'.repeat(600);
    const out = assignGroups(
      [f('a.ts'), f('b.ts')],
      [
        { title: 'Long', paths: ['a.ts'], details: long },
        { title: 'Blank', paths: ['b.ts'], details: '   \n  ' },
      ],
    );
    expect(out.get('a.ts')?.details).toHaveLength(500);
    expect(out.get('b.ts')?.details).toBeUndefined();
  });

  it('does not truncate through a surrogate pair (no lone surrogate at the cut)', () => {
    // 499 ASCII chars then an emoji (a surrogate pair at code units 499–500):
    // a naive slice(0,500) keeps the high surrogate only. Expect it dropped.
    const details = `${'a'.repeat(499)}😀${'b'.repeat(100)}`;
    const out = assignGroups([f('a.ts')], [{ title: 'G', paths: ['a.ts'], details }]);
    const clamped = out.get('a.ts')?.details ?? '';
    expect(clamped).toHaveLength(499);
    // No unpaired high surrogate remains at the boundary.
    const last = clamped.charCodeAt(clamped.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });
});

describe('assignGroups — heuristic fallback (no explicit groups)', () => {
  it('buckets tests/docs/config and groups the rest by top-level module', () => {
    const out = assignGroups([
      f('packages/core/index.ts', 50, 0), // module: packages
      f('packages/core/index.test.ts'), // Tests bucket
      f('docs/guide.md'), // Docs bucket
      f('package.json'), // Build & config bucket
    ]);
    expect(out.get('packages/core/index.ts')?.group).toBe('packages');
    expect(out.get('packages/core/index.test.ts')?.group).toBe('Tests');
    expect(out.get('docs/guide.md')?.group).toBe('Docs');
    expect(out.get('package.json')?.group).toBe('Build & config');
  });

  it('ranks source modules (by churn) before housekeeping buckets', () => {
    const out = assignGroups([
      f('src/big.ts', 100, 0), // heavy source module
      f('src/big.test.ts', 1, 0), // Tests bucket
    ]);
    const src = out.get('src/big.ts');
    const tests = out.get('src/big.test.ts');
    expect(src?.group).toBe('src');
    expect(tests?.group).toBe('Tests');
    expect((src?.rank ?? 9) < (tests?.rank ?? 0)).toBe(true);
  });
});
