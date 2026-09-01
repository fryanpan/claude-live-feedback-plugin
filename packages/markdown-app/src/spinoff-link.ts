/**
 * Writing a spun-off task back into the prose it came from — and taking it
 * back out again.
 *
 * The rule is that spinning a line off ADDS NO WORDS. The selected words
 * become the task's link and `task-link-chips.ts` hangs the row's live status
 * beside them; the doc says exactly what it said before, once.
 *
 * That rule is a correction, and the bug it corrects is worth stating because
 * the obvious implementation walks straight back into it. The first version
 * INSERTED the title after the line — `insertContentAt(end, ' ' + title)` —
 * and the title is derived from the selection, so selecting a whole line and
 * spinning it off wrote that line into the doc a second time:
 *
 *     Check whether Access covers the mockup route
 *     Check whether Access covers the mockup route        ← inserted, linked
 *
 * Four lines out of four in the reviewer's pass, the H1 included, and the
 * duplicate was flushed to the bound `.md`. Deriving a better title does not
 * fix it: any link text drawn from the selection duplicates the selection
 * whenever somebody selects the thing they mean, which is the common case.
 * Marking the words instead of re-emitting them cannot duplicate at all.
 */
import type { Editor } from '@tiptap/core';
import type { Node as ProseNode } from '@tiptap/pm/model';

/** The mark's name in the schema — TipTap's `Link` extension. */
const LINK = 'link';

/**
 * The FIRST line the selection touches, clipped to that line.
 *
 * A spin-off is anchored on a line, and a task is one thing. Somebody who
 * drags across four paragraphs and taps "Create a task" gets one row, so
 * marking all four would turn a page into a single anchor pointing at a row
 * that only describes its opening sentence — and the whole passage would then
 * navigate away on a click.
 *
 * "Line" here is the innermost TEXTBLOCK, not the top-level node: a bullet
 * list is one top-level block containing many list items, and linking the
 * whole list because somebody selected its first bullet is the same mistake
 * one level up.
 */
function firstLineIn(
  doc: ProseNode,
  range: { from: number; to: number },
): {
  from: number;
  to: number;
} | null {
  let found: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    // Containers (lists, blockquotes, table cells) are walked THROUGH; only a
    // textblock is a line.
    if (!node.isTextblock) return true;
    const start = pos + 1;
    const end = pos + 1 + node.content.size;
    if (range.from < end && range.to > start) {
      found = { from: Math.max(range.from, start), to: Math.min(range.to, end) };
    }
    return false;
  });
  return found;
}

/**
 * Mark the selection as the task's link, in one transaction, with no text
 * written — clipped to the first line it touches.
 *
 * Returns false when there is nothing to mark (an empty range, a selection
 * over no text, a schema with no link mark), so a caller can tell "nothing to
 * mark" from "marked it".
 */
export function linkSpinoffRange(
  editor: Editor,
  range: { from: number; to: number },
  href: string,
): boolean {
  const { state } = editor;
  const linkType = state.schema.marks[LINK];
  if (!linkType || range.to <= range.from) return false;
  const line = firstLineIn(state.doc, range);
  if (!line || line.to <= line.from) return false;
  const tr = state.tr;
  // `addMark` over a range that already carries a link replaces it, which is
  // what spinning the same line off twice should do: one line, one row.
  tr.addMark(line.from, line.to, linkType.create({ href }));
  editor.view.dispatch(tr);
  return true;
}

/**
 * Strip the link mark wherever it points at `href` — the undo half.
 *
 * By href rather than by the positions we marked, because an undo offered in
 * a toast is offered for several seconds and the person may well type in
 * those seconds. Stored positions go stale under an edit; the href does not.
 * A doc where the link is already gone (they deleted the line, they undid it
 * with the keyboard) is a no-op that reports false.
 */
export function unlinkSpinoffHref(editor: Editor, href: string): boolean {
  const { state } = editor;
  const linkType = state.schema.marks[LINK];
  if (!linkType) return false;
  const spans: Array<{ from: number; to: number }> = [];
  state.doc.descendants((node, pos) => {
    if (!node.isText) return;
    const has = node.marks.some((m) => m.type === linkType && m.attrs.href === href);
    if (has) spans.push({ from: pos, to: pos + node.nodeSize });
  });
  if (spans.length === 0) return false;
  const tr = state.tr;
  for (const span of spans) tr.removeMark(span.from, span.to, linkType);
  editor.view.dispatch(tr);
  return true;
}
