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

/** The mark's name in the schema — TipTap's `Link` extension. */
const LINK = 'link';

/**
 * Mark `range` as the task's link, in one transaction, with no text written.
 *
 * Returns false when the range is empty or the schema has no link mark, so a
 * caller can tell "nothing to mark" from "marked it".
 */
export function linkSpinoffRange(
  editor: Editor,
  range: { from: number; to: number },
  href: string,
): boolean {
  const { state } = editor;
  const linkType = state.schema.marks[LINK];
  if (!linkType || range.to <= range.from) return false;
  const tr = state.tr;
  // `addMark` over a range that already carries a link replaces it, which is
  // what spinning the same line off twice should do: one line, one row.
  tr.addMark(range.from, range.to, linkType.create({ href }));
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
