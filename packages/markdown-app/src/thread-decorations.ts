import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
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

const META_KEY = 'threadDecorations';
interface Meta {
  ranges?: ThreadRange[];
  activeId?: string | null;
  pulseId?: string | null;
}

export const threadDecorationsKey = new PluginKey<State>('thread-decorations');

interface State {
  ranges: ThreadRange[];
  activeId: string | null;
  pulseId: string | null;
  deco: DecorationSet;
}

function buildDecos(
  doc: any,
  ranges: ThreadRange[],
  activeId: string | null,
  pulseId: string | null,
): DecorationSet {
  const decos: Decoration[] = [];
  const docSize = doc.content.size;
  for (const r of ranges) {
    const from = Math.max(0, Math.min(r.from, docSize));
    const to = Math.max(0, Math.min(r.to, docSize));
    if (from >= to) continue;
    const classes = ['thread-range'];
    if (r.status === 'resolved') classes.push('resolved');
    if (activeId === r.id) classes.push('active');
    if (pulseId === r.id) classes.push('pulse');
    decos.push(Decoration.inline(from, to, { class: classes.join(' '), 'data-thread-id': r.id }));
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
            deco: buildDecos(pmState.doc, [], null, null),
          }),
          apply: (tr, prev) => {
            const meta = tr.getMeta(META_KEY) as Meta | undefined;
            let ranges = prev.ranges;
            let activeId = prev.activeId;
            let pulseId = prev.pulseId;
            if (meta) {
              if (meta.ranges) ranges = meta.ranges;
              if ('activeId' in meta) activeId = meta.activeId ?? null;
              if ('pulseId' in meta) pulseId = meta.pulseId ?? null;
            }
            // rebuild when doc changed or state changed
            if (meta || tr.docChanged) {
              return {
                ranges,
                activeId,
                pulseId,
                deco: buildDecos(tr.doc, ranges, activeId, pulseId),
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
  view: { state: any; dispatch: (tr: any) => void },
  meta: Meta,
): void {
  const tr = view.state.tr;
  tr.setMeta(META_KEY, meta);
  view.dispatch(tr);
}
