import { Extension } from '@tiptap/core';
import type { Node as ProseNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type * as Y from 'yjs';

/**
 * The one line that carries the "Make a plan" entry (round-4 mock, B1): the
 * doc opens with nothing but the Goal heading, and this placeholder does all
 * the explaining — talk and type both land here, and "ask to make a plan"
 * names the next step the floating Make Plan button offers. No recording UI
 * on the doc, no listening chip; the meeting strip is the capture chrome.
 *
 * STRICTLY RENDER-TIME, like the task-link chips: a widget decoration at the
 * end of the doc, gone the moment any body content exists. The stored doc
 * never contains this text.
 */

export const PLAN_PLACEHOLDER_TEXT =
  'Type or say what problem you’d like to solve. When you’re done, ask to make a plan';

const planPlaceholderKey = new PluginKey<DecorationSet>('plan-placeholder');

/** The refresh ping the meta observer sends when `huddleKind` arrives after
 *  mount (sync order is the server's business, not ours). */
const META_KEY = 'planPlaceholder';

/**
 * Goal-shaped and still unwritten: a first-child heading (the seeded
 * `# Goal`), and nothing after it but empty paragraphs. A doc with no
 * heading at all is NOT empty in this sense — the seed hasn't synced yet,
 * and a placeholder floating in a truly blank doc would attach the copy to
 * nothing.
 */
export function planBodyIsEmpty(doc: ProseNode): boolean {
  if (doc.childCount === 0) return false;
  const first = doc.child(0);
  if (first.type.name !== 'heading') return false;
  for (let i = 1; i < doc.childCount; i++) {
    const child = doc.child(i);
    if (child.type.name !== 'paragraph' || child.content.size > 0) return false;
  }
  return true;
}

function placeholderEl(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'plan-placeholder';
  el.textContent = PLAN_PLACEHOLDER_TEXT;
  return el;
}

export interface PlanPlaceholderOptions {
  /** The collaboration doc — the kind is read from its meta map lazily,
   *  because meta syncs on the server's schedule, not before mount. */
  ydoc: Y.Doc | null;
}

export const PlanPlaceholder = Extension.create<PlanPlaceholderOptions>({
  name: 'planPlaceholder',

  addOptions() {
    return { ydoc: null };
  },

  addProseMirrorPlugins() {
    const ydoc = this.options.ydoc;
    if (!ydoc) return [];
    const isPlan = (): boolean => ydoc.getMap('meta').get('huddleKind') === 'plan';
    const build = (doc: ProseNode): DecorationSet => {
      if (!isPlan() || !planBodyIsEmpty(doc)) return DecorationSet.empty;
      return DecorationSet.create(doc, [
        Decoration.widget(doc.content.size, placeholderEl, {
          key: 'plan-placeholder',
          side: 1,
          ignoreSelection: true,
        }),
      ]);
    };
    return [
      new Plugin<DecorationSet>({
        key: planPlaceholderKey,
        state: {
          init: (_cfg, pmState) => build(pmState.doc),
          apply: (tr, prev) => {
            if (tr.getMeta(META_KEY) || tr.docChanged) return build(tr.doc);
            return prev;
          },
        },
        props: {
          decorations(state) {
            return planPlaceholderKey.getState(state);
          },
        },
        view(view) {
          // `huddleKind` can land after the first paint (initial sync) — a
          // meta write is not a doc change, so it never reaches `apply` on
          // its own. One ping per meta event; build() stays idempotent.
          const meta = ydoc.getMap('meta');
          const onMeta = (): void => {
            view.dispatch(view.state.tr.setMeta(META_KEY, true));
          };
          meta.observe(onMeta);
          return {
            destroy() {
              meta.unobserve(onMeta);
            },
          };
        },
      }),
    ];
  },
});
