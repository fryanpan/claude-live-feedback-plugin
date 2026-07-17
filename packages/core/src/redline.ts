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
import {
  type MarkdownBlockSpan,
  type MarkdownBlockType,
  splitMarkdownBlocks,
} from './markdown-blocks.ts';

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

export interface RedlineBlock {
  kind: 'same' | 'ins' | 'del' | 'changed';
  type: MarkdownBlockType;
  segments: RedlineSegment[];
  /** New-side source span. Absent on 'del' blocks — they exist only on base. */
  from?: number;
  to?: number;
  /** Anchor target for a comment on a 'del' block: the nearest FOLLOWING
   *  new-side offset. Present only on 'del' blocks. */
  snapTo?: number;
}

/**
 * Extend an offset range to whole-line boundaries within `text`.
 *
 * The flat-surface twin of code-anchor.ts's `snapToLines`, which needs a
 * CodeMirror EditorState. This one works on the raw string, so core can
 * line-snap without a view — matching the line-snapping the server's
 * `createThreadByFind` flat branch does.
 */
export function snapOffsetsToLines(
  text: string,
  from: number,
  to: number,
): { from: number; to: number } {
  const lo = Math.max(0, Math.min(from, to, text.length));
  const hi = Math.max(0, Math.min(Math.max(from, to), text.length));
  const start = text.lastIndexOf('\n', Math.max(0, lo - 1)) + 1;
  const nl = text.indexOf('\n', hi);
  const end = nl === -1 ? text.length : nl;
  return { from: start, to: end };
}

/** Token overlap ratio — cheap, and enough to answer "did this paragraph
 *  BECOME that paragraph, or is it a different paragraph entirely?".
 *
 *  Tokenized on word characters, NOT on whitespace: with punctuation attached,
 *  "One." and "One changed." share no token at all, scoring 0 and splitting an
 *  obvious edit into a delete plus an add. Punctuation must not decide whether
 *  two paragraphs are the same paragraph. (diffWords keeps punctuation
 *  attached — that's display, and there it's correct.) */
function similarity(a: string, b: string): number {
  const wa = a.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const wb = b.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (wa.length === 0 && wb.length === 0) return 1;
  if (wa.length === 0 || wb.length === 0) return 0;
  const pool = new Map<string, number>();
  for (const w of wa) pool.set(w, (pool.get(w) ?? 0) + 1);
  let hits = 0;
  for (const w of wb) {
    const n = pool.get(w) ?? 0;
    if (n > 0) {
      hits++;
      pool.set(w, n - 1);
    }
  }
  return (2 * hits) / (wa.length + wb.length);
}

/**
 * Untuned. Above this, two blocks of the same kind are treated as an edit of
 * one into the other (word-diffed); below, as a delete plus an add. This
 * threshold is a judgment call with no principled value — it has not been
 * tuned against a corpus.
 */
export const PAIR_SIMILARITY_THRESHOLD = 0.35;

/** Blocks are only word-diffed against each other when they're the same kind
 *  AND the change isn't structural. A heading's level and a fence's content
 *  live in the source text, so word-diffing `## X` against `### X` would show
 *  the reviewer marker noise instead of the real change. Word does the same:
 *  structural changes render as delete + insert. */
function pairable(a: MarkdownBlockSpan, b: MarkdownBlockSpan): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'codeBlock' || a.type === 'table' || a.type === 'horizontalRule') return false;
  if (a.type === 'heading') {
    const la = /^#+/.exec(a.text)?.[0].length ?? 0;
    const lb = /^#+/.exec(b.text)?.[0].length ?? 0;
    if (la !== lb) return false;
  }
  return similarity(a.text, b.text) >= PAIR_SIMILARITY_THRESHOLD;
}

const asSame = (b: MarkdownBlockSpan): RedlineBlock => ({
  kind: 'same',
  type: b.type,
  segments: [{ kind: 'same', text: b.text, from: b.from, to: b.to }],
  from: b.from,
  to: b.to,
});
const asIns = (b: MarkdownBlockSpan): RedlineBlock => ({
  kind: 'ins',
  type: b.type,
  segments: [{ kind: 'ins', text: b.text, from: b.from, to: b.to }],
  from: b.from,
  to: b.to,
});
const asDel = (a: MarkdownBlockSpan): RedlineBlock => ({
  kind: 'del',
  type: a.type,
  segments: [{ kind: 'del', text: a.text }],
});
const asChanged = (a: MarkdownBlockSpan, b: MarkdownBlockSpan): RedlineBlock => ({
  kind: 'changed',
  type: b.type,
  segments: diffWords(a.text, b.text, b.from),
  from: b.from,
  to: b.to,
});

/**
 * Word-style redline of `baseMd` against `newMd`.
 *
 * Offsets on 'same' / 'ins' / 'changed' blocks index into `newMd` — i.e. into
 * the `content` Y.Text.
 */
export function computeRedline(baseMd: string, newMd: string): RedlineBlock[] {
  const baseBlocks = splitMarkdownBlocks(baseMd);
  const newBlocks = splitMarkdownBlocks(newMd);

  const { keptA, keptB } = lcsKept(
    baseBlocks.map((b) => b.text),
    newBlocks.map((b) => b.text),
  );

  const out: RedlineBlock[] = [];
  let i = 0;
  let j = 0;
  while (i < baseBlocks.length || j < newBlocks.length) {
    if (i < baseBlocks.length && keptA.has(i) && j < newBlocks.length && keptB.has(j)) {
      out.push(asSame(newBlocks[j]));
      i++;
      j++;
      continue;
    }
    // Collect the run of unmatched blocks on each side — the "gap" — and pair
    // within it.
    const gapA: MarkdownBlockSpan[] = [];
    const gapB: MarkdownBlockSpan[] = [];
    while (i < baseBlocks.length && !keptA.has(i)) gapA.push(baseBlocks[i++]);
    while (j < newBlocks.length && !keptB.has(j)) gapB.push(newBlocks[j++]);
    if (gapA.length === 0 && gapB.length === 0) break; // no progress — bail
    out.push(...pairGap(gapA, gapB));
  }

  // A deleted block has no new-side position, so a comment on it snaps to the
  // nearest FOLLOWING new-side offset. Backward pass: the target is the next
  // later block that has one, or the end of the document.
  let nextFrom = newMd.replace(/\r\n/g, '\n').length;
  for (let k = out.length - 1; k >= 0; k--) {
    const b = out[k];
    if (b.from != null) {
      nextFrom = b.from;
      continue;
    }
    b.snapTo = nextFrom;
  }
  return out;
}

/** Within one gap, decide which base blocks BECAME which new blocks (word-diff
 *  them) versus which were simply deleted or added (show whole). Greedy
 *  best-match; a gap holds a handful of blocks, so optimal assignment isn't
 *  worth it. Deletions are emitted before the new-side blocks so the removal
 *  reads above its replacement, as Word does. */
function pairGap(gapA: MarkdownBlockSpan[], gapB: MarkdownBlockSpan[]): RedlineBlock[] {
  const usedA = new Set<number>();
  const matchFor = new Map<number, number>(); // gapB index -> gapA index
  for (let bi = 0; bi < gapB.length; bi++) {
    let best = -1;
    let bestScore = 0;
    for (let ai = 0; ai < gapA.length; ai++) {
      if (usedA.has(ai)) continue;
      if (!pairable(gapA[ai], gapB[bi])) continue;
      const score = similarity(gapA[ai].text, gapB[bi].text);
      if (score > bestScore) {
        bestScore = score;
        best = ai;
      }
    }
    if (best >= 0) {
      usedA.add(best);
      matchFor.set(bi, best);
    }
  }
  const out: RedlineBlock[] = [];
  for (let ai = 0; ai < gapA.length; ai++) {
    if (!usedA.has(ai)) out.push(asDel(gapA[ai]));
  }
  for (let bi = 0; bi < gapB.length; bi++) {
    const ai = matchFor.get(bi);
    out.push(ai == null ? asIns(gapB[bi]) : asChanged(gapA[ai], gapB[bi]));
  }
  return out;
}
