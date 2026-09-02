/**
 * The coverage gate's own arithmetic.
 *
 * A gate that reports the wrong number is worse than no gate: it ratchets
 * against a fiction and nobody re-derives it. These drive the parsing and the
 * summing on fixed input, so the join between two different tools' lcov — the
 * part with no other check on it — has one.
 */
import { describe, expect, it } from 'vitest';
import { TARGET_PCT, codeLines, parseLcov, summarize, worstFiles } from './coverage.ts';

const record = (file: string, das: Array<[number, number]>) =>
  `TN:\nSF:${file}\n${das.map(([n, h]) => `DA:${n},${h}`).join('\n')}\nend_of_record\n`;

describe('parseLcov', () => {
  it('reads a record into line → hits', () => {
    const files = parseLcov(
      record('packages/core/src/a.ts', [
        [1, 3],
        [2, 0],
      ]),
    );
    expect([...(files.get('packages/core/src/a.ts') ?? [])]).toEqual([
      [1, 3],
      [2, 0],
    ]);
  });

  it('merges two records for the same file, keeping the higher hit count', () => {
    // v8 emits one record per file, bun can emit several. A line covered in
    // either view is covered; taking the last record would silently discard
    // the first one's hits.
    const files = parseLcov(
      record('packages/core/src/a.ts', [
        [1, 0],
        [2, 5],
      ]) +
        record('packages/core/src/a.ts', [
          [1, 7],
          [2, 0],
        ]),
    );
    expect([...(files.get('packages/core/src/a.ts') ?? [])]).toEqual([
      [1, 7],
      [2, 5],
    ]);
  });

  it('makes an absolute path repo-relative, so both tools key the same', () => {
    const abs = `${process.cwd()}/packages/core/src/a.ts`;
    const files = parseLcov(record(abs, [[1, 1]]));
    expect([...files.keys()]).toEqual(['packages/core/src/a.ts']);
  });

  it('ignores the counters it does not use, and a malformed DA line', () => {
    const files = parseLcov(
      'TN:\nSF:packages/core/src/a.ts\nFNF:3\nFNH:1\nDA:x,1\nDA:4,2\nLF:1\nLH:1\nend_of_record\n',
    );
    expect([...(files.get('packages/core/src/a.ts') ?? [])]).toEqual([[4, 2]]);
  });
});

describe('codeLines — the stand-in for a file no tool ever loaded', () => {
  it('counts lines that could carry code and nothing else', () => {
    expect(
      codeLines(
        ['/**', ' * A doc comment.', ' */', '', '// a note', 'const a = 1;', 'export { a };'].join(
          '\n',
        ),
      ),
    ).toBe(2);
  });

  it('does not let a single-line block comment open a block', () => {
    expect(codeLines(['/* one line */', 'const a = 1;'].join('\n'))).toBe(1);
  });

  it('is zero for a file with nothing in it', () => {
    expect(codeLines('')).toBe(0);
    expect(codeLines('\n\n\n')).toBe(0);
  });
});

describe('summarize', () => {
  /** Every real source file of a package, measured, so the shape is the real
   *  one — the fixture below only has to be a subset of it. */
  const lcovFor = (files: string[], covered: boolean) =>
    files
      .map((f) =>
        record(f, [
          [1, covered ? 1 : 0],
          [2, covered ? 1 : 0],
        ]),
      )
      .join('');

  it('attributes each package to exactly one runner', () => {
    // The server suite is bun's and vitest cannot see it; measuring server
    // sources from the vitest lcov would report the package as untested.
    const packages = summarize({ vitest: '', bun: '' });
    expect(packages.map((p) => `${p.package}:${p.runner}`)).toEqual([
      'core:vitest',
      'markdown-app:vitest',
      'mcp:vitest',
      'widget:vitest',
      'server:bun',
    ]);
  });

  it('counts a source file no lcov mentions as zero, never as absent', () => {
    // The failure this stops: a denominator built from the coverage report
    // itself can only contain files somebody already tested, so it can only
    // ever read 100%.
    const packages = summarize({ vitest: '', bun: '' });
    for (const p of packages) {
      expect(p.linesFound).toBeGreaterThan(0);
      expect(p.linesHit).toBe(0);
      expect(p.pct).toBe(0);
      expect(p.files.every((f) => f.neverImported)).toBe(true);
    }
  });

  it('reads a package’s hits only from its own runner’s lcov', () => {
    const core = summarize({ vitest: '', bun: '' }).find((p) => p.package === 'core');
    const files = (core?.files ?? []).map((f) => f.file);
    // The same records, offered to the wrong runner, must change nothing.
    const wrongRunner = summarize({ vitest: '', bun: lcovFor(files, true) }).find(
      (p) => p.package === 'core',
    );
    expect(wrongRunner?.linesHit).toBe(0);
    const rightRunner = summarize({ vitest: lcovFor(files, true), bun: '' }).find(
      (p) => p.package === 'core',
    );
    expect(rightRunner?.linesHit).toBe(files.length * 2);
    expect(rightRunner?.pct).toBe(100);
  });

  it('counts a line as hit only when somebody ran it', () => {
    const core = summarize({ vitest: '', bun: '' }).find((p) => p.package === 'core');
    const files = (core?.files ?? []).map((f) => f.file);
    const cold = summarize({ vitest: lcovFor(files, false), bun: '' }).find(
      (p) => p.package === 'core',
    );
    expect(cold?.linesFound).toBe(files.length * 2);
    expect(cold?.linesHit).toBe(0);
  });
});

describe('worstFiles', () => {
  const pkg = (files: Array<[string, number, number]>) => ({
    package: 'x',
    runner: 'vitest' as const,
    linesFound: 0,
    linesHit: 0,
    pct: 0,
    files: files.map(([file, hit, found]) => ({ file, hit, found, neverImported: false })),
  });

  it('lists the least-covered first and stops at ten', () => {
    const many = Array.from({ length: 14 }, (_, i): [string, number, number] => [
      `f${i}.ts`,
      i,
      100,
    ]);
    const worst = worstFiles(pkg(many));
    expect(worst).toHaveLength(10);
    expect(worst[0]?.file).toBe('f0.ts');
    expect(worst[9]?.file).toBe('f9.ts');
  });

  it('breaks a tie by size — the bigger gap is the one worth reading', () => {
    const worst = worstFiles(
      pkg([
        ['small.ts', 0, 10],
        ['big.ts', 0, 900],
      ]),
    );
    expect(worst.map((f) => f.file)).toEqual(['big.ts', 'small.ts']);
  });

  it('leaves out files already over the bar, and files with nothing in them', () => {
    const worst = worstFiles(
      pkg([
        ['good.ts', 95, 100],
        ['empty.ts', 0, 0],
        ['bad.ts', 1, 100],
      ]),
    );
    expect(worst.map((f) => f.file)).toEqual(['bad.ts']);
    expect(TARGET_PCT).toBe(80);
  });
});
