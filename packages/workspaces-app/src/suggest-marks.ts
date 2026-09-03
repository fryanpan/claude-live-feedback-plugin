import { SUGGEST_DELETE_MARK, SUGGEST_INSERT_MARK } from '@feedback/core';
import { Mark } from '@tiptap/core';

/**
 * Tiptap marks for suggested edits (redlining Phase 2).
 *
 * These exist in the BASE editor schema (editor.ts), not just a suggesting
 * surface: y-prosemirror drops marks the ProseMirror schema doesn't know, so
 * an agent-written suggestion in the Yjs doc would be silently destroyed by
 * the first browser that opened the doc without them. Registration is
 * load-bearing; the pending-proposal styling and the Suggesting input mode
 * build on top (later commits of this PR).
 *
 * Attribute shape is the shared schema in @feedback/core (`SuggestionAttrs`):
 * sid/authorId/authorName/authorColor as strings, ts as a NUMBER. Per the
 * attribute-type learnings, y-prosemirror passes Yjs attribute values through
 * verbatim — the parse rules below re-read `data-ts` as a number so an
 * HTML round-trip can't silently downgrade the type to string.
 */

function stringAttr(dataName: string, attrName: string) {
  return {
    default: '',
    parseHTML: (element: HTMLElement): string => element.getAttribute(dataName) ?? '',
    renderHTML: (attrs: Record<string, unknown>): Record<string, string> => {
      const v = attrs[attrName];
      return typeof v === 'string' && v.length > 0 ? { [dataName]: v } : {};
    },
  };
}

function tsAttr() {
  return {
    default: 0,
    parseHTML: (element: HTMLElement): number => {
      const n = Number(element.getAttribute('data-ts'));
      return Number.isFinite(n) ? n : 0;
    },
    renderHTML: (attrs: Record<string, unknown>): Record<string, string> => {
      const v = attrs.ts;
      return typeof v === 'number' && v > 0 ? { 'data-ts': String(v) } : {};
    },
  };
}

/**
 * The author color as an inline CSS custom property, so the stylesheet's
 * underline/strikethrough/tint rules render each author distinctly. The value
 * comes from our own mark attrs, but it round-trips through user-editable
 * HTML — only a literal hex color is allowed into the style attribute so an
 * arbitrary string can't smuggle extra CSS declarations in.
 */
function authorColorStyle(attrs: Record<string, unknown>): Record<string, string> {
  const c = attrs.authorColor;
  return typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c)
    ? { style: `--lf-suggest-color: ${c}` }
    : {};
}

function suggestionAttributes() {
  return {
    sid: stringAttr('data-sid', 'sid'),
    authorId: stringAttr('data-author-id', 'authorId'),
    authorName: stringAttr('data-author-name', 'authorName'),
    authorColor: stringAttr('data-author-color', 'authorColor'),
    ts: tsAttr(),
  };
}

/** Proposed NEW text — visible in the live doc, excluded from disk until
 *  accepted (the serializer rule in @feedback/core prose.ts). */
export const SuggestInsert = Mark.create({
  name: SUGGEST_INSERT_MARK,
  // Typing at the edge of a proposal must not silently extend it.
  inclusive: () => false,
  addAttributes: suggestionAttributes,
  parseHTML: () => [{ tag: 'span[data-lf-suggest="ins"]' }],
  renderHTML: ({ mark, HTMLAttributes }) => [
    'span',
    {
      ...HTMLAttributes,
      ...authorColorStyle(mark.attrs),
      'data-lf-suggest': 'ins',
      class: 'lf-suggest-ins',
    },
    0,
  ],
});

/** Text proposed FOR REMOVAL — stays in the doc (and on disk) until the
 *  suggestion is accepted. */
export const SuggestDelete = Mark.create({
  name: SUGGEST_DELETE_MARK,
  inclusive: () => false,
  addAttributes: suggestionAttributes,
  parseHTML: () => [{ tag: 'span[data-lf-suggest="del"]' }],
  renderHTML: ({ mark, HTMLAttributes }) => [
    'span',
    {
      ...HTMLAttributes,
      ...authorColorStyle(mark.attrs),
      'data-lf-suggest': 'del',
      class: 'lf-suggest-del',
    },
    0,
  ],
});
