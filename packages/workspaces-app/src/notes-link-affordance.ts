import {
  acceptedHref,
  isSuggestionHref,
  parseWorkspaceLink,
  titleFromSuggestionLabel,
} from '@feedback/core';
import { Extension } from '@tiptap/core';
import type { Node as ProseNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { type TaskLinkRun, taskLinkRunsIn } from './task-link-chips.ts';

/**
 * The two taps a meeting note's links can take: accept a question, and undo a
 * link that was wrong.
 *
 * THE QUESTION. The note-taker writes "related: Volume buttons?" as an
 * ordinary markdown link whose href carries `suggest=1`
 * (`core/note-suggestion.ts`). Tapping it writes the ref onto the row and
 * rewrites the words in place, so the question becomes the citation it was
 * asking about. Nothing else in the doc changes and nothing new is inserted —
 * the link the reader tapped IS the link they end up with, which is why this
 * needs no chip, no caption and no confirm step. Links in this editor are
 * non-navigable on a plain click already, so the tap was free.
 *
 * THE UNDO, and why it is only on rows that have a ref. The matcher answers
 * from a loose description and will sometimes answer wrong, so a wrong link
 * has to be removable — and removable in a way that takes the ROW's side with
 * it, or the doc stops citing a task that still lists the doc. The control is
 * a widget beside the link, and it is drawn only where this doc actually
 * holds a ref, which is read from the doc's own backlink surface. So an
 * ordinary pasted task link carries nothing, and a control that appears is
 * always a control with something to undo.
 *
 * UNDOING KEEPS THE WORDS. It removes the ref and the link mark, not the
 * sentence: the composer weaves a row's title into the middle of a note
 * ("we sized the volume buttons again"), and deleting the text to remove a
 * citation would take a clause of somebody's meeting record with it. What was
 * said stays; what is no longer claimed is the link.
 */

export const notesLinkAffordanceKey = new PluginKey<AffordanceState>('notes-link-affordance');
const META_KEY = 'notesLinkAffordance';

/** The attribute the undo control is found by — the click lands on the
 *  widget, which is outside the document, so there is no position to read. */
const UNLINK_ATTR = 'data-cw-unlink-task';

export interface NotesLinkAffordanceOptions {
  /** The doc these notes are in: the ref side of every link they carry. */
  docId: string;
  /**
   * Task ids this doc is currently linked from. Read on every rebuild rather
   * than captured, because accepting a question adds one and undoing removes
   * one — and the control has to appear and disappear with them.
   */
  linkedTasks: () => ReadonlySet<string>;
  /** Write the doc ref onto the row. `false` leaves the note untouched. */
  link: (taskId: string) => Promise<boolean>;
  /** Remove it. `false` leaves the note untouched. */
  unlink: (taskId: string) => Promise<boolean>;
  /** Something changed on the server; re-read `linkedTasks` behind this. */
  onChanged?: () => void | Promise<void>;
}

/** The task a workspace link names, or null when it names something else. */
function taskIdOf(url: string): string | null {
  const link = parseWorkspaceLink(url);
  return link?.kind === 'task' ? link.taskId : null;
}

/** The undo control: an affordance, not a label. */
function unlinkEl(taskId: string): HTMLElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'note-unlink';
  el.setAttribute(UNLINK_ATTR, taskId);
  // The control is a glyph; the name it needs is the one a screen reader
  // reads, and it belongs there rather than beside it in the prose.
  el.setAttribute('aria-label', 'Remove this link');
  el.title = 'Remove this link';
  el.textContent = '×';
  return el;
}

/**
 * What the plugin holds: the linked set it last heard about, and the controls
 * built from it. The set lives here rather than being read per rebuild
 * because it comes from the network — a decoration build must be synchronous
 * and must not depend on when a fetch happened to land.
 */
interface AffordanceState {
  linked: ReadonlySet<string>;
  deco: DecorationSet;
}

function build(doc: ProseNode, linked: ReadonlySet<string>): DecorationSet {
  const decos: Decoration[] = [];
  for (const run of taskLinkRunsIn(doc)) {
    if (isSuggestionHref(run.url)) continue;
    const taskId = taskIdOf(run.url);
    if (!taskId || !linked.has(taskId)) continue;
    decos.push(
      Decoration.widget(run.to, () => unlinkEl(taskId), {
        key: `unlink|${taskId}`,
        // After the status chip, which takes side 1: the chip says what the
        // row IS and the control acts on the link, and a control between a
        // link and its own status reads as belonging to neither.
        side: 2,
        ignoreSelection: true,
      }),
    );
  }
  return DecorationSet.create(doc, decos);
}

/** The run in the CURRENT document carrying exactly this href. Re-found after
 *  the await rather than remembered: the meeting keeps writing while the
 *  request is in flight, and a stale position would edit the wrong words. */
function runWithHref(view: EditorView, href: string): TaskLinkRun | undefined {
  return taskLinkRunsIn(view.state.doc).find((r) => r.url === href);
}

/** Turn one written question into the citation it was asking about. */
function acceptInDoc(view: EditorView, href: string): boolean {
  const run = runWithHref(view, href);
  if (!run) return false;
  const linkMark = view.state.schema.marks.link;
  if (!linkMark) return false;
  const shown = view.state.doc.textBetween(run.from, run.to);
  // A reader who rewrote the words keeps them: their sentence is not ours to
  // replace, and only the marker has to go.
  const title = titleFromSuggestionLabel(shown) ?? shown;
  const tr = view.state.tr.replaceWith(
    run.from,
    run.to,
    view.state.schema.text(title, [linkMark.create({ href: acceptedHref(run.url) })]),
  );
  view.dispatch(tr);
  return true;
}

/** Take the citation off the words, leaving the words. */
function unlinkInDoc(view: EditorView, taskId: string): boolean {
  const linkMark = view.state.schema.marks.link;
  if (!linkMark) return false;
  const runs = taskLinkRunsIn(view.state.doc).filter((r) => taskIdOf(r.url) === taskId);
  if (runs.length === 0) return false;
  const tr = view.state.tr;
  // Back to front, so an earlier removal cannot move a later run's position.
  for (const run of [...runs].reverse()) tr.removeMark(run.from, run.to, linkMark);
  view.dispatch(tr);
  return true;
}

/**
 * Tell this editor which rows the doc is linked from now.
 *
 * The only way the set changes: there is no polling, because every change to
 * it is one somebody just made in this editor or one the caller learned about
 * from the server on its own schedule.
 */
export function refreshNotesLinkAffordances(view: EditorView, linked: ReadonlySet<string>): void {
  view.dispatch(view.state.tr.setMeta(META_KEY, linked));
}

export const NotesLinkAffordance = Extension.create<Partial<NotesLinkAffordanceOptions>>({
  name: 'notesLinkAffordance',
  addOptions() {
    return {};
  },
  addProseMirrorPlugins() {
    const opts = this.options;
    // Unconfigured — every surface but a workspace doc — the plugin is not
    // installed at all, rather than installed and inert on every keystroke.
    if (!opts.docId || !opts.linkedTasks || !opts.link || !opts.unlink) return [];
    const options = opts as NotesLinkAffordanceOptions;
    return [
      new Plugin<AffordanceState>({
        key: notesLinkAffordanceKey,
        props: {
          decorations(state) {
            return notesLinkAffordanceKey.getState(state)?.deco;
          },
        },
        state: {
          init: (_cfg, pmState) => {
            const linked = options.linkedTasks();
            return { linked, deco: build(pmState.doc, linked) };
          },
          apply: (tr, prev, _old, next) => {
            const told = tr.getMeta(META_KEY) as ReadonlySet<string> | undefined;
            if (told) return { linked: told, deco: build(next.doc, told) };
            if (tr.docChanged) return { linked: prev.linked, deco: build(next.doc, prev.linked) };
            return prev;
          },
        },
        view(view) {
          // Whatever the caller learns after a write lands, told to the
          // plugin as a set. Nothing here dispatches from `update`: a
          // decoration rebuild that dispatched would re-enter update and
          // never stop.
          const settle = async (changed: boolean): Promise<void> => {
            if (!changed) return;
            await options.onChanged?.();
            if (!(view as { isDestroyed?: boolean }).isDestroyed) {
              refreshNotesLinkAffordances(view, options.linkedTasks());
            }
          };
          const onClick = (ev: MouseEvent): void => {
            // Only a plain primary tap is a gesture here. Cmd/Ctrl-click is
            // "open the row in a tab" and the editor already answers it;
            // taking that over would make the one way to LOOK at a row before
            // accepting it unreachable.
            if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
            const el = ev.target as HTMLElement | null;
            const undo = el?.closest?.(`[${UNLINK_ATTR}]`);
            if (undo) {
              const taskId = undo.getAttribute(UNLINK_ATTR);
              if (!taskId) return;
              ev.preventDefault();
              ev.stopPropagation();
              void options.unlink(taskId).then((ok) => {
                if (ok) unlinkInDoc(view, taskId);
                return settle(ok);
              });
              return;
            }
            const anchor = el?.closest?.('a[href]') as HTMLAnchorElement | null;
            const href = anchor?.getAttribute('href');
            if (!href || !isSuggestionHref(href)) return;
            const taskId = taskIdOf(href);
            if (!taskId) return;
            // The tap is the whole gesture: no dialog, and the link the
            // reader touched is the link they are left with.
            ev.preventDefault();
            ev.stopPropagation();
            void options.link(taskId).then((ok) => {
              if (ok) acceptInDoc(view, href);
              return settle(ok);
            });
          };
          // Capture phase: the default action on an anchor is a navigation,
          // and `preventDefault` has to be in before anything downstream
          // decides to follow the href.
          view.dom.addEventListener('click', onClick, true);
          return {
            destroy: () => view.dom.removeEventListener('click', onClick, true),
          };
        },
      }),
    ];
  },
});
