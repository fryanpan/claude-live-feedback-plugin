/**
 * Markdown in, markdown out: the only two directions the prose fragment is
 * ever converted along, and the block vocabulary shared by both.
 *
 * `parseMarkdownBlocks` builds `Y.XmlElement` blocks from source text and
 * `serializeFragmentToMarkdown` writes the tree back out, which is what the
 * file-backed-doc writer flushes to disk. `applyMarkdownToFragment` is the
 * two composed under an LCS diff, so a reparse touches only the blocks that
 * actually changed and every anchor over the rest survives.
 *
 * Deliberately a subset, not a markdown implementation — the supported
 * block and inline vocabulary is listed on `parseMarkdownBlocks` below, and
 * the serializer round-trips exactly that much. Both halves live in one
 * file because they are one grammar: a mark the parser learns and the
 * serializer does not emit is a doc that loses text on its next flush.
 *
 * Builds on `prose-fragment.ts`. Imports no sibling in the family.
 */
import * as Y from 'yjs';
import { LCS_CELL_BUDGET, lcsKept } from './lcs.ts';
import { getProseFragment, headingLevelOf } from './prose-fragment.ts';
import { SUGGEST_INSERT_MARK } from './suggest.ts';

/**
 * Parse a small subset of markdown into Y.XmlElement blocks matching
 * tiptap-starter-kit's schema. Enough for the agent to answer "add a
 * section", "insert a bullet list", "add a heading" without having to
 * build XmlElement trees by hand.
 *
 * Supported:
 *   # / ## / ###        → heading (level from # count)
 *   -, *                → bulletList > listItem > paragraph
 *   1.                  → orderedList > listItem > paragraph
 *   >                   → blockquote > paragraph
 *   ```                 → codeBlock
 *   ---                 → horizontalRule
 *   (anything else)     → paragraph (blank lines split paragraphs)
 *
 * Deliberately NOT a full markdown parser. Inline marks (bold/italic/
 * links) come through as literal text for now — the agent can follow
 * up with find_and_replace or edit_at_anchor to add marks later.
 */
/**
 * Tokenize a line of inline prose into a Yjs delta with mark attributes.
 * Handles the common syntax round-tripped by tiptap-markdown:
 *   `code`   **bold**   *italic*   ~~strike~~   [text](url)
 * Underscore variants (__bold__, _italic_) are supported too.
 * Ambiguous text (unpaired asterisks etc.) passes through literal.
 */
export function inlineMarksToDelta(
  text: string,
): Array<{ insert: string; attributes?: Record<string, unknown> }> {
  const out: Array<{ insert: string; attributes?: Record<string, unknown> }> = [];
  let buf = '';
  let i = 0;
  const flush = () => {
    if (buf.length === 0) return;
    out.push({ insert: buf });
    buf = '';
  };
  const emitWith = (inner: string, attrs: Record<string, unknown>) => {
    flush();
    const nested = inlineMarksToDelta(inner);
    for (const op of nested) {
      out.push({
        insert: op.insert,
        attributes: { ...(op.attributes ?? {}), ...attrs },
      });
    }
  };

  while (i < text.length) {
    const r = text.slice(i);

    // `code`
    if (r.startsWith('`')) {
      const close = r.indexOf('`', 1);
      if (close > 1) {
        flush();
        out.push({ insert: r.slice(1, close), attributes: { code: true } });
        i += close + 1;
        continue;
      }
    }

    // [text](url) — the label is parsed recursively so `[**b**](u)` (which
    // is what the serializer emits for a bold link: link outermost) reads
    // back as bold+link rather than as a link whose text is literally `**b**`.
    if (r.startsWith('[')) {
      const rb = r.indexOf(']');
      if (rb > 0 && r[rb + 1] === '(') {
        const rp = r.indexOf(')', rb + 2);
        if (rp > 0) {
          emitWith(r.slice(1, rb), { link: { href: r.slice(rb + 2, rp) } });
          i += rp + 1;
          continue;
        }
      }
    }

    // ~~strike~~
    if (r.startsWith('~~')) {
      const close = r.indexOf('~~', 2);
      if (close > 2) {
        emitWith(r.slice(2, close), { strike: true });
        i += close + 2;
        continue;
      }
    }

    // 2-char wrappers: **bold** / __bold__
    let matched = false;
    for (const m of ['**', '__'] as const) {
      if (r.startsWith(m)) {
        const close = findEmphasisClose(r, m);
        if (close > m.length) {
          emitWith(r.slice(m.length, close), { bold: true });
          i += close + m.length;
          matched = true;
          break;
        }
      }
    }
    if (matched) continue;

    // 1-char wrappers: *italic* / _italic_
    // Require the inner char to be non-space so "a * b" doesn't italicize.
    for (const m of ['*', '_'] as const) {
      if (!r.startsWith(m) || !r[1] || r[1] === ' ' || r[1] === m) continue;
      // CommonMark: underscore emphasis does NOT open/close intra-word
      // (asterisk does). Without this, snake_case identifiers like
      // `estimated_effort_h` get parsed as `estimated`+<em>effort</em>+`h`
      // and round-trip back to `estimated*effort*h` — which broke bound-doc
      // editing of any doc full of snake_case field names.
      if (m === '_' && /\w/.test(i > 0 ? (text[i - 1] ?? '') : '')) continue;
      const close = findEmphasisClose(r, m);
      if (close > 1 && r[close - 1] !== ' ') {
        if (m === '_' && /\w/.test(r[close + 1] ?? '')) continue;
        emitWith(r.slice(1, close), { italic: true });
        i += close + 1;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    buf += text[i];
    i++;
  }
  flush();
  return out;
}

/**
 * Find the index (in `r`) of the delimiter run that closes an emphasis span
 * opened by `delim` (`*`, `**`, `_` or `__`) at the start of `r`. Returns -1
 * when there is no closer.
 *
 * A plain `indexOf` cannot read nested emphasis: in `**a *b***` the first
 * `**` after the opener is INSIDE the closing `***`, so the bold ended one
 * character early and the italic never parsed. The serializer legitimately
 * emits exactly that shape (bold containing an italic that ends where the
 * bold ends), so the parser has to read it back or the round-trip loses the
 * mark. The rule: walk delimiter RUNS, not characters. A run of the other
 * width toggles an "inner span is open" flag and is skipped; a run of our own
 * width closes; a mixed run (odd length ≥ 3) is the inner span's closer glued
 * to ours — inner closes first when an inner span is open, otherwise the outer
 * closer comes first and the remainder is left for the caller (`*a***b**` is
 * italic a then bold b, per CommonMark).
 *
 * Underscore runs inside a word (`snake_case`) are never delimiters.
 */
function findEmphasisClose(r: string, delim: '*' | '**' | '_' | '__'): number {
  const ch = delim[0] as string;
  const want = delim.length;
  let innerOpen = false;
  let p = want;
  while (p < r.length) {
    if (r[p] !== ch) {
      p++;
      continue;
    }
    let len = 1;
    while (r[p + len] === ch) len++;
    const intraWord = ch === '_' && /\w/.test(r[p - 1] ?? '') && /\w/.test(r[p + len] ?? '');
    if (intraWord) {
      p += len;
      continue;
    }
    if (want === 1) {
      if (len === 1) return p;
      if (len % 2 === 0) {
        if ((len / 2) % 2 === 1) innerOpen = !innerOpen;
        p += len;
        continue;
      }
      // Odd run ≥ 3: when an inner 2-char span is open it closes first
      // (2 chars), then our single closer; anything past those 3 is left
      // for the caller (`*a**b*****c**` closes at the third char of the
      // 5-run, leaving `**` to open the next bold). With no inner span our
      // closer comes first and the rest is the caller's.
      return innerOpen ? p + 2 : p;
    }
    // want === 2
    if (len === 1) {
      innerOpen = !innerOpen;
      p += 1;
      continue;
    }
    if (len === 2) return p;
    // Run ≥ 3: when an inner italic is open it closes first (1 char), then
    // our `**`; anything past those 3 is left for the caller
    // (`***both****ital*` closes at the second char of the 4-run, leaving
    // `*` to open the next italic). With no inner span our closer comes
    // first and the rest is the caller's.
    return innerOpen ? p + 1 : p;
  }
  return -1;
}

export function insertDeltaInto(
  xmlText: Y.XmlText,
  delta: ReturnType<typeof inlineMarksToDelta>,
): void {
  if (delta.length === 0) return;
  xmlText.applyDelta(delta);
}

/**
 * Store a heading's level as a NUMBER, not a string.
 *
 * y-prosemirror hands Yjs attributes to prosemirror verbatim, and Tiptap's
 * Heading extension picks its tag with `options.levels.includes(attrs.level)`
 * where `levels` is `[1..6]` — numbers. A string `'2'` fails that check, so
 * the node renders as `<h1>` and every heading in the doc comes out the same
 * size. (This is why manually re-setting a heading in the editor "fixed" it:
 * prosemirror writes the number back.) Yjs itself stores any JSON value in an
 * attribute; the default Y.XmlElement type param is what narrows it to string.
 */
function setHeadingLevel(el: Y.XmlElement, level: number): void {
  const clamped = Math.min(6, Math.max(1, level));
  (el as unknown as Y.XmlElement<{ level: number }>).setAttribute('level', clamped);
}

/**
 * Rewrite any heading whose `level` attribute is still a string (every doc
 * persisted before the fix above) to the numeric form. Returns how many
 * headings changed; idempotent, so it's safe to run on every room load.
 */
export function normalizeHeadingLevels(
  doc: Y.Doc,
  opts: { transactionOrigin?: unknown } = {},
): number {
  const fragment = getProseFragment(doc);
  const stale: Y.XmlElement[] = [];
  const visit = (node: Y.XmlElement | Y.XmlText | Y.XmlHook): void => {
    if (!(node instanceof Y.XmlElement)) return;
    if (node.nodeName === 'heading' && typeof node.getAttribute('level') !== 'number') {
      stale.push(node);
    }
    for (const child of node.toArray()) visit(child as Y.XmlElement | Y.XmlText);
  };
  for (const child of fragment.toArray()) visit(child as Y.XmlElement | Y.XmlText);
  if (stale.length === 0) return 0;
  doc.transact(() => {
    for (const el of stale) {
      setHeadingLevel(el, headingLevelOf(el));
    }
  }, opts.transactionOrigin ?? 'file-watch');
  return stale.length;
}

/** Serialization keys for a fresh parse of `markdown`. A prelim (not yet
 *  integrated) Y.XmlElement exposes neither children nor attributes, so the
 *  blocks are integrated into a throwaway doc to be read. */
function markdownBlockKeys(
  markdown: string,
  key: (node: Y.XmlElement | Y.XmlText, i: number) => string,
): string[] {
  const scratch = new Y.Doc();
  const fragment = getProseFragment(scratch);
  fragment.push(parseMarkdownBlocks(markdown));
  return (fragment.toArray() as (Y.XmlElement | Y.XmlText)[]).map(key);
}

/**
 * Replace the fragment's top-level blocks with a fresh parse of `markdown`,
 * touching only the blocks that actually changed.
 *
 * The naive `fragment.delete(0, len) + push(next)` destroys the Y.XmlText
 * identity of EVERY block, which orphans every thread anchor in the doc —
 * even threads on paragraphs the rewrite never touched. Diffing at block
 * granularity (blocks keyed by their serialized markdown) keeps untouched
 * blocks in place, so their RelativePositions keep resolving.
 *
 * Returns true if the fragment changed.
 */
export function applyMarkdownToFragment(fragment: Y.XmlFragment, markdown: string): boolean {
  const prev = fragment.toArray() as (Y.XmlElement | Y.XmlText)[];
  // serializeBlock returns null for a text-empty heading, an empty XmlText and
  // a src-less image. Those still have to be told apart, so the fallback key
  // carries the node type AND its attributes — an empty `## ` and an empty
  // `#### ` differ only in `level`, and a type-only key would call them equal
  // and keep the stale block (with its stale level).
  const key = (node: Y.XmlElement | Y.XmlText, i: number): string => {
    const s = serializeBlock(node);
    if (s != null) return s;
    if (!(node instanceof Y.XmlElement)) return `__empty_text_${i}__`;
    return `__empty_${node.nodeName}_${JSON.stringify(node.getAttributes())}__`;
  };
  // Blocks whose entire text is a pending insert-suggestion serialize to
  // NOTHING, so they have no key in disk space — an LCS over them would
  // delete a pending proposal on any external disk change, even one that
  // never touched its neighborhood. Treat them as transparent instead: they
  // are excluded from the diff, never deleted, and new blocks are positioned
  // relative to the accepted blocks only.
  const suggestedPrev = prev.map((b) => b instanceof Y.XmlElement && isEntirelySuggestedInsert(b));
  const acceptedIdx: number[] = [];
  for (let i = 0; i < prev.length; i++) {
    if (!suggestedPrev[i]) acceptedIdx.push(i);
  }
  const prevKeys = acceptedIdx.map((i) => key(prev[i]!, i));
  const nextKeys = markdownBlockKeys(markdown, key);
  // Keyed separately from the blocks we insert: reading a prelim block's
  // content requires integrating it into a doc, and an integrated Yjs type
  // can't then be re-parented into the live fragment. (So the markdown is
  // parsed twice per call — cheap next to the Yjs work, and this runs at most
  // once per 500ms mtime poll.)
  const next = parseMarkdownBlocks(markdown);

  // Never wipe the doc to empty. Both call sites already guard on a zero-block
  // parse, but this is exported — make it safe by construction.
  if (next.length === 0) return false;

  // Guard the O(n·m) table. Beyond this the destructive replace is the only
  // option — which reinstates the thread-orphaning this function exists to
  // prevent, so say so out loud rather than degrading silently. 2000×2000
  // blocks is far past any real review doc (this repo's run 30–100).
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
  if (keptOld.size === n && keptNew.size === m) return false;

  // Deletions first, right-to-left so earlier indices stay valid. `keptOld`
  // indexes the ACCEPTED (non-suggested) blocks; map back through acceptedIdx
  // so fully-suggested blocks are never deleted.
  for (let a = n - 1; a >= 0; a--) {
    if (!keptOld.has(a)) fragment.delete(acceptedIdx[a]!, 1);
  }
  // The fragment now holds the kept accepted blocks in order, interleaved
  // with any surviving fully-suggested blocks. Insert new block j where the
  // j-th accepted block sits (append past the end), counting suggested
  // blocks as transparent — so a proposal stays attached to its preceding
  // accepted neighbor.
  for (let j = 0; j < m; j++) {
    if (!keptNew.has(j)) fragment.insert(acceptedInsertPos(fragment, j), [next[j]]);
  }
  return true;
}

/** Index in `fragment` of the j-th accepted (non-fully-suggested) block, or
 *  fragment.length when there are fewer than j+1 accepted blocks. */
function acceptedInsertPos(fragment: Y.XmlFragment, j: number): number {
  const kids = fragment.toArray() as (Y.XmlElement | Y.XmlText)[];
  let accepted = 0;
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i]!;
    if (k instanceof Y.XmlElement && isEntirelySuggestedInsert(k)) continue;
    if (accepted === j) return i;
    accepted++;
  }
  return kids.length;
}

export function parseMarkdownBlocks(markdown: string): Y.XmlElement[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: Y.XmlElement[] = [];
  let i = 0;

  // These read a line that has already had its indent stripped by the
  // caller. The indent-aware forms — `isListItemLine`, `indentOf` — are
  // below with the list builder, and list detection uses only those now:
  // a column-anchored `isBullet` sent an indented item into the paragraph
  // fallback, which then swallowed every sibling after it.
  const isHeading = (s: string) => /^#{1,6}\s+/.test(s);
  const isQuote = (s: string) => /^>\s?/.test(s);
  const isFence = (s: string) => /^```/.test(s);
  const isRule = (s: string) => /^(---|\*\*\*|___)\s*$/.test(s);
  // Pipe-table heuristics: a table row has a leading/trailing pipe with
  // cells between them. The second line is a separator of dashes.
  const isTableRow = (s: string) => /^\s*\|.*\|\s*$/.test(s);
  const isTableSep = (s: string) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(s);
  // A line that is *only* a markdown image: ![alt](src) or ![alt](src "title").
  // Captured as an image node so the src lives in an attribute and never gets
  // run through inline emphasis parsing (which would mangle `_` in URLs).
  const isImage = (s: string) => /^!\[[^\]]*\]\([^)]*\)\s*$/.test(s.trim());

  // A block starter ALWAYS interrupts a paragraph, wherever it sits on the
  // line. The predicates above anchor at column 0, which is what a plain
  // markdown grammar wants; but the paragraph gatherer used them directly,
  // so a `### heading` or a `- item` carrying any leading whitespace was
  // read as more prose and glued into the paragraph as literal characters.
  // That is the "one slip flattens forty lines" shape: once in the
  // paragraph fallback nothing stopped it, and the markdown syntax showed
  // on screen. CommonMark: a heading (and a list item) interrupts a
  // paragraph. Fences stay column-anchored — the closing-fence scan below
  // is column-anchored too, and widening only one end never closes.
  const isBlockStart = (s: string) => {
    const t = s.trimStart();
    return (
      isHeading(t) ||
      isListItemLine(s) ||
      isQuote(t) ||
      isFence(s) ||
      isRule(t) ||
      isImage(t) ||
      isTableRow(s)
    );
  };

  const mkParagraph = (text: string): Y.XmlElement => {
    const p = new Y.XmlElement('paragraph');
    if (text.length > 0) {
      const t = new Y.XmlText();
      insertDeltaInto(t, inlineMarksToDelta(text));
      p.insert(0, [t]);
    }
    return p;
  };

  // Build an `image` node from a standalone `![alt](src "title")` line. The
  // node name matches the Tiptap Image extension so it renders in the live
  // editor; src/alt/title round-trip as attributes. src is matched as a run
  // of non-space chars, so remote URLs and relative paths both work and
  // underscores in the path are never parsed as emphasis.
  const mkImage = (raw: string): Y.XmlElement => {
    const m = raw.trim().match(/^!\[([^\]]*)\]\(\s*(\S+?)(?:\s+"([^"]*)")?\s*\)$/);
    const img = new Y.XmlElement('image');
    img.setAttribute('src', m?.[2] ?? '');
    img.setAttribute('alt', m?.[1] ?? '');
    if (m?.[3]) img.setAttribute('title', m[3]);
    return img;
  };

  // --- Nested list parsing -------------------------------------------------
  // The serializer emits 2-space-per-level indentation; the parser reads
  // nesting back by leading-space count so the round-trip is lossless. We
  // accept any increase in indentation as a deeper level (handles 2- and
  // 4-space human-authored markdown alike). `isBullet`/`isNumbered` above
  // anchor at column 0; these indent-aware variants drive the list builder.
  const indentOf = (s: string) => s.match(/^ */)?.[0].length ?? 0;
  const isListItemLine = (s: string) => /^\s*(?:[-*]|\d+\.)\s+/.test(s);
  const isOrderedLine = (s: string) => /^\s*\d+\.\s+/.test(s);
  const stripMarker = (s: string) => s.replace(/^\s*(?:[-*]|\d+\.)\s+/, '');

  // Gather an item's child content (nested lists + continuation paragraphs,
  // all indented deeper than `baseIndent`) into `children`. Returns the next
  // index. An ARRAY, not the item: the item is a prelim type until the whole
  // list lands in the doc, and appending with `li.insert(li.length, …)` read
  // `.length` off it — Yjs logs "Invalid access: Add Yjs type to a document
  // before reading data." for every such read. The caller inserts the array
  // once. See `mkTable` for the measurement; lists and tables share the bug
  // and shared the fix.
  function consumeItemChildren(
    start: number,
    baseIndent: number,
    children: Y.XmlElement[],
  ): number {
    let k = start;
    for (;;) {
      let j = k;
      while (j < lines.length && (lines[j] ?? '').trim() === '') j++;
      if (j >= lines.length) return k;
      const ind = indentOf(lines[j] ?? '');
      if (ind <= baseIndent) return k; // back to sibling level or shallower
      // A heading ends the item's content, indented or not. It used to fall
      // into the paragraph gatherer below, which had no heading rule at all
      // — so `### …` and everything after it landed inside the item as
      // literal text. Hand it back to the top-level loop, which now reads an
      // indented ATX heading as a heading.
      if (isHeading((lines[j] ?? '').trimStart())) return k;
      k = j; // consume intervening blanks now that we know content follows
      if (isListItemLine(lines[k] ?? '')) {
        const [sub, next] = parseListAt(k, ind);
        children.push(sub);
        k = next;
      } else if (isFence((lines[k] ?? '').trim())) {
        // A fenced code block inside the item. The serializer emits it
        // indented one level under the marker; read it back as a codeBlock
        // child (stripping that indent from every line) instead of letting
        // the paragraph gatherer below join its lines with spaces — which
        // flattened multi-line code onto one line on every round-trip.
        const fenceLine = (lines[k] ?? '').trim();
        const lang = fenceLine.replace(/^```/, '').trim();
        const strip = (s: string) => (indentOf(s) >= ind ? s.slice(ind) : s.trimStart());
        k++;
        const code: string[] = [];
        while (k < lines.length && !isFence((lines[k] ?? '').trim())) {
          code.push(strip(lines[k] ?? ''));
          k++;
        }
        if (k < lines.length) k++; // closing fence
        const cb = new Y.XmlElement('codeBlock');
        if (lang) cb.setAttribute('language', lang);
        const t = new Y.XmlText();
        t.insert(0, code.join('\n'));
        cb.insert(0, [t]);
        children.push(cb);
      } else {
        const paraLines: string[] = [];
        while (
          k < lines.length &&
          (lines[k] ?? '').trim() !== '' &&
          indentOf(lines[k] ?? '') > baseIndent &&
          !isListItemLine(lines[k] ?? '') &&
          !isHeading((lines[k] ?? '').trimStart()) &&
          !isFence((lines[k] ?? '').trim())
        ) {
          paraLines.push((lines[k] ?? '').trim());
          k++;
        }
        children.push(mkParagraph(paraLines.join(' ')));
      }
    }
  }

  // Parse a list whose items sit at exactly `baseIndent`. Consumes sibling
  // items, their nested lists, and continuation paragraphs. Returns the
  // list element and the next index.
  function parseListAt(start: number, baseIndent: number): [Y.XmlElement, number] {
    const ordered = isOrderedLine(lines[start] ?? '');
    const list = new Y.XmlElement(ordered ? 'orderedList' : 'bulletList');
    const items: Y.XmlElement[] = [];
    let k = start;
    for (;;) {
      let j = k;
      while (j < lines.length && (lines[j] ?? '').trim() === '') j++;
      if (j >= lines.length) {
        k = j;
        break;
      }
      const ind = indentOf(lines[j] ?? '');
      if (ind < baseIndent) break;
      if (ind > baseIndent) break; // deeper content with no open item — malformed
      if (!isListItemLine(lines[j] ?? '')) break; // non-item line at this level
      if (isOrderedLine(lines[j] ?? '') !== ordered) break; // list type switches
      k = j;
      const children: Y.XmlElement[] = [mkParagraph(stripMarker(lines[k] ?? ''))];
      k++;
      k = consumeItemChildren(k, baseIndent, children);
      const li = new Y.XmlElement('listItem');
      li.insert(0, children);
      items.push(li);
    }
    list.insert(0, items);
    return [list, k];
  }

  // YAML frontmatter — only at the very top of the file. Captured as a
  // single codeBlock(language='yaml-frontmatter') holding the raw YAML text
  // so the keys aren't merged into a single space-joined paragraph by the
  // generic line-coalescer below, and the serializer can emit `---\n…\n---`
  // verbatim. Falls through to normal parsing if there's no closing `---`.
  if (i < lines.length && (lines[i] ?? '').trim() === '---') {
    let j = i + 1;
    while (j < lines.length && (lines[j] ?? '').trim() !== '---') j++;
    if (j < lines.length) {
      const yamlLines: string[] = [];
      for (let k = i + 1; k < j; k++) {
        const ln = lines[k] ?? '';
        // Drop blank lines so frontmatter that was previously round-tripped
        // through the old parser (which left blank lines between values)
        // self-heals on the next reparse.
        if (ln.trim() !== '') yamlLines.push(ln);
      }
      if (yamlLines.length > 0) {
        const cb = new Y.XmlElement('codeBlock');
        cb.setAttribute('language', 'yaml-frontmatter');
        const t = new Y.XmlText();
        t.insert(0, yamlLines.join('\n'));
        cb.insert(0, [t]);
        out.push(cb);
        i = j + 1;
      }
    }
  }

  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i++;
      continue;
    }

    if (isHeading(line.trimStart())) {
      const m = line.trimStart().match(/^(#{1,6})\s+(.*)$/);
      const level = Math.min(6, Math.max(1, m?.[1]?.length ?? 1));
      const text = m?.[2] ?? '';
      const h = new Y.XmlElement('heading');
      setHeadingLevel(h, level);
      if (text) {
        const t = new Y.XmlText();
        insertDeltaInto(t, inlineMarksToDelta(text));
        h.insert(0, [t]);
      }
      out.push(h);
      i++;
      continue;
    }

    if (isRule(line.trimStart())) {
      out.push(new Y.XmlElement('horizontalRule'));
      i++;
      continue;
    }

    if (isFence(line)) {
      // Capture the language hint after the opening fence (```mermaid, ```ts, …).
      const lang = line.replace(/^```/, '').trim();
      i++;
      const code: string[] = [];
      while (i < lines.length && !isFence(lines[i] ?? '')) {
        code.push(lines[i] ?? '');
        i++;
      }
      if (i < lines.length) i++; // skip closing fence
      const cb = new Y.XmlElement('codeBlock');
      if (lang) cb.setAttribute('language', lang);
      const t = new Y.XmlText();
      t.insert(0, code.join('\n'));
      cb.insert(0, [t]);
      out.push(cb);
      continue;
    }

    // Indent-aware: a list whose items carry leading whitespace is still a
    // list. Column-anchored detection here sent an indented item into the
    // paragraph fallback, which then swallowed every sibling item after it.
    if (isListItemLine(line)) {
      const [list, next] = parseListAt(i, indentOf(line));
      out.push(list);
      i = next;
      continue;
    }

    if (isQuote(line.trimStart())) {
      const quoted: string[] = [];
      while (i < lines.length && isQuote((lines[i] ?? '').trimStart())) {
        quoted.push((lines[i] ?? '').trimStart().replace(/^>\s?/, ''));
        i++;
      }
      const bq = new Y.XmlElement('blockquote');
      bq.insert(0, [mkParagraph(quoted.join('\n'))]);
      out.push(bq);
      continue;
    }

    // GFM-style pipe table. Detected by: header row → separator row
    // (dashes + pipes) → one-or-more body rows. Cells are split on
    // `|`, trimmed, and wrapped as paragraph children of each cell.
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1] ?? '')) {
      const headerCells = splitTableRow(line);
      i += 2; // consume header + separator
      const bodyRows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i] ?? '')) {
        bodyRows.push(splitTableRow(lines[i] ?? ''));
        i++;
      }
      out.push(mkTable(headerCells, bodyRows));
      continue;
    }

    // Standalone image line → image node (keeps the src out of inline parsing).
    if (isImage(line)) {
      out.push(mkImage(line));
      i++;
      continue;
    }

    // Default: a paragraph. Gather consecutive non-blank, non-block-start
    // lines and join with a space so soft-wrapped prose becomes one
    // paragraph (standard markdown convention).
    // `trimStart`, not `trim`: the leading whitespace has to go, because a
    // continuation line's indent would otherwise be joined into the prose as
    // characters. Trailing whitespace has to STAY, because two spaces at the
    // end of a line is markdown's hard line break, and trimming it silently
    // rewrote the author's line breaks on the next write-back.
    const paraLines: string[] = [line.trimStart()];
    i++;
    while (i < lines.length) {
      const nxt = lines[i] ?? '';
      if (nxt.trim() === '' || isBlockStart(nxt)) break;
      paraLines.push(nxt.trimStart());
      i++;
    }
    out.push(mkParagraph(paraLines.join(' ')));
  }
  return out;
}

export function splitTableRow(line: string): string[] {
  // Strip the optional leading/trailing pipe, then split on UNESCAPED `|`
  // only: `\|` is cell content — the serializer's escape for a literal
  // pipe — so honoring it here is what makes parse invert serialize.
  // Splitting on every `|` shredded such cells into fragments that could
  // never round-trip or structurally match. The escape is removed from the
  // cell text; the serializer puts it back on the way out.
  const inner = line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '');
  return inner.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function mkTable(headerCells: string[], bodyRows: string[][]): Y.XmlElement {
  // Every row and the table itself are PRELIM types here — nothing is in a
  // doc yet — so each is filled with ONE insert of a ready-made array.
  // Reading `.length` on a prelim type (the old `insert(row.length, …)`
  // append) makes Yjs log "Invalid access: Add Yjs type to a document
  // before reading data." once per cell — and hydrate parses every bound
  // doc. Replaying that parse over the live data dir's 1,465 bound docs on
  // 2026-08-29 measured 57,936 such warnings, 11.1 MB of stderr, in ONE
  // pass; the fix takes it to zero, with byte-identical output for all
  // 1,465. Parse time is unchanged — this was never a speed bug, it was an
  // unbounded log.
  const mkCell = (name: 'tableHeader' | 'tableCell', text: string): Y.XmlElement => {
    const cell = new Y.XmlElement(name);
    const p = new Y.XmlElement('paragraph');
    if (text.length > 0) {
      const t = new Y.XmlText();
      insertDeltaInto(t, inlineMarksToDelta(text));
      p.insert(0, [t]);
    }
    cell.insert(0, [p]);
    return cell;
  };
  const mkRow = (cells: Y.XmlElement[]): Y.XmlElement => {
    const tr = new Y.XmlElement('tableRow');
    tr.insert(0, cells);
    return tr;
  };
  const headerRow = mkRow(headerCells.map((cell) => mkCell('tableHeader', cell)));
  // Body rows — pad with empty cells if a row is short so shape stays rectangular.
  const rows = bodyRows.map((row) =>
    mkRow(headerCells.map((_, ci) => mkCell('tableCell', row[ci] ?? ''))),
  );
  const table = new Y.XmlElement('table');
  table.insert(0, [headerRow, ...rows]);
  return table;
}

/**
 * Parse markdown and serialize it straight back: the serializer-space
 * normal form. Two strings with the same normal form carry identical
 * document content and differ only in formatting the round-trip doesn't
 * preserve (blank-line runs, list indent style, ...). Sync arbitration
 * uses this to tell pure normalization drift apart from a real edit.
 */
export function normalizeMarkdown(markdown: string): string {
  const doc = new Y.Doc();
  try {
    const fragment = getProseFragment(doc);
    doc.transact(() => {
      const blocks = parseMarkdownBlocks(markdown);
      // Parse + push, NOT applyMarkdownToFragment: the fragment is empty so
      // the diff would insert everything anyway, and apply's block-keying
      // reads prelim types, which logs a Yjs warning per block — at hydrate
      // this runs for every bound doc, so that's log spam at scale.
      if (blocks.length > 0) fragment.push(blocks);
    });
    return serializeFragmentToMarkdown(fragment);
  } finally {
    doc.destroy();
  }
}

/**
 * Serialize the entire prose fragment back into markdown. Round-trips
 * the block types parseMarkdownBlocks handles (headings, paragraphs,
 * bullet/ordered lists, blockquotes, code blocks, horizontal rules).
 * Inline marks (bold/italic/link) are lost — same limitation as the
 * parser. Used by the file-backed-doc writer so edits flow out to
 * disk as human-readable markdown.
 */
export function serializeFragmentToMarkdown(fragment: Y.XmlFragment): string {
  const children = fragment.toArray();
  // Recognize a leading YAML-frontmatter pattern: horizontalRule, then one or
  // more paragraphs (the YAML lines), then a closing horizontalRule. The
  // markdown parser doesn't have a typed frontmatter node — it tokenizes
  // `---` as horizontalRule and the YAML lines as plain paragraphs — so on
  // round-trip we need to emit the block back as `---\nyaml\n---` without
  // the `\n\n` block separators that would otherwise appear between every
  // paragraph and corrupt the YAML. Self-heals docs whose frontmatter was
  // already corrupted by a prior round-trip (the parser ignores blank lines
  // so they're absent from the Yjs state — the serializer just stops
  // re-introducing them).
  let i = 0;
  let frontmatterMd: string | null = null;
  if (children.length >= 2) {
    const first = children[0];
    if (isHorizontalRuleNode(first)) {
      let j = 1;
      const yamlLines: string[] = [];
      while (j < children.length && isParagraphNode(children[j])) {
        yamlLines.push(textContent(children[j] as Y.XmlElement));
        j++;
      }
      if (j < children.length && isHorizontalRuleNode(children[j]) && yamlLines.length > 0) {
        frontmatterMd = `---\n${yamlLines.join('\n')}\n---`;
        i = j + 1;
      }
    }
  }

  const parts: string[] = [];
  if (frontmatterMd != null) parts.push(frontmatterMd);
  for (; i < children.length; i++) {
    const s = serializeBlock(children[i] as Y.XmlElement | Y.XmlText);
    if (s != null && s !== '') parts.push(s);
  }
  return parts.length > 0 ? `${parts.join('\n\n')}\n` : '';
}

function isHorizontalRuleNode(n: unknown): boolean {
  return n instanceof Y.XmlElement && n.nodeName === 'horizontalRule';
}
function isParagraphNode(n: unknown): boolean {
  return n instanceof Y.XmlElement && n.nodeName === 'paragraph';
}

/** Serialize a single block element to markdown (public accessor for
 *  get_doc's table/list rendering). */
export function serializeBlockToMarkdown(node: Y.XmlElement): string {
  return serializeBlock(node) ?? '';
}

function serializeBlock(node: Y.XmlElement | Y.XmlText): string | null {
  if (node instanceof Y.XmlText) {
    const s = node.toString();
    return s.length > 0 ? s : null;
  }
  if (!(node instanceof Y.XmlElement)) return null;
  // A block whose entire text is a pending insert-suggestion has no accepted
  // content — it contributes nothing (no empty paragraph line, no empty
  // fence). Blocks with no text at all (horizontalRule, image, a genuinely
  // empty codeBlock) are unaffected: the whole-block rule requires text.
  if (isEntirelySuggestedInsert(node)) return null;
  switch (node.nodeName) {
    case 'paragraph':
      return textContent(node);
    case 'heading': {
      const level = headingLevelOf(node);
      const text = textContent(node);
      return text.length > 0 ? `${'#'.repeat(level)} ${text}` : null;
    }
    case 'blockquote':
      return serializeBlockquote(node);
    case 'codeBlock': {
      const lang = node.getAttribute('language') ?? '';
      // YAML frontmatter is captured as a typed codeBlock at parse time so
      // the keys round-trip without being merged into a single paragraph.
      // The serializer emits it back as a `---`-bracketed block.
      if (lang === 'yaml-frontmatter') {
        return `---\n${textContent(node)}\n---`;
      }
      return `\`\`\`${lang}\n${textContent(node)}\n\`\`\``;
    }
    case 'horizontalRule':
      return '---';
    case 'bulletList':
    case 'orderedList':
      return serializeList(node, 0);
    case 'table':
      return serializeTable(node);
    case 'image': {
      const src = String(node.getAttribute('src') ?? '');
      if (!src) return null;
      const alt = String(node.getAttribute('alt') ?? '');
      const title = node.getAttribute('title');
      const titlePart = title ? ` "${String(title)}"` : '';
      return `![${alt}](${src}${titlePart})`;
    }
    default:
      return textContent(node);
  }
}

function serializeTable(table: Y.XmlElement): string {
  const rows = table
    .toArray()
    .filter((n): n is Y.XmlElement => n instanceof Y.XmlElement && n.nodeName === 'tableRow')
    // A fully-suggested row would otherwise serialize as an all-empty `| |`
    // line — it has no accepted content, so it contributes nothing.
    .filter((r) => !isEntirelySuggestedInsert(r));
  if (rows.length === 0) return '';
  const cells: string[][] = rows.map((r) =>
    r
      .toArray()
      .filter(
        (c): c is Y.XmlElement =>
          c instanceof Y.XmlElement && (c.nodeName === 'tableCell' || c.nodeName === 'tableHeader'),
      )
      .map((c) => textContent(c).replace(/\|/g, '\\|').replace(/\n/g, ' ')),
  );
  const colCount = Math.max(...cells.map((r) => r.length));
  // Pad ragged rows to rectangular shape.
  for (const r of cells) while (r.length < colCount) r.push('');
  // Column widths for pretty alignment (cap to avoid runaway widths).
  const widths = new Array(colCount).fill(0);
  for (const r of cells) {
    for (let ci = 0; ci < colCount; ci++) {
      widths[ci] = Math.min(60, Math.max(widths[ci], r[ci]?.length ?? 0, 3));
    }
  }
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));
  const lines: string[] = [];
  const [header, ...body] = cells;
  if (header) lines.push(`| ${header.map((c, ci) => pad(c, widths[ci])).join(' | ')} |`);
  lines.push(`| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`);
  for (const row of body) lines.push(`| ${row.map((c, ci) => pad(c, widths[ci])).join(' | ')} |`);
  return lines.join('\n');
}

export function textContent(node: Y.XmlElement): string {
  const parts: string[] = [];
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) parts.push(textWithMarks(child));
    else if (child instanceof Y.XmlElement) parts.push(textContent(child));
  }
  return parts.join('');
}

/**
 * Read a Y.XmlText's delta and re-emit markdown syntax for any marks
 * (bold/italic/code/link/strike) it carries. Inverse of
 * inlineMarksToDelta — plain text remains plain; marked runs get
 * wrapped in the appropriate syntax.
 */
function textWithMarks(xmlText: Y.XmlText): string {
  const delta = xmlText.toDelta() as Array<{
    insert?: string;
    attributes?: Record<string, unknown>;
  }>;
  let out = '';
  // Marks currently open, outermost first. A Yjs delta is a flat sequence of
  // ops each carrying a SET of marks — it has no notion of which mark is
  // "outer" — so nesting is decided here, by MARK precedence (link outermost,
  // code innermost). A mark stays open across ops as long as every op still
  // carries it; the moment an op drops a mark, that mark and everything opened
  // inside it is closed (innermost first), and whatever the op still carries
  // is re-opened. This is what makes `**a *b* c**` come out as one bold run
  // rather than three — the old per-op `wrapMarks` closed and re-opened bold
  // around the italic, doubling the delimiters into `**a ****b**** c**` and
  // corrupting every bound file that held such a run.
  const active: InlineMark[] = [];
  const segs = expelEmphasisWhitespace(delta);
  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si]!;
    const marks = seg.marks;
    let keep = 0;
    while (keep < active.length && marks.some((m) => m.key === active[keep]!.key)) keep++;
    for (let k = active.length - 1; k >= keep; k--) out += active[k]!.close;
    active.length = keep;
    // A whitespace segment never OPENS a mark: an emphasis delimiter must sit
    // against a word, so a run that has to be (re)opened opens after the
    // space, on the word that follows.
    if (!seg.ws) {
      for (const m of marks) {
        if (active.some((a) => a.key === m.key)) continue;
        const v = unambiguousOpen(m, out, segs, si);
        out += v.open;
        active.push(v);
      }
    }
    out += seg.text;
  }
  for (let k = active.length - 1; k >= 0; k--) out += active[k]!.close;
  return out;
}

type InlineMark = { key: string; open: string; close: string };
type InlineSegment = { text: string; marks: InlineMark[]; ws?: boolean };

const EMPHASIS_KEYS = new Set(['bold', 'italic', 'strike']);

/**
 * Pick the delimiter for a bold/italic mark being OPENED. Closing marks and
 * reopening one right after glues their delimiters into a single asterisk
 * run — `[bold+italic][italic]` closes `***` then reopens `*`, and the glued
 * `****` (or `*****` when bold reopens) is where emphasis died on the round
 * trip: the runs came back as literal asterisks in task bodies. A glued run
 * of 3 is unambiguous (the parser reads mixed runs), so the switch fires
 * only at 4+: the reopened mark takes its underscore form, which cannot glue
 * with `*`. One exception — underscore emphasis cannot CLOSE against a word
 * character (`_ital_x` is literal, in CommonMark and in this file's own
 * parser), so when the mark's span ends flush against a word the asterisk
 * form stays and findEmphasisClose reads the glued run back instead.
 */
function unambiguousOpen(
  m: InlineMark,
  out: string,
  segs: InlineSegment[],
  si: number,
): InlineMark {
  if (m.key !== 'bold' && m.key !== 'italic') return m;
  const trailing = /\*+$/.exec(out)?.[0].length ?? 0;
  if (trailing === 0 || trailing + m.open.length < 4) return m;
  let j = si + 1;
  while (j < segs.length && segs[j]!.marks.some((n) => n.key === m.key)) j++;
  const following = j < segs.length ? (segs[j]!.text[0] ?? '') : '';
  if (/[\w_]/.test(following)) return m;
  const u = m.open.replace(/\*/g, '_');
  return { key: m.key, open: u, close: u };
}

/**
 * Turn a Yjs delta into the segments the serializer walks, moving whitespace
 * OUT from under emphasis marks at their edges. Markdown emphasis cannot open
 * before a space or close after one (`** word**`, `*word *` are literal
 * asterisks in CommonMark and in this file's own parser), and an editor
 * selection routinely bolds a trailing space. So an op's leading whitespace
 * keeps only the emphasis it shares with the PREVIOUS op, its trailing
 * whitespace only what it shares with the NEXT one, and a whitespace-only op
 * only what both neighbours carry — the delimiters land against a word on
 * both sides. Link and code are not emphasis and keep their whitespace; a code
 * op is never split at all.
 *
 * Also applies THE SERIALIZER RULE for suggested edits: disk always holds the
 * ACCEPTED state, so text carrying a pending insert-suggestion is dropped here
 * — and ONLY here, because every doc→disk path (write-back, reconcile's
 * currentSerialized, lastWritten, normalizeMarkdown) funnels through
 * textWithMarks. Text carrying `suggestDelete` falls through and is emitted
 * WITHOUT the mark: inlineMarksOf reads only the real inline marks.
 */
function expelEmphasisWhitespace(
  delta: Array<{ insert?: string; attributes?: Record<string, unknown> }>,
): InlineSegment[] {
  const ops = delta.filter(
    (op): op is { insert: string; attributes?: Record<string, unknown> } =>
      typeof op.insert === 'string' &&
      op.insert.length > 0 &&
      op.attributes?.[SUGGEST_INSERT_MARK] == null,
  );
  const out: InlineSegment[] = [];
  const shared = (marks: InlineMark[], neighbour: InlineMark[] | undefined) =>
    marks.filter((m) => !EMPHASIS_KEYS.has(m.key) || neighbour?.some((n) => n.key === m.key));
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    const marks = inlineMarksOf(op.attributes);
    const hasEmphasis = marks.some((m) => EMPHASIS_KEYS.has(m.key));
    const isCode = marks.some((m) => m.key === 'code');
    if (!hasEmphasis || isCode) {
      out.push({ text: op.insert, marks });
      continue;
    }
    const prev = i > 0 ? inlineMarksOf(ops[i - 1]!.attributes) : undefined;
    const next = i + 1 < ops.length ? inlineMarksOf(ops[i + 1]!.attributes) : undefined;
    const m = op.insert.match(/^(\s*)(.*?)(\s*)$/s);
    const lead = m?.[1] ?? '';
    const core = m?.[2] ?? '';
    const trail = m?.[3] ?? '';
    if (core.length === 0) {
      out.push({ text: op.insert, marks: shared(shared(marks, prev), next), ws: true });
      continue;
    }
    if (lead) out.push({ text: lead, marks: shared(marks, prev), ws: true });
    out.push({ text: core, marks });
    if (trail) out.push({ text: trail, marks: shared(marks, next), ws: true });
  }
  return out;
}

/**
 * The inline marks an op carries, in NESTING order — outermost first. Link
 * wraps everything (`[**b**](u)`), code sits innermost so no delimiter ever
 * lands inside a code span. Suggestion bookkeeping attributes are not marks
 * and are ignored here.
 */
function inlineMarksOf(attrs: Record<string, unknown> | undefined): InlineMark[] {
  if (!attrs) return [];
  const out: InlineMark[] = [];
  if (attrs.link && typeof attrs.link === 'object' && attrs.link !== null) {
    const href = (attrs.link as { href?: string }).href ?? '';
    if (href) out.push({ key: `link:${href}`, open: '[', close: `](${href})` });
  }
  if (attrs.strike) out.push({ key: 'strike', open: '~~', close: '~~' });
  if (attrs.bold) out.push({ key: 'bold', open: '**', close: '**' });
  if (attrs.italic) out.push({ key: 'italic', open: '*', close: '*' });
  if (attrs.code) out.push({ key: 'code', open: '`', close: '`' });
  return out;
}

/**
 * True when a block's ENTIRE text is a pending insert-suggestion (and it has
 * at least one character of text). Such a block does not exist in the
 * accepted state: it must contribute nothing to serialization — not even an
 * empty shell (`- ` marker, empty code fence) — and a disk-driven reconcile
 * must treat it as transparent (it has no key in disk space to match).
 */
function isEntirelySuggestedInsert(node: Y.XmlElement): boolean {
  let sawText = false;
  const visit = (n: Y.XmlElement | Y.XmlText | Y.XmlHook): boolean => {
    if (n instanceof Y.XmlText) {
      const delta = n.toDelta() as Array<{
        insert?: string;
        attributes?: Record<string, unknown>;
      }>;
      for (const op of delta) {
        if (typeof op.insert !== 'string' || op.insert.length === 0) continue;
        sawText = true;
        if (op.attributes?.[SUGGEST_INSERT_MARK] == null) return false;
      }
      return true;
    }
    if (n instanceof Y.XmlElement) {
      for (const child of n.toArray()) {
        if (!visit(child as Y.XmlElement | Y.XmlText)) return false;
      }
    }
    return true;
  };
  return visit(node) && sawText;
}

/**
 * Serialize a bulletList / orderedList to markdown, preserving nested
 * lists and multi-paragraph list items. `depth` is the nesting level
 * (0 = top). Indentation is 2 spaces per level — the same unit the
 * parser reads back, so the round-trip is lossless.
 *
 * The editor (y-prosemirror) shapes a list item as
 *   listItem > paragraph [, bulletList|orderedList ] [, paragraph … ]
 * The previous serializer flattened EVERY child of a listItem with
 * `textContent` joined by a single space, which silently destroyed
 * nested bullets and sub-paragraphs on write-back (a peer lost a nested
 * "Notes & Questions" section this way). Recurse instead.
 */
function serializeList(list: Y.XmlElement, depth: number): string {
  const ordered = list.nodeName === 'orderedList';
  const indent = '  '.repeat(depth);
  const contIndent = '  '.repeat(depth + 1);
  const lines: string[] = [];
  let n = 0;
  for (const li of list.toArray()) {
    if (!(li instanceof Y.XmlElement) || li.nodeName !== 'listItem') continue;
    // A fully-suggested item is not part of the accepted list — skipping it
    // here (not just via serializeBlock) avoids emitting an empty `- ` marker.
    if (isEntirelySuggestedInsert(li)) continue;
    n++;
    const marker = ordered ? `${n}. ` : '- ';
    const children = li.toArray().filter((c): c is Y.XmlElement => c instanceof Y.XmlElement);
    // The first paragraph is the item's own line; everything after it
    // (nested lists, extra paragraphs) renders as indented child content.
    const firstParaIdx = children.findIndex((c) => c.nodeName === 'paragraph');
    const firstText = firstParaIdx >= 0 ? textContent(children[firstParaIdx]!) : '';
    lines.push(`${indent}${marker}${firstText}`);
    for (let k = 0; k < children.length; k++) {
      if (k === firstParaIdx) continue;
      const child = children[k]!;
      if (child.nodeName === 'bulletList' || child.nodeName === 'orderedList') {
        lines.push(serializeList(child, depth + 1));
      } else {
        // Continuation paragraph (or other block) inside the item: blank
        // line, then indent one level deeper than the marker.
        const text = serializeBlock(child) ?? textContent(child);
        lines.push('');
        for (const tl of text.split('\n')) lines.push(tl.length > 0 ? `${contIndent}${tl}` : tl);
      }
    }
  }
  return lines.join('\n');
}

/**
 * Serialize a blockquote to markdown, preserving paragraph boundaries.
 *
 * The editor (y-prosemirror) shapes a quote the human split with Enter as
 *   blockquote > paragraph [, paragraph … ]
 * The previous serializer flattened all children with `textContent` (joined
 * by ''), so multiple paragraphs collapsed onto one `> ` line with the
 * boundary erased — a CRM peer misread Bryan's own multi-paragraph draft as a
 * single line because of it. Recurse over the block children instead, quoting
 * each, and separate adjacent paragraphs with a blank `>` line (the markdown
 * paragraph separator inside a quote). A single paragraph that carries soft
 * line-breaks still renders as adjacent `> ` lines, so both shapes round-trip.
 */
function serializeBlockquote(node: Y.XmlElement): string {
  const quote = (text: string): string =>
    text
      .split('\n')
      .map((l) => (l.length > 0 ? `> ${l}` : '>'))
      .join('\n');
  const parts = node
    .toArray()
    .map((child) => serializeBlock(child as Y.XmlElement | Y.XmlText))
    .filter((s): s is string => s != null && s !== '')
    .map(quote);
  // An empty quote (bare `>`, or an editor placeholder before the user types)
  // still emits its marker so the block survives the round-trip instead of
  // being silently dropped by the fragment serializer.
  return parts.length > 0 ? parts.join('\n>\n') : '>';
}
