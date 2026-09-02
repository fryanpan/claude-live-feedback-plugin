import { describe, expect, it } from 'vitest';
import { wireInPlaceTitle } from '../src/hub/hub-render.ts';
import { wireWordsInPlace } from '../src/hub/inline-rename.ts';

// Urgent-fixes ticket, 2026-09-01: editing a task title and clicking outside
// reverted the edit. Both title editors used to cancel on blur; now a changed
// title survives a click away, an unchanged or emptied one restores, and
// Escape is the only cancel.

describe('detail-panel title (input) on blur', () => {
  const setup = () => {
    const el = document.createElement('h2');
    el.textContent = 'Old title';
    const commits: string[] = [];
    const begin = wireInPlaceTitle(
      el,
      () => 'Old title',
      (v) => commits.push(v),
    );
    begin();
    const input = el.querySelector('input') as HTMLInputElement;
    return { el, input, commits };
  };

  it('saves a changed title when the editor loses focus', () => {
    const { el, input, commits } = setup();
    input.value = 'New title';
    input.dispatchEvent(new Event('blur'));
    expect(commits).toEqual(['New title']);
    expect(el.querySelector('input')).toBeNull();
    expect(el.textContent).toBe('New title');
  });

  it('restores an unchanged or emptied title without saving', () => {
    for (const value of ['Old title', '   ']) {
      const { el, input, commits } = setup();
      input.value = value;
      input.dispatchEvent(new Event('blur'));
      expect(commits).toEqual([]);
      expect(el.textContent).toBe('Old title');
    }
  });

  it('still cancels on Escape even with a changed value', () => {
    const { el, input, commits } = setup();
    input.value = 'New title';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(commits).toEqual([]);
    expect(el.textContent).toBe('Old title');
  });
});

describe('row title (contenteditable words) on blur', () => {
  const setup = () => {
    const el = document.createElement('span');
    el.textContent = 'Old title';
    document.body.append(el);
    const commits: string[] = [];
    const { begin } = wireWordsInPlace(
      el,
      () => 'Old title',
      (v) => commits.push(v),
    );
    begin();
    return { el, commits };
  };

  it('saves a changed title when the words lose focus', () => {
    const { el, commits } = setup();
    el.textContent = 'New title';
    el.dispatchEvent(new Event('blur'));
    expect(commits).toEqual(['New title']);
    expect(el.hasAttribute('contenteditable')).toBe(false);
  });

  it('restores an unchanged or emptied title without saving', () => {
    for (const value of ['Old title', '']) {
      const { el, commits } = setup();
      el.textContent = value;
      el.dispatchEvent(new Event('blur'));
      expect(commits).toEqual([]);
      expect(el.textContent).toBe('Old title');
    }
  });
});
