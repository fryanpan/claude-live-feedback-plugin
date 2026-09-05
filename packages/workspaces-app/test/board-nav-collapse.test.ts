import { beforeEach, describe, expect, it } from 'vitest';
import { wireNavCollapse } from '../src/board/board-shell.ts';
import { mountShell } from './support/board-region-harness.ts';

/**
 * The rail's collapse toggle. It lives beside the markup it toggles because
 * everything it touches is the rail: the class the rail wears, the glyph and
 * label on the button, and the one stored preference that makes the choice
 * survive a reload — which is the whole point of it, and the half that a
 * click test alone would never catch.
 */
function storage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
}

describe('wireNavCollapse', () => {
  let el: (id: string) => HTMLElement;
  beforeEach(() => {
    el = mountShell();
  });

  it('starts expanded when nothing was stored', () => {
    wireNavCollapse(document, storage());
    expect(el('board-nav').classList.contains('board-nav--collapsed')).toBe(false);
    expect(el('board-nav-collapse').title).toBe('Collapse');
  });

  it('restores a collapsed rail from the stored preference', () => {
    wireNavCollapse(document, storage({ 'cw-board-nav-collapsed': '1' }));
    expect(el('board-nav').classList.contains('board-nav--collapsed')).toBe(true);
    expect(el('board-nav-collapse').title).toBe('Expand');
    expect(el('board-nav-collapse').querySelector('.board-nav-label')?.textContent).toBe('Expand');
  });

  it('toggles the rail and remembers the choice', () => {
    const store = storage();
    wireNavCollapse(document, store);
    el('board-nav-collapse').click();
    expect(el('board-nav').classList.contains('board-nav--collapsed')).toBe(true);
    expect(store.map.get('cw-board-nav-collapsed')).toBe('1');

    el('board-nav-collapse').click();
    expect(el('board-nav').classList.contains('board-nav--collapsed')).toBe(false);
    expect(store.map.get('cw-board-nav-collapsed')).toBe('0');
  });

  it('swaps the button’s glyph, so the control says which way it goes', () => {
    wireNavCollapse(document, storage());
    const glyph = () => el('board-nav-collapse').querySelector('.board-nav-icon')?.innerHTML ?? '';
    const expanded = glyph();
    el('board-nav-collapse').click();
    expect(glyph()).not.toBe(expanded);
    expect(glyph()).not.toBe('');
  });

  it('wires nothing at all when the shell has no rail', () => {
    // The button only renders on wide screens; on a phone this must be a
    // no-op rather than a boot-time throw.
    document.body.replaceChildren();
    expect(() =>
      wireNavCollapse(document, storage({ 'cw-board-nav-collapsed': '1' })),
    ).not.toThrow();
  });
});
