/**
 * One prompt, open: the words, a Save, a Restore, and the default behind a
 * disclosure.
 *
 * Its own module for the same reason `hub/review-criteria.ts` is one: the
 * behaviour worth pinning is what the field does when the read fails, when
 * the box is empty, and when the words that come back are not the words that
 * were sent — none of which is reachable from inside the page's boot.
 *
 * Three rules are carried over from that field verbatim, because each was
 * learned rather than chosen:
 *
 *  - A FAILED READ DISABLES THE BOX rather than emptying it. An empty box a
 *    reader then saves would write emptiness over words that are still there;
 *    a failed READ must never become a destructive WRITE.
 *  - AN EMPTY BOX IS REFUSED ON SAVE. Select-all-delete is a slip far more
 *    often than a request to send no instructions at all, and "the default"
 *    already has its own button.
 *  - A SAVE RE-READS rather than trusting what it sent. The server decides
 *    whether these words are now an override, and a restore has to come back
 *    with the default's own text to put in the box.
 */

import { escapeHtml } from '@feedback/core';
import type { PromptDetail, PromptsApi } from './prompts-api.ts';

/**
 * The Save button's own words.
 *
 * The promise this page makes — the change takes effect on the next call,
 * with no restart and no deploy — is invisible unless something says it, and
 * a caption under the button is the shape this page does not use. So the
 * button says it in its own label.
 *
 * "used from now on" and not "the next NOTE uses this", which is what the
 * label said until it was read on the review-criteria row: only one of the
 * seven prompts writes notes, and a label borrowed from the notetaker told
 * the other six a small lie about what they do.
 */
export const SAVE_LABEL = 'Save — used from now on';

export interface PromptEditorDeps {
  /** Where the pane paints. Owned by this module while it is mounted. */
  host: HTMLElement;
  api: PromptsApi;
  id: string;
  /** The board's one-line report. */
  toast: (message: string) => void;
}

export interface PromptEditorHandle {
  /** Read and paint. Awaited by the page and by tests. */
  refresh(): Promise<void>;
  /** Resolves when any in-flight write has finished. Tests await it. */
  settled(): Promise<void>;
}

/** The marker beside the name, or nothing. The list uses the same word. */
function editedMark(detail: PromptDetail): string {
  return detail.isDefault ? '' : '<span class="prompt-edited">Edited</span>';
}

function editorMarkup(detail: PromptDetail): string {
  const head =
    `<div class="prompt-editor-head">` +
    `<h2>${escapeHtml(detail.name)}</h2>` +
    editedMark(detail) +
    `<span class="prompt-purpose">${escapeHtml(detail.purpose)}</span>` +
    '</div>';
  // A prompt this page does not edit shows its words and no box to type in.
  // The thread summary is the one: it is versioned, and an edit marks every
  // stored summary stale, so the next backfill re-pays for all of them.
  const body = detail.editable
    ? `<textarea class="prompt-box" id="prompt-box" spellcheck="false" aria-label="${escapeHtml(detail.name)}"></textarea>` +
      `<div class="prompt-actions">` +
      `<button type="button" class="prompt-btn prompt-btn-primary" id="prompt-save">${escapeHtml(SAVE_LABEL)}</button>` +
      `<button type="button" class="prompt-btn" id="prompt-restore">Restore default</button>` +
      '</div>'
    : `<pre class="prompt-readonly" id="prompt-readonly"></pre>`;
  // A prompt nobody can edit has no override, so its default is the text
  // already on the screen. The disclosure would open onto the same words.
  const shipped = detail.editable
    ? `<details class="prompt-default-view">` +
      '<summary>Show the default</summary>' +
      `<pre id="prompt-default"></pre>` +
      '</details>'
    : '';
  return `<div class="prompt-editor">${head}${body}${shipped}</div>`;
}

export function mountPromptEditor(deps: PromptEditorDeps): PromptEditorHandle {
  const { host, api, id, toast } = deps;
  let inFlight: Promise<void> | null = null;
  /** The words the box last got from the server. A save that comes back with
   *  different words (a restore) repaints; one that agrees leaves the
   *  reader's cursor where it is. */
  let painted: PromptDetail | null = null;

  function paint(detail: PromptDetail): void {
    const first = painted === null || painted.editable !== detail.editable;
    if (first) host.innerHTML = editorMarkup(detail);
    painted = detail;
    const mark = host.querySelector('.prompt-editor-head .prompt-edited');
    if (detail.isDefault) mark?.remove();
    else if (!mark) {
      const h2 = host.querySelector('.prompt-editor-head h2');
      h2?.insertAdjacentHTML('afterend', '<span class="prompt-edited">Edited</span>');
    }
    const box = host.querySelector('#prompt-box') as HTMLTextAreaElement | null;
    if (box) {
      box.disabled = false;
      box.value = detail.value;
    }
    const readOnly = host.querySelector('#prompt-readonly');
    if (readOnly) readOnly.textContent = detail.value;
    const shipped = host.querySelector('#prompt-default');
    if (shipped) shipped.textContent = detail.default;
    if (first) wire();
  }

  function disable(message: string): void {
    // Disabled, not emptied. See the header: a failed read must never become
    // a destructive write.
    const box = host.querySelector('#prompt-box') as HTMLTextAreaElement | null;
    const save = host.querySelector('#prompt-save') as HTMLButtonElement | null;
    const restore = host.querySelector('#prompt-restore') as HTMLButtonElement | null;
    if (box) box.disabled = true;
    if (save) save.disabled = true;
    if (restore) restore.disabled = true;
    if (!box && !painted) host.innerHTML = `<div class="prompt-editor"><p>${message}</p></div>`;
    toast(message);
  }

  async function refresh(): Promise<void> {
    const detail = await api.detail(id);
    if (!detail) {
      disable('Could not read this prompt — reload to try again.');
      return;
    }
    paint(detail);
  }

  async function write(value: string | null): Promise<void> {
    const res = await api.save(id, value);
    if (!res.ok) {
      toast(res.message ?? 'Could not save the prompt');
      return;
    }
    await refresh();
    toast(value === null ? 'Back to the default' : 'Saved');
  }

  function run(value: string | null): void {
    inFlight = write(value).finally(() => {
      inFlight = null;
    });
  }

  function wire(): void {
    host.querySelector('#prompt-save')?.addEventListener('click', () => {
      const box = host.querySelector('#prompt-box') as HTMLTextAreaElement | null;
      const value = (box?.value ?? '').trim();
      if (value === '') {
        toast('A prompt cannot be empty — use “Restore default” instead');
        return;
      }
      run(value);
    });
    host.querySelector('#prompt-restore')?.addEventListener('click', () => run(null));
  }

  return {
    refresh,
    settled: async () => {
      await inFlight;
    },
  };
}
