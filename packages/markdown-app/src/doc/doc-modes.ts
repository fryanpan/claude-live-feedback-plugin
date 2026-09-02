/**
 * The two mode switches over a markdown document: view/edit, and Suggesting.
 *
 * They are one file because they are one interlock, not two toggles that
 * happen to sit together. Suggesting implies an editable surface, so turning
 * it on drags edit mode along with it; `canWrite` can veto both; and the
 * read-only lock has to be able to put both back. Splitting them would leave
 * that agreement spread across two files and a comment.
 *
 * The caller gets back only the two verbs the read-only lock needs. The mode
 * variables stay in here, which is what stops a second writer appearing.
 */
import type { User } from '@feedback/core';
import { type EditMode, initialEditMode, writeEditModePref } from '../edit-mode.ts';
import type { EditorHandle } from '../editor.ts';
import type { MountScope } from '../mount-scope.ts';
import { readSuggestModePref, setSuggesting, writeSuggestModePref } from '../suggest-input.ts';

export interface DocModeElements {
  toggleEditMode: HTMLButtonElement;
  toggleSuggestMode: HTMLButtonElement;
  formatBar: HTMLElement;
  toggleFormat: HTMLButtonElement;
}

export interface DocModeOptions {
  editor: EditorHandle;
  scope: MountScope;
  els: DocModeElements;
  docId: string;
  user: User;
  canWrite: boolean;
  /** True when this mount started a huddle, which opens in edit mode. */
  justStarted: boolean;
}

/** What the read-only lock calls to put the surface back to reading. */
export interface DocModeLock {
  stopSuggesting: () => void;
  toViewMode: () => void;
}

export function wireDocModes(opts: DocModeOptions): DocModeLock {
  const { editor, scope, els, docId, user, canWrite, justStarted } = opts;
  const { toggleEditMode, toggleSuggestMode, formatBar, toggleFormat } = els;

  // =========================================================================
  // VIEW / EDIT MODE
  //   Mobile Safari focuses the editor on tap → keyboard opens → bottom UI
  //   gets pushed around. Default mobile viewports to read-only (view) mode
  //   so a tap doesn't bring up the keyboard. Long-press to select text
  //   still works in view mode and surfaces the comment pill. Persist the
  //   user's chosen mode in localStorage.
  // =========================================================================
  //   The mode itself, and the stored preference behind it, live in
  //   edit-mode.ts — including why the preference alone can never decide this.
  function applyEditMode(mode: EditMode): void {
    const editable = mode === 'edit';
    editor.editor.setEditable(editable);
    document.body.classList.toggle('view-mode', !editable);
    toggleEditMode.setAttribute('aria-pressed', String(editable));
    toggleEditMode.title = editable ? 'Tap to switch to view mode' : 'Tap to switch to edit mode';
    toggleEditMode.setAttribute(
      'aria-label',
      editable
        ? 'Currently editing — tap to switch to view mode'
        : 'Currently viewing — tap to switch to edit mode',
    );
    if (!editable) {
      formatBar.classList.add('is-collapsed');
      toggleFormat.setAttribute('aria-pressed', 'false');
    }
  }
  // The stored preference is CONSULTED, not obeyed: `canWrite` is the answer
  // main() already awaited, so the first `setEditable` of this mount is
  // already the right one. There is no window in which the document is live
  // and the answer is outstanding — the mount had the answer before it ran.
  let editMode: EditMode = initialEditMode(canWrite, { justStarted });
  applyEditMode(editMode);
  scope.listen(toggleEditMode, 'click', () => {
    // A disabled button fires no click. Kept anyway: `lockDocToReading` is
    // what disables it, and a guard that depends on a DOM property having
    // been set is one refactor away from being no guard at all.
    if (!canWrite) return;
    editMode = editMode === 'edit' ? 'view' : 'edit';
    writeEditModePref(editMode);
    applyEditMode(editMode);
  });

  // =========================================================================
  // SUGGESTING MODE — Google-Docs-style proposals. While ON, the suggest-input
  //   plugin turns typing/deleting into attributed suggestInsert/suggestDelete
  //   marks; nothing reaches disk until accepted (the serializer emits the
  //   accepted state). Persisted per doc (localStorage is per-browser, so the
  //   doc key already scopes it to this user).
  // =========================================================================
  let suggesting = readSuggestModePref(docId);
  function applySuggestMode(on: boolean): void {
    // Never on for a browser the server refuses. Belt to the toggle's
    // braces: this is the single call both the mount and the click go
    // through, so a persisted `suggest: on` preference cannot bring the
    // mode back for a reader who cannot write.
    if (!canWrite) on = false;
    setSuggesting(editor.editor.view, {
      on,
      author: { id: user.id, name: user.name, color: user.color },
    });
    document.body.classList.toggle('suggest-mode', on);
    toggleSuggestMode.setAttribute('aria-pressed', String(on));
    toggleSuggestMode.title = on
      ? 'Suggesting — edits become proposals. Tap for direct editing'
      : 'Tap to switch to Suggesting — edits become proposals';
    toggleSuggestMode.setAttribute(
      'aria-label',
      on
        ? 'Suggesting on — your edits become proposals. Tap for direct editing'
        : 'Suggesting off — tap to propose edits instead of making them',
    );
  }
  applySuggestMode(suggesting);
  scope.listen(toggleSuggestMode, 'click', () => {
    // See the edit toggle: covers the window before the session answer lands.
    if (!canWrite) return;
    suggesting = !suggesting;
    writeSuggestModePref(docId, suggesting);
    // Suggesting implies an editable surface — proposing requires typing.
    if (suggesting && editMode !== 'edit') {
      editMode = 'edit';
      writeEditModePref(editMode);
      applyEditMode(editMode);
    }
    applySuggestMode(suggesting);
  });

  return {
    stopSuggesting: () => {
      suggesting = false;
      applySuggestMode(false);
    },
    toViewMode: () => {
      editMode = 'view';
      applyEditMode('view');
    },
  };
}
