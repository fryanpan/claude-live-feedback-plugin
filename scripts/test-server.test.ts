/**
 * The parallel server-suite runner's own arithmetic.
 *
 * The three things that could go silently wrong here are all "ran less than
 * you think": a file the enumerator never found, a shard split that drops
 * one, and a coverage merge that keeps only the last chunk. The last of those
 * was a real bug in this file's first draft — every worker pointed at one
 * coverage directory, bun rewrote it per chunk, and the merged number came
 * out at 35.7% against a floor of 95 because it had measured a fraction of
 * the suite. So each of the three has a test that fails when it returns.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SUITE_DIR,
  discover,
  interleave,
  mergeLcov,
  nextChunkSize,
  planChunks,
  shardOf,
} from './test-server.ts';

const temps: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'test-server-'));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('discover', () => {
  it('finds a test file nothing has committed yet', () => {
    // The hole this exists to not repeat: `coverage` and `test:audit` both
    // enumerate with `git ls-files`, so a test file that is written but not
    // staged is invisible to them. `bun test <dir>` walks the filesystem, and
    // so must anything that replaces it — otherwise a builder's new test
    // silently does not run in the gate they ran to check it.
    const root = tmp();
    mkdirSync(join(root, 'suite'));
    writeFileSync(join(root, 'suite', 'brand-new.test.ts'), 'export {};');
    expect(discover(root, 'suite')).toEqual(['suite/brand-new.test.ts']);
  });

  it('takes the file shapes bun test takes, and leaves the helpers alone', () => {
    const root = tmp();
    mkdirSync(join(root, 'suite', 'nested'), { recursive: true });
    for (const name of [
      'a.test.ts',
      'b.test.tsx',
      'c_test.ts',
      'd.spec.ts',
      'e_spec.js',
      'harness.ts',
      'fixtures.json',
      'notes.test.md',
    ]) {
      writeFileSync(join(root, 'suite', name), '');
    }
    writeFileSync(join(root, 'suite', 'nested', 'deep.test.ts'), '');
    expect(discover(root, 'suite')).toEqual([
      'suite/a.test.ts',
      'suite/b.test.tsx',
      'suite/c_test.ts',
      'suite/d.spec.ts',
      'suite/e_spec.js',
      'suite/nested/deep.test.ts',
    ]);
  });

  it('finds the real suite, which is where the number in the header comes from', () => {
    expect(discover(process.cwd(), SUITE_DIR).length).toBeGreaterThan(300);
  });
});

describe('interleave', () => {
  const files = Array.from({ length: 50 }, (_, i) => `packages/server/test/f${i}.test.ts`);

  it('keeps every file, exactly once', () => {
    expect(interleave(files).slice().sort()).toEqual(files.slice().sort());
  });

  it('is the same order every time — a run must not depend on when it ran', () => {
    expect(interleave(files)).toEqual(interleave(files.slice().reverse()));
  });

  it('does not leave alphabetical neighbours adjacent', () => {
    // Why it exists: the slowest files in this suite are all `sse-*.test.ts`,
    // and sorted order puts them in one chunk.
    const order = interleave(files);
    const adjacent = order.filter((f, i) => {
      const n = (s: string) => Number(s.match(/f(\d+)/)?.[1]);
      return i > 0 && Math.abs((n(f) ?? 0) - (n(order[i - 1] ?? '') ?? 0)) === 1;
    });
    expect(adjacent.length).toBeLessThan(files.length / 3);
  });
});

describe('shardOf', () => {
  const files = Array.from({ length: 17 }, (_, i) => `f${i}.ts`);

  it('puts every file in exactly one shard', () => {
    const seen = [1, 2, 3].flatMap((i) => shardOf(files, i, 3));
    expect(seen.slice().sort()).toEqual(files.slice().sort());
  });

  it('spreads neighbours across shards rather than cutting the list in blocks', () => {
    expect(shardOf(files, 1, 3).slice(0, 3)).toEqual(['f0.ts', 'f3.ts', 'f6.ts']);
  });

  it('is empty, not wrong, when there are fewer files than shards', () => {
    expect(shardOf(['only.ts'], 2, 3)).toEqual([]);
  });
});

describe('nextChunkSize', () => {
  it('never returns zero, which would spin the worker loop forever', () => {
    for (const remaining of [1, 2, 3, 7]) {
      expect(nextChunkSize(remaining, 8)).toBeGreaterThan(0);
    }
  });

  it('shrinks as the queue drains, so nobody is left holding a long tail', () => {
    expect(nextChunkSize(400, 4)).toBe(50);
    expect(nextChunkSize(40, 4)).toBe(5);
    expect(nextChunkSize(4, 4)).toBe(1);
  });

  it('hands the whole queue out in a finite number of chunks', () => {
    let remaining = 412;
    let chunks = 0;
    while (remaining > 0) {
      remaining -= nextChunkSize(remaining, 8);
      chunks++;
      expect(chunks).toBeLessThan(1000);
    }
    expect(remaining).toBe(0);
  });
});

describe('planChunks', () => {
  const files = Array.from({ length: 100 }, (_, i) => `f${i}.ts`);

  it('decides the grouping before anything runs, not as workers grab', () => {
    // Which worker picks a chunk up may depend on machine speed. Which files
    // are in a chunk must not: each chunk is its own bun process, so a
    // timing-dependent split would run the same commit's tests in different
    // company on two runs, and a file that only passes beside (or apart from)
    // another would fail intermittently with nothing to say why.
    expect(planChunks(files, 4)).toEqual(planChunks(files, 4));
  });

  it('covers every file, in order, exactly once', () => {
    expect(planChunks(files, 8).flat()).toEqual(files);
  });

  it('starts big and ends at single files', () => {
    const chunks = planChunks(files, 4);
    expect(chunks[0]?.length).toBe(12);
    expect(chunks[chunks.length - 1]?.length).toBe(1);
  });

  it('is one chunk when there is one file', () => {
    expect(planChunks(['only.ts'], 8)).toEqual([['only.ts']]);
  });

  it('is empty for an empty suite rather than looping', () => {
    expect(planChunks([], 4)).toEqual([]);
  });
});

describe('mergeLcov', () => {
  const record = (file: string, hits: number) => `TN:\nSF:${file}\nDA:1,${hits}\nend_of_record\n`;

  it('keeps every chunk, not just the last one', () => {
    // The bug this is here for: one coverage directory per WORKER meant bun
    // overwrote it on every chunk, and the merge silently kept a fraction of
    // the suite. Two chunks in, two records out.
    const root = tmp();
    const dirs = ['chunk-1', 'chunk-2'].map((d) => join(root, d));
    dirs.forEach((d, i) => {
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'lcov.info'), record(`packages/server/src/f${i}.ts`, 1));
    });
    const out = join(root, 'merged');
    expect(mergeLcov(dirs, out)).toBe(2);
    const merged = readFileSync(join(out, 'lcov.info'), 'utf8');
    expect(merged).toContain('packages/server/src/f0.ts');
    expect(merged).toContain('packages/server/src/f1.ts');
  });

  it('counts only the chunks that actually produced one', () => {
    // The caller compares this count against the chunks it ran and fails on a
    // mismatch — a chunk that wrote no lcov must not merge as a silent zero.
    const root = tmp();
    const present = join(root, 'chunk-1');
    mkdirSync(present, { recursive: true });
    writeFileSync(join(present, 'lcov.info'), record('packages/server/src/a.ts', 1));
    expect(mergeLcov([present, join(root, 'chunk-2')], join(root, 'out'))).toBe(1);
  });
});
