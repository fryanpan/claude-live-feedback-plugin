/**
 * Driving a composer from a test.
 *
 * Composers are live markdown editors now, so "type into the box" is no
 * longer `ta.value = …` plus an `input` event — the textarea is still the
 * value every caller reads, but the words a person sees are in a ProseMirror
 * view beside it. These put a test on the same side as the person.
 *
 * Focus goes through a frame: Tiptap defers `focus()` into a
 * requestAnimationFrame, so a test that asserts on focus in the same tick it
 * asked for it is asserting before the browser would have done it. `frame()`
 * is that wait, and it is why the repaint tests are async.
 */
import {
  type ComposerSelection,
  focusMarkdownComposer,
  refreshMarkdownComposer,
} from '../../src/md-composer.ts';

/** The editor's element for a composer's textarea, or null if it has none. */
export function surfaceOf(ta: HTMLTextAreaElement): HTMLElement | null {
  return ta.parentElement?.querySelector<HTMLElement>('.md-composer-surface') ?? null;
}

/** What the editor is showing, as HTML. */
export function renderedHtml(ta: HTMLTextAreaElement): string {
  return surfaceOf(ta)?.querySelector('.ProseMirror')?.innerHTML ?? '';
}

/** Let Tiptap's deferred focus land. */
export function frame(): Promise<void> {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * A caret sitting `offset` characters into a single-paragraph composer.
 * ProseMirror counts the paragraph's own opening token, so the position for
 * an offset into the first paragraph is one past it.
 */
export function caretAt(offset: number): ComposerSelection {
  return { from: offset + 1, to: offset + 1 };
}

/** Put words in the box and the caret in them — value, editor, focus, all
 *  three, because a composer keeps them in three places. */
export function typeInComposer(
  ta: HTMLTextAreaElement,
  text: string,
  caret = text.length,
): Promise<void> {
  ta.value = text;
  refreshMarkdownComposer(ta);
  focusMarkdownComposer(ta, caretAt(caret));
  return frame();
}
