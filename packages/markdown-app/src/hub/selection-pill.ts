/**
 * The selection → pill pattern the review-doc editor uses, for surfaces that
 * are NOT the editor: select words, a pill appears beside them, tapping it
 * opens a place to write. Shared by the walkthrough card (a phrase of a
 * review item) and the Home activity pane (a phrase of a task note or
 * title) so there is one pill, not two that drift.
 *
 * Not the editor's pill (app.ts `positionPill`): that one keys off a
 * ProseMirror selection resolvable to Yjs offsets, and these surfaces render
 * static text. What the two share is the shape and the `.comment-pill`
 * dressing. The pill sends the WORDS; whoever receives them decides what
 * they anchor to.
 */
import { type MutableRef, useLayoutEffect, useState } from 'preact/hooks';
import { pillPlace, selectedPhraseIn } from './review-item-phrase.ts';

export interface SelectionPill {
  /** The selected words, trimmed — null when nothing in the body is selected. */
  phrase: string | null;
  /** Where the pill goes (fixed-position px). */
  place: { left: number; top: number };
  /** The element the selection sits in, so a body holding many things can
   *  tell which one the words belong to. Null while nothing is selected. */
  at: Element | null;
  /** Hide the pill (the selection is left alone). */
  clear: () => void;
}

/**
 * Keys off `selectionchange` on the document, debounced the way the editor's
 * is, and only ever reads a selection inside the body node — a selection
 * anywhere else on the page hides the pill.
 */
export function useSelectionPill(
  body: MutableRef<HTMLElement | null>,
  enabled: boolean,
): SelectionPill {
  const [phrase, setPhrase] = useState<string | null>(null);
  const [place, setPlace] = useState({ left: 8, top: 8 });
  const [at, setAt] = useState<Element | null>(null);
  // A LAYOUT effect: the listener has to be on the document before the first
  // selection can happen, and a passive effect lands a frame after mount —
  // a phrase selected in that frame would never show the pill.
  useLayoutEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = (): void => {
      const el = body.current;
      const found = el ? selectedPhraseIn(el) : null;
      if (found && el) {
        setPlace(pillPlace(found.range, el));
        setAt(elementOf(found.range.commonAncestorContainer));
        setPhrase(found.text);
      } else {
        setPhrase(null);
        setAt(null);
      }
    };
    const onChange = (): void => {
      clearTimeout(timer);
      timer = setTimeout(read, 120);
    };
    document.addEventListener('selectionchange', onChange);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('selectionchange', onChange);
    };
  }, [body, enabled]);
  return {
    phrase,
    place,
    at,
    clear: () => {
      setPhrase(null);
      setAt(null);
    },
  };
}

function elementOf(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/** Punctuation a tapped word sheds at its end — the reader tapped the word,
 *  not the comma after it. */
const TRAILING = /[.,;:!?)\]}'"»”’]+$/;

/**
 * The word under `offset` in `text`: the run of non-whitespace around it,
 * minus trailing punctuation. Null on whitespace (nothing was tapped) and
 * on an empty string. Pure, so the boundary rule is testable without a
 * caret API.
 */
export function wordRangeAt(text: string, offset: number): { start: number; end: number } | null {
  if (text.length === 0) return null;
  const i = Math.min(Math.max(0, offset), text.length);
  // A caret at the very end of the text still means the last word; a caret
  // ON whitespace means the reader tapped between words, which is nothing.
  const here = i < text.length ? i : i - 1;
  if (here < 0 || /\s/.test(text[here] as string)) return null;
  let start = here;
  while (start > 0 && !/\s/.test(text[start - 1] as string)) start--;
  let end = here + 1;
  while (end < text.length && !/\s/.test(text[end] as string)) end++;
  const trimmed = text.slice(start, end).replace(TRAILING, '');
  if (trimmed.length === 0) return null;
  return { start, end: start + trimmed.length };
}

/**
 * "Tap a word to select it": put the browser's selection on the word under
 * the point, if the point lands on text inside `within`. A tap does not
 * select on its own — only a long-press does on touch — so this is what
 * makes tapping a phrase the same gesture as selecting it. Returns whether a
 * selection was made; the pill hears about it through `selectionchange`.
 *
 * Uses whichever caret-from-point API the engine has (`caretPositionFromPoint`
 * is the standard, `caretRangeFromPoint` the WebKit/Blink one); with neither
 * the tap simply does nothing, which is what it did before.
 */
export function selectWordAtPoint(x: number, y: number, within: HTMLElement): boolean {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  let node: Node | null = null;
  let offset = 0;
  if (typeof doc.caretPositionFromPoint === 'function') {
    const p = doc.caretPositionFromPoint(x, y);
    if (p) {
      node = p.offsetNode;
      offset = p.offset;
    }
  } else if (typeof doc.caretRangeFromPoint === 'function') {
    const r = doc.caretRangeFromPoint(x, y);
    if (r) {
      node = r.startContainer;
      offset = r.startOffset;
    }
  }
  if (!node || node.nodeType !== Node.TEXT_NODE || !within.contains(node)) return false;
  const word = wordRangeAt((node as Text).data, offset);
  if (!word) return false;
  const sel = window.getSelection();
  if (!sel) return false;
  const range = document.createRange();
  range.setStart(node, word.start);
  range.setEnd(node, word.end);
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}
