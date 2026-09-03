/**
 * A phrase of a review item, in the DOM: reading the one a person selected,
 * placing the comment pill beside it, and marking the one a revision changed.
 *
 * The card renders `review.detail` as HTML from markdown, and the server
 * anchors into the markdown SOURCE. Nothing here maps between the two by
 * offset — the pill sends the selected WORDS, and the server locates them in
 * the source itself (uniquely, or it keeps the words alone); the revised
 * span comes back as source offsets, is sliced to words in the model, and is
 * found again in the rendered text here. Words survive the round trip where
 * offsets cannot, and a phrase that cannot be found is left unmarked rather
 * than marked in the wrong place.
 */

const MARK_CLASS = 'thread-range resolved';

/** The trimmed text a person has selected INSIDE `el`, or null when the
 *  selection is empty, collapsed, or somewhere else on the page. */
export function selectedPhraseIn(el: HTMLElement): { text: string; range: Range } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.commonAncestorContainer)) return null;
  const text = sel.toString().trim();
  return text === '' ? null : { text, range };
}

/**
 * Where the pill goes: beside the END of the selection, tucked under it when
 * that would run off the right edge, and never below the on-screen keyboard
 * — the same rules the editor's pill follows (app.ts `positionPill`), without
 * the ProseMirror half. `fallback` stands in when the range has no boxes
 * (a layout-less environment, or a selection the engine cannot measure).
 */
export function pillPlace(range: Range, fallback: HTMLElement): { left: number; top: number } {
  const pillW = 36;
  const pillH = 36;
  const gap = 8;
  const rects = range.getClientRects();
  const last = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
  const box = last && (last.width > 0 || last.height > 0) ? last : fallback.getBoundingClientRect();
  const vv = window.visualViewport;
  const vvTop = vv?.offsetTop ?? 0;
  const vvHeight = vv?.height ?? window.innerHeight;
  const availableBottom = Math.max(8, vvTop + vvHeight - pillH - 8);
  let left = box.right + gap;
  let top = Math.max(8, box.top - 2);
  if (left + pillW > window.innerWidth - 8) {
    left = Math.max(8, box.right - pillW);
    top = box.bottom + gap;
  }
  return { left: Math.max(8, left), top: Math.min(top, availableBottom) };
}

function textNodesIn(el: HTMLElement): Text[] {
  const out: Text[] = [];
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) out.push(walker.currentNode as Text);
  return out;
}

/** Take every mark this module put in `el` back out, leaving the text. */
export function unmarkPhrase(el: HTMLElement): void {
  for (const mark of Array.from(el.querySelectorAll('mark.thread-range'))) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
  }
  el.normalize();
}

/** Markdown's inline punctuation, which the rendered text has shed. */
function loosen(phrase: string): string {
  return phrase.replace(/[*_`~[\]]/g, '');
}

/**
 * Wrap the first occurrence of `phrase` in `el`'s rendered text in a
 * resolved-range mark, across as many text nodes as it spans. Tries the
 * phrase as given, then with markdown punctuation stripped (a revised span
 * of the SOURCE may carry `**` the render does not). Returns whether a mark
 * was placed; on false the DOM is untouched. `className` is the mark's
 * dressing — resolved by default; the task feed passes the ACTIVE range for
 * the phrase an open thread is about.
 */
export function markPhrase(el: HTMLElement, phrase: string, className = MARK_CLASS): boolean {
  unmarkPhrase(el);
  const nodes = textNodesIn(el);
  const whole = nodes.map((n) => n.data).join('');
  let needle = phrase;
  let at = whole.indexOf(needle);
  if (at < 0) {
    needle = loosen(phrase).trim();
    at = needle === '' ? -1 : whole.indexOf(needle);
  }
  if (at < 0) return false;
  const end = at + needle.length;
  let offset = 0;
  for (const node of nodes) {
    const nodeStart = offset;
    const nodeEnd = offset + node.data.length;
    offset = nodeEnd;
    if (nodeEnd <= at || nodeStart >= end) continue;
    // The piece of this node inside [at, end): split off what lies outside
    // it, then wrap what remains.
    let target = node;
    const from = Math.max(at, nodeStart) - nodeStart;
    const to = Math.min(end, nodeEnd) - nodeStart;
    if (from > 0) target = target.splitText(from);
    if (to - from < target.data.length) target.splitText(to - from);
    const mark = el.ownerDocument.createElement('mark');
    mark.className = className;
    target.parentNode?.insertBefore(mark, target);
    mark.appendChild(target);
  }
  return true;
}
