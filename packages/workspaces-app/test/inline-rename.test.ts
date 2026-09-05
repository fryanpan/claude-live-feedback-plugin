/**
 * The rename-in-place primitives, driven directly.
 *
 * They were covered only through the two callers that use them — the Preact
 * board row and the vanilla detail panel — and only for the blur ending. The
 * parts with no coverage at all are the ones with the most branches and the
 * least visibility: which caret offset a click maps to (including the WebKit
 * fallback that Safari, and therefore an iPad, actually takes), what happens
 * when the engine declines to answer, and the key gating that keeps a
 * keystroke inside a rename from reaching the row's own shortcuts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  caretOffsetIn,
  placeCaretIn,
  sameSelection,
  selectionInside,
  wireWordsInPlace,
} from '../src/board/inline-rename.ts';

/**
 * The two caret APIs, as the guard in `caretOffsetIn` actually sees them:
 * optional and of unknown shape. lib.dom declares both as required members of
 * `Document` and neither is present everywhere it is declared — happy-dom has
 * neither, Safari had only the second for years — so a stub that answers a
 * runtime `typeof` check cannot also satisfy the declared type.
 */
type CaretDoc = Omit<Document, 'caretPositionFromPoint' | 'caretRangeFromPoint'> & {
  caretPositionFromPoint?: unknown;
  caretRangeFromPoint?: unknown;
};
const caretDoc = () => document as unknown as CaretDoc;

afterEach(() => {
  const doc = caretDoc();
  doc.caretPositionFromPoint = undefined;
  doc.caretRangeFromPoint = undefined;
  document.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
});

/** A span in the document, so `contains` and selections behave. */
function span(html: string): HTMLElement {
  const el = document.createElement('span');
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

/** Stand in for the standard API, answering with a fixed hit. */
function withCaretPosition(offsetNode: Node | null, offset: number) {
  caretDoc().caretPositionFromPoint = () => (offsetNode === null ? null : { offsetNode, offset });
}

/** Stand in for WebKit's older spelling — the one Safari, and so an iPad, takes. */
function withCaretRange(startContainer: Node | null, startOffset: number) {
  caretDoc().caretRangeFromPoint = () =>
    startContainer === null ? null : { startContainer, startOffset };
}

describe('caretOffsetIn — which character the pointer landed on', () => {
  it('reports the offset inside a single text node', () => {
    const el = span('Ship the thing');
    withCaretPosition(el.firstChild, 5);
    expect(caretOffsetIn(el, 10, 10)).toBe(5);
  });

  it('counts the text that comes BEFORE the node the hit landed in', () => {
    // The input holds the whole title, but a text node reports its own
    // offset — so a title that renders as more than one node has to have the
    // preceding text added, in document order.
    const el = span('Ship <b>the</b> thing');
    const bold = el.querySelector('b')?.firstChild as Node;
    expect(bold.textContent).toBe('the');
    withCaretPosition(bold, 2);
    expect(caretOffsetIn(el, 10, 10)).toBe('Ship '.length + 2);

    const tail = el.lastChild as Node;
    expect(tail.textContent).toBe(' thing');
    withCaretPosition(tail, 3);
    expect(caretOffsetIn(el, 10, 10)).toBe('Ship the'.length + 3);
  });

  it("takes WebKit's older spelling when the standard one is absent", () => {
    // Safari had only this for years, and Safari is what an iPad reviews on —
    // so the fallback is load-bearing rather than decoration.
    const el = span('Ship the thing');
    withCaretRange(el.firstChild, 7);
    expect(caretOffsetIn(el, 10, 10)).toBe(7);
  });

  it('prefers the standard API when both exist', () => {
    const el = span('Ship the thing');
    withCaretPosition(el.firstChild, 2);
    withCaretRange(el.firstChild, 9);
    expect(caretOffsetIn(el, 10, 10)).toBe(2);
  });

  it('says nothing when the engine declines to answer', () => {
    // Every caller reads `undefined` as "put the caret at the end".
    const el = span('Ship the thing');
    withCaretPosition(null, 0);
    expect(caretOffsetIn(el, 10, 10)).toBeUndefined();
  });

  it('says nothing when there is no layout engine to ask', () => {
    // happy-dom, where this suite runs, has neither API — which is the
    // production shape for any engine that has not shipped them.
    const el = span('Ship the thing');
    expect(caretOffsetIn(el, 10, 10)).toBeUndefined();
  });

  it('says nothing when the hit landed outside the element', () => {
    const el = span('Ship the thing');
    const other = span('Somewhere else');
    withCaretPosition(other.firstChild, 3);
    expect(caretOffsetIn(el, 10, 10)).toBeUndefined();
  });

  it('says nothing when the hit landed on an element rather than text', () => {
    const el = span('Ship <b>the</b> thing');
    withCaretPosition(el.querySelector('b'), 0);
    expect(caretOffsetIn(el, 10, 10)).toBeUndefined();
  });
});

describe('placeCaretIn', () => {
  /** Where the live selection sits, as (node, offset). */
  function caret() {
    const sel = document.getSelection();
    return {
      node: sel?.anchorNode ?? null,
      offset: sel?.anchorOffset ?? -1,
      collapsed: sel?.isCollapsed,
    };
  }

  it('puts a collapsed caret at the offset asked for', () => {
    const el = span('Ship the thing');
    placeCaretIn(el, 5);
    expect(caret()).toEqual({ node: el.firstChild, offset: 5, collapsed: true });
  });

  it('goes to the end when no offset is given', () => {
    const el = span('Ship the thing');
    placeCaretIn(el);
    expect(caret().offset).toBe('Ship the thing'.length);
  });

  it('clamps an offset past either end rather than throwing', () => {
    const el = span('Ship');
    placeCaretIn(el, 999);
    expect(caret().offset).toBe(4);
    placeCaretIn(el, -5);
    expect(caret().offset).toBe(0);
  });

  it('puts the caret inside an empty element, so the first keystroke lands there', () => {
    const el = span('');
    expect(() => placeCaretIn(el, 0)).not.toThrow();
    expect(document.getSelection()?.anchorNode).toBe(el);
  });

  it('leaves a selection stub that cannot hold a range alone', () => {
    // Several tests drive the drag-select guard with a bare object; a stub
    // that has no addRange must not take the caret down with it.
    const el = span('Ship the thing');
    const real = window.getSelection;
    window.getSelection = (() => ({ isCollapsed: false })) as typeof window.getSelection;
    try {
      expect(() => placeCaretIn(el, 2)).not.toThrow();
    } finally {
      window.getSelection = real;
    }
  });
});

describe('wireWordsInPlace', () => {
  function setup(title = 'Old title') {
    const el = span(title);
    const commits: string[] = [];
    const edits: boolean[] = [];
    const handle = wireWordsInPlace(
      el,
      () => title,
      (v) => commits.push(v),
      (e) => edits.push(e),
    );
    return { el, commits, edits, handle };
  }

  const key = (el: HTMLElement, k: string) =>
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

  it('edits the element that already holds the words — same node, same text node', () => {
    // The whole reason this exists rather than an <input>: entering edit mode
    // must not shift the text by a pixel, and the way that is guaranteed is
    // that nothing is replaced.
    const { el, handle } = setup();
    const textNode = el.firstChild;
    handle.begin();
    expect(el.isConnected).toBe(true);
    expect(el.firstChild).toBe(textNode);
    expect(el.querySelector('input')).toBeNull();
    expect(el.getAttribute('contenteditable')).toBeTruthy();
  });

  it('reports the edit state, because the caller owning the text has to keep its hands off', () => {
    const { handle, edits } = setup();
    expect(handle.isEditing()).toBe(false);
    handle.begin();
    expect(handle.isEditing()).toBe(true);
    expect(edits).toEqual([true]);
    key(document.querySelector('span') as HTMLElement, 'Escape');
    expect(handle.isEditing()).toBe(false);
    expect(edits).toEqual([true, false]);
  });

  it('commits a changed title on Enter and leaves edit mode', () => {
    const { el, commits, handle } = setup();
    handle.begin();
    el.textContent = '  New title  ';
    key(el, 'Enter');
    expect(commits).toEqual(['New title']);
    expect(el.textContent).toBe('New title');
    expect(el.hasAttribute('contenteditable')).toBe(false);
  });

  it('restores without committing when Enter finds nothing new', () => {
    for (const typed of ['Old title', '   ', '']) {
      const { el, commits, handle } = setup();
      handle.begin();
      el.textContent = typed;
      key(el, 'Enter');
      expect(commits).toEqual([]);
      expect(el.textContent).toBe('Old title');
    }
  });

  it('Escape is the deliberate cancel — a changed title is thrown away', () => {
    const { el, commits, handle } = setup();
    handle.begin();
    el.textContent = 'New title';
    key(el, 'Escape');
    expect(commits).toEqual([]);
    expect(el.textContent).toBe('Old title');
    expect(el.hasAttribute('contenteditable')).toBe(false);
  });

  it('keeps every other keystroke inside the rename', () => {
    // The row above listens for `r` and F2, and this element is a SPAN — the
    // "am I inside a text field" guards that watch for input/textarea do not
    // cover it, so the gating has to happen here.
    const { el, handle } = setup();
    const heard: string[] = [];
    document.body.addEventListener('keydown', (ev) => heard.push((ev as KeyboardEvent).key));
    handle.begin();
    key(el, 'r');
    key(el, 'F2');
    expect(heard).toEqual([]);
    // And Enter is consumed rather than left to the page.
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    el.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(heard).toEqual([]);
  });

  it('lets keystrokes through when no rename is running', () => {
    // The control on the test above: the listener is attached once and gated
    // on `editing`, not added and removed per edit.
    const { el } = setup();
    const heard: string[] = [];
    document.body.addEventListener('keydown', (ev) => heard.push((ev as KeyboardEvent).key));
    key(el, 'r');
    expect(heard).toEqual(['r']);
  });

  it('a second begin() while editing does not reset what Escape restores', () => {
    const { el, handle, edits } = setup();
    handle.begin();
    el.textContent = 'Half-typed';
    handle.begin();
    expect(edits).toEqual([true]);
    key(el, 'Escape');
    expect(el.textContent).toBe('Old title');
  });

  it('a blur with no rename running commits nothing', () => {
    const { el, commits } = setup();
    el.textContent = 'Changed by somebody else';
    el.dispatchEvent(new Event('blur'));
    expect(commits).toEqual([]);
    expect(el.textContent).toBe('Changed by somebody else');
  });
});

describe('selectionInside / sameSelection — "this click only made a selection"', () => {
  function select(node: Node, start: number, end: number) {
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const sel = document.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  it('reports a live, non-empty selection that sits inside the element', () => {
    const el = span('Ship the thing');
    select(el.firstChild as Node, 0, 4);
    expect(selectionInside(el)).toEqual({
      anchor: el.firstChild,
      focus: el.firstChild,
      anchorOffset: 0,
      focusOffset: 4,
    });
  });

  it('reports nothing for a collapsed caret — that is a click, not a drag', () => {
    const el = span('Ship the thing');
    select(el.firstChild as Node, 3, 3);
    expect(selectionInside(el)).toBeNull();
  });

  it('reports nothing when the selection lives somewhere else', () => {
    const el = span('Ship the thing');
    const other = span('Somewhere else');
    select(other.firstChild as Node, 0, 4);
    expect(selectionInside(el)).toBeNull();
  });

  it('sameSelection compares the four fields, and treats two nothings as equal', () => {
    const el = span('Ship the thing');
    select(el.firstChild as Node, 0, 4);
    const first = selectionInside(el);
    select(el.firstChild as Node, 0, 4);
    expect(sameSelection(first, selectionInside(el))).toBe(true);
    select(el.firstChild as Node, 0, 5);
    expect(sameSelection(first, selectionInside(el))).toBe(false);
    expect(sameSelection(null, null)).toBe(true);
    expect(sameSelection(first, null)).toBe(false);
  });
});

describe('finePointer — asking the pointer, not the viewport', () => {
  /** Re-imported per case: the query is resolved once and kept, so the answer
   *  a module gives is fixed for its lifetime. */
  async function freshFinePointer(matchMedia: unknown) {
    vi.resetModules();
    const real = (globalThis as { matchMedia?: unknown }).matchMedia;
    (globalThis as { matchMedia?: unknown }).matchMedia = matchMedia;
    try {
      const mod = await import('../src/board/inline-rename.ts');
      return mod.finePointer();
    } finally {
      (globalThis as { matchMedia?: unknown }).matchMedia = real;
    }
  }

  it('is true for a hovering, precise pointer', async () => {
    expect(await freshFinePointer((q: string) => ({ matches: q.includes('hover') }))).toBe(true);
  });

  it('is false for a touchscreen — a 430px phone never gets the desktop gesture', async () => {
    expect(await freshFinePointer(() => ({ matches: false }))).toBe(false);
  });

  it('assumes a fine pointer when the engine cannot be asked at all', async () => {
    expect(await freshFinePointer(undefined)).toBe(true);
    expect(
      await freshFinePointer(() => {
        throw new Error('no media queries here');
      }),
    ).toBe(true);
  });

  it('asks for hover AND a fine pointer, not one or the other', async () => {
    let asked = '';
    await freshFinePointer((q: string) => {
      asked = q;
      return { matches: true };
    });
    expect(asked).toContain('hover: hover');
    expect(asked).toContain('pointer: fine');
  });
});
