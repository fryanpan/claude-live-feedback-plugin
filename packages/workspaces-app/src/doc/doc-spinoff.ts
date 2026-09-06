import { type User, readDocMeta } from '@feedback/core';
import type * as Y from 'yjs';
/**
 * Spinning selected words off a huddle doc into work: "Create task" and
 * "Research", and taking either one back.
 *
 * Taking it back lives beside taking it, because the undo is what makes the
 * tap safe to offer at all — the toast that reports the row is the same toast
 * that carries the Undo, and the two halves have to agree on what was made
 * (an archived row, an un-linked range) or the offer is a lie.
 */
import { api } from '../doc-path.ts';
import type { EditorHandle } from '../editor.ts';
import { linkSpinoffRange, unlinkSpinoffHref } from '../spinoff-link.ts';
import { type SpinoffTaskId, boardIdFor, runSpinoff } from '../spinoff-menu.ts';
import { type ChromeSelection, anchorBody } from './anchor-body.ts';
import { showToast } from './chrome-dom.ts';

export interface DocSpinoffOptions {
  docId: string;
  ydoc: Y.Doc;
  user: User;
  editor: EditorHandle;
  /** The doc's own metadata — `boardIdFor` reads `backTo` off it, which is
   *  the board a huddle was started from and NOT `workspaceId`. */
  meta: { backTo?: { workspaceId?: string }; workspaceId?: string };
}

/** Take a selection off the doc and onto the board. */
export type SpinoffRunner = (
  action: SpinoffTaskId,
  sel: ChromeSelection,
  range: { from: number; to: number } | null,
) => Promise<void>;

export function createSpinoffRunner(opts: DocSpinoffOptions): SpinoffRunner {
  const { docId, ydoc, user, editor, meta } = opts;

  /**
   * Take a spin-off back: archive the row, and un-link the words.
   *
   * Archive rather than delete — a spun-off row may already have been read,
   * ranked or replied to in the seconds the toast was up, and this project
   * does not destroy content to undo a tap. The board stops showing it, and
   * it is still there to restore.
   */
  async function undoSpinoff(taskId: string, href: string | undefined): Promise<void> {
    try {
      const res = await fetch(api(`tasks/${encodeURIComponent(taskId)}/archive`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author: user, reason: 'Undone from the doc it was spun off from' }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      showToast("Couldn't undo that — the task is still on the board.");
      return;
    }
    if (href !== undefined) unlinkSpinoffHref(editor.editor, href);
    showToast('Undone.');
  }

  return async function takeSpinoff(action, sel, range): Promise<void> {
    // The BOARD this doc is filed on, which is `backTo` — not `workspaceId`.
    //
    // Those are two different ids and the difference is the whole bug this
    // comment exists for: `meta.workspaceId` is the GROUPING id of a diff
    // review or a folder browse, and a huddle doc has none at all. Reading it
    // gave the empty string, which is not `undefined`, so the guard below
    // passed and the create went to `/workspaces//tasks` — a 404 the
    // person saw as a toast reading "404".
    //
    // `backTo` is what the server answers when it can name the board a doc
    // was reached from, which for a huddle is the board that started it.
    const workspaceId = boardIdFor(meta);
    // Empty, not undefined, is how "no board" actually arrives — `DocMeta`
    // defaults both ids to `''`.
    if (!workspaceId) {
      showToast('This doc is not on a board yet.');
      return;
    }
    try {
      const made = await runSpinoff(action, {
        docId,
        workspaceId,
        user,
        quote: sel.snippet,
        anchor: anchorBody(sel),
        docTitle: readDocMeta(ydoc).title,
        fetchJson: async (url, init) => {
          const res = await fetch(url, init);
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(String((body as { error?: string }).error ?? res.status));
          return body;
        },
      });
      if (!made) {
        showToast("That didn't go through — try again.");
        return;
      }
      if (made.action === 'research') {
        // The doc is the receipt: a "Research: …" section now sits under
        // the line, and the ask thread on the line is what the lead
        // answers. Nothing to link and nothing to undo from here — the
        // section is prose, and deleting prose is the editor's own verb.
        showToast(
          made.placeholder
            ? `“${made.section}” added below — the lead fills it in.`
            : 'Research asked for — the lead answers on the thread.',
        );
        return;
      }
      // The selected words BECOME the task's link — nothing is written into
      // the doc. `task-link-chips.ts` hangs the row's live status beside
      // them, so the line reads as itself with a status on the end.
      if (made.href !== undefined && range) {
        linkSpinoffRange(editor.editor, range, made.href);
      }
      const named = made.title ? `“${made.title}”` : 'Task';
      const { taskId, href } = made;
      // Name the column. The row's placement is now decided from what the
      // row says rather than from which button was pressed, so "added to the
      // board" would leave the person to go and find out which half of that
      // decision they got.
      const landed = made.status === 'triage' ? 'sent to Triage' : 'added to To do';
      showToast(
        `${named} — ${landed}.`,
        taskId !== undefined
          ? { label: 'Undo', onAction: () => void undoSpinoff(taskId, href) }
          : undefined,
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : "That didn't go through.");
    }
  };
}
