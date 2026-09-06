/**
 * The coverage gate's own arithmetic.
 *
 * A gate that reports the wrong number is worse than no gate: it ratchets
 * against a fiction and nobody re-derives it. These drive the parsing and the
 * summing on fixed input, so the join between two different tools' lcov — the
 * part with no other check on it — has one.
 */
import { describe, expect, it } from 'vitest';
import {
  DENOMINATOR,
  TARGET_PCT,
  codeLines,
  parseLcov,
  summarize,
  worstFiles,
} from './coverage.ts';

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
      'workspaces-app:vitest',
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

describe('the denominator a shard cannot move', () => {
  /** The lines a runner claims for a file, as an lcov record. */
  const claim = (file: string, from: number, to: number, hits: number) =>
    record(
      file,
      Array.from({ length: to - from + 1 }, (_, i): [number, number] => [from + i, hits]),
    );

  const filesOf = (pkg: string) =>
    (summarize({ vitest: '', bun: '' }).find((p) => p.package === pkg)?.files ?? []).map(
      (f) => f.file,
    );

  it('names where each runner’s denominator comes from', () => {
    expect(DENOMINATOR.vitest).toBe('lcov');
    expect(DENOMINATOR.bun).toBe('source');
  });

  it('does not move a bun package’s denominator when the tool reports more lines', () => {
    // The measurement behind this: `bun test --coverage` reports the lines it
    // learned about while running, so middleware/host-guard.ts came back with
    // 298 lines from one run of the suite and 660 from the union of the same
    // suite run in chunks — with the identical 295 hit both times. A floor
    // over that denominator is a gate on how the suite was SCHEDULED. Two
    // views of one execution must therefore produce one number.
    const files = filesOf('server').slice(0, 20);
    const narrow = files.map((f) => claim(f, 1, 10, 1)).join('');
    const wide = narrow + files.map((f) => claim(f, 11, 60, 0)).join('');

    const of = (bun: string) => summarize({ vitest: '', bun }).find((p) => p.package === 'server');
    expect(of(wide)?.linesFound).toBe(of(narrow)?.linesFound);
    expect(of(wide)?.linesHit).toBe(of(narrow)?.linesHit);
    expect(of(wide)?.pct).toBe(of(narrow)?.pct);
  });

  it('still counts the hits a shard found, wherever the shard found them', () => {
    const files = filesOf('server').slice(0, 5);
    // Two shards, disjoint line ranges: the union is what ran.
    const shardA = files.map((f) => claim(f, 1, 10, 1)).join('');
    const shardB = files.map((f) => claim(f, 11, 20, 1)).join('');
    const merged = summarize({ vitest: '', bun: shardA + shardB }).find(
      (p) => p.package === 'server',
    );
    const alone = summarize({ vitest: '', bun: shardA }).find((p) => p.package === 'server');
    expect(merged?.linesHit).toBe((alone?.linesHit ?? 0) + files.length * 10);
  });

  it('leaves a vitest package reading its own instrumentation', () => {
    // Vitest’s `all: true` denominator is a property of the source, so it is
    // already stable across shards — measured 2026-09-06, four shards merged
    // report every package to the line. Nothing here reaches in to change it.
    const files = filesOf('core');
    const cold = summarize({ vitest: files.map((f) => claim(f, 1, 3, 0)).join(''), bun: '' }).find(
      (p) => p.package === 'core',
    );
    expect(cold?.linesFound).toBe(files.length * 3);
  });

  it('cannot report more than 100%, whatever the two counting rules disagree about', () => {
    const files = filesOf('server').slice(0, 3);
    // Every line of a huge range hit: more lines than the sources have.
    const absurd = files.map((f) => claim(f, 1, 100000, 1)).join('');
    const pkg = summarize({ vitest: '', bun: absurd }).find((p) => p.package === 'server');
    expect(pkg?.pct).toBeLessThanOrEqual(100);
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
