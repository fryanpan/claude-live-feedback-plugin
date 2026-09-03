import { SUGGEST_DELETE_MARK, SUGGEST_INSERT_MARK } from '@feedback/core';
import { Extension } from '@tiptap/core';
import type { Node as ProseNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/**
 * Mobile fallback marker for pending suggestions (redline-suggestions Phase
 * 2, commit 5): a small, tappable "✎ suggestion" widget rendered right
 * after each proposal's furthest marked position — mirrors live-markup.ts's
 * `.lf-del-chip` (same "always in the DOM, CSS decides visibility ≤1100px"
 * contract; styles.css shows `.lf-suggest-chip` in the SAME media query
 * block that reveals `.lf-del-chip`). markup-margin.ts owns what happens
 * when one is tapped (opens a bottom sheet with the same card the desktop
 * balloon renders); this extension owns only the decoration.
 *
 * Registered in the BASE editor schema (editor.ts), not a redline-only
 * extra: suggestion marks — and the need to reach Accept/Reject on a phone
 * — apply to the plain markdown surface too (suggest-marks.ts explains why
 * the marks themselves are base-schema; this follows the same reasoning).
 *
 * One chip per `sid`, not per marked range: a "replace" proposal carries
 * BOTH a suggestDelete range and an adjacent suggestInsert range under one
 * sid, and both should surface a single tappable marker, not two competing
 * ones.
 */

function buildSuggestionChip(sid: string): HTMLElement {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'lf-suggest-chip';
  chip.contentEditable = 'false';
  chip.textContent = '✎ suggestion';
  chip.setAttribute('aria-label', 'View suggested edit');
  chip.dataset.lfSuggestSid = sid;
  return chip;
}

/**
 * The furthest doc position any range of each `sid` reaches. Pure over the
 * PM doc (no view needed) — exported for a focused test of the positioning
 * rule without standing up a full editor.
 */
export function suggestionChipEnds(doc: ProseNode): Map<string, number> {
  const ends = new Map<string, number>();
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    for (const mark of node.marks) {
      if (mark.type.name !== SUGGEST_INSERT_MARK && mark.type.name !== SUGGEST_DELETE_MARK) {
        continue;
      }
      const sid = mark.attrs.sid;
      if (typeof sid !== 'string' || sid.length === 0) continue;
      const end = pos + node.nodeSize;
      if (end > (ends.get(sid) ?? -1)) ends.set(sid, end);
    }
  });
  return ends;
}

function computeDecorations(doc: ProseNode): DecorationSet {
  const decos: Decoration[] = [];
  for (const [sid, pos] of suggestionChipEnds(doc)) {
    decos.push(Decoration.widget(pos, () => buildSuggestionChip(sid), { side: 1 }));
  }
  return DecorationSet.create(doc, decos);
}

const suggestionChipsKey = new PluginKey<DecorationSet>('lf-suggestion-chips');

export const SuggestionChips = Extension.create({
  name: 'suggestionChips',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: suggestionChipsKey,
        state: {
          init: (_config, state) => computeDecorations(state.doc),
          apply: (tr, prev) => (tr.docChanged ? computeDecorations(tr.doc) : prev),
        },
        props: {
          decorations(state) {
            return suggestionChipsKey.getState(state);
          },
        },
      }),
    ];
  },
});
