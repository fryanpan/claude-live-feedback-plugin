import { describe, expect, it } from 'vitest';
import { OVERVIEW_DOC, judge, moduleOf, topLevelModules } from './architecture-freshness';

describe('moduleOf', () => {
  it('records a source file sitting directly in a package src', () => {
    expect(moduleOf('packages/server/src/tasks.ts')).toBe('packages/server/src/tasks.ts');
    expect(moduleOf('packages/workspaces-app/src/board.css')).toBe(
      'packages/workspaces-app/src/board.css',
    );
    expect(moduleOf('packages/workspaces-app/src/app-entry.tsx')).toBe(
      'packages/workspaces-app/src/app-entry.tsx',
    );
  });

  it('collapses anything deeper to the directory it sits in', () => {
    expect(moduleOf('packages/server/src/routes/tasks.ts')).toBe('packages/server/src/routes/');
    expect(moduleOf('packages/server/src/routes/deeply/nested/thing.ts')).toBe(
      'packages/server/src/routes/',
    );
    // A directory counts even when the file inside it is a test or a fixture:
    // the directory is the module, and it exists either way.
    expect(moduleOf('packages/core/src/anchor/anchor.test.ts')).toBe('packages/core/src/anchor/');
    expect(moduleOf('packages/server/src/routes/fixtures/sample.json')).toBe(
      'packages/server/src/routes/',
    );
  });

  it('ignores tests, declarations and non-code files at the top level', () => {
    expect(moduleOf('packages/core/src/goal-effort.test.ts')).toBeNull();
    expect(moduleOf('packages/workspaces-app/src/board.test.tsx')).toBeNull();
    expect(moduleOf('packages/core/src/types.d.ts')).toBeNull();
    expect(moduleOf('packages/server/src/notes.json')).toBeNull();
    expect(moduleOf('packages/server/src/README.md')).toBeNull();
  });

  it('ignores paths outside packages/<pkg>/src', () => {
    expect(moduleOf('packages/server/test/tasks.test.ts')).toBeNull();
    expect(moduleOf('packages/plugin/skills/x/SKILL.md')).toBeNull();
    expect(moduleOf('scripts/loc-audit.ts')).toBeNull();
    expect(moduleOf('docs/architecture/overview.md')).toBeNull();
    expect(moduleOf('packages/server/src')).toBeNull();
  });
});

describe('topLevelModules', () => {
  it('deduplicates a directory named by many files', () => {
    expect(
      [
        ...topLevelModules([
          'packages/server/src/routes/a.ts',
          'packages/server/src/routes/b.ts',
          'packages/server/src/routes/c/d.ts',
          'packages/server/src/tasks.ts',
        ]),
      ].sort(),
    ).toEqual(['packages/server/src/routes/', 'packages/server/src/tasks.ts']);
  });
});

describe('judge', () => {
  const base = ['packages/server/src/tasks.ts', 'packages/server/src/routes/tasks.ts'];

  it('passes when the module list is identical', () => {
    const v = judge(base, [...base], ['packages/server/src/tasks.ts']);
    expect(v.ok).toBe(true);
    expect(v.ok && v.reason).toBe('unchanged');
  });

  it('passes when a file is added inside a directory that already existed', () => {
    const v = judge(
      base,
      [...base, 'packages/server/src/routes/goals.ts'],
      ['packages/server/src/routes/goals.ts'],
    );
    expect(v.ok).toBe(true);
    expect(v.ok && v.reason).toBe('unchanged');
  });

  it('fails when a top-level file appears and the overview does not move', () => {
    const v = judge(
      base,
      [...base, 'packages/server/src/zz-probe.ts'],
      ['packages/server/src/zz-probe.ts'],
    );
    expect(v.ok).toBe(false);
    expect(v.added).toEqual(['packages/server/src/zz-probe.ts']);
    expect(v.removed).toEqual([]);
  });

  it('passes the same change once the overview moves with it', () => {
    const v = judge(
      base,
      [...base, 'packages/server/src/zz-probe.ts'],
      ['packages/server/src/zz-probe.ts', OVERVIEW_DOC],
    );
    expect(v.ok).toBe(true);
    expect(v.ok && v.reason).toBe('documented');
    expect(v.added).toEqual(['packages/server/src/zz-probe.ts']);
  });

  it('fails on a removal, not only an addition', () => {
    const v = judge(
      base,
      ['packages/server/src/routes/tasks.ts'],
      ['packages/server/src/tasks.ts'],
    );
    expect(v.ok).toBe(false);
    expect(v.removed).toEqual(['packages/server/src/tasks.ts']);
  });

  it('reports a move into a directory as one removal and one addition', () => {
    const v = judge(
      ['packages/server/src/shells.ts'],
      ['packages/server/src/http/shells.ts'],
      ['packages/server/src/shells.ts', 'packages/server/src/http/shells.ts'],
    );
    expect(v.ok).toBe(false);
    expect(v.added).toEqual(['packages/server/src/http/']);
    expect(v.removed).toEqual(['packages/server/src/shells.ts']);
  });

  it('does not accept an unrelated doc edit as the update', () => {
    const v = judge(
      base,
      [...base, 'packages/server/src/zz-probe.ts'],
      ['docs/architecture/stall-detection.md'],
    );
    expect(v.ok).toBe(false);
  });
});
