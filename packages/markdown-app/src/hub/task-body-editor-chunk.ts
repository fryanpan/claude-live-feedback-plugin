/**
 * The lazily-loaded half of the inline task editor: the review surface's own
 * `createEditor` plus Tiptap's Placeholder. Reached ONLY through the dynamic
 * `import()` in hub-app.ts, so the bundler splits it into its own chunk and
 * the board's entry stays a board. Import nothing from here statically.
 */
import type { AnyExtension } from '@tiptap/core';
import Placeholder from '@tiptap/extension-placeholder';

export { createEditor } from '../editor.ts';

export function placeholder(text: string): AnyExtension {
  return Placeholder.configure({ placeholder: text });
}
