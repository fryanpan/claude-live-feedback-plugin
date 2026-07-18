import { afterEach, describe, expect, it } from 'vitest';
import { setActiveFile } from '../src/diff-nav.ts';

afterEach(() => {
  document.body.innerHTML = '';
});

function list(html: string): HTMLElement {
  const el = document.createElement('ol');
  el.id = 'set-pane-list';
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

describe('diff-nav setActiveFile', () => {
  it('moves the active marker without rewriting the list', () => {
    const l = list(
      '<li class="diff-file"><a href="/review/a" class="active" aria-current="page">a</a></li>' +
        '<li class="diff-file"><a href="/review/b">b</a></li>',
    );
    const before = l.innerHTML.length;

    setActiveFile('b');

    const a = l.querySelector('a[href="/review/a"]');
    const b = l.querySelector('a[href="/review/b"]');
    expect(b?.classList.contains('active')).toBe(true);
    expect(b?.getAttribute('aria-current')).toBe('page');
    expect(a?.classList.contains('active')).toBe(false);
    expect(a?.getAttribute('aria-current')).toBe(null);
    // Structure length barely changes (class/attr moves) — no re-render.
    expect(Math.abs(l.innerHTML.length - before)).toBeLessThan(40);
  });

  it('matches absolute reviewUrl hrefs with query params', () => {
    const l = list(
      '<li><a href="http://host:8787/review/abc123?u=x" >abc</a></li>' +
        '<li><a href="http://host:8787/review/def456?u=x" class="active">def</a></li>',
    );
    setActiveFile('abc123');
    expect(
      l.querySelector('a[href^="http://host:8787/review/abc123"]')?.classList.contains('active'),
    ).toBe(true);
    expect(
      l.querySelector('a[href^="http://host:8787/review/def456"]')?.classList.contains('active'),
    ).toBe(false);
  });

  it('updates both #set-pane-list and #doc-menu', () => {
    const setPane = list('<li><a href="/review/a">a</a></li><li><a href="/review/b">b</a></li>');
    const docMenu = document.createElement('ol');
    docMenu.id = 'doc-menu';
    docMenu.innerHTML = '<li><a href="/review/a">a</a></li><li><a href="/review/b">b</a></li>';
    document.body.appendChild(docMenu);

    setActiveFile('b');

    expect(setPane.querySelector('a[href="/review/b"]')?.classList.contains('active')).toBe(true);
    expect(docMenu.querySelector('a[href="/review/b"]')?.classList.contains('active')).toBe(true);
  });

  it('is a no-op when the docId is not in the list (keeps the current marker)', () => {
    const l = list('<li><a href="/review/a" class="active" aria-current="page">a</a></li>');
    expect(() => setActiveFile('zzz')).not.toThrow();
    // Target absent → don't touch the existing marker.
    expect(l.querySelector('a[href="/review/a"]')?.classList.contains('active')).toBe(true);
    expect(l.querySelector('a[href="/review/a"]')?.getAttribute('aria-current')).toBe('page');
  });
});
