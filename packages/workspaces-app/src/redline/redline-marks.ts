import { Extension, Mark } from '@tiptap/core';

/**
 * Tiptap extensions for the markdown redline surface.
 *
 * The marks are DISPLAY only — they carry no provenance, because anchors are
 * line-snapped: a word-precise offset would be snapped back to its line
 * immediately, so provenance lives on the BLOCK (RedlineProvenance below).
 */

export const RedlineIns = Mark.create({
  name: 'redlineIns',
  inclusive: () => false,
  parseHTML: () => [{ tag: 'ins' }],
  renderHTML: () => ['ins', { class: 'lf-ins' }, 0],
});

/**
 * Priority 60 is load-bearing, not decoration. StarterKit's Strike mark parses
 * `del` (alongside `s` and `strike`) at the default priority of 50, so a plain
 * `{ tag: 'del' }` rule LOSES and every deletion renders as ordinary
 * strikethrough — near-identical by eye, and silently wrong. Outranking Strike
 * is the fix; disabling Strike is not, because real `~~strikethrough~~` in the
 * source must still render as itself.
 */
export const RedlineDel = Mark.create({
  name: 'redlineDel',
  inclusive: () => false,
  parseHTML: () => [{ tag: 'del', priority: 60 }],
  renderHTML: () => ['del', { class: 'lf-del' }, 0],
});

/** Block types that can carry provenance. Anything not listed simply has none,
 *  and a comment on it falls back to the nearest block that does. */
export const PROVENANCE_TYPES = [
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'bulletList',
  'orderedList',
  'table',
  'horizontalRule',
  'image',
];

function numberAttr(dataName: string, attrName: string) {
  return {
    default: null as number | null,
    parseHTML: (element: HTMLElement): number | null => {
      const raw = element.getAttribute(dataName);
      if (raw == null) return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    },
    renderHTML: (attrs: Record<string, unknown>): Record<string, string> => {
      const v = attrs[attrName];
      return v == null ? {} : { [dataName]: String(v) };
    },
  };
}

/**
 * Lifts `data-lf-*` provenance from the rendered HTML onto block nodes.
 *
 * `lfFrom`/`lfTo` are offsets into the `content` Y.Text — the block's source
 * span on the NEW side. `lfSnap` replaces them on deletion-only blocks, which
 * have no new-side position. This is the bridge that lets a selection in the
 * rendered prose produce an anchor byte-identical to the source diff view's.
 *
 * Stored as NUMBERS, not strings. `docs/process/learnings.md` records the
 * heading-level bug, which was exactly this: an attribute typed as a string
 * where a number was expected, silently falling back and hiding for weeks.
 */
export const RedlineProvenance = Extension.create({
  name: 'redlineProvenance',
  addGlobalAttributes() {
    return [
      {
        types: PROVENANCE_TYPES,
        attributes: {
          lfFrom: numberAttr('data-lf-from', 'lfFrom'),
          lfTo: numberAttr('data-lf-to', 'lfTo'),
          lfSnap: numberAttr('data-lf-snap', 'lfSnap'),
          lfChange: {
            default: null as string | null,
            parseHTML: (element: HTMLElement): string | null =>
              element.getAttribute('data-lf-change'),
            renderHTML: (attrs: Record<string, unknown>): Record<string, string> =>
              attrs.lfChange == null
                ? {}
                : {
                    'data-lf-change': String(attrs.lfChange),
                    class: `lf-block-${String(attrs.lfChange)}`,
                  },
          },
        },
      },
    ];
  },
});
