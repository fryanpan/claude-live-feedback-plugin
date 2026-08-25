/**
 * Rename-in-place primitives, and the drag-select guard that has to sit beside
 * them.
 *
 * These moved out of `hub-render.ts` when the board became a Preact island.
 * They are DOM-level and framework-free on purpose: the island's rows call
 * them through a ref, the vanilla detail panel still calls them directly, and
 * neither has to know the other exists. A shared module is what keeps the two
 * gestures — click the words to rename, and "this click only made a selection"
 * — spelled ONCE, so the board and the panel cannot drift apart on either.
 */

/**
 * Which character of `el`'s text the pointer landed on, or `undefined` when
 * the engine will not say. Asana's rule, and Bryan's: clicking a task's name
 * puts the caret where the click was — not at the end, not over a select-all
 * — so the gesture that starts a rename has to carry a position with it.
 *
 * Two spellings of the same question. `caretPositionFromPoint` is the
 * standard; `caretRangeFromPoint` is WebKit's older one and for years the
 * only one Safari had — and Safari is what an iPad reviews on, so the
 * fallback is load-bearing rather than decoration. A DOM with no layout
 * engine (happy-dom, where the unit suite runs) has neither and returns
 * `undefined`, which every caller reads as "put it at the end".
 */
export function caretOffsetIn(el: HTMLElement, x: number, y: number): number | undefined {
  // Both are declared as required members of `Document`, and neither is
  // present everywhere it is declared — Safari shipped only the second for
  // years, and happy-dom has neither. So the guard is a runtime one.
  const doc = el.ownerDocument;
  let node: Node | null = null;
  let offset = 0;
  if (typeof doc.caretPositionFromPoint === 'function') {
    const pos = doc.caretPositionFromPoint(x, y);
    if (!pos) return undefined;
    node = pos.offsetNode;
    offset = pos.offset;
  } else if (typeof doc.caretRangeFromPoint === 'function') {
    const range = doc.caretRangeFromPoint(x, y);
    if (!range) return undefined;
    node = range.startContainer;
    offset = range.startOffset;
  }
  if (!node || node.nodeType !== Node.TEXT_NODE || !el.contains(node)) return undefined;
  // The offset a text node reports is its OWN, and the input holds the whole
  // title — so count the text that comes before the node the hit landed in.
  // One text node is the common case here; the walk is what keeps it honest
  // for a title that ever renders as more than one.
  let before = 0;
  const stack: Node[] = [el];
  const seen: Node[] = [];
  while (stack.length > 0) {
    const n = stack.pop() as Node;
    const kids = Array.from(n.childNodes);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    if (n !== el && n.nodeType === Node.TEXT_NODE) seen.push(n);
  }
  for (const t of seen) {
    if (t === node) return before + offset;
    before += t.textContent?.length ?? 0;
  }
  return undefined;
}

/**
 * Put a collapsed caret at `offset` inside `el`'s text, or at the end when no
 * offset is given. The editing counterpart of `caretOffsetIn`.
 *
 * Reads the selection off the WINDOW rather than the document, deliberately:
 * several tests stub `document.getSelection` with a bare object to drive the
 * drag-select guard, and a stub that cannot hold a range must not take the
 * caret with it. Every capability is checked before it is used, so a DOM that
 * has no real selection simply leaves the caret wherever focus put it.
 */
export function placeCaretIn(el: HTMLElement, offset?: number): void {
  const doc = el.ownerDocument;
  const sel = doc.defaultView?.getSelection?.();
  if (!sel || typeof sel.removeAllRanges !== 'function' || typeof sel.addRange !== 'function') {
    return;
  }
  if (typeof doc.createRange !== 'function') return;
  const node = el.firstChild;
  const range = doc.createRange();
  if (node && node.nodeType === Node.TEXT_NODE) {
    const len = node.textContent?.length ?? 0;
    range.setStart(node, typeof offset === 'number' ? Math.max(0, Math.min(len, offset)) : len);
    range.collapse(true);
  } else {
    // No text node to aim at — an empty title. Put the caret inside the
    // element so the first keystroke lands there rather than nowhere.
    range.selectNodeContents(el);
    range.collapse(false);
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Whether this engine understands `contenteditable="plaintext-only"`. */
let plaintextOnly: boolean | undefined;
function editableMode(): 'plaintext-only' | 'true' {
  if (plaintextOnly === undefined) {
    plaintextOnly = false;
    try {
      const probe = document.createElement('div');
      probe.contentEditable = 'plaintext-only';
      plaintextOnly = probe.contentEditable === 'plaintext-only';
    } catch {
      // Firefox before 136 THROWS on the unsupported value rather than
      // ignoring it — and the attribute form is worse there than the throw,
      // because an unrecognised keyword makes the element inherit instead of
      // becoming editable at all. So the probe decides, once.
      plaintextOnly = false;
    }
  }
  return plaintextOnly ? 'plaintext-only' : 'true';
}

/**
 * Rename the words WHERE THEY ARE, by making the element that already holds
 * them editable. Enter commits, Escape or blur cancels.
 *
 * This exists rather than reusing `wireInPlaceTitle` because of one
 * requirement that an `<input>` cannot satisfy structurally (Bryan,
 * 2026-08-21): *"Entering edit mode must NOT shift the text — zero layout
 * jump."* Swapping a span for an input means matching font, weight,
 * line-height, padding, border and baseline between two different box types,
 * and getting it right today says nothing about the next font change —
 * `.hub-title-input` currently adds 4px of padding and a 1px border, which is
 * exactly the 5px sideways jump this replaces. Here the element, its text node
 * and its box are never replaced at all: one attribute changes. Zero shift is
 * then a property of the DOM rather than a number two rules have to agree on.
 *
 * The second thing it buys is Asana's transition — the hover rectangle is on
 * this same element, so it can simply turn off while editing and leave the
 * reader with nothing but a caret in the text they clicked.
 *
 * `isEditing` comes back alongside the starter because a caller that OWNS the
 * element's text — a Preact row, which rewrites it on every repaint — has to
 * know when to keep its hands off. Nothing else can answer that: the edit
 * state lives in this closure, and a rename in flight is exactly the moment a
 * declarative text write would eat what is being typed.
 */
export function wireWordsInPlace(
  el: HTMLElement,
  current: () => string,
  commit: (v: string) => void,
  onEdit?: (editing: boolean) => void,
): { begin: (caret?: number) => void; isEditing: () => boolean } {
  let original = '';
  let editing = false;

  // Listeners are attached ONCE and gated on `editing`, rather than added per
  // edit and removed on exit: a rename that ends by committing also ends by
  // blurring, and handlers registered per-edit accumulate a set at a time.
  const end = (text: string, save: boolean): void => {
    if (!editing) return;
    editing = false;
    el.removeAttribute('contenteditable');
    el.textContent = text;
    onEdit?.(false);
    if (save) commit(text);
  };

  el.addEventListener('keydown', (ev) => {
    if (!editing) return;
    if (ev.key !== 'Enter' && ev.key !== 'Escape') {
      // Every other key belongs to the edit. The row above listens for `r`
      // and F2, and this element is a SPAN — the "am I inside a text field"
      // guards that watch for input/textarea do not cover it.
      ev.stopPropagation();
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.key === 'Escape') {
      end(original, false);
      return;
    }
    const v = (el.textContent ?? '').trim();
    if (v && v !== original) end(v, true);
    else end(original, false);
  });

  // Blur cancels: an accidental click away must never rewrite a title.
  el.addEventListener('blur', () => end(original, false));

  // There is deliberately no paste handler. `plaintext-only` flattens the
  // clipboard where it applies, and where it does not, both endings read
  // `el.textContent` — so pasted markup can look wrong for the length of the
  // edit but can never reach the task. A handler would buy the cosmetic half
  // at the cost of the native undo stack.
  return {
    begin(caret?: number): void {
      if (editing) return;
      original = current();
      editing = true;
      el.setAttribute('contenteditable', editableMode());
      onEdit?.(true);
      el.focus();
      placeCaretIn(el, caret);
    },
    isEditing: () => editing,
  };
}

/** Where a live, non-empty selection sits inside `el` — or null for none. */
export type SelectionMark = {
  anchor: Node | null;
  focus: Node | null;
  anchorOffset: number;
  focusOffset: number;
};

export function selectionInside(el: HTMLElement): SelectionMark | null {
  const sel = typeof document.getSelection === 'function' ? document.getSelection() : null;
  if (!sel || sel.isCollapsed || !sel.anchorNode || !el.contains(sel.anchorNode)) return null;
  return {
    anchor: sel.anchorNode,
    focus: sel.focusNode,
    anchorOffset: sel.anchorOffset,
    focusOffset: sel.focusOffset,
  };
}

export function sameSelection(a: SelectionMark | null, b: SelectionMark | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.anchor === b.anchor &&
    a.focus === b.focus &&
    a.anchorOffset === b.anchorOffset &&
    a.focusOffset === b.focusOffset
  );
}

/**
 * A hovering, precise pointer is what makes tap-to-rename on the title safe:
 * it implies a visible hover state (so the drag handle and the open caret are
 * discoverable) and a click that lands where it was aimed. Asking the pointer
 * rather than the viewport width is the honest form of the question — an
 * iPad with a trackpad gets the desktop gesture, a touchscreen laptop's mouse
 * does too, and a 430px phone never does.
 */
let pointerQuery: { matches: boolean } | null | undefined;
export function finePointer(): boolean {
  if (pointerQuery === undefined) {
    // Resolved once and kept: the MediaQueryList stays LIVE (its `matches`
    // tracks the real pointer), and asking for a new one per row would build
    // a hundred objects on every board render.
    const mm = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia;
    try {
      pointerQuery =
        typeof mm === 'function' ? mm.call(globalThis, '(hover: hover) and (pointer: fine)') : null;
    } catch {
      pointerQuery = null;
    }
  }
  return pointerQuery === null ? true : pointerQuery.matches;
}
