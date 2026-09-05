/**
 * The two bottom sheets the redline margin falls back to on a phone, where the
 * balloon column is hidden: one shows the deleted markdown behind a chip, the
 * other shows a suggestion's card.
 *
 * Both are built from the same DOM and CSS classes as the full-screen thread
 * view, so they look and animate like the comment drawer without owning any of
 * that element's thread-specific state. They are structurally identical to each
 * other, and deliberately not merged: the suggestion sheet renders a card it is
 * handed, and the deletion sheet renders text it is given.
 */
import type { suggestOps } from '@feedback/core';
import type { MountScope } from '../mount-scope.ts';

/**
 * The mobile fallback for a deletion balloon: a bottom sheet showing the
 * deleted markdown, opened by tapping a `.cw-del-chip` (live-markup.ts).
 *
 * Built from the SAME DOM structure and CSS classes as review-chrome.ts's
 * full-screen thread view (`.thread-view` / `.thread-view-header` /
 * `.thread-view-body` — fixed slide-up sheet, drag handle, close button) so
 * it looks and animates identically to the mobile comment drawer Bryan
 * already knows. A distinct element rather than the literal `#thread-view`
 * singleton: that element's state machine (`threadViewId`, the reply bar,
 * resolve/reopen) is thread-specific, and overloading it for plain deleted
 * text would tangle two unrelated concerns. `.cw-del-sheet` is the only
 * extra class — every positioning/animation rule comes from `.thread-view`
 * for free.
 */
export function mountDeletionSheet(scope: MountScope): { open: (text: string) => void } {
  const sheet = document.createElement('div');
  sheet.className = 'thread-view cw-del-sheet hidden';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'Deleted text');
  sheet.setAttribute('aria-hidden', 'true');
  sheet.innerHTML = `
    <header class="thread-view-header">
      <span class="drag-handle" aria-hidden="true"></span>
      <h2 class="thread-view-title">Deleted</h2>
      <button type="button" class="icon-btn thread-view-close" aria-label="Close" title="Close">×</button>
    </header>
    <div class="thread-view-body"><div class="cw-del-sheet-text"></div></div>
  `;
  document.body.appendChild(sheet);
  const textEl = sheet.querySelector('.cw-del-sheet-text') as HTMLElement;

  function close(): void {
    sheet.classList.add('hidden');
    sheet.setAttribute('aria-hidden', 'true');
  }
  function open(text: string): void {
    // Plain text, never HTML: deleted markdown is untrusted doc content —
    // same rule buildDelBalloon follows below.
    textEl.textContent = text;
    sheet.classList.remove('hidden');
    sheet.setAttribute('aria-hidden', 'false');
  }
  scope.listen(sheet.querySelector('.thread-view-close') as HTMLElement, 'click', close);
  scope.onCleanup(() => sheet.remove());
  return { open };
}

/**
 * The mobile fallback for a suggestion balloon: a bottom sheet showing the
 * SAME card the balloon renders (author, age, "replace X with Y", Accept /
 * Reject), opened by tapping a `.cw-suggest-chip` (suggestion-chips.ts).
 * `render` builds that card — passed in rather than duplicated, so
 * accept/reject wire to the identical fetch calls the balloon uses.
 * Structurally identical to `mountDeletionSheet` above.
 */
export function mountSuggestionSheet(
  scope: MountScope,
  render: (s: suggestOps.SuggestionSummary) => HTMLElement,
): { open: (s: suggestOps.SuggestionSummary) => void; closeIfShowing: (sid: string) => void } {
  const sheet = document.createElement('div');
  sheet.className = 'thread-view cw-suggest-sheet hidden';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'Suggested edit');
  sheet.setAttribute('aria-hidden', 'true');
  sheet.innerHTML = `
    <header class="thread-view-header">
      <span class="drag-handle" aria-hidden="true"></span>
      <h2 class="thread-view-title">Suggestion</h2>
      <button type="button" class="icon-btn thread-view-close" aria-label="Close" title="Close">×</button>
    </header>
    <div class="thread-view-body"><div class="cw-suggest-sheet-body"></div></div>
  `;
  document.body.appendChild(sheet);
  const bodyEl = sheet.querySelector('.cw-suggest-sheet-body') as HTMLElement;

  let openSid: string | null = null;
  function close(): void {
    openSid = null;
    sheet.classList.add('hidden');
    sheet.setAttribute('aria-hidden', 'true');
  }
  function open(s: suggestOps.SuggestionSummary): void {
    openSid = s.sid;
    bodyEl.textContent = '';
    bodyEl.appendChild(render(s));
    sheet.classList.remove('hidden');
    sheet.setAttribute('aria-hidden', 'false');
  }
  function closeIfShowing(sid: string): void {
    if (openSid === sid) close();
  }
  scope.listen(sheet.querySelector('.thread-view-close') as HTMLElement, 'click', close);
  scope.onCleanup(() => sheet.remove());
  return { open, closeIfShowing };
}
