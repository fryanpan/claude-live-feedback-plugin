import {
  type Change,
  type Chunk,
  type DiffConfig,
  getChunks,
  getOriginalDoc,
  presentableDiff,
  unifiedMergeView,
} from '@codemirror/merge';
import type { Extension, Text } from '@codemirror/state';
import { EditorView, GutterMarker, ViewPlugin, type ViewUpdate, gutter } from '@codemirror/view';

/**
 * PR-style extras layered onto @codemirror/merge's unified view:
 *  - an OLD-line-number gutter (base-commit numbering) next to the standard
 *    NEW-line-number gutter, GitHub style;
 *  - old line numbers stamped onto each deleted line inside the deletion
 *    widgets (they're widget DOM, not document lines, so no gutter reaches
 *    them — CSS renders the number from `data-old-line`).
 *
 * The editor document is the file at the TARGET commit; `original` is the
 * base text. Both are immutable here, so the chunk set is computed once.
 */

/**
 * A change the whitespace filter withheld from the chunk set: real textual
 * difference, deliberately not rendered. Offsets are in the same coordinates
 * as a Chunk's — `A` is the base document, `B` the target.
 */
/** Cap on @codemirror/merge's expensive exact diff; beyond it the library
 *  falls back to a coarser algorithm. */
export const DIFF_SCAN_LIMIT = 2000;

export interface HiddenRegion {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
}

/** Every whitespace run collapsed to one space, ends trimmed. Two texts that
 *  differ only in layout compare equal after this; a difference in any
 *  non-space character survives it. */
const squashWhitespace = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * Whether two texts differ only in layout — indentation, trailing space,
 * blank lines, CRLF.
 *
 * Whitespace-INSENSITIVE, not whitespace-BLIND: `a b` → `ab` removes a space
 * that separates two tokens, and comes back false. That distinction only
 * holds if callers pass whole LINES — see `expandToLines`.
 */
export function isWhitespaceOnlyChange(a: string, b: string): boolean {
  return squashWhitespace(a) === squashWhitespace(b);
}

/**
 * The full lines a character range touches.
 *
 * Classification MUST happen on these, never on the raw change slice.
 * `presentableDiff` reports `foo bar` → `foobar` as a change whose slices
 * are exactly `' '` and `''` — both of which squash to empty, so a
 * slice-level test calls a real code edit "whitespace" and the line vanishes
 * from the diff entirely. Verified: it rendered zero chunks before this.
 * The enclosing lines squash to `foo bar` vs `foobar`, which differ.
 *
 * Widening is also conservative in the right direction: when one line holds
 * both a real edit and a reindent, the line reads as changed and stays
 * visible. Showing noise is a nuisance; hiding a change is a bug.
 */
function expandToLines(s: string, from: number, to: number): string {
  const start = s.lastIndexOf('\n', Math.max(0, from - 1)) + 1;
  const nl = s.indexOf('\n', to);
  return s.slice(start, nl === -1 ? s.length : nl);
}

/**
 * Does a change begin inside a quoted span on its line?
 *
 * Whitespace inside a string literal is CONTENT — `"hello  world"` →
 * `"hello world"` changes what the program prints, and squashing runs makes
 * the two lines compare equal, so line expansion alone would hide it.
 * Telling a literal from formatting properly needs a parser per language;
 * this counts quote characters before the change instead.
 *
 * A heuristic, and deliberately a one-directional one: it can only ever
 * classify a change as NOT-whitespace, so its failure mode is showing a
 * reindent we could have hidden. Escaped quotes and apostrophes in prose
 * both land on that side. (git's own `-w`, and every "hide whitespace" diff
 * view built on it, simply gets this case wrong.)
 */
function startsInsideQuotes(s: string, at: number): boolean {
  const start = s.lastIndexOf('\n', Math.max(0, at - 1)) + 1;
  let quotes = 0;
  for (let i = start; i < at; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'" || ch === '`') quotes++;
  }
  return quotes % 2 === 1;
}

export interface WhitespaceFilter {
  /** Hand to `unifiedMergeView`/`Chunk.build` in place of a bare config. */
  diffConfig: DiffConfig;
  /**
   * Changes withheld on the last run, in document order. Each recompute
   * REPLACES this array rather than mutating it, so its identity is a valid
   * cache key (`oldLineForPos` memoizes on exactly that). Read it through the
   * filter; don't hold a reference across a recompute.
   */
  readonly hidden: readonly HiddenRegion[];
}

/**
 * A diff that leaves whitespace-only changes out of the chunk set.
 *
 * `DiffConfig.override` is the only seam @codemirror/merge offers — it has
 * no whitespace option of its own — so we run its own `presentableDiff` and
 * drop the changes that carry no content. Dropped changes are RECORDED
 * rather than discarded, because they still describe a real size difference
 * between the two documents and `oldLineForPos` has to account for it.
 *
 * `enabled: false` returns the stock config and an always-empty `hidden`,
 * so the toggle costs nothing and can't drift from the default behaviour.
 */
export function whitespaceFilter(opts: {
  scanLimit: number;
  enabled: boolean;
}): WhitespaceFilter {
  let hidden: readonly HiddenRegion[] = [];
  if (!opts.enabled) {
    return { diffConfig: { scanLimit: opts.scanLimit }, hidden };
  }
  const override = (a: string, b: string): readonly Change[] => {
    const next: HiddenRegion[] = [];
    const kept: Change[] = [];
    for (const c of presentableDiff(a, b, { scanLimit: opts.scanLimit })) {
      // Whole lines, not the slice — see expandToLines. Then the literal
      // guard, because inside a string a space IS content.
      const ok =
        isWhitespaceOnlyChange(
          expandToLines(a, c.fromA, c.toA),
          expandToLines(b, c.fromB, c.toB),
        ) &&
        !startsInsideQuotes(a, c.fromA) &&
        !startsInsideQuotes(b, c.fromB);
      if (ok) next.push({ fromA: c.fromA, toA: c.toA, fromB: c.fromB, toB: c.toB });
      else kept.push(c);
    }
    hidden = next;
    return kept;
  };
  return {
    diffConfig: { scanLimit: opts.scanLimit, override },
    get hidden() {
      return hidden;
    },
  };
}

type Region = HiddenRegion & { hidden: boolean };

const EMPTY_HIDDEN: readonly HiddenRegion[] = [];

// One-entry memo, keyed on the two source arrays by identity. The gutter
// calls oldLineForPos once PER VISIBLE LINE with the same arrays, and a
// reformatted file can carry thousands of suppressed regions — rebuilding
// and re-sorting that list per line is a per-frame cliff. Safe as an
// identity key because whitespaceFilter REPLACES `hidden` on each
// recompute rather than mutating it in place.
let memoChunks: readonly Chunk[] | null = null;
let memoHidden: readonly HiddenRegion[] | null = null;
let memoRegions: Region[] = [];

function mergedRegions(chunks: readonly Chunk[], hidden: readonly HiddenRegion[]): Region[] {
  if (chunks === memoChunks && hidden === memoHidden) return memoRegions;
  const regions: Region[] = [];
  for (const c of chunks) {
    regions.push({ fromA: c.fromA, toA: c.toA, fromB: c.fromB, toB: c.toB, hidden: false });
  }
  for (const h of hidden) {
    regions.push({ fromA: h.fromA, toA: h.toA, fromB: h.fromB, toB: h.toB, hidden: true });
  }
  regions.sort((x, y) => x.fromB - y.fromB);
  memoChunks = chunks;
  memoHidden = hidden;
  memoRegions = regions;
  return regions;
}

/** How many line breaks a character range covers in a document. */
function lineSpan(doc: Text, from: number, to: number): number {
  const a = doc.lineAt(Math.max(0, Math.min(from, doc.length))).number;
  const b = doc.lineAt(Math.max(0, Math.min(to, doc.length))).number;
  return b - a;
}

/**
 * Old-file line number for the line starting at `pos` in the new document,
 * or null when the line lies inside a changed chunk (an added/updated line
 * has no old number). Outside chunks the two texts are identical, so the
 * old position is the new position shifted by the accumulated size delta of
 * every chunk that ended earlier.
 *
 * `opts.hidden` carries the changes the whitespace filter suppressed. They
 * are NOT chunks — nothing renders them — but they are real size
 * differences, so leaving them out of the running delta makes every old
 * number after a reindent silently wrong. A position INSIDE one is
 * unchanged content wearing different indentation, so it keeps a base
 * number, mapped by counting lines rather than characters (the character
 * delta is exactly what's in dispute there).
 */
export function oldLineForPos(
  chunks: readonly Chunk[],
  original: Text,
  pos: number,
  opts?: { hidden?: readonly HiddenRegion[]; doc?: Text },
): number | null {
  const regions = mergedRegions(chunks, opts?.hidden ?? EMPTY_HIDDEN);

  let delta = 0;
  for (const r of regions) {
    if (r.toB <= pos) {
      delta += r.toA - r.fromA - (r.toB - r.fromB);
      continue;
    }
    if (pos >= r.fromB && pos < r.toB) {
      if (!r.hidden) return null;
      const doc = opts?.doc;
      if (!doc) return null;
      // Two kinds of suppressed change reach here, and only one is mappable:
      //
      //   reindent / trailing space — same number of lines on both sides, so
      //     line N of the region is line N of the base. Map it.
      //   blank line added or removed — the region's lines don't correspond
      //     one-to-one, and the added line exists in NO base revision. Blank,
      //     not a nearest-neighbour guess: repeating the line above asserts
      //     an identity that doesn't exist, and the entire value of this
      //     gutter is that a reviewer can trust it against the base commit.
      if (lineSpan(original, r.fromA, r.toA) !== lineSpan(doc, r.fromB, r.toB)) return null;
      const into = doc.lineAt(pos).number - doc.lineAt(r.fromB).number;
      return original.lineAt(Math.min(r.fromA, original.length)).number + into;
    }
    break;
  }
  const posA = pos + delta;
  if (posA < 0 || posA > original.length) return null;
  const line = original.lineAt(posA);
  // Only claim a base line when the mapped position IS that line's start.
  // For genuine context the two documents are identical from the previous
  // region's end through here, so it always is. When a suppressed change
  // added a line, the following line's start maps into the MIDDLE of a base
  // line instead — which is the tell that it has no base counterpart. Before
  // this guard such a line silently borrowed its neighbour's number.
  return line.from === posA ? line.number : null;
}

class OldLineMarker extends GutterMarker {
  constructor(readonly label: string) {
    super();
  }
  override eq(other: OldLineMarker): boolean {
    return other.label === this.label;
  }
  override toDOM(): Node {
    return document.createTextNode(this.label);
  }
}

/**
 * `filter` MUST be the same instance handed to `diffMergeExtensions` in this
 * extension list — the gutter reads the changes that view suppressed, and
 * two filters would each hold half the picture.
 */
export function oldLineNumberGutter(filter?: WhitespaceFilter): Extension {
  return gutter({
    class: 'cm-old-line-gutter',
    lineMarker(view, line) {
      const info = getChunks(view.state);
      if (!info) return null;
      const n = oldLineForPos(info.chunks, getOriginalDoc(view.state), line.from, {
        hidden: filter?.hidden,
        doc: view.state.doc,
      });
      return new OldLineMarker(n == null ? '' : String(n));
    },
    lineMarkerChange: () => false,
  });
}

/**
 * Stamp `data-old-line` onto every `.cm-deletedLine` inside each deletion
 * widget. Widgets are matched to chunks by document position (widgets sit
 * at their chunk's `fromB`), not DOM order, because off-viewport widgets
 * aren't in the DOM.
 */
const numberDeletedLines = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      requestAnimationFrame(() => this.stamp(view));
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged || u.geometryChanged) {
        requestAnimationFrame(() => this.stamp(u.view));
      }
    }
    stamp(view: EditorView): void {
      const info = getChunks(view.state);
      if (!info) return;
      const original = getOriginalDoc(view.state);
      const deleters = info.chunks.filter((c) => c.toA > c.fromA);
      for (const widget of view.dom.querySelectorAll('.cm-deletedChunk')) {
        let pos: number;
        try {
          pos = view.posAtDOM(widget as HTMLElement);
        } catch {
          continue;
        }
        const chunk = deleters.find((c) => Math.abs(c.fromB - pos) <= 1);
        if (!chunk) continue;
        let n = original.lineAt(Math.min(chunk.fromA, original.length)).number;
        for (const lineEl of widget.querySelectorAll('.cm-deletedLine')) {
          lineEl.setAttribute('data-old-line', String(n++));
        }
      }
    }
  },
);

export interface DiffViewConfig {
  /** The file's text at the base commit ('' for added files). */
  baseText: string;
  /** Collapse long unchanged stretches (diff mode). File mode passes false
   *  so the whole file shows, with added/changed lines still highlighted. */
  collapse?: boolean;
  /** Whitespace suppression. Share the instance with `oldLineNumberGutter`. */
  filter?: WhitespaceFilter;
}

/**
 * The merge machinery for diff mode (swapped in/out by the view toggle).
 * Gutter ORDER is the caller's job: put `oldLineNumberGutter()` before
 * `lineNumbers()` in the same extension list so the base numbering renders
 * left of the target numbering, GitHub style.
 */
export function diffMergeExtensions(cfg: DiffViewConfig): Extension[] {
  return [
    unifiedMergeView({
      original: cfg.baseText,
      mergeControls: false,
      ...(cfg.collapse !== false ? { collapseUnchanged: { margin: 3, minSize: 6 } } : {}),
      diffConfig: cfg.filter?.diffConfig ?? { scanLimit: DIFF_SCAN_LIMIT },
    }),
    numberDeletedLines,
  ];
}
