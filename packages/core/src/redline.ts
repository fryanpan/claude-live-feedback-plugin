/**
 * Word-style redline of one markdown document against another.
 *
 * Pure by design: the diff-review redline is DERIVED on every client from two
 * inputs that are already identical everywhere — the `content` Y.Text (CRDT,
 * converges by construction) and the base text (`git show <pinned-hash>:path`,
 * immutable). Same inputs + same pure function = same output, so every client
 * renders the same redline with no coordination and there is no redline state
 * to sync. That is the whole reason this is a function and not a document.
 *
 * Offsets reported here index the NEW side — i.e. the `content` Y.Text — which
 * is what lets a rendered position map back to a thread anchor.
 */
import { LCS_CELL_BUDGET, lcsKept } from './lcs.ts';

export type RedlineSegKind = 'same' | 'ins' | 'del';

export interface RedlineSegment {
  kind: RedlineSegKind;
  text: string;
  /** Offsets into the new side. Absent on 'del': deleted text has no position
   *  there, which is why a comment on it needs the deletedSnippet hint. */
  from?: number;
  to?: number;
}

interface Token {
  text: string;
  from: number;
}

/** Split into words AND whitespace runs. Keeping the whitespace as tokens is
 *  what lets the segments reassemble into the exact source rather than an
 *  approximation of it. */
function tokenize(s: string): Token[] {
  const out: Token[] = [];
  const re = /\s+|\S+/g;
  let m: RegExpExecArray | null = re.exec(s);
  while (m) {
    out.push({ text: m[0], from: m.index });
    m = re.exec(s);
  }
  return out;
}

/**
 * Word-level diff of `a` (base) against `b` (new).
 *
 * `same` + `del` reassembles into `a`; `same` + `ins` reassembles into `b`.
 * Offsets are into `b`, shifted by `bOffset` so a caller diffing a single
 * block gets whole-document offsets back.
 */
export function diffWords(a: string, b: string, bOffset = 0): RedlineSegment[] {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length === 0 && tb.length === 0) return [];

  // Past the budget, degrade to a whole-string replace rather than build a
  // table that would stall the browser. A single block this large is
  // pathological — but degrade loudly rather than silently mis-render.
  const overBudget = ta.length * tb.length > LCS_CELL_BUDGET;
  if (overBudget) {
    console.warn(
      `[redline] ${ta.length}x${tb.length} tokens exceeds the diff budget; ` +
        'falling back to a whole-block replace for this block',
    );
  }
  const { keptA, keptB } = overBudget
    ? { keptA: new Set<number>(), keptB: new Set<number>() }
    : lcsKept(
        ta.map((t) => t.text),
        tb.map((t) => t.text),
      );

  const out: RedlineSegment[] = [];
  const push = (kind: RedlineSegKind, text: string, from?: number): void => {
    const last = out[out.length - 1];
    // Merge adjacent runs of the same kind so the renderer emits one <ins> per
    // run rather than one per token.
    if (last && last.kind === kind) {
      last.text += text;
      if (kind !== 'del' && last.to != null) last.to += text.length;
      return;
    }
    if (kind === 'del') {
      out.push({ kind, text });
      return;
    }
    const start = (from ?? 0) + bOffset;
    out.push({ kind, text, from: start, to: start + text.length });
  };

  let i = 0;
  let j = 0;
  while (i < ta.length || j < tb.length) {
    const aKept = i < ta.length && keptA.has(i);
    const bKept = j < tb.length && keptB.has(j);
    if (aKept && bKept) {
      push('same', tb[j].text, tb[j].from);
      i++;
      j++;
      continue;
    }
    if (i < ta.length && !aKept) {
      push('del', ta[i].text);
      i++;
      continue;
    }
    if (j < tb.length && !bKept) {
      push('ins', tb[j].text, tb[j].from);
      j++;
      continue;
    }
    // Only reachable if one side is exhausted while the other still holds kept
    // tokens — impossible for a well-formed LCS, but don't spin.
    break;
  }
  return out;
}
