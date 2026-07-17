/**
 * Longest common subsequence over two keyed sequences.
 *
 * Extracted from `applyMarkdownToFragment` (prose.ts), which diffs a doc's
 * blocks so a reparse replaces only what changed — the property that keeps
 * thread anchors alive across a re-seed. The redline needs the same
 * computation twice more (over blocks, then over words), so it lives here
 * rather than being written a third time.
 */

/**
 * Returns the indices each side KEEPS — the elements participating in the
 * LCS. Anything not in the returned sets is a deletion (in `a`) or an
 * insertion (in `b`). Elements are compared with `===`, so callers key
 * non-primitives to strings first.
 *
 * Callers must bound `a.length * b.length` themselves; see `LCS_CELL_BUDGET`.
 */
export function lcsKept<T>(a: T[], b: T[]): { keptA: Set<number>; keptB: Set<number> } {
  const n = a.length;
  const m = b.length;
  const keptA = new Set<number>();
  const keptB = new Set<number>();
  if (n === 0 || m === 0) return { keptA, keptB };

  // Flat suffix table: lcs[i][j] = length of the LCS of a[i..] and b[j..].
  // Flat + Int32Array rather than nested arrays — this runs on every mtime
  // poll for every bound doc.
  const w = m + 1;
  const lcs = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * w + j + 1] + 1
          : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i] === b[j]) {
      keptA.add(i);
      keptB.add(j);
      i++;
      j++;
    } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return { keptA, keptB };
}

/**
 * Guard for the O(n·m) table. 2000x2000 is far past any real document — this
 * repo's review docs run 30–100 blocks. Past the budget a caller must degrade
 * deliberately (and say so), not silently build a table that stalls.
 */
export const LCS_CELL_BUDGET = 4_000_000;
