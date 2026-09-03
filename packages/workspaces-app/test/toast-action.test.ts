/**
 * The toast's optional button — in practice, Undo after a spin-off.
 *
 * Spinning a line off writes a row onto a board other people are looking at,
 * and until now the only confirmation was the word "Task created." with no
 * way back: undoing meant leaving the doc, finding the row, and archiving it
 * by hand. The button is the way back, and these are the properties that make
 * it one — it has to be reachable for longer than a bare toast, it has to not
 * survive into the NEXT toast, and pressing it has to dismiss.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { showToast } from '../src/doc/chrome-dom.ts';

function toast(): HTMLElement {
  const t = document.getElementById('toast');
  if (!t) throw new Error('no #toast');
  return t;
}
function actionBtn(): HTMLButtonElement | null {
  return toast().querySelector<HTMLButtonElement>('.toast-action');
}

beforeEach(() => {
  vi.useFakeTimers();
  const t = document.createElement('div');
  t.id = 'toast';
  t.className = 'hidden';
  document.body.appendChild(t);
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('showToast', () => {
  it('shows the words, with no button when nothing is offered', () => {
    showToast('Undone.');
    expect(toast().textContent).toBe('Undone.');
    expect(actionBtn()).toBeNull();
    expect(toast().classList.contains('hidden')).toBe(false);
  });

  it('offers the action as a button beside the words', () => {
    showToast('“Cloudflare Access” — added to the board.', {
      label: 'Undo',
      onAction: () => {},
    });
    expect(actionBtn()?.textContent).toBe('Undo');
    expect(toast().textContent).toContain('“Cloudflare Access”');
  });

  it('runs the action once and dismisses on the press', () => {
    const onAction = vi.fn();
    showToast('Added.', { label: 'Undo', onAction });

    actionBtn()?.click();

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(toast().classList.contains('hidden')).toBe(true);
  });

  it('stays up longer than a bare toast — an offer nobody can reach is none', () => {
    showToast('Added.', { label: 'Undo', onAction: () => {} });
    vi.advanceTimersByTime(2400);
    expect(toast().classList.contains('hidden')).toBe(false);

    vi.advanceTimersByTime(7000);
    expect(toast().classList.contains('hidden')).toBe(true);
  });

  it('a bare toast still goes away on its own', () => {
    showToast('Undone.');
    vi.advanceTimersByTime(2400);
    expect(toast().classList.contains('hidden')).toBe(true);
  });

  it('does not leave the last toast’s button under the next one’s words', () => {
    // The failure this prevents: an Undo that outlives the thing it undoes,
    // still wired to the row it archived, sitting under an unrelated message.
    const stale = vi.fn();
    showToast('Added.', { label: 'Undo', onAction: stale });
    showToast('Select a line first.');

    expect(actionBtn()).toBeNull();
    expect(toast().textContent).toBe('Select a line first.');
    expect(stale).not.toHaveBeenCalled();
  });

  it('a second offer replaces the first, and the first no longer fires', () => {
    const first = vi.fn();
    const second = vi.fn();
    showToast('One.', { label: 'Undo', onAction: first });
    showToast('Two.', { label: 'Undo', onAction: second });

    actionBtn()?.click();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
