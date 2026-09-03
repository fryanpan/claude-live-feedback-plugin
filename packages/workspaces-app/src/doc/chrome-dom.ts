/**
 * The three DOM helpers every boot on this surface uses: the by-id lookup that
 * throws rather than returning null, the toast, and the button factory.
 *
 * They were at the bottom of review-chrome.ts, which made that file an import
 * every module needed for reasons that had nothing to do with review chrome.
 * Nothing here knows about docs, threads or panels.
 */

export function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing element #${id}`);
  return e as T;
}

/** One thing a toast can offer to do — in practice, Undo. */
export interface ToastAction {
  label: string;
  onAction: () => void;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * A toast, optionally carrying one button.
 *
 * The button exists so that an action which wrote to somebody else's board
 * can be taken back from where it was taken: spinning a line off creates a
 * row, and the only way to un-create it used to be to go and find it. An
 * offer nobody can reach in time is not an offer, so a toast with an action
 * stays up appreciably longer than a bare one.
 */
export function showToast(msg: string, action?: ToastAction): void {
  const t = document.getElementById('toast');
  if (!t) return;
  // Wholesale, never "update the words in place": whatever the last toast
  // left here goes, button included. A surviving Undo is an offer to
  // archive a row the person has since stopped looking at.
  t.replaceChildren(msg);
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      if (toastTimer) clearTimeout(toastTimer);
      t.classList.add('hidden');
      action.onAction();
    });
    t.append(btn);
  }
  t.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), action ? 7000 : 2400);
}

export function makeBtn(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  if (primary) b.className = 'primary';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
