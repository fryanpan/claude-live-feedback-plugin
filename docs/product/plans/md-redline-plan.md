# Markdown Redline in Diff Review — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render `.md` files in a diff review as Word-style tracked changes — prose rendered as prose, with removed words struck through and added words underlined inline — with comments working on that surface.

**Architecture:** The doc stays flat (`type: 'diff'`, `contentKind` = `'flat'`, content in `ydoc.getText('content')`). The redline is *derived client-side* as a pure function of `content` (CRDT-synced) and `baseText` (REST, pinned to a commit hash → immutable). Nothing about the redline is stored or synced; identical inputs on every client produce identical output. A read-only Tiptap view renders it, and block-level provenance attributes carry rendered positions back to `content` offsets so threads stay byte-identical to the ones the source diff view creates.

**Tech Stack:** TypeScript (strict), Bun, Yjs, Tiptap 3 / ProseMirror, tiptap-markdown, vitest + happy-dom, biome.

**Spec:** `docs/superpowers/specs/2026-07-16-markdown-redline-diff-design.md`

## Global Constraints

- TypeScript strict mode. No `any` — the repo uses `unknown` + narrowing.
- **No new dependencies in `packages/core`.** Core depends only on `lib0`, `y-protocols`, `yjs`. The word diff and LCS are hand-rolled — consistent with the existing hand-rolled LCS in `applyMarkdownToFragment`.
- Tests: `bun run test:vitest` (vitest, happy-dom, `packages/*/test/**/*.test.ts`) and `bun run test:server` (`bun test packages/server/test`). CI job is `verify`. **Do not run `bun test` against vitest suites** — they need happy-dom; that mistake produced a false-positive review finding on PR #63.
- Lint/format: `bun run lint` (biome). Typecheck: `bun run typecheck`.
- Mobile is load-bearing — verify at 430px per `docs/product/design-mobile.md`.
- Plain ASCII sentinels only. A NUL byte written into source once made `prose.ts` read as binary to grep (`docs/process/learnings.md`).
- **Never `Write`/`Edit` a bound `.md`.** The spec doc for this work is bound to live-feedback (`md-redline-diff-design`); route any edit to it through the LF MCP tools.
- Threads on diff docs anchor **line-snapped** into `content`. Every anchor this feature creates must be byte-identical to what `code-editor.ts` `getSelectionRel()` produces for the same lines.

## Refinement of the spec (read this before Task 5)

The spec describes the provenance map as per-segment. Implementation refines it to **per-block (and per-list-item)**, because anchors are line-snapped anyway: a word-precise offset would be snapped back to its line immediately, so segment-level provenance buys nothing and costs the ability to render inline markdown (bold, links) inside changed text. Word-level precision is preserved in *what you see*; anchor precision is block/line — exactly matching the source diff view. This is a strict simplification, not a capability loss.

## File Structure

**Create:**
- `packages/core/src/lcs.ts` — generic LCS kept-index computation, extracted from `prose.ts`.
- `packages/core/src/markdown-blocks.ts` — pure markdown → block spans with source offsets.
- `packages/core/src/redline.ts` — `diffWords`, `computeRedline`, `snapOffsetsToLines`.
- `packages/markdown-app/src/redline/redline-marks.ts` — `RedlineIns` / `RedlineDel` marks + `RedlineProvenance` global attribute extension.
- `packages/markdown-app/src/redline/redline-markdown.ts` — `RedlineBlock[]` → annotated markdown string.
- `packages/markdown-app/src/redline/redline-editor.ts` — the read-only Tiptap surface implementing `ReviewSurface`.
- `packages/markdown-app/src/redline/redline-app.ts` — boot path (mirrors `code/code-app.ts`).

**Modify:**
- `packages/core/src/prose.ts:663-745` — `applyMarkdownToFragment` uses the extracted LCS.
- `packages/core/src/index.ts` — export the new modules.
- `packages/core/src/types.ts:148-155` — add `deletedSnippet?` to `TextRangeAnchor`.
- `packages/server/src/rooms.ts` — accept/persist `deletedSnippet` on thread create.
- `packages/server/src/server.ts` — forward `deletedSnippet` through the thread route.
- `packages/markdown-app/src/app.ts:101` — branch `.md` diff docs to the redline boot.
- `packages/markdown-app/src/styles.css` — `ins`/`del` styling, mobile.
- `packages/markdown-app/index.html` — third view-toggle button.

---

### Task 0: Verify the markdown → Tiptap pipeline preserves `<ins>` / `<del>` and data attributes

The whole rendering approach assumes tiptap-markdown passes inline HTML through and that a global attribute can round-trip via `data-*`. If it doesn't, Tasks 5-7 need a different renderer (programmatic ProseMirror JSON). **Find out first — this is the plan's biggest unknown.**

**Files:**
- Test: `packages/markdown-app/test/redline-pipeline.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a go/no-go answer. If this task fails, STOP and report before starting Task 1.

- [ ] **Step 1: Write the probe test**

```ts
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { Mark } from '@tiptap/core';
import { describe, expect, it } from 'vitest';

const Ins = Mark.create({
  name: 'redlineIns',
  parseHTML: () => [{ tag: 'ins' }],
  renderHTML: () => ['ins', {}, 0],
});
const Del = Mark.create({
  name: 'redlineDel',
  parseHTML: () => [{ tag: 'del' }],
  renderHTML: () => ['del', {}, 0],
});

describe('redline render pipeline', () => {
  it('passes inline <ins>/<del> through markdown into marks, keeping inner markdown', () => {
    const editor = new Editor({
      extensions: [StarterKit.configure({ undoRedo: false }), Markdown, Ins, Del],
      content: '',
    });
    editor.commands.setContent(
      '## A <del>stale</del><ins>**fresh**</ins> heading\n\nBody text.\n',
      { emitUpdate: false },
    );
    const html = editor.getHTML();
    expect(html).toContain('<del>stale</del>');
    expect(html).toContain('<ins>');
    // The markdown INSIDE the ins tag must still be parsed as a mark.
    expect(html).toContain('<strong>fresh</strong>');
    expect(html).toContain('<h2>');
    editor.destroy();
  });

  it('round-trips a data-* attribute on a block node via a global attribute', () => {
    const Provenance = Mark.create({ name: 'noop' }); // placeholder; see Step 3
    void Provenance;
    const editor = new Editor({
      extensions: [
        StarterKit.configure({ undoRedo: false }),
        Markdown,
        // Global attribute under test.
        (await import('../src/redline/redline-marks.ts')).RedlineProvenance,
      ],
      content: '',
    });
    editor.commands.setContent('<p data-lf-from="12" data-lf-to="40">Body.</p>', {
      emitUpdate: false,
    });
    const node = editor.state.doc.child(0);
    expect(node.attrs.lfFrom).toBe(12);
    expect(node.attrs.lfTo).toBe(40);
    editor.destroy();
  });
});
```

- [ ] **Step 2: Run it and observe**

Run: `bunx vitest run packages/markdown-app/test/redline-pipeline.test.ts`
Expected: the first test's outcome is the finding. The second FAILS (module doesn't exist) — that's fine, it's covered by Task 5.

- [x] **Step 3: Record the finding**

**RESOLVED 2026-07-16 — the gate PASSES. The rendering approach is verified.** Two findings that bind the tasks below:

1. **`<del>` must outrank StarterKit's Strike mark.** Strike's own `parseHTML` claims `del` (alongside `s` and `strike`) at the default priority of 50, so a plain `{ tag: 'del' }` rule LOSES and every deletion silently renders as ordinary strikethrough — visually near-identical, so this would not have been caught by eye. `RedlineDel` must use `parseHTML: () => [{ tag: 'del', priority: 60 }]` (Task 7). Do NOT fix this by disabling Strike: real `~~strikethrough~~` in the source must still render as itself.
2. **Inline markdown inside the wrapper parses.** Verified output:
   `<h2>A <del class="lf-del">stale</del><strong><ins class="lf-ins">fresh</ins></strong> heading</h2>`
   — the block marker stays literal, and `**fresh**` inside the `<ins>` becomes `<strong>`. Mark nesting order (`<strong><ins>` vs `<ins><strong>`) is ProseMirror's call and is cosmetically irrelevant. Lists behave the same way.

Retained for context: had it failed (inline HTML stripped, or inner markdown not parsed), the fallback was building ProseMirror JSON directly in `redline-markdown.ts` and parsing inline markdown per segment — a larger Task 6, costing inline-formatting fidelity inside changed text.

- [ ] **Step 4: Commit the probe**

```bash
git add packages/markdown-app/test/redline-pipeline.test.ts
git commit -m "test(redline): probe markdown->tiptap pipeline for ins/del passthrough"
```

---

### Task 1: Extract the LCS from `applyMarkdownToFragment`

`computeRedline` needs the same LCS twice (blocks, then words). Extract it rather than writing a third copy. `applyMarkdownToFragment` is load-bearing for thread anchors — the existing tests are the gate.

**Files:**
- Create: `packages/core/src/lcs.ts`
- Test: `packages/core/test/lcs.test.ts`
- Modify: `packages/core/src/prose.ts:703-731`, `packages/core/src/index.ts`

**Interfaces:**
- Produces: `lcsKept<T>(a: T[], b: T[]): { keptA: Set<number>; keptB: Set<number> }` — indices of the longest common subsequence, compared with `===`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { lcsKept } from '../src/lcs.ts';

describe('lcsKept', () => {
  it('keeps everything when the sequences are identical', () => {
    const { keptA, keptB } = lcsKept(['a', 'b', 'c'], ['a', 'b', 'c']);
    expect([...keptA].sort()).toEqual([0, 1, 2]);
    expect([...keptB].sort()).toEqual([0, 1, 2]);
  });

  it('keeps nothing when the sequences are disjoint', () => {
    const { keptA, keptB } = lcsKept(['a'], ['z']);
    expect(keptA.size).toBe(0);
    expect(keptB.size).toBe(0);
  });

  it('finds the common subsequence around an insertion', () => {
    const { keptA, keptB } = lcsKept(['a', 'c'], ['a', 'b', 'c']);
    expect([...keptA].sort()).toEqual([0, 1]);
    expect([...keptB].sort()).toEqual([0, 2]);
  });

  it('finds the common subsequence around a deletion', () => {
    const { keptA, keptB } = lcsKept(['a', 'b', 'c'], ['a', 'c']);
    expect([...keptA].sort()).toEqual([0, 2]);
    expect([...keptB].sort()).toEqual([0, 1]);
  });

  it('handles empty input on either side', () => {
    expect(lcsKept([], ['a']).keptA.size).toBe(0);
    expect(lcsKept(['a'], []).keptB.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run packages/core/test/lcs.test.ts`
Expected: FAIL — cannot resolve `../src/lcs.ts`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/lcs.ts` — this is the table + traceback lifted verbatim from `prose.ts:705-731`, with the Yjs specifics left behind:

```ts
/**
 * Longest common subsequence over two keyed sequences.
 *
 * Returns the indices each side KEEPS — i.e. the elements that participate in
 * the LCS. Everything not in the returned sets is a deletion (in `a`) or an
 * insertion (in `b`).
 *
 * Flat Int32Array suffix table: lcs[i][j] = length of the LCS of a[i..] and
 * b[j..]. Callers are responsible for bounding n*m; see `LCS_CELL_BUDGET`.
 */
export function lcsKept<T>(a: T[], b: T[]): { keptA: Set<number>; keptB: Set<number> } {
  const n = a.length;
  const m = b.length;
  const keptA = new Set<number>();
  const keptB = new Set<number>();
  if (n === 0 || m === 0) return { keptA, keptB };

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

/** Guard for the O(n·m) table. 2000x2000 is far past any real document. */
export const LCS_CELL_BUDGET = 4_000_000;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run packages/core/test/lcs.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Refactor `applyMarkdownToFragment` to use it**

In `packages/core/src/prose.ts`, add to the imports at the top of the file:

```ts
import { LCS_CELL_BUDGET, lcsKept } from './lcs.ts';
```

Replace the budget guard and the whole LCS block (`prose.ts:693-731`, from `if (prevKeys.length * nextKeys.length > 4_000_000) {` through the traceback `for` loop) with:

```ts
  if (prevKeys.length * nextKeys.length > LCS_CELL_BUDGET) {
    console.warn(
      `[prose] ${prevKeys.length}→${nextKeys.length} blocks exceeds the diff budget; ` +
        'falling back to a destructive replace — thread anchors in this doc will orphan',
    );
    fragment.delete(0, fragment.length);
    fragment.push(next);
    return true;
  }

  // Longest common subsequence → which old blocks survive, and what each
  // maps to in the new list.
  const n = prevKeys.length;
  const m = nextKeys.length;
  const { keptA: keptOld, keptB: keptNew } = lcsKept(prevKeys, nextKeys);
```

Everything below (`if (keptOld.size === n && keptNew.size === m) return false;` onward) is unchanged.

- [ ] **Step 6: Verify the existing anchor tests still pass**

Run: `bunx vitest run packages/core/test/reparse.test.ts packages/core/test/prose.test.ts packages/core/test/lcs.test.ts`
Expected: PASS. These cover block identity preservation across reparse — the behavior that keeps thread anchors alive. If any fail, the extraction changed behavior; revert and re-do.

- [ ] **Step 7: Export and commit**

Add to `packages/core/src/index.ts`, after the `export * from './identity.ts';` line:

```ts
export * from './lcs.ts';
```

```bash
bun run lint && bun run typecheck
git add packages/core/src/lcs.ts packages/core/test/lcs.test.ts packages/core/src/prose.ts packages/core/src/index.ts
git commit -m "refactor(core): extract lcsKept from applyMarkdownToFragment

The redline needs the same LCS over blocks and over words. Extracted
verbatim; applyMarkdownToFragment's existing reparse tests are the gate."
```

---

### Task 2: `splitMarkdownBlocks` — pure blocks with source offsets

The provenance chain starts here. `parseMarkdownBlocks` produces Yjs elements and no source offsets; the redline needs `text === md.slice(from, to)` so a rendered block can name its own byte range in `content`.

**Files:**
- Create: `packages/core/src/markdown-blocks.ts`
- Test: `packages/core/test/markdown-blocks.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces:
  ```ts
  export type MarkdownBlockType =
    | 'heading' | 'paragraph' | 'bulletList' | 'orderedList'
    | 'blockquote' | 'codeBlock' | 'horizontalRule' | 'table';
  export interface MarkdownBlockSpan {
    type: MarkdownBlockType;
    /** Verbatim source: text === md.slice(from, to). */
    text: string;
    from: number;
    to: number;
  }
  export function splitMarkdownBlocks(md: string): MarkdownBlockSpan[];
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { splitMarkdownBlocks } from '../src/markdown-blocks.ts';

describe('splitMarkdownBlocks', () => {
  it('returns spans whose text is verbatim source', () => {
    const md = '# Title\n\nA paragraph.\n';
    for (const b of splitMarkdownBlocks(md)) {
      expect(b.text).toBe(md.slice(b.from, b.to));
    }
  });

  it('splits headings and paragraphs', () => {
    const blocks = splitMarkdownBlocks('# Title\n\nA paragraph.\n');
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph']);
    expect(blocks[0].text.trim()).toBe('# Title');
    expect(blocks[1].text.trim()).toBe('A paragraph.');
  });

  it('keeps a fenced code block whole, including blank lines inside it', () => {
    const md = '```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter.\n';
    const blocks = splitMarkdownBlocks(md);
    expect(blocks.map((b) => b.type)).toEqual(['codeBlock', 'paragraph']);
    expect(blocks[0].text).toContain('const b = 2;');
  });

  it('keeps a multi-item list as one block', () => {
    const blocks = splitMarkdownBlocks('- one\n- two\n- three\n');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('bulletList');
  });

  it('keeps a multi-paragraph blockquote as one block', () => {
    const blocks = splitMarkdownBlocks('> First.\n>\n> Second.\n');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('blockquote');
  });

  it('splits a pipe table as one block', () => {
    const md = '| a | b |\n| --- | --- |\n| 1 | 2 |\n\nAfter.\n';
    const blocks = splitMarkdownBlocks(md);
    expect(blocks.map((b) => b.type)).toEqual(['table', 'paragraph']);
  });

  it('returns an empty array for empty input', () => {
    expect(splitMarkdownBlocks('')).toEqual([]);
    expect(splitMarkdownBlocks('\n\n')).toEqual([]);
  });

  it('normalizes CRLF without breaking offsets', () => {
    const md = '# T\r\n\r\nBody.\r\n';
    for (const b of splitMarkdownBlocks(md)) {
      expect(md.slice(b.from, b.to)).toBe(b.text);
    }
  });

  it('spans are non-overlapping and ascending', () => {
    const blocks = splitMarkdownBlocks('# T\n\nA.\n\n- x\n- y\n\n> q\n');
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i].from).toBeGreaterThanOrEqual(blocks[i - 1].to);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run packages/core/test/markdown-blocks.test.ts`
Expected: FAIL — cannot resolve `../src/markdown-blocks.ts`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/markdown-blocks.ts`. Mirror the block grammar `parseMarkdownBlocks` (`prose.ts:747-760`) already uses, so the two agree on what a block is:

```ts
/**
 * Split markdown source into top-level block spans, tracking byte offsets.
 *
 * `parseMarkdownBlocks` produces Yjs elements and discards source positions.
 * The redline needs the positions: a rendered block has to be able to name
 * its own byte range in the `content` Y.Text so a comment on it can be
 * anchored line-snapped, exactly like the source diff view's comments.
 *
 * Invariant: `block.text === md.slice(block.from, block.to)` for every block.
 * The line grammar deliberately matches prose.ts:752-760.
 */
export type MarkdownBlockType =
  | 'heading'
  | 'paragraph'
  | 'bulletList'
  | 'orderedList'
  | 'blockquote'
  | 'codeBlock'
  | 'horizontalRule'
  | 'table';

export interface MarkdownBlockSpan {
  type: MarkdownBlockType;
  text: string;
  from: number;
  to: number;
}

const isHeading = (s: string) => /^#{1,6}\s+/.test(s);
const isBullet = (s: string) => /^\s*[-*]\s+/.test(s);
const isNumbered = (s: string) => /^\s*\d+\.\s+/.test(s);
const isQuote = (s: string) => /^>\s?/.test(s);
const isFence = (s: string) => /^```/.test(s);
const isRule = (s: string) => /^(---|\*\*\*|___)\s*$/.test(s);
const isTableRow = (s: string) => /^\|.*\|\s*$/.test(s);

export function splitMarkdownBlocks(md: string): MarkdownBlockSpan[] {
  // CRLF would make every offset after the first line wrong. Normalize, and
  // note that callers pass content that is already \n-normalized by the
  // server's file read; this is belt-and-braces for direct callers.
  const src = md.replace(/\r\n/g, '\n');
  const out: MarkdownBlockSpan[] = [];

  // Line index with absolute start offsets, so a block's span is just
  // starts[firstLine] .. starts[lastLine] + lines[lastLine].length.
  const lines: string[] = [];
  const starts: number[] = [];
  let cursor = 0;
  for (const line of src.split('\n')) {
    lines.push(line);
    starts.push(cursor);
    cursor += line.length + 1; // +1 for the \n
  }

  const emit = (type: MarkdownBlockType, first: number, last: number): void => {
    const from = starts[first];
    const to = starts[last] + lines[last].length;
    if (to <= from) return;
    out.push({ type, text: src.slice(from, to), from, to });
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (isFence(line)) {
      const start = i;
      i++;
      while (i < lines.length && !isFence(lines[i])) i++;
      if (i < lines.length) i++; // closing fence
      emit('codeBlock', start, i - 1);
      continue;
    }
    if (isRule(line)) {
      emit('horizontalRule', i, i);
      i++;
      continue;
    }
    if (isHeading(line)) {
      emit('heading', i, i);
      i++;
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const start = i;
      while (i < lines.length && isTableRow(lines[i])) i++;
      emit('table', start, i - 1);
      continue;
    }
    if (isQuote(line)) {
      const start = i;
      while (i < lines.length && (isQuote(lines[i]) || lines[i].trim() === '>')) i++;
      emit('blockquote', start, i - 1);
      continue;
    }
    if (isBullet(line) || isNumbered(line)) {
      const type: MarkdownBlockType = isBullet(line) ? 'bulletList' : 'orderedList';
      const start = i;
      // A list runs until a blank line followed by a non-indented line, so
      // indented continuations and nested items stay inside the block.
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === '') {
          const next = lines[i + 1] ?? '';
          if (!/^\s+\S/.test(next) && !isBullet(next) && !isNumbered(next)) break;
        } else if (!isBullet(l) && !isNumbered(l) && !/^\s+\S/.test(l)) {
          break;
        }
        i++;
      }
      emit(type, start, i - 1);
      continue;
    }
    // Paragraph: runs to the next blank line or block starter.
    const start = i;
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === '' || isHeading(l) || isFence(l) || isRule(l) || isQuote(l)) break;
      if (isBullet(l) || isNumbered(l)) break;
      i++;
    }
    emit('paragraph', start, i - 1);
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run packages/core/test/markdown-blocks.test.ts`
Expected: PASS (8 tests). If the list or paragraph run-on rules fail a case, fix the implementation — not the test — unless the test encodes a wrong expectation about the grammar in `prose.ts`.

- [ ] **Step 5: Export and commit**

Add to `packages/core/src/index.ts`:

```ts
export * from './markdown-blocks.ts';
```

```bash
bun run lint && bun run typecheck
git add packages/core/src/markdown-blocks.ts packages/core/test/markdown-blocks.test.ts packages/core/src/index.ts
git commit -m "feat(core): splitMarkdownBlocks — pure block spans with source offsets"
```

---

### Task 3: `diffWords` — word-level diff with offsets into the new side

**Files:**
- Create: `packages/core/src/redline.ts`
- Test: `packages/core/test/redline-words.test.ts`

**Interfaces:**
- Consumes: `lcsKept` from Task 1.
- Produces:
  ```ts
  export type RedlineSegKind = 'same' | 'ins' | 'del';
  export interface RedlineSegment {
    kind: RedlineSegKind;
    text: string;
    /** Offsets into the `b` string. Absent on 'del' — deleted text has no
     *  position on the new side. */
    from?: number;
    to?: number;
  }
  export function diffWords(a: string, b: string, bOffset?: number): RedlineSegment[];
  ```
  `bOffset` is added to every emitted `from`/`to` so a caller can pass a block's source text and get offsets in whole-document space.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { diffWords } from '../src/redline.ts';

const textOf = (segs: ReturnType<typeof diffWords>, kind: string) =>
  segs.filter((s) => s.kind === kind).map((s) => s.text).join('');

describe('diffWords', () => {
  it('marks everything same for identical input', () => {
    const segs = diffWords('the quick fox', 'the quick fox');
    expect(segs.every((s) => s.kind === 'same')).toBe(true);
    expect(textOf(segs, 'same')).toBe('the quick fox');
  });

  it('isolates a single changed word', () => {
    const segs = diffWords('the quick brown fox', 'the quick red fox');
    expect(textOf(segs, 'del')).toBe('brown');
    expect(textOf(segs, 'ins')).toBe('red');
    expect(textOf(segs, 'same')).toContain('the quick ');
    expect(textOf(segs, 'same')).toContain(' fox');
  });

  it('reports offsets into b that slice back to the segment text', () => {
    const b = 'the quick red fox';
    for (const s of diffWords('the quick brown fox', b)) {
      if (s.kind === 'del') {
        expect(s.from).toBeUndefined();
        continue;
      }
      expect(b.slice(s.from, s.to)).toBe(s.text);
    }
  });

  it('applies bOffset to reported offsets', () => {
    const segs = diffWords('a', 'b', 100);
    const ins = segs.find((s) => s.kind === 'ins');
    expect(ins?.from).toBe(100);
    expect(ins?.to).toBe(101);
  });

  it('handles pure insertion and pure deletion', () => {
    expect(textOf(diffWords('', 'new text'), 'ins')).toBe('new text');
    expect(textOf(diffWords('old text', ''), 'del')).toBe('old text');
  });

  it('preserves whitespace so segments reassemble into the originals', () => {
    const a = 'one  two\nthree';
    const b = 'one  four\nthree';
    const segs = diffWords(a, b);
    const rebuiltA = segs.filter((s) => s.kind !== 'ins').map((s) => s.text).join('');
    const rebuiltB = segs.filter((s) => s.kind !== 'del').map((s) => s.text).join('');
    expect(rebuiltA).toBe(a);
    expect(rebuiltB).toBe(b);
  });

  it('merges adjacent same tokens into one segment', () => {
    const segs = diffWords('a b c', 'a b c');
    expect(segs).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run packages/core/test/redline-words.test.ts`
Expected: FAIL — cannot resolve `../src/redline.ts`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/redline.ts`:

```ts
import { LCS_CELL_BUDGET, lcsKept } from './lcs.ts';

export type RedlineSegKind = 'same' | 'ins' | 'del';

export interface RedlineSegment {
  kind: RedlineSegKind;
  text: string;
  /** Offsets into the new side. Absent on 'del' — deleted text has no
   *  position on the new side, which is the whole reason the deletedSnippet
   *  anchor hint exists. */
  from?: number;
  to?: number;
}

interface Token {
  text: string;
  from: number;
}

/** Split into words and whitespace runs, keeping both so the segments
 *  reassemble into the exact source. */
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
 * Whitespace runs are tokens too, so `same`+`del` reassembles into `a` and
 * `same`+`ins` reassembles into `b` exactly. Offsets are into `b`, shifted by
 * `bOffset` so a caller diffing one block gets whole-document offsets.
 */
export function diffWords(a: string, b: string, bOffset = 0): RedlineSegment[] {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length === 0 && tb.length === 0) return [];

  // Past the budget, degrade to a whole-string replace rather than build a
  // table that would stall the browser. A block this big is pathological.
  const overBudget = ta.length * tb.length > LCS_CELL_BUDGET;
  const { keptA, keptB } = overBudget
    ? { keptA: new Set<number>(), keptB: new Set<number>() }
    : lcsKept(
        ta.map((t) => t.text),
        tb.map((t) => t.text),
      );

  const out: RedlineSegment[] = [];
  const push = (kind: RedlineSegKind, text: string, from?: number): void => {
    const last = out[out.length - 1];
    // Merge adjacent segments of the same kind so the renderer emits one
    // <ins>/<del> per run rather than one per token.
    if (last && last.kind === kind) {
      last.text += text;
      if (kind !== 'del' && last.to != null) last.to += text.length;
      return;
    }
    out.push(
      kind === 'del'
        ? { kind, text }
        : { kind, text, from: (from ?? 0) + bOffset, to: (from ?? 0) + bOffset + text.length },
    );
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
    // Only reachable if one side is exhausted while the other still has kept
    // tokens — impossible for a well-formed LCS, but don't spin.
    break;
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run packages/core/test/redline-words.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
bun run lint && bun run typecheck
git add packages/core/src/redline.ts packages/core/test/redline-words.test.ts
git commit -m "feat(core): diffWords — word-level diff carrying new-side offsets"
```

---

### Task 4: `computeRedline` — block diff, pairing, and snap targets

**Files:**
- Modify: `packages/core/src/redline.ts`
- Test: `packages/core/test/redline.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `splitMarkdownBlocks` (Task 2), `diffWords` (Task 3), `lcsKept` (Task 1).
- Produces:
  ```ts
  export interface RedlineBlock {
    kind: 'same' | 'ins' | 'del' | 'changed';
    type: MarkdownBlockType;
    segments: RedlineSegment[];
    /** New-side span. Absent on 'del' blocks. */
    from?: number;
    to?: number;
    /** Where a comment on a 'del' block anchors: the nearest following
     *  new-side offset. Present only on 'del' blocks. */
    snapTo?: number;
  }
  export function computeRedline(baseMd: string, newMd: string): RedlineBlock[];
  export function snapOffsetsToLines(text: string, from: number, to: number): { from: number; to: number };
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { computeRedline, snapOffsetsToLines } from '../src/redline.ts';

describe('snapOffsetsToLines', () => {
  it('extends a mid-line range to whole lines', () => {
    const text = 'alpha\nbravo\ncharlie\n';
    // "rav" inside bravo
    expect(snapOffsetsToLines(text, 7, 10)).toEqual({ from: 6, to: 11 });
  });

  it('snaps a collapsed offset to its own line', () => {
    const text = 'alpha\nbravo\n';
    expect(snapOffsetsToLines(text, 8, 8)).toEqual({ from: 6, to: 11 });
  });

  it('handles the first and last line', () => {
    const text = 'alpha\nbravo';
    expect(snapOffsetsToLines(text, 0, 1)).toEqual({ from: 0, to: 5 });
    expect(snapOffsetsToLines(text, 7, 8)).toEqual({ from: 6, to: 11 });
  });
});

describe('computeRedline', () => {
  it('marks every block same for identical input', () => {
    const md = '# Title\n\nBody text.\n';
    const blocks = computeRedline(md, md);
    expect(blocks.map((b) => b.kind)).toEqual(['same', 'same']);
  });

  it('word-diffs a reworded paragraph rather than replacing it', () => {
    const blocks = computeRedline('The quick brown fox.\n', 'The quick red fox.\n');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('changed');
    const del = blocks[0].segments.filter((s) => s.kind === 'del').map((s) => s.text).join('');
    const ins = blocks[0].segments.filter((s) => s.kind === 'ins').map((s) => s.text).join('');
    expect(del).toBe('brown');
    expect(ins).toBe('red');
  });

  it('reports an inserted block with a new-side span', () => {
    const blocks = computeRedline('A.\n', 'A.\n\nB.\n');
    const ins = blocks.filter((b) => b.kind === 'ins');
    expect(ins).toHaveLength(1);
    expect(ins[0].from).toBeDefined();
  });

  it('gives a deleted block a snapTo pointing at the next surviving block', () => {
    const newMd = 'A.\n\nC.\n';
    const blocks = computeRedline('A.\n\nB.\n\nC.\n', newMd);
    const del = blocks.find((b) => b.kind === 'del');
    expect(del).toBeDefined();
    expect(del?.from).toBeUndefined();
    // Snaps to the start of "C." — the next block that still exists.
    expect(del?.snapTo).toBe(newMd.indexOf('C.'));
  });

  it('snapTo falls back to the end of the document when nothing follows', () => {
    const newMd = 'A.\n';
    const blocks = computeRedline('A.\n\nTrailing.\n', newMd);
    const del = blocks.find((b) => b.kind === 'del');
    expect(del?.snapTo).toBe(newMd.length);
  });

  it('renders a heading level change as delete + insert, not a word diff', () => {
    const blocks = computeRedline('## Section\n', '### Section\n');
    // Same node type but a structural change — the level lives in the source
    // text, so the word diff would show "##" -> "###" which is noise.
    expect(blocks.map((b) => b.kind).sort()).toEqual(['del', 'ins']);
  });

  it('renders a paragraph becoming a list as delete + insert', () => {
    const blocks = computeRedline('one two\n', '- one\n- two\n');
    expect(blocks.map((b) => b.kind).sort()).toEqual(['del', 'ins']);
  });

  it('treats an added file (empty base) as all insertions', () => {
    const blocks = computeRedline('', '# New\n\nBody.\n');
    expect(blocks.every((b) => b.kind === 'ins')).toBe(true);
  });

  it('treats a deleted file (empty new) as all deletions', () => {
    const blocks = computeRedline('# Gone\n', '');
    expect(blocks.every((b) => b.kind === 'del')).toBe(true);
  });

  it('keeps blocks in new-side document order', () => {
    const blocks = computeRedline('A.\n\nB.\n', 'A.\n\nX.\n\nB.\n');
    const spans = blocks.filter((b) => b.from != null).map((b) => b.from as number);
    expect([...spans].sort((x, y) => x - y)).toEqual(spans);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run packages/core/test/redline.test.ts`
Expected: FAIL — `computeRedline` / `snapOffsetsToLines` are not exported.

- [ ] **Step 3: Write the implementation**

Append to `packages/core/src/redline.ts`:

```ts
import { type MarkdownBlockSpan, type MarkdownBlockType, splitMarkdownBlocks } from './markdown-blocks.ts';

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
 * line-snap without a view. Matches the line-snapping the server's
 * `createThreadByFind` flat branch does (rooms.ts:479).
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

/** Blocks are only word-diffed against each other when they're the same kind
 *  AND the change isn't structural. A heading's level and a list's markers
 *  live in the source text, so word-diffing `## X` against `### X` would show
 *  the reviewer marker noise instead of the real change. Word says the same
 *  thing: structural changes render as delete + insert. */
function pairable(a: MarkdownBlockSpan, b: MarkdownBlockSpan): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'codeBlock' || a.type === 'table' || a.type === 'horizontalRule') return false;
  if (a.type === 'heading') {
    const la = /^#+/.exec(a.text)?.[0].length ?? 0;
    const lb = /^#+/.exec(b.text)?.[0].length ?? 0;
    if (la !== lb) return false;
  }
  return similarity(a.text, b.text) >= 0.35;
}

/** Token overlap ratio — cheap and good enough to answer "did this paragraph
 *  become that paragraph, or is it a different paragraph entirely?". */
function similarity(a: string, b: string): number {
  const wa = a.toLowerCase().match(/\S+/g) ?? [];
  const wb = b.toLowerCase().match(/\S+/g) ?? [];
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
 * Word-style redline of `baseMd` against `newMd`.
 *
 * Pure: same inputs always produce the same output, which is what lets every
 * client derive an identical redline from the shared `content` + the pinned
 * `baseText` without any coordination. Offsets on 'same'/'ins'/'changed'
 * blocks index into `newMd` — i.e. into the `content` Y.Text.
 */
export function computeRedline(baseMd: string, newMd: string): RedlineBlock[] {
  const baseBlocks = splitMarkdownBlocks(baseMd);
  const newBlocks = splitMarkdownBlocks(newMd);

  const { keptA, keptB } = lcsKept(
    baseBlocks.map((b) => b.text),
    newBlocks.map((b) => b.text),
  );

  const out: RedlineBlock[] = [];
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
  const asDel = (b: MarkdownBlockSpan): RedlineBlock => ({
    kind: 'del',
    type: b.type,
    segments: [{ kind: 'del', text: b.text }],
  });
  const asChanged = (a: MarkdownBlockSpan, b: MarkdownBlockSpan): RedlineBlock => ({
    kind: 'changed',
    type: b.type,
    segments: diffWords(a.text, b.text, b.from),
    from: b.from,
    to: b.to,
  });

  let i = 0;
  let j = 0;
  while (i < baseBlocks.length || j < newBlocks.length) {
    const aKept = i < baseBlocks.length && keptA.has(i);
    const bKept = j < newBlocks.length && keptB.has(j);
    if (aKept && bKept) {
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
    out.push(...pairGap(gapA, gapB));
    if (gapA.length === 0 && gapB.length === 0) break; // no progress guard
  }

  // A deleted block has no new-side position, so a comment on it snaps to the
  // nearest FOLLOWING new-side offset. Resolved by a backward pass: the snap
  // target is the next later block that has one, or the end of the document.
  let nextFrom = newMd.length;
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
 *  them) versus which were simply deleted/added (show whole). Greedy best-match
 *  in new-side order — good enough, and the alternative (optimal assignment) is
 *  not worth it for the handful of blocks a gap holds. */
function pairGap(gapA: MarkdownBlockSpan[], gapB: MarkdownBlockSpan[]): RedlineBlock[] {
  const out: RedlineBlock[] = [];
  const usedA = new Set<number>();
  const matchFor = new Map<number, number>(); // index in gapB -> index in gapA
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
  // Unmatched base blocks render as deletions, emitted before the new-side
  // blocks they sat near — reading order puts the removal above its
  // replacement, as Word does.
  for (let ai = 0; ai < gapA.length; ai++) {
    if (!usedA.has(ai)) {
      out.push({ kind: 'del', type: gapA[ai].type, segments: [{ kind: 'del', text: gapA[ai].text }] });
    }
  }
  for (let bi = 0; bi < gapB.length; bi++) {
    const ai = matchFor.get(bi);
    const b = gapB[bi];
    if (ai == null) {
      out.push({
        kind: 'ins',
        type: b.type,
        segments: [{ kind: 'ins', text: b.text, from: b.from, to: b.to }],
        from: b.from,
        to: b.to,
      });
    } else {
      out.push({
        kind: 'changed',
        type: b.type,
        segments: diffWords(gapA[ai].text, b.text, b.from),
        from: b.from,
        to: b.to,
      });
    }
  }
  return out;
}
```

Note: `asSame` / `asIns` / `asDel` / `asChanged` in `computeRedline` and the inline objects in `pairGap` overlap. After the tests pass, collapse them into the shared helpers (`pairGap` should call the same builders) — DRY, and a reviewer will flag it otherwise.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run packages/core/test/redline.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Export and commit**

Add to `packages/core/src/index.ts`:

```ts
export * from './redline.ts';
```

```bash
bun run lint && bun run typecheck && bunx vitest run packages/core
git add packages/core/src/redline.ts packages/core/test/redline.test.ts packages/core/src/index.ts
git commit -m "feat(core): computeRedline — block diff + word pairing with snap targets"
```

---

### Task 5: `deletedSnippet` anchor hint — core, rooms, AND the route

`docs/process/learnings.md` records the exact trap here: "Every REST handler in server.ts hand-copies body fields into the rooms call — a new param needs THREE additions (MCP tool, route, rooms), and the route is the one nothing type-checks." The `groups` param was added to the tool and to `bindDiff` but not forwarded by the route; the API returned `ok:true` and discarded it, and unit tests passed because they called the rooms method directly. **Write the HTTP-level test.**

**Files:**
- Modify: `packages/core/src/types.ts:148-155`
- Modify: `packages/server/src/rooms.ts` (thread-create path)
- Modify: `packages/server/src/server.ts` (thread POST route)
- Test: `packages/server/test/deleted-snippet.test.ts`

**Interfaces:**
- Produces: `TextRangeAnchor.deletedSnippet?: string` — persisted through create and readable via the thread GET.

- [ ] **Step 1: Find the thread-create route and rooms method**

Run:
```bash
grep -n "createThread\|threads.*POST\|'threads'" packages/server/src/server.ts packages/server/src/rooms.ts | head -30
```
Read both call sites fully before editing. The route hand-copies body fields — you are adding one to that copy.

- [ ] **Step 2: Write the failing HTTP-level test**

Model it on the existing server tests' harness (read `packages/server/test/` for how a test server is started — do not invent a new harness).

```ts
import { describe, expect, it } from 'vitest';
// NOTE: server tests run under `bun test packages/server/test`, NOT vitest.
// Use the same imports/harness as the sibling tests in this directory.

describe('deletedSnippet anchor hint', () => {
  it('survives a round trip through the REST thread route', async () => {
    // 1. Start the test server + create a diff-ish doc with flat content.
    // 2. POST a thread whose anchor carries deletedSnippet: 'the removed words'.
    // 3. GET the thread back through the REST route.
    // 4. expect(anchor.deletedSnippet).toBe('the removed words')
    //
    // The point of this test is the ROUTE, not the rooms method: calling
    // rooms directly would pass even if the route drops the field, which is
    // exactly how the `groups` bug shipped.
  });
});
```

Fill in the body using the harness the neighbouring server tests use.

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test packages/server/test/deleted-snippet.test.ts`
Expected: FAIL — `deletedSnippet` is `undefined` on the way back out.

- [ ] **Step 4: Add the field to the type**

In `packages/core/src/types.ts`, extend `TextRangeAnchor`:

```ts
export interface TextRangeAnchor {
  kind: 'text-range';
  startRel: Uint8Array;
  endRel: Uint8Array;
  snippet: AnchorSnippet;
  context?: AnchorContext;
  /**
   * Set when the thread was created on text that exists only on the BASE side
   * of a diff — i.e. struck-through text in the redline view. Deleted text has
   * no position in `content`, so the anchor snaps to the nearest following
   * retained line and this records what the comment was actually about. The
   * redline view re-finds the deletion by matching this snippet near the
   * anchor line; the source diff view uses it to label the thread.
   */
  deletedSnippet?: string;
}
```

- [ ] **Step 5: Thread it through rooms and the route**

Add `deletedSnippet` to the rooms thread-create signature and persist it on the frozen anchor JSON. Then add it to the route's hand-copy in `server.ts`. Grep to prove no call site was missed:

```bash
grep -rn "deletedSnippet" packages/core/src packages/server/src packages/markdown-app/src
```
Expected: the type, the rooms method, the route, and (later) the redline surface. If the route isn't in that list, the bug from `learnings.md` just recurred.

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test packages/server/test/deleted-snippet.test.ts && bun run test:server`
Expected: PASS, and no regression in the existing server suite.

- [ ] **Step 7: Commit**

```bash
bun run lint && bun run typecheck
git add packages/core/src/types.ts packages/server/src/rooms.ts packages/server/src/server.ts packages/server/test/deleted-snippet.test.ts
git commit -m "feat(anchor): deletedSnippet hint for comments on base-only text

Threaded through core, rooms, AND the REST route, with an HTTP-level test —
the route is the layer that silently dropped `groups` (see learnings.md)."
```

---

### Task 6: Render `RedlineBlock[]` to annotated markdown

**Files:**
- Create: `packages/markdown-app/src/redline/redline-markdown.ts`
- Test: `packages/markdown-app/test/redline-markdown.test.ts`

**Interfaces:**
- Consumes: `RedlineBlock` (Task 4).
- Produces: `renderRedlineMarkdown(blocks: RedlineBlock[]): string` — markdown where changed inline text is wrapped in `<ins>` / `<del>`, and every block carries `data-lf-*` provenance.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { computeRedline } from '@feedback/core';
import { renderRedlineMarkdown } from '../src/redline/redline-markdown.ts';

describe('renderRedlineMarkdown', () => {
  it('wraps changed words in ins/del and leaves same text bare', () => {
    const md = renderRedlineMarkdown(computeRedline('The quick brown fox.\n', 'The quick red fox.\n'));
    expect(md).toContain('<del>brown</del>');
    expect(md).toContain('<ins>red</ins>');
    expect(md).toContain('The quick');
  });

  it('keeps block markdown syntax outside the ins/del wrappers', () => {
    const md = renderRedlineMarkdown(computeRedline('## Old title\n', '## New title\n'));
    // The `## ` must stay literal markdown — wrapping it would render the
    // heading as a paragraph of struck-through hashes.
    expect(md).toMatch(/^## /m);
    expect(md).toContain('<del>Old</del>');
    expect(md).toContain('<ins>New</ins>');
  });

  it('marks a whole inserted block with a provenance span', () => {
    const md = renderRedlineMarkdown(computeRedline('A.\n', 'A.\n\nBrand new.\n'));
    expect(md).toContain('<ins>Brand new.</ins>');
    expect(md).toMatch(/data-lf-from="\d+"/);
  });

  it('emits data-lf-snap on a deleted block instead of a from/to', () => {
    const md = renderRedlineMarkdown(computeRedline('A.\n\nGone.\n\nC.\n', 'A.\n\nC.\n'));
    expect(md).toContain('data-lf-snap=');
    expect(md).toContain('<del>Gone.</del>');
  });

  it('does not wrap code block or table content inline', () => {
    const blocks = computeRedline('```ts\nconst a = 1;\n```\n', '```ts\nconst a = 2;\n```\n');
    const md = renderRedlineMarkdown(blocks);
    // Inline tags inside a fence would render literally. Whole-block styling
    // handles these instead.
    expect(md).not.toMatch(/```[\s\S]*<del>/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run packages/markdown-app/test/redline-markdown.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/markdown-app/src/redline/redline-markdown.ts`. Key rules, in order of importance:

1. **Never wrap block-level markdown syntax.** For a block whose source starts with a marker (`## `, `- `, `> `, `1. `), the marker stays literal and only the inline text is wrapped. Otherwise a struck-through `##` renders as a paragraph.
2. **Never wrap inside a fence or a table.** `codeBlock` / `table` / `horizontalRule` blocks emit their source verbatim and get whole-block change styling via `data-lf-change`.
3. **Provenance goes on the block**, as `data-lf-from` / `data-lf-to` (or `data-lf-snap` for `del` blocks), via an HTML comment-free wrapper the global attribute in Task 7 parses.

```ts
import type { RedlineBlock, RedlineSegment } from '@feedback/core';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** Split a block's source into its leading block marker and the inline text
 *  after it. The marker must stay literal markdown — only inline text can be
 *  wrapped in <ins>/<del>. */
function splitMarker(text: string): { marker: string; body: string } {
  const m = /^(\s*(?:#{1,6}\s+|[-*]\s+|\d+\.\s+|>\s?))/.exec(text);
  return m ? { marker: m[1], body: text.slice(m[1].length) } : { marker: '', body: text };
}

function wrapSegments(segs: RedlineSegment[]): string {
  return segs
    .map((s) => {
      if (s.kind === 'same') return s.text;
      const tag = s.kind === 'ins' ? 'ins' : 'del';
      // Whitespace-only runs must not be wrapped — an empty <ins> </ins>
      // renders as a stray underlined gap.
      if (s.text.trim() === '') return s.text;
      return `<${tag}>${s.text}</${tag}>`;
    })
    .join('');
}

/**
 * Render a redline to markdown that the Tiptap surface can parse.
 *
 * Inline changes become <ins>/<del> (marks — see redline-marks.ts). Block
 * provenance rides on data-lf-* attributes that the RedlineProvenance global
 * attribute lifts onto the block node, which is how a rendered position maps
 * back to a `content` offset for anchoring.
 */
export function renderRedlineMarkdown(blocks: RedlineBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    const attrs =
      b.from != null
        ? ` data-lf-from="${b.from}" data-lf-to="${b.to}"`
        : ` data-lf-snap="${b.snapTo ?? 0}"`;
    const changeAttr = b.kind === 'same' ? '' : ` data-lf-change="${b.kind}"`;

    // Verbatim blocks: no inline wrapping is possible, so the whole block is
    // styled instead.
    if (b.type === 'codeBlock' || b.type === 'table' || b.type === 'horizontalRule') {
      const src = b.segments.map((s) => s.text).join('');
      parts.push(`<div${attrs}${changeAttr}>\n\n${src}\n\n</div>`);
      continue;
    }

    // Reconstruct the block from its segments, wrapping only inline text and
    // leaving the leading block marker literal.
    const full = b.segments.map((s) => s.text).join('');
    const { marker } = splitMarker(full);
    let consumed = 0;
    const body: RedlineSegment[] = [];
    for (const s of b.segments) {
      if (consumed >= marker.length) {
        body.push(s);
        continue;
      }
      const take = Math.min(marker.length - consumed, s.text.length);
      consumed += take;
      if (take < s.text.length) body.push({ ...s, text: s.text.slice(take) });
    }
    parts.push(`${marker}${wrapSegments(body)}`);
    void esc; // escaping is handled by the markdown parser for inline text
  }
  return `${parts.join('\n\n')}\n`;
}
```

**Implementer note:** the marker-consumption loop above is the fiddly part — a `del` segment can straddle the marker boundary. Let the tests drive it; if a test shows a marker being wrapped, fix the loop, not the test. If `data-lf-*` on a `<div>` wrapper turns out not to survive (Task 0 probes this), fall back to emitting the provenance as attributes on the block via `renderHTML` in Task 7 and reconstructing the index by document order instead.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run packages/markdown-app/test/redline-markdown.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
bun run lint && bun run typecheck
git add packages/markdown-app/src/redline/redline-markdown.ts packages/markdown-app/test/redline-markdown.test.ts
git commit -m "feat(redline): render redline blocks to annotated markdown"
```

---

### Task 7: Marks + provenance attribute extension

**Files:**
- Create: `packages/markdown-app/src/redline/redline-marks.ts`
- Test: `packages/markdown-app/test/redline-marks.test.ts`

**Interfaces:**
- Produces: `RedlineIns`, `RedlineDel` (Tiptap marks), `RedlineProvenance` (global attribute adding `lfFrom` / `lfTo` / `lfSnap` / `lfChange` to block nodes).

- [ ] **Step 1: Write the failing test**

```ts
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { describe, expect, it } from 'vitest';
import { RedlineDel, RedlineIns, RedlineProvenance } from '../src/redline/redline-marks.ts';

function mount(content: string): Editor {
  const editor = new Editor({
    extensions: [StarterKit.configure({ undoRedo: false }), Markdown, RedlineIns, RedlineDel, RedlineProvenance],
    content: '',
  });
  editor.commands.setContent(content, { emitUpdate: false });
  return editor;
}

describe('redline marks', () => {
  it('renders ins and del marks from markdown', () => {
    const editor = mount('A <del>stale</del><ins>fresh</ins> line.\n');
    const html = editor.getHTML();
    expect(html).toContain('<del>stale</del>');
    expect(html).toContain('<ins>fresh</ins>');
    editor.destroy();
  });

  it('lifts data-lf-from / data-lf-to onto the block node as numbers', () => {
    const editor = mount('<p data-lf-from="10" data-lf-to="25">Body.</p>');
    const node = editor.state.doc.child(0);
    expect(node.attrs.lfFrom).toBe(10);
    expect(node.attrs.lfTo).toBe(25);
    editor.destroy();
  });

  it('defaults provenance attrs to null when absent', () => {
    const editor = mount('Plain paragraph.\n');
    expect(editor.state.doc.child(0).attrs.lfFrom).toBeNull();
    editor.destroy();
  });

  it('lifts data-lf-snap for deletion-only blocks', () => {
    const editor = mount('<p data-lf-snap="42">Gone.</p>');
    expect(editor.state.doc.child(0).attrs.lfSnap).toBe(42);
    editor.destroy();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run packages/markdown-app/test/redline-marks.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/markdown-app/src/redline/redline-marks.ts`:

```ts
import { Extension, Mark } from '@tiptap/core';

/**
 * Inline marks for redlined text. Display only — they carry no provenance,
 * because anchors are line-snapped: a word-precise offset would be snapped
 * back to its line immediately, so provenance lives on the BLOCK instead
 * (RedlineProvenance below).
 */
export const RedlineIns = Mark.create({
  name: 'redlineIns',
  inclusive: () => false,
  parseHTML: () => [{ tag: 'ins' }],
  renderHTML: () => ['ins', { class: 'lf-ins' }, 0],
});

// Priority 60 is load-bearing, not decoration: StarterKit's Strike mark parses
// `del` at the default 50, so without this every deletion renders as ordinary
// strikethrough — near-identical by eye, and silently wrong. Verified in Task 0.
export const RedlineDel = Mark.create({
  name: 'redlineDel',
  inclusive: () => false,
  parseHTML: () => [{ tag: 'del', priority: 60 }],
  renderHTML: () => ['del', { class: 'lf-del' }, 0],
});

const numAttr = (name: string) => ({
  default: null as number | null,
  parseHTML: (element: HTMLElement): number | null => {
    const raw = element.getAttribute(name);
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  },
  renderHTML: (attrs: Record<string, unknown>): Record<string, string> => {
    const key = name.replace(/^data-lf-/, 'lf');
    void key;
    return {};
  },
});

/**
 * Lifts data-lf-* provenance from the rendered HTML onto block nodes.
 *
 * `lfFrom`/`lfTo` are offsets into the `content` Y.Text — the block's source
 * span on the NEW side. `lfSnap` replaces them on deletion-only blocks, which
 * have no new-side position. This is the bridge that lets a selection in the
 * rendered prose produce an anchor byte-identical to the source diff view's.
 *
 * Stored as NUMBERS, not strings: the heading-level bug (learnings.md) was
 * exactly this — a Yjs/PM attribute typed as a string where a number was
 * expected, silently falling back and hiding for weeks.
 */
export const RedlineProvenance = Extension.create({
  name: 'redlineProvenance',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading', 'blockquote', 'codeBlock', 'bulletList', 'orderedList', 'listItem', 'table', 'horizontalRule'],
        attributes: {
          lfFrom: { ...numAttr('data-lf-from'), renderHTML: (a) => (a.lfFrom == null ? {} : { 'data-lf-from': String(a.lfFrom) }) },
          lfTo: { ...numAttr('data-lf-to'), renderHTML: (a) => (a.lfTo == null ? {} : { 'data-lf-to': String(a.lfTo) }) },
          lfSnap: { ...numAttr('data-lf-snap'), renderHTML: (a) => (a.lfSnap == null ? {} : { 'data-lf-snap': String(a.lfSnap) }) },
          lfChange: {
            default: null as string | null,
            parseHTML: (el: HTMLElement) => el.getAttribute('data-lf-change'),
            renderHTML: (a: Record<string, unknown>) =>
              a.lfChange == null ? {} : { 'data-lf-change': String(a.lfChange), class: `lf-block-${String(a.lfChange)}` },
          },
        },
      },
    ];
  },
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run packages/markdown-app/test/redline-marks.test.ts`
Expected: PASS (4 tests). Clean up the unused `numAttr.renderHTML` stub once the real per-attribute `renderHTML` overrides are in — biome will flag the dead code.

- [ ] **Step 5: Commit**

```bash
bun run lint && bun run typecheck
git add packages/markdown-app/src/redline/redline-marks.ts packages/markdown-app/test/redline-marks.test.ts
git commit -m "feat(redline): ins/del marks + block provenance attributes"
```

---

### Task 8: The redline surface (`ReviewSurface` implementation)

This is where the payoff lands: implementing `ReviewSurface` means `mountReviewChrome` gives the redline the entire thread/composer/drawer/reveal stack for free, unchanged.

**Files:**
- Create: `packages/markdown-app/src/redline/redline-editor.ts`
- Test: `packages/markdown-app/test/redline-editor.test.ts`

**Interfaces:**
- Consumes: `computeRedline`, `snapOffsetsToLines`, `encodeOffsetRel`/`resolveRelOffset` (`code/code-anchor.ts`), the Task 6/7 modules, `ReviewSurface` (`review-surface.ts`).
- Produces:
  ```ts
  export interface RedlineSurface extends ReviewSurface {
    /** Recompute + re-render from the current content. */
    refresh: () => void;
  }
  export function createRedlineEditor(opts: {
    parent: HTMLElement;
    ydoc: Y.Doc;
    baseText: string;
    onSelectionChange?: () => void;
  }): RedlineSurface;
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { getContent } from '@feedback/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createRedlineEditor } from '../src/redline/redline-editor.ts';

function mount(baseText: string, newText: string) {
  const ydoc = new Y.Doc();
  getContent(ydoc).insert(0, newText);
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const surface = createRedlineEditor({ parent, ydoc, baseText });
  return { ydoc, parent, surface };
}

describe('createRedlineEditor', () => {
  it('renders prose as prose with inline ins/del', () => {
    const { parent, surface } = mount('The quick brown fox.\n', '# T\n\nThe quick red fox.\n');
    expect(parent.innerHTML).toContain('<h1>');
    expect(parent.innerHTML).toContain('<del');
    expect(parent.innerHTML).toContain('<ins');
    surface.destroy();
  });

  it('renders nothing but same-blocks when base equals content', () => {
    const { parent, surface } = mount('# T\n\nBody.\n', '# T\n\nBody.\n');
    expect(parent.innerHTML).not.toContain('<del');
    expect(parent.innerHTML).not.toContain('<ins');
    surface.destroy();
  });

  it('resolves an anchor created by the code surface to a prose range', () => {
    const newText = '# T\n\nAlpha.\n\nBravo.\n';
    const { ydoc, surface } = mount('# T\n\nAlpha.\n', newText);
    const content = getContent(ydoc);
    // Anchor the line "Bravo." exactly as code-editor.getSelectionRel would.
    const from = newText.indexOf('Bravo.');
    const to = from + 'Bravo.'.length;
    const startRel = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(content, from));
    const endRel = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(content, to));
    const range = surface.resolveRel(startRel, endRel);
    expect(range).not.toBeNull();
    expect((range as { from: number }).from).toBeGreaterThan(0);
    surface.destroy();
  });

  it('re-renders when content changes (agent save)', () => {
    const { ydoc, parent, surface } = mount('Old text.\n', 'Old text.\n');
    expect(parent.innerHTML).not.toContain('<ins');
    const content = getContent(ydoc);
    content.delete(0, content.length);
    content.insert(0, 'New text.\n');
    expect(parent.innerHTML).toContain('<ins');
    surface.destroy();
  });

  it('renders the whole doc as insertions when content arrives after mount', () => {
    // The empty-at-mount case: Yjs hasn't synced yet when the surface mounts.
    // Anything derived at mount is stale — same class as the collapseUnchanged
    // compartment bug (learnings.md).
    const ydoc = new Y.Doc();
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const surface = createRedlineEditor({ parent, ydoc, baseText: '' });
    getContent(ydoc).insert(0, '# Arrived late\n');
    expect(parent.innerHTML).toContain('Arrived late');
    surface.destroy();
  });

  it('reports a 1-based content line for a prose position', () => {
    const { surface } = mount('A.\n', 'A.\n\nB.\n');
    expect(typeof surface.lineForPos?.(1)).toBe('number');
    surface.destroy();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run packages/markdown-app/test/redline-editor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/markdown-app/src/redline/redline-editor.ts`. Structure:

```ts
import { Editor } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import StarterKit from '@tiptap/starter-kit';
import { computeRedline, getContent, snapOffsetsToLines } from '@feedback/core';
import { Markdown } from 'tiptap-markdown';
import * as Y from 'yjs';
import { encodeOffsetRel, resolveRelOffset } from '../code/code-anchor.ts';
import { MermaidCodeBlock } from '../mermaid-code-block.ts';
import { setThreadDecorations, ThreadDecorations } from '../thread-decorations.ts';
import type { ReviewSurface } from '../review-surface.ts';
import { renderRedlineMarkdown } from './redline-markdown.ts';
import { RedlineDel, RedlineIns, RedlineProvenance } from './redline-marks.ts';

export interface RedlineSurface extends ReviewSurface {
  refresh: () => void;
}

/**
 * Read-only Tiptap surface rendering a Word-style redline of `baseText`
 * against the `content` Y.Text.
 *
 * The doc is NOT collaborative — it is derived. Every client computes the
 * same redline from the same shared inputs (`content` is CRDT-synced;
 * `baseText` is pinned to a commit hash and immutable), so there is nothing
 * to sync. Threads still live in the shared CRDT, anchored into `content` via
 * the block provenance attributes — which is what keeps them interoperable
 * with the source diff view and with the agent.
 */
export function createRedlineEditor(opts: {
  parent: HTMLElement;
  ydoc: Y.Doc;
  baseText: string;
  onSelectionChange?: () => void;
}): RedlineSurface {
  const content = getContent(opts.ydoc);

  const editor = new Editor({
    element: opts.parent,
    editable: false,
    extensions: [
      StarterKit.configure({ undoRedo: false, codeBlock: false }),
      MermaidCodeBlock,
      Image,
      Markdown,
      RedlineIns,
      RedlineDel,
      RedlineProvenance,
      ThreadDecorations,
    ],
    content: '',
    onSelectionUpdate: () => opts.onSelectionChange?.(),
  });

  // Index of block provenance, rebuilt on every render: PM node range -> the
  // block's span in `content`. Sorted by pmFrom, so a lookup is a scan.
  interface BlockIndexEntry {
    pmFrom: number;
    pmTo: number;
    from: number | null;
    to: number | null;
    snap: number | null;
  }
  let index: BlockIndexEntry[] = [];

  function render(): void {
    const md = renderRedlineMarkdown(computeRedline(opts.baseText, content.toString()));
    editor.commands.setContent(md, { emitUpdate: false });
    index = [];
    editor.state.doc.descendants((node, pos) => {
      const a = node.attrs as { lfFrom?: number | null; lfTo?: number | null; lfSnap?: number | null };
      if (a.lfFrom == null && a.lfSnap == null) return true;
      index.push({
        pmFrom: pos,
        pmTo: pos + node.nodeSize,
        from: a.lfFrom ?? null,
        to: a.lfTo ?? null,
        snap: a.lfSnap ?? null,
      });
      return true;
    });
    index.sort((x, y) => x.pmFrom - y.pmFrom);
  }

  // Derive on every content change, INCLUDING the empty->content transition
  // at mount (Yjs syncs after the surface mounts, so a mount-time render
  // alone would leave the view permanently empty).
  render();
  const onContentChange = () => render();
  content.observe(onContentChange);

  /** Innermost indexed block containing a PM position. */
  function blockAt(pos: number): BlockIndexEntry | null {
    let best: BlockIndexEntry | null = null;
    for (const e of index) {
      if (e.pmFrom > pos) break;
      if (pos < e.pmTo && (!best || e.pmFrom >= best.pmFrom)) best = e;
    }
    return best;
  }

  return {
    getSelectionRel() {
      // TODO in implementation: mirror editor.ts:135-175 — use the PM
      // selection, falling back to the raw DOM selection via posAtDOM, since
      // this surface is contenteditable=false and iOS Safari never propagates
      // a long-press selection into PM state.
      const { from, to } = editor.state.selection;
      const a = blockAt(from);
      const b = blockAt(to) ?? a;
      if (!a) return null;
      const text = content.toString();
      // Deleted-only block: no new-side position. Snap to the nearest
      // following retained line and record what was actually selected.
      const deletedSnippet =
        a.from == null ? editor.state.doc.textBetween(a.pmFrom, a.pmTo, ' ').slice(0, 120) : undefined;
      const lo = a.from ?? a.snap ?? 0;
      const hi = b?.to ?? b?.snap ?? lo;
      const snapped = snapOffsetsToLines(text, lo, hi);
      if (snapped.from === snapped.to) return null;
      return {
        start: encodeOffsetRel(content, snapped.from),
        end: encodeOffsetRel(content, snapped.to),
        snippet: text.slice(snapped.from, snapped.to).slice(0, 120),
        ...(deletedSnippet ? { deletedSnippet } : {}),
      };
    },
    resolveRel(startRel, endRel) {
      const s = resolveRelOffset(opts.ydoc, startRel);
      const e = resolveRelOffset(opts.ydoc, endRel);
      if (s == null || e == null) return null;
      const lo = Math.min(s, e);
      const hi = Math.max(s, e);
      // Find every indexed block overlapping the content range.
      let from: number | null = null;
      let to: number | null = null;
      for (const b of index) {
        if (b.from == null || b.to == null) continue;
        if (b.to <= lo || b.from >= hi) continue;
        from = from == null ? b.pmFrom : Math.min(from, b.pmFrom);
        to = to == null ? b.pmTo : Math.max(to, b.pmTo);
      }
      if (from == null || to == null || from === to) return null;
      return { from, to };
    },
    lineForPos(pos) {
      const b = blockAt(pos);
      const off = b?.from ?? b?.snap;
      if (off == null) return null;
      return content.toString().slice(0, off).split('\n').length;
    },
    scrollToPos(pos) {
      const clamped = Math.max(0, Math.min(pos, editor.state.doc.content.size));
      editor.commands.setTextSelection(clamped);
      editor.commands.scrollIntoView();
    },
    pulseRange(from, to) {
      const pulseId = `pulse-${from}-${to}-${Date.now()}`;
      setThreadDecorations(editor.view, { pulseId });
      setTimeout(() => setThreadDecorations(editor.view, { pulseId: null }), 1200);
    },
    setThreadRanges(ranges, activeId) {
      setThreadDecorations(editor.view, { ranges, activeId });
    },
    refresh: render,
    destroy() {
      content.unobserve(onContentChange);
      editor.destroy();
    },
  };
}
```

**Implementer notes:**
- `getSelectionRel` MUST carry the `deletedSnippet` through — check the `ReviewSurface` return type; if it doesn't allow the extra field, widen it (it flows to the thread-create body that Task 5 wired).
- Read `editor.ts:135-175` and port the DOM-selection fallback verbatim. Skipping it breaks iOS long-press commenting, which is how Bryan reviews.
- `render()` on every content change re-runs `setContent`, which resets the PM selection. Debounce in Task 9 (working-tree mode fires ~1s), and skip the re-render when the computed markdown is unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run packages/markdown-app/test/redline-editor.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
bun run lint && bun run typecheck
git add packages/markdown-app/src/redline/redline-editor.ts packages/markdown-app/test/redline-editor.test.ts
git commit -m "feat(redline): read-only Tiptap surface implementing ReviewSurface"
```

---

### Task 9: Boot wiring + the three-way view toggle

**Files:**
- Create: `packages/markdown-app/src/redline/redline-app.ts`
- Modify: `packages/markdown-app/src/app.ts:96-111`
- Modify: `packages/markdown-app/index.html` (view-toggle group)

**Interfaces:**
- Consumes: `createRedlineEditor` (Task 8), `mountReviewChrome` (`review-chrome.ts`), `renderDiffNav` (`diff-nav.ts`), `bootCode` (`code/code-app.ts`).
- Produces: `bootRedline(opts)` — same option shape as `bootCode`.

- [ ] **Step 1: Read the boot path you're mirroring**

Read `packages/markdown-app/src/code/code-app.ts` end to end. `bootRedline` is a sibling of it: same diff-nav wiring, same base-text fetch, same reading tracker, same pill affordance, same chrome mount — the only difference is the surface and the toggle. Reuse, don't retype: extract the shared pill/banner helpers if the duplication is more than ~30 lines.

- [ ] **Step 2: Write `bootRedline`**

Key requirements, in priority order:

1. **Fetch `baseText` before mounting** — same `GET /api/docs/${docId}/diff` call as `code-app.ts:60-67`.
2. **`baseText == null` → fall back to `bootCode`.** The repo was pruned; there is no redline to compute. Show the same banner `code-app.ts` shows.
3. **Toggle: Redline | Diff | File.** Redline is the default for `.md`. Redline and the CodeMirror modes are different surfaces, so switching means tearing down one and mounting the other — persist the choice in `localStorage` under a per-doc key so it survives the reload, and re-mount the chrome against the new surface.
4. **Debounce the re-render** (250ms) so a working-tree review saving every ~1s doesn't thrash `setContent`.

- [ ] **Step 3: Wire the app.ts branch**

Replace `packages/markdown-app/src/app.ts:101-111` with:

```ts
  // Markdown files inside a diff review get the Word-style redline surface:
  // prose rendered as prose with inline strikethrough/underline, instead of
  // raw markdown source with +/- gutters. Non-markdown diff docs, and .md
  // files whose base text is unavailable, keep the CodeMirror surface.
  if (docType === 'diff' && (docRelPath ?? '').toLowerCase().endsWith('.md')) {
    void bootRedline({
      docId,
      client,
      user,
      sourceUrl: docSourceUrl,
      workspaceId: docWorkspaceId,
      docType,
      relPath: docRelPath,
    });
    return;
  }
  if (docType === 'code' || docType === 'diff') {
    void bootCode({
      docId,
      client,
      user,
      sourceUrl: docSourceUrl,
      workspaceId: docWorkspaceId,
      docType,
      relPath: docRelPath,
    });
    return;
  }
```

Add the import at the top of `app.ts`:

```ts
import { bootRedline } from './redline/redline-app.ts';
```

- [ ] **Step 4: Add the toggle button**

In `packages/markdown-app/index.html`, find the `view-toggle` group holding `view-diff` / `view-file` and add a third button *before* them:

```html
<button id="view-redline" class="active" aria-pressed="true">Redline</button>
```

- [ ] **Step 5: Verify end to end against a real server**

This is the step that catches what unit tests can't. Do NOT use the fleet-shared prod server on :8787 — start an isolated instance:

```bash
bun run packages/server/src/bin.ts --port 8795 &
```

Create a diff review over a branch of this repo that changes a `.md` file, open the returned URL against :8795, and confirm: prose renders as prose; a reworded sentence shows only the changed words; the toggle switches to the source diff and back; a comment made in the redline appears in the source diff view on the same line.

State in the commit message what you verified and what you could not.

- [ ] **Step 6: Commit**

```bash
bun run lint && bun run typecheck && bun run test
git add packages/markdown-app/src/redline/redline-app.ts packages/markdown-app/src/app.ts packages/markdown-app/index.html
git commit -m "feat(redline): boot .md diff docs into the redline surface with a view toggle"
```

---

### Task 10: Styles + mobile

**Files:**
- Modify: `packages/markdown-app/src/styles.css`

- [ ] **Step 1: Add the redline styles**

Append to `packages/markdown-app/src/styles.css`. Requirements:

- `ins.lf-ins` — underline, green-ish, no background fill that would fight the thread highlight.
- `del.lf-del` — line-through, red-ish, slightly muted so surviving text stays dominant.
- `[data-lf-change='ins'|'del']` block styling — a left change bar, matching the `.cm-changedLine` bar in the source view so the two surfaces read as one product.
- Both must survive the existing thread-highlight and `.pulse` decorations layering on top.
- Do NOT rely on color alone — the strikethrough and underline carry the meaning for colorblind readers.

- [ ] **Step 2: Verify at 430px**

Per `docs/product/design-mobile.md`. Watch specifically for: a long unbroken `<del>` run forcing horizontal scroll (the CSS Grid `1fr` trap from `learnings.md` — use `minmax(0, 1fr)`), and the three-button toggle wrapping.

- [ ] **Step 3: Commit**

```bash
bun run lint
git add packages/markdown-app/src/styles.css
git commit -m "style(redline): ins/del + change-bar styling, verified at 430px"
```

---

### Task 11: Ship

- [ ] **Step 1: Full verification**

```bash
bun run lint && bun run typecheck && bun run test
```
Expected: all green. `bun run test` runs both vitest and the server suite.

- [ ] **Step 2: Invoke the ship skill**

Per `CLAUDE.md` / `workflow-conventions.md`, invoke `team-lead-fleet:ship-guarded` — this touches a surface Bryan relies on daily (diff review), so the regression-risk gate is the right one. It runs code review, opens the PR, monitors CI and Copilot, and merges.

**Report honestly in the PR:** the block-pairing similarity threshold (0.35) is a guess that has not been tuned against real documents, and the redline is unverified against a document with mermaid diagrams or nested lists deeper than two levels.

## Self-Review Notes

- **Spec coverage:** goal → Tasks 2-9; provenance map → Tasks 6-8 (refined to block-level, documented above); multi-client → no code needed (purity is the mechanism), asserted by Task 4's determinism tests; deleted-text anchoring → Tasks 5, 8; block pairing → Task 4; recompute discipline → Tasks 8, 9; testing → every task; out-of-scope (presence, accept/reject) → not planned, correctly.
- **Known risk carried:** Task 0 gates the rendering approach. If it fails, Tasks 6-8 change shape and the plan needs revision before continuing.
- **Type consistency:** `RedlineSegment`/`RedlineBlock`/`MarkdownBlockSpan` are defined once (Tasks 2-4) and consumed unchanged in 6-8. `lfFrom`/`lfTo`/`lfSnap`/`lfChange` are the attribute names throughout Tasks 6-8 and 10.
