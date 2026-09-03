import { Extension } from '@tiptap/core';
import type { Node as ProseNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
// Same key instance Collaboration registers under — see editor.ts's import
// note; y-prosemirror's own export is a different key and never matches.
import { ySyncPluginKey } from '@tiptap/y-tiptap';

/**
 * The settle wash: when the notetaker's freshly composed note arrives in the
 * doc mid-meeting, the lines it wrote are highlighted and the highlight
 * lingers (~2.8s: hold, then fade — the approved mock's `settle-wash`), so
 * the eye can follow a chunk of provisional transcript "up" into the note it
 * became. No label, no chip — the wash IS the whole announcement (owner's
 * call: the settled note gets no "from live text" marker).
 *
 * WHAT COUNTS AS THE NOTETAKER WRITING. The client cannot see who authored a
 * remote Yjs update, so the gate is the conjunction that is true for notes
 * and rarely for anything else: the transaction is REMOTE (carries the
 * y-sync meta — a local keystroke never does), a meeting is live on THIS
 * surface (`isLive`), and the "Meeting notes" section holds lines it did
 * not hold before (`newNoteLines` — a content diff, see there for why the
 * step map cannot be used). A collaborator typing into the notes section during a
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

export interface NoteLine {
  from: number;
  to: number;
  /** The line's content, marks included — what "the same line" means. */
  key: string;
}

/** The lines the notes section is made of: every textblock (a bullet's
 *  paragraph, a heading, a paragraph) from the section heading to the end of
 *  the doc. A bullet with children is several lines, one per textblock. */
export function noteLines(doc: ProseNode): NoteLine[] {
  const start = notesSectionStart(doc);
  if (start === null) return [];
  const out: NoteLine[] = [];
  doc.nodesBetween(start, doc.content.size, (node, pos) => {
    if (node.isTextblock) {
      out.push({ from: pos, to: pos + node.nodeSize, key: JSON.stringify(node.toJSON()) });
      return false;
    }
    return true;
  });
  return out;
}

/**
 * The lines of `after`'s notes section that `before`'s did not hold — the
 * lines this write added or changed. A content diff rather than the
 * transaction's step map, because the collaboration binding applies every
 * remote update as ONE replace of the whole document (y-tiptap's
 * `_typeChanged`): the map says "everything was inserted", and washing what
 * it says would light the entire section on every tick — which it did.
 * A line that appears twice consumes one match per copy, so a duplicated
 * line washes once, at its second copy.
 */
export function newNoteLines(before: ProseNode, after: ProseNode): NoteLine[] {
  const had = new Map<string, number>();
  for (const line of noteLines(before)) had.set(line.key, (had.get(line.key) ?? 0) + 1);
  return noteLines(after).filter((line) => {
    const n = had.get(line.key) ?? 0;
    if (n > 0) {
      had.set(line.key, n - 1);
      return false;
    }
    return true;
  });
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
            const until = Date.now() + SETTLE_WASH_MS;
            const decos = newNoteLines(tr.before, tr.doc).map((line) =>
              Decoration.node(line.from, line.to, { class: 'settle-wash' }, { until }),
            );
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
