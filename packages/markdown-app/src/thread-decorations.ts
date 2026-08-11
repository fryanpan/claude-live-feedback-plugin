import { Extension } from '@tiptap/core';
import type { Node as ProseNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/**
 * Thread highlight decorations.
 *
 * Renders inline background highlights for every resolved text-range anchor
 * in the doc, plus a brighter pulse when the user clicks a specific thread
 * in the side panel. Updates are driven by a `setThreadRanges` tr meta.
 */

export interface ThreadRange {
  id: string;
  from: number;
  to: number;
  status: 'open' | 'resolved';
}

/**
 * A comment card to render IN THE FLOW, under the block its thread is
 * anchored in — the mobile inline comment surface.
 *
 * Only the id and the node travel: the position comes from the thread's own
 * `ThreadRange`, which this plugin already maps through every transaction. A
 * second set of positions would drift from the highlight it is supposed to
 * sit under.
 */
export interface InlineCardSpec {
  id: string;
  el: HTMLElement;
}

const META_KEY = 'threadDecorations';
interface Meta {
  ranges?: ThreadRange[];
  activeId?: string | null;
  pulseId?: string | null;
  inlineCards?: InlineCardSpec[];
}

export const threadDecorationsKey = new PluginKey<State>('thread-decorations');

interface State {
  ranges: ThreadRange[];
  activeId: string | null;
  pulseId: string | null;
  inlineCards: InlineCardSpec[];
  deco: DecorationSet;
}

/**
 * ONE shared spec object, deliberately hoisted.
 *
 * `WidgetType.eq` is `toDOM == other.toDOM && compareObjs(spec, other.spec)`,
 * and `compareObjs` compares own properties with `===`. A spec built inline
 * would carry a FRESH `stopEvent` closure on every rebuild, so every
 * transaction would declare the widget changed and rebuild the widget view
 * around the card. (Under happy-dom the card's DOM survives that either way,
 * so this is churn avoided by construction rather than a bug with a
 * regression test behind it — see the inline-card suite, where the
 * detach-detector could not be made non-vacuous.)
 *
 * `stopEvent`: everything inside the card (the reply box, Resolve, the fold
 * tap) is the card's business; ProseMirror must not treat any of it as
 * editing the document.
 */
const INLINE_CARD_SPEC = { side: 1, stopEvent: () => true, ignoreSelection: true };

/**
 * The position just after the top-level block containing `pos` — where an
 * in-flow card belongs, the way a GitHub PR comment sits under its hunk.
 * Inside the block would put the card in the middle of a paragraph's text.
 */
function afterBlockAt(doc: ProseNode, pos: number): number {
  const clamped = Math.max(0, Math.min(pos, doc.content.size));
  const $p = doc.resolve(clamped);
  return $p.depth >= 1 ? $p.after(1) : clamped;
}

function buildDecos(
  doc: ProseNode,
  ranges: ThreadRange[],
  activeId: string | null,
  pulseId: string | null,
  inlineCards: InlineCardSpec[],
): DecorationSet {
  const decos: Decoration[] = [];
  const docSize = doc.content.size;
  const cardFor = new Map(inlineCards.map((c) => [c.id, c.el]));
  for (const r of ranges) {
    // Resolved threads disappear from the doc — the conversation is
    // still reachable via the Resolved tab in the drawer, but the
    // highlight no longer competes for the reader's attention.
    if (r.status === 'resolved') continue;
    const from = Math.max(0, Math.min(r.from, docSize));
    const to = Math.max(0, Math.min(r.to, docSize));
    if (from >= to) continue;
    const classes = ['thread-range'];
    if (activeId === r.id) classes.push('active');
    if (pulseId === r.id) classes.push('pulse');
    decos.push(Decoration.inline(from, to, { class: classes.join(' '), 'data-thread-id': r.id }));

    const card = cardFor.get(r.id);
    if (!card) continue;
    // The NODE is the widget, not a factory: ProseMirror compares widgets by
    // their toDOM identity, so handing it the same element again leaves the
    // live card in place — which is what lets an expanded card keep animating
    // through an unrelated transaction instead of being rebuilt mid-morph.
    decos.push(Decoration.widget(afterBlockAt(doc, to), card, INLINE_CARD_SPEC));
  }
  return DecorationSet.create(doc, decos);
}

export const ThreadDecorations = Extension.create({
  name: 'threadDecorations',
  addProseMirrorPlugins() {
    return [
      new Plugin<State>({
        key: threadDecorationsKey,
        state: {
          init: (_cfg, pmState) => ({
            ranges: [],
            activeId: null,
            pulseId: null,
            inlineCards: [],
            deco: buildDecos(pmState.doc, [], null, null, []),
          }),
          apply: (tr, prev) => {
            const meta = tr.getMeta(META_KEY) as Meta | undefined;
            let ranges = prev.ranges;
            let activeId = prev.activeId;
            let pulseId = prev.pulseId;
            let inlineCards = prev.inlineCards;
            // Map stored positions through the change BEFORE rebuilding.
            // `ranges` are absolute positions captured when they were last
            // computed from thread anchors; the anchors themselves are Yjs
            // RelativePositions and stay correct, but these cached numbers do
            // not. Without mapping, every character typed at or before a
            // range left its highlight rendered N positions off — drifting
            // further with each keystroke, and only re-syncing on the next
            // full refresh. Same contract live-markup.ts already keeps for
            // the redline marks.
            //
            // assoc: `from` +1 and `to` -1 so text typed exactly at either
            // edge falls OUTSIDE the highlight (it keeps covering the words
            // the comment was left on), while typing INSIDE grows it.
            if (tr.docChanged && ranges.length > 0) {
              ranges = ranges.map((r) => ({
                ...r,
                from: tr.mapping.map(r.from, 1),
                to: tr.mapping.map(r.to, -1),
              }));
            }
            if (meta) {
              if (meta.ranges) ranges = meta.ranges;
              if ('activeId' in meta) activeId = meta.activeId ?? null;
              if ('pulseId' in meta) pulseId = meta.pulseId ?? null;
              if (meta.inlineCards) inlineCards = meta.inlineCards;
            }
            // rebuild when doc changed or state changed
            if (meta || tr.docChanged) {
              return {
                ranges,
                activeId,
                pulseId,
                inlineCards,
                deco: buildDecos(tr.doc, ranges, activeId, pulseId, inlineCards),
              };
            }
            return prev;
          },
        },
        props: {
          decorations(state) {
            return threadDecorationsKey.getState(state)?.deco;
          },
        },
      }),
    ];
  },
});

export function setThreadDecorations(
  view: EditorView | { state: EditorState; dispatch: (tr: Transaction) => void },
  meta: Meta,
): void {
  const tr = view.state.tr;
  tr.setMeta(META_KEY, meta);
  view.dispatch(tr);
}
