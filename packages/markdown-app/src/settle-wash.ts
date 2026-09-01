import { Extension } from '@tiptap/core';
import type { Node as ProseNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
// Same key instance Collaboration registers under — see editor.ts's import
// note; y-prosemirror's own export is a different key and never matches.
import { ySyncPluginKey } from '@tiptap/y-tiptap';

/**
 * The settle wash: when the notetaker's freshly composed note arrives in the
 * doc mid-meeting, the block it landed in is highlighted and the highlight
 * lingers (~2.8s: hold, then fade — the approved mock's `settle-wash`), so
 * the eye can follow a chunk of provisional transcript "up" into the note it
 * became. No label, no chip — the wash IS the whole announcement (owner's
 * call: the settled note gets no "from live text" marker).
 *
 * WHAT COUNTS AS THE NOTETAKER WRITING. The client cannot see who authored a
 * remote Yjs update, so the gate is the conjunction that is true for notes
 * and rarely for anything else: the transaction is REMOTE (carries the
 * y-sync meta — a local keystroke never does), a meeting is live on THIS
 * surface (`isLive`), and the inserted content sits inside the "Meeting
 * notes" section. A collaborator typing into the notes section during a
 * recording gets washed too; that is acceptable noise, where washing every
 * remote edit anywhere would not be.
 *
 * Decorations, never content: the wash must survive nothing and sync
 * nowhere. Each decoration carries its expiry; a sweep transaction dispatched
 * shortly after expiry drops it (the CSS animation has already finished —
 * the sweep only cleans the class off the DOM).
 */

export const SETTLE_WASH_MS = 2_800;
/** Wash classes are swept a beat after the animation ends. */
const SWEEP_LAG_MS = 200;

const key = new PluginKey<DecorationSet>('settleWash');
const SWEEP = 'settleWashSweep';

export interface SettleWashOptions {
  /** Whether a meeting is live on this surface right now. */
  isLive: () => boolean;
  /**
   * Remote content just landed in the notes section — the signal the live
   * zone's bot fallback uses to drop its settled lines.
   */
  onNotesInsert?: () => void;
}

/** Doc position where the notes section starts, or null. LAST heading named
 *  "Meeting notes", the same rule the server's section finder follows. */
export function notesSectionStart(doc: ProseNode): number | null {
  let at: number | null = null;
  doc.forEach((node, pos) => {
    if (node.type.name === 'heading' && node.textContent.trim() === 'Meeting notes') {
      at = pos;
    }
  });
  return at;
}

/** The ranges `tr` inserted, in the coordinates of its resulting doc. */
export function insertedRanges(tr: Transaction): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  tr.mapping.maps.forEach((map, i) => {
    map.forEach((_oldFrom, _oldTo, newFrom, newTo) => {
      if (newTo <= newFrom) return;
      // Into the final doc's coordinates, through the steps that follow.
      const from = tr.mapping.slice(i + 1).map(newFrom, 1);
      const to = tr.mapping.slice(i + 1).map(newTo, -1);
      if (to > from) out.push({ from, to });
    });
  });
  return out;
}

/** The blocks to wash for one inserted range: list items where the content
 *  is a list, textblocks otherwise — the smallest thing that reads as "the
 *  note that just arrived" rather than "the whole notes section". */
function washTargets(
  doc: ProseNode,
  range: { from: number; to: number },
): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  const from = Math.max(0, Math.min(range.from, doc.content.size));
  const to = Math.max(from, Math.min(range.to, doc.content.size));
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === 'listItem') {
      out.push({ from: pos, to: pos + node.nodeSize });
      return false;
    }
    if (node.isTextblock) {
      out.push({ from: pos, to: pos + node.nodeSize });
      return false;
    }
    return true;
  });
  return out;
}

export const SettleWash = Extension.create<SettleWashOptions>({
  name: 'settleWash',

  addOptions() {
    return { isLive: () => false };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            let next = set.map(tr.mapping, tr.doc);
            const sweepBefore = tr.getMeta(SWEEP) as number | undefined;
            if (sweepBefore !== undefined) {
              next = DecorationSet.create(
                tr.doc,
                next
                  .find()
                  .filter((d) => ((d.spec as { until?: number }).until ?? 0) > sweepBefore),
              );
            }
            if (!tr.docChanged || !tr.getMeta(ySyncPluginKey) || !options.isLive()) return next;
            // Hydration is a remote transaction too — the binding applies the
            // whole existing doc over an empty one when the surface mounts.
            // Opening a doc mid-meeting must not wash its entire notes
            // section, so a write over an empty doc never washes.
            if (tr.before.textContent === '') return next;
            const start = notesSectionStart(tr.doc);
            if (start === null) return next;
            const until = Date.now() + SETTLE_WASH_MS;
            const decos: Decoration[] = [];
            for (const range of insertedRanges(tr)) {
              if (range.to <= start) continue;
              for (const block of washTargets(tr.doc, range)) {
                if (block.from < start) continue;
                decos.push(
                  Decoration.node(block.from, block.to, { class: 'settle-wash' }, { until }),
                );
              }
            }
            return decos.length > 0 ? next.add(tr.doc, decos) : next;
          },
        },
        props: {
          decorations(state) {
            return key.getState(state);
          },
        },
        view(view) {
          let timer: ReturnType<typeof setTimeout> | null = null;
          return {
            update(v, prev) {
              const before = key.getState(prev)?.find().length ?? 0;
              const after = key.getState(v.state)?.find().length ?? 0;
              if (after > before) {
                options.onNotesInsert?.();
                // One sweep per batch of arrivals; a fresh batch re-arms it.
                if (timer !== null) clearTimeout(timer);
                timer = setTimeout(() => {
                  timer = null;
                  view.dispatch(view.state.tr.setMeta(SWEEP, Date.now()));
                }, SETTLE_WASH_MS + SWEEP_LAG_MS);
              }
            },
            destroy() {
              if (timer !== null) clearTimeout(timer);
            },
          };
        },
      }),
    ];
  },
});
