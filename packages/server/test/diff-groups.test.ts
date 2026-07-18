import { describe, expect, it } from 'bun:test';
import {
  type GroupableFile,
  MAX_GROUP_DETAILS,
  assignGroups,
  findOverlongGroupDetails,
} from '../src/diff-groups.ts';

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

  it('carries a group’s details onto every file it claims, trimmed', () => {
    const out = assignGroups(
      [f('src/a.ts'), f('src/b.ts'), f('README.md')],
      [
        { title: 'Core', paths: ['src'], details: '  The routing rewrite.  ' },
        { title: 'Docs', paths: ['README.md'] }, // no details
      ],
    );
    expect(out.get('src/a.ts')?.details).toBe('The routing rewrite.');
    expect(out.get('src/b.ts')?.details).toBe('The routing rewrite.');
    expect(out.get('README.md')?.details).toBeUndefined();
  });

  it('treats blank/whitespace details as undefined (no empty node) and never truncates', () => {
    const atLimit = 'x'.repeat(MAX_GROUP_DETAILS);
    const out = assignGroups(
      [f('a.ts'), f('b.ts')],
      [
        { title: 'AtLimit', paths: ['a.ts'], details: atLimit }, // exactly 500 → kept whole
        { title: 'Blank', paths: ['b.ts'], details: '   \n  ' },
      ],
    );
    // At the cap: passed through untouched (validation, not assignGroups,
    // guards the over-limit case; here it's within the limit).
    expect(out.get('a.ts')?.details).toBe(atLimit);
    expect(out.get('b.ts')?.details).toBeUndefined();
  });
});

describe('findOverlongGroupDetails', () => {
  it('flags only groups whose trimmed details exceed the cap', () => {
    const over = findOverlongGroupDetails([
      { title: 'Fine', details: 'short' },
      { title: 'AtLimit', details: 'x'.repeat(MAX_GROUP_DETAILS) }, // exactly 500 → ok
      { title: 'TooLong', details: 'y'.repeat(MAX_GROUP_DETAILS + 1) },
      { title: 'None' }, // no details
    ]);
    expect(over).toEqual([{ title: 'TooLong', length: MAX_GROUP_DETAILS + 1 }]);
  });

  it('measures the TRIMMED length (leading/trailing whitespace does not count)', () => {
    const padded = `   ${'z'.repeat(MAX_GROUP_DETAILS)}   `; // 506 raw, 500 trimmed
    expect(findOverlongGroupDetails([{ title: 'Padded', details: padded }])).toEqual([]);
  });

  it('returns empty for undefined groups', () => {
    expect(findOverlongGroupDetails(undefined)).toEqual([]);
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
