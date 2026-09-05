/**
 * The last phase of a markdown document's boot: what this browser is allowed
 * to do with the surface.
 *
 * Three things in one place because between them they settle one question.
 * The format bar's own collapse toggle and its hotkey; the view/edit and
 * Suggesting interlock (doc-modes.ts); and the read-only lock that overrides
 * both when the server will not accept writes. The lock has to run AFTER the
 * toggles exist, because it drives them through the handle they hand back —
 * putting the order here is what keeps it from being an accident of two call
 * sites.
 *
 * Synchronous, and last in the mount, because it speaks for the whole
 * surface: `canWrite` arrived on the MountContext, so nothing here waits on a
 * network answer and nothing is editable in the meantime.
 */
import type { User } from '@feedback/core';
import type { EditorHandle } from '../editor.ts';
import type { MountScope } from '../mount-scope.ts';
import { lockDocToReading } from '../signin/write-gate.ts';
import { type DocModeElements, wireDocModes } from './doc-modes.ts';
import { applyWidthPref, wireFormatBar } from './editor-toolbar.ts';

export interface DocGatesOptions {
  editor: EditorHandle;
  scope: MountScope;
  els: DocModeElements;
  docId: string;
  user: User;
  canWrite: boolean;
  /** True when this mount started a huddle, which opens in edit mode. */
  justStarted: boolean;
}

export function wireDocGates(opts: DocGatesOptions): void {
  const { editor, scope, els, docId, user, canWrite, justStarted } = opts;
  const { formatBar, toggleFormat } = els;

  // =========================================================================
  // FORMATTING TOOLBAR — collapsed by default. Aa button toggles it.
  // =========================================================================
  scope.listen(toggleFormat, 'click', () => {
    const collapsed = formatBar.classList.toggle('is-collapsed');
    toggleFormat.setAttribute('aria-pressed', String(!collapsed));
  });
  applyWidthPref();
  wireFormatBar(editor, scope);

  // The two mode switches and the interlock between them live in
  // doc/doc-modes.ts; what stays here is the read-only lock that speaks for
  // the whole surface, and it drives them through the handle it gets back.
  const modes = wireDocModes({ editor, scope, els, docId, user, canWrite, justStarted });

  /**
   * A browser the server will not accept writes from does not get an edit
   * toggle — or a Suggesting toggle, which is the same door. The socket is
   * already read-only server-side; this is what stops a person typing into it
   * and watching the text vanish on reload.
   */
  if (!canWrite) {
    // The crumb and the save-state chip are `lockDocToReading`'s now — they
    // were here, and the redline and code surfaces went without them.
    lockDocToReading(modes);
  }

  // =========================================================================
  // HOTKEYS — ⌘M / Escape are wired by the shared chrome; only the
  // markdown-specific format-bar hotkey lives here.
  // =========================================================================
  scope.listen(document, 'keydown', (ev) => {
    const ke = ev as KeyboardEvent;
    if ((ke.metaKey || ke.ctrlKey) && ke.shiftKey && ke.key.toLowerCase() === 'f') {
      ke.preventDefault();
      toggleFormat.click();
    }
  });
}
